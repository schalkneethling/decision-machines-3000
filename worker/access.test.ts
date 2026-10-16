import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { ACCESS_CERTS_TIMEOUT_MS, certsUrl, verifyAccessToken } from "./access.ts";
import type { AccessApplication, Verification } from "./access.ts";
import {
  accessClaims,
  createSigner,
  keySetBody,
  nowSeconds,
  signToken,
  toBase64Url,
} from "./fixtures/access-tokens.ts";
import type { Signer } from "./fixtures/access-tokens.ts";

const APPLICATION: AccessApplication = {
  issuer: "https://myteam.cloudflareaccess.com",
  audience: "a1b2c3d4".repeat(8),
};

let current: Signer;
let other: Signer;

beforeAll(async () => {
  [current, other] = await Promise.all([createSigner("current-key"), createSigner("other-key")]);
});

/** The verifier's dependencies: a `fetch` for the certs endpoint and a signal that never fires. */
function deps(fetch: typeof globalThis.fetch) {
  return {
    fetch: vi.fn(fetch),
    timeoutSignal: vi.fn((_ms: number) => new AbortController().signal),
  };
}

/** A certs endpoint that lists `signers`. */
function servingKeys(...signers: Signer[]): typeof fetch {
  return () => Promise.resolve(Response.json(keySetBody(...signers)));
}

function unexpectedFetch(): Promise<Response> {
  return Promise.reject(new Error("fetch was called."));
}

async function verify(token: string | null, fetch = servingKeys(current)): Promise<Verification> {
  return verifyAccessToken(token, APPLICATION, deps(fetch));
}

