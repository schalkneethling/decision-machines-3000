/**
 * Verifies a Cloudflare Access application token (ADR-0003).
 *
 * Access puts the token, a JWT, in the `Cf-Access-Jwt-Assertion` header of
 * every request it lets through to the origin. The origin must still verify it,
 * because anyone who reaches the Worker on a hostname Access does not cover can
 * send that header themselves. The checks, in order, follow Cloudflare's
 * "Validate JWTs" page (developers.cloudflare.com/cloudflare-one/identity/
 * authorization-cookie/validating-json/, read on 2026-10-15):
 *
 * 1. The token has three base64url parts, and the header's `alg` is `RS256`,
 *    the only algorithm Access signs with. Anything else, `none` included, is
 *    refused before any key is looked at.
 * 2. The claims are checked once before any fetch, unverified, so a token that
 *    is plainly for another application or long expired costs no network call.
 *    That early check proves nothing on its own, which is why step 4 repeats it.
 * 3. The team's current public keys are fetched from
 *    `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs` and the RSA key
 *    whose `kid` matches the header's is used. The page says to match `kid`
 *    against the published keys rather than cache one key, because Access
 *    rotates the pair every six weeks and keeps the previous one valid for seven
 *    days. The RSASSA-PKCS1-v1_5 / SHA-256 signature is then checked with Web
 *    Crypto, which both workerd and Node provide, so no JWT library is needed.
 * 4. The claims, now signed: `iss` must equal the team domain, `aud` must
 *    contain the application's audience tag as a whole value, `exp` must be in
 *    the future, and `nbf`, when present, must not be. There is no clock leeway:
 *    a token Access just issued is valid at once, and refusing a stale one is
 *    the point.
 *
 * The keys are fetched for every verification and cached nowhere. A cache that
 * outlives a request would be the Worker's first mutable global, and one extra
 * Cloudflare-to-Cloudflare fetch per protected request is cheap next to the
 * provider call. If that ever changes, the cache belongs in `worker/index.ts`,
 * created once per isolate and passed in through `HandlerDeps`.
 *
 * Nothing here logs or returns the token, a key, or any claim value.
 */

import * as z from "zod/mini";
import type { HandlerDeps } from "./handler.ts";

/** The request header Access sets. Headers are case-insensitive; this is the lower-case form `Headers` uses. */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

/** How long the fetch of the team's keys may take before the request is refused. */
export const ACCESS_CERTS_TIMEOUT_MS = 5_000;

/** The Access application a token must have been issued for. */
export type AccessApplication = {
  /** The team domain, as `https://<team>.cloudflareaccess.com`, which is also the expected `iss`. */
  issuer: string;
  /** The Application Audience (AUD) tag the token's `aud` must include. */
  audience: string;
};

/**
 * Why a token was refused. Each is a category, never the token itself, so a
 * message can name it safely.
 */
export type TokenProblem =
  | "missing"
  | "malformed"
  | "algorithm"
  | "unknown_key"
  | "signature"
  | "expired"
  | "not_yet_valid"
  | "audience"
  | "issuer";

export type Verification =
  | { ok: true }
  | { ok: false; problem: TokenProblem }
  /** The keys could not be fetched or read; `detail` is an HTTP status or an error class name. */
  | { ok: false; problem: "keys_unavailable"; detail: string };

/** One sentence per problem, for the 403 and for the protection report. */
export const TOKEN_PROBLEM_SENTENCES: Readonly<Record<TokenProblem, string>> = {
  missing: "This request carried no Cloudflare Access token.",
  malformed: "The Cloudflare Access token on this request is malformed.",
  algorithm: "The Cloudflare Access token's signing algorithm is not RS256.",
  unknown_key: "The Cloudflare Access token's signing key is not one of the team's current keys.",
  signature: "The Cloudflare Access token's signature does not match.",
  expired: "The Cloudflare Access token has expired.",
  not_yet_valid: "The Cloudflare Access token is not valid yet.",
  audience: "The Cloudflare Access token was issued for another application (audience).",
  issuer: "The Cloudflare Access token was issued by another team (issuer).",
};

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]*$/;