describe("verifyAccessToken", () => {
  it("accepts a token signed by a listed key, for the application, within its times", async () => {
    const token = await signToken(current, accessClaims(APPLICATION));

    expect(await verify(token)).toEqual({ ok: true });
  });

  it("accepts a token whose key is not the first one listed, as during a rotation", async () => {
    const token = await signToken(current, accessClaims(APPLICATION));

    expect(await verify(token, servingKeys(other, current))).toEqual({ ok: true });
  });

  it("accepts `aud` given as one string, which is valid JWT too", async () => {
    const token = await signToken(
      current,
      accessClaims(APPLICATION, { aud: APPLICATION.audience }),
    );

    expect(await verify(token)).toEqual({ ok: true });
  });

  it("accepts a token with no `nbf`", async () => {
    const token = await signToken(current, accessClaims(APPLICATION, { nbf: undefined }));

    expect(await verify(token)).toEqual({ ok: true });
  });

  it("fetches the team's keys from the certs URL, without following a redirect, with the timeout signal", async () => {
    const token = await signToken(current, accessClaims(APPLICATION));
    const verifier = deps(servingKeys(current));

    await verifyAccessToken(token, APPLICATION, verifier);

    expect(verifier.fetch).toHaveBeenCalledOnce();
    const [url, init] = verifier.fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://myteam.cloudflareaccess.com/cdn-cgi/access/certs");
    expect(certsUrl(APPLICATION.issuer)).toBe(url);
    expect(init.method).toBe("GET");
    // workerd implements only "follow" and "manual"; it throws on "error".
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(verifier.timeoutSignal).toHaveBeenCalledExactlyOnceWith(ACCESS_CERTS_TIMEOUT_MS);
  });

  it("refuses a redirect from the certs endpoint without following it or reading it", async () => {
    const token = await signToken(current, accessClaims(APPLICATION));
    let pulled = false;
    let cancelled = false;
    // A zero high-water mark, so `pull` runs only when something reads the body.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    // Behaves as workerd does: `redirect: "error"` is not a value it accepts.
    const verifier = deps((_input, init) => {
      if (init?.redirect === "error") {
        return Promise.reject(
          new TypeError('Invalid redirect value, must be one of "follow" or "manual"'),
        );
      }
      return Promise.resolve(
        new Response(body, { status: 302, headers: { location: "https://elsewhere.example/" } }),
      );
    });

    const result = await verifyAccessToken(token, APPLICATION, verifier);

    expect(result).toEqual({ ok: false, problem: "keys_unavailable", detail: "status 302" });
    expect(verifier.fetch).toHaveBeenCalledOnce();
    expect(pulled).toBe(false);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["for another audience", { aud: ["b".repeat(64)] }, "audience"],
    ["expired", { exp: nowSeconds() - 60 }, "expired"],
    ["not valid yet", { nbf: nowSeconds() + 3600 }, "not_yet_valid"],
    ["from another team", { iss: "https://otherteam.cloudflareaccess.com" }, "issuer"],
  ])(
    "refuses a well-formed token that is %s before fetching any key, because the claims already fail",
    async (_name, overrides, problem) => {
      const token = await signToken(current, accessClaims(APPLICATION, overrides));

      expect(await verify(token, unexpectedFetch)).toEqual({ ok: false, problem });
    },
  );

  it("accepts the right RSA key published alongside a key of another type", async () => {
    const token = await signToken(current, accessClaims(APPLICATION));
    const published = keySetBody(current) as { keys: unknown[] };
    published.keys.unshift({
      kid: "ec-key",
      kty: "EC",
      alg: "ES256",
      use: "sig",
      crv: "P-256",
      x: "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
      y: "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    });

    expect(await verify(token, () => Promise.resolve(Response.json(published)))).toEqual({
      ok: true,
    });
  });

  it.each([null, "", "   "])("refuses %j as missing, without fetching keys", async (token) => {
    expect(await verify(token, unexpectedFetch)).toEqual({ ok: false, problem: "missing" });
  });

  describe("a malformed token is refused without fetching keys", () => {
    it.each([
      ["one part", "abc"],
      ["two parts", "abc.def"],
      ["four parts", "a.b.c.d"],
      ["a header that is not base64url", `${toBase64Url("{}")}!.${toBase64Url("{}")}.AQ`],
      ["a header that is not JSON", `${toBase64Url("not json")}.${toBase64Url("{}")}.AQ`],
      ["a header with no kid", `${toBase64Url('{"alg":"RS256"}')}.${toBase64Url("{}")}.AQ`],
      [
        "claims with no exp",
        `${toBase64Url('{"alg":"RS256","kid":"k"}')}.${toBase64Url('{"iss":"x","aud":"y"}')}.AQ`,
      ],
      [
        "an empty signature",
        `${toBase64Url('{"alg":"RS256","kid":"k"}')}.${toBase64Url('{"iss":"x","aud":"y","exp":1}')}.`,
      ],
    ])("%s", async (_name, token) => {
      expect(await verify(token, unexpectedFetch)).toEqual({ ok: false, problem: "malformed" });
    });
  });

  it.each(["none", "HS256", "RS512", "ES256", "rs256"])(
    "refuses alg %j before fetching any key",
    async (alg) => {
      const token = await signToken(current, accessClaims(APPLICATION), {
        alg,
        kid: current.kid,
      });

      expect(await verify(token, unexpectedFetch)).toEqual({ ok: false, problem: "algorithm" });
    },
  );

  it("refuses a kid the team does not list", async () => {
    const token = await signToken(other, accessClaims(APPLICATION));

    expect(await verify(token, servingKeys(current))).toEqual({
      ok: false,
      problem: "unknown_key",
    });
  });

  it("refuses a listed key that is not an RSA key", async () => {
    const token = await signToken(current, accessClaims(APPLICATION));
    const keys = keySetBody(current) as { keys: { kty: string }[] };
    keys.keys[0]!.kty = "EC";

    expect(await verify(token, () => Promise.resolve(Response.json(keys)))).toEqual({
      ok: false,
      problem: "unknown_key",
    });
  });

  it("refuses a token signed by another key pair under a listed kid", async () => {
    const forged = await signToken(other, accessClaims(APPLICATION), {
      alg: "RS256",
      kid: current.kid,
    });

    expect(await verify(forged)).toEqual({ ok: false, problem: "signature" });
  });

  it("refuses a token whose claims were changed after signing", async () => {
    const token = await signToken(
      current,
      accessClaims(APPLICATION, { email: "owner@example.com" }),
    );
    const [header, , signature] = token.split(".") as [string, string, string];
    const tampered = `${header}.${toBase64Url(
      JSON.stringify(accessClaims(APPLICATION, { email: "intruder@example.com" })),
    )}.${signature}`;

    expect(await verify(tampered)).toEqual({ ok: false, problem: "signature" });
  });

  it.each([
    ["expired a minute ago", { exp: nowSeconds() - 60 }, "expired"],
    ["expiring this very second", { exp: nowSeconds() }, "expired"],
    ["not valid for another hour", { nbf: nowSeconds() + 3600 }, "not_yet_valid"],
    ["for another audience", { aud: ["b".repeat(64)] }, "audience"],
    ["for a list of other audiences", { aud: ["b".repeat(64), "c".repeat(64)] }, "audience"],
    ["for no audience", { aud: [] }, "audience"],
    ["from another team", { iss: "https://otherteam.cloudflareaccess.com" }, "issuer"],
    ["from the team's domain over http", { iss: "http://myteam.cloudflareaccess.com" }, "issuer"],
    // The issuer is compared whole, not as a prefix.
    [
      "from a domain that starts with the team's",
      { iss: "https://myteam.cloudflareaccess.com.evil.com" },
      "issuer",
    ],
    [
      "from the team's domain with a trailing slash",
      { iss: "https://myteam.cloudflareaccess.com/" },
      "issuer",
    ],
    // The audience is compared whole, not as a substring: every Access
    // application of an account is signed with the same key.
    ["for the tag with a suffix, as a string", { aud: `${APPLICATION.audience}0` }, "audience"],
    ["for the tag with a prefix, as a string", { aud: `0${APPLICATION.audience}` }, "audience"],
    [
      "for a prefix of the tag, as a string",
      { aud: APPLICATION.audience.slice(0, -1) },
      "audience",
    ],
    ["for the tag with a suffix, in a list", { aud: [`${APPLICATION.audience}0`] }, "audience"],
    ["for the tag with a prefix, in a list", { aud: [`0${APPLICATION.audience}`] }, "audience"],
    [
      "for a prefix of the tag, in a list",
      { aud: [APPLICATION.audience.slice(0, -1)] },
      "audience",
    ],
  ])("refuses a correctly signed token that is %s", async (_name, overrides, problem) => {
    const token = await signToken(current, accessClaims(APPLICATION, overrides));

    expect(await verify(token)).toEqual({ ok: false, problem });
  });

  describe("keys that cannot be fetched or read", () => {
    it.each([
      ["a 500", () => Promise.resolve(new Response("busy", { status: 500 })), "status 500"],
      [
        "a redirect answered as 302",
        () => Promise.resolve(new Response(null, { status: 302 })),
        "status 302",
      ],
      [
        "a body that is not JSON",
        () => Promise.resolve(new Response("<html>", { status: 200 })),
        "body is not JSON",
      ],
      [
        "a body that is not a key set",
        () => Promise.resolve(Response.json({ keys: "none" })),
        "body is not a key set",
      ],
      ["a rejected fetch", () => Promise.reject(new TypeError("fetch failed")), "TypeError"],
      [
        "a timed-out fetch",
        () => Promise.reject(new DOMException("The operation was aborted.", "TimeoutError")),
        "TimeoutError",
      ],
    ])(
      "answers keys_unavailable for %s, with a detail that never quotes the body",
      async (_name, fetch, detail) => {
        const token = await signToken(current, accessClaims(APPLICATION));

        expect(await verify(token, fetch as typeof globalThis.fetch)).toEqual({
          ok: false,
          problem: "keys_unavailable",
          detail,
        });
      },
    );
  });
});