/** The bytes of a base64url string, or undefined when it is not one. */
function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64URL.test(text)) return undefined;
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return undefined;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * The bytes a token was signed over: its first two parts, joined with a dot.
 * Both parts are base64url, so every character is one ASCII byte, and the
 * result is backed by a plain `ArrayBuffer`, as `crypto.subtle.verify` wants.
 */
function signedBytes(headerPart: string, claimsPart: string): Uint8Array<ArrayBuffer> {
  const text = `${headerPart}.${claimsPart}`;
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) bytes[index] = text.charCodeAt(index);
  return bytes;
}

/** The JSON a base64url part holds, or undefined when it is not UTF-8 JSON. */
function decodeJsonPart(part: string): unknown {
  const bytes = fromBase64Url(part);
  if (bytes === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return undefined;
  }
}

/** The signed header: only `alg` and `kid` are read. `z.object` drops the other fields. */
const headerSchema = z.object({ alg: z.string(), kid: z.string() });

/**
 * The claims this module checks, as the "Application token" page lists them.
 * `aud` is an array in Access tokens, but a string is also valid JWT.
 */
const claimsSchema = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.exactOptional(z.number()),
});

/**
 * The key set at `/cdn-cgi/access/certs`: the `keys` array. `n` and `e` are
 * optional here because a key of another type, published alongside the RSA
 * ones, has neither, and must not make the whole set unreadable.
 */
const keySetSchema = z.object({
  keys: z.array(
    z.object({
      kid: z.string(),
      kty: z.string(),
      n: z.exactOptional(z.string()),
      e: z.exactOptional(z.string()),
    }),
  ),
});

/** A published key that can verify an RS256 signature: RSA, with both parameters. */
type RsaKey = { kid: string; kty: "RSA"; n: string; e: string };

function isRsaKey(key: z.output<typeof keySetSchema>["keys"][number]): key is RsaKey {
  return key.kty === "RSA" && key.n !== undefined && key.e !== undefined;
}

type Parsed = {
  header: z.output<typeof headerSchema>;
  claims: z.output<typeof claimsSchema>;
  /** The bytes that were signed: the first two parts joined with a dot, as ASCII. */
  signed: Uint8Array<ArrayBuffer>;
  signature: Uint8Array<ArrayBuffer>;
};

/** Splits and decodes a token, or says why it cannot be. */
function parseToken(
  token: string,
): { ok: true; parsed: Parsed } | { ok: false; problem: TokenProblem } {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, problem: "malformed" };
  const [headerPart, claimsPart, signaturePart] = parts as [string, string, string];

  const header = headerSchema.safeParse(decodeJsonPart(headerPart));
  const claims = claimsSchema.safeParse(decodeJsonPart(claimsPart));
  const signature = fromBase64Url(signaturePart);
  if (!header.success || !claims.success || signature === undefined || signature.byteLength === 0) {
    return { ok: false, problem: "malformed" };
  }
  return {
    ok: true,
    parsed: {
      header: header.data,
      claims: claims.data,
      signed: signedBytes(headerPart, claimsPart),
      signature,
    },
  };
}

// ---------------------------------------------------------------------------
// The team's keys
// ---------------------------------------------------------------------------

type KeySet = z.output<typeof keySetSchema>;

/** The URL of a team's current public keys. */
export function certsUrl(issuer: string): string {
  return `${issuer}/cdn-cgi/access/certs`;
}

/**
 * Fetches the team's key set through `deps.fetch`, with one timeout and
 * without following redirects, so a misconfigured team domain cannot send the
 * request elsewhere. `redirect` is `"manual"` rather than `"error"`, because
 * workerd implements only `"follow"` and `"manual"` and throws on `"error"`;
 * a redirect therefore comes back as its own 3xx, which the status check
 * refuses, with its body cancelled unread and its `Location` never looked at.
 * Failures carry a status or an error class name, never the body.
 */
async function fetchKeySet(
  issuer: string,
  deps: Pick<HandlerDeps, "fetch" | "timeoutSignal">,
): Promise<{ ok: true; keys: KeySet } | { ok: false; detail: string }> {
  let response: Response;
  try {
    response = await deps.fetch(certsUrl(issuer), {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: deps.timeoutSignal(ACCESS_CERTS_TIMEOUT_MS),
    });
  } catch (thrown) {
    return { ok: false, detail: thrown instanceof Error ? thrown.name : typeof thrown };
  }
  if (response.status !== 200) {
    await discardBody(response);
    return { ok: false, detail: `status ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: "body is not JSON" };
  }
  const keys = keySetSchema.safeParse(body);
  return keys.success
    ? { ok: true, keys: keys.data }
    : { ok: false, detail: "body is not a key set" };
}

/** Cancels a body that will not be read, so the connection is released. A body that cannot be cancelled is left alone. */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed or locked; nothing to release.
  }
}

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };

/** Imports one published RSA public key for verification only, or undefined when it is not usable. */
async function importKey(key: RsaKey): Promise<CryptoKey | undefined> {
  try {
    // Only `kty`, `n`, and `e` are passed, so a stray `alg` or `use` on the
    // published key cannot make the import fail or change the algorithm.
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: key.n, e: key.e },
      RSA_SHA256,
      false,
      ["verify"],
    );
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Whether `aud` (a string or a list) holds the application's audience as a whole value. */
function hasAudience(aud: string | string[], audience: string): boolean {
  return typeof aud === "string" ? aud === audience : aud.some((value) => value === audience);
}

/**
 * The first claim that fails for `application` at `nowSeconds`, or undefined
 * when all pass. Called twice: on the unverified claims, to skip the key fetch
 * for a token that cannot pass, and again once the signature has been checked,
 * because only then do the claims mean anything.
 */
function claimProblem(
  claims: z.output<typeof claimsSchema>,
  application: AccessApplication,
  nowSeconds: number,
): TokenProblem | undefined {
  if (claims.exp <= nowSeconds) return "expired";
  if (claims.nbf !== undefined && claims.nbf > nowSeconds) return "not_yet_valid";
  if (claims.iss !== application.issuer) return "issuer";
  if (!hasAudience(claims.aud, application.audience)) return "audience";
  return undefined;
}

/**
 * Verifies the token of one request against `application`. `token` is the raw
 * header value, or null when the header is absent. Every check must pass; the
 * first that fails names the problem.
 */
export async function verifyAccessToken(
  token: string | null,
  application: AccessApplication,
  deps: Pick<HandlerDeps, "fetch" | "timeoutSignal">,
): Promise<Verification> {
  if (token === null || token.trim() === "") return { ok: false, problem: "missing" };

  const parsed = parseToken(token.trim());
  if (!parsed.ok) return parsed;
  const { header, claims, signed, signature } = parsed.parsed;
  if (header.alg !== "RS256") return { ok: false, problem: "algorithm" };
  const early = claimProblem(claims, application, Date.now() / 1000);
  if (early !== undefined) return { ok: false, problem: early };

  const keySet = await fetchKeySet(application.issuer, deps);
  if (!keySet.ok) return { ok: false, problem: "keys_unavailable", detail: keySet.detail };
  const published = keySet.keys.keys.filter(isRsaKey).find((key) => key.kid === header.kid);
  const key = published === undefined ? undefined : await importKey(published);
  if (key === undefined) return { ok: false, problem: "unknown_key" };

  let valid: boolean;
  try {
    valid = await crypto.subtle.verify(RSA_SHA256.name, key, signature, signed);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, problem: "signature" };

  const problem = claimProblem(claims, application, Date.now() / 1000);
  return problem === undefined ? { ok: true } : { ok: false, problem };
}
