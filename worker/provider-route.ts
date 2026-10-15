/**
 * What the routes that call one provider share: finding the provider and its
 * key, reading a JSON body within a byte limit, answering a `ProviderError`
 * with its status, and writing the log line. The decide route (`decide.ts`)
 * and the warm route (`warm.ts`) both use it, so they check and answer alike.
 *
 * No message here names a key value: they name environment variable names,
 * catalog ids, and display names.
 */

import { PROVIDERS, PROVIDER_ORDER } from "../src/providers/catalog.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import { declaredLength } from "./body-limit.ts";
import { PROVIDER_KEY_NAMES, isKeySet, isPlaceholder } from "./env.ts";
import type { ProviderKeys } from "./env.ts";
import type { ProviderError, ProviderErrorKind } from "./providers/adapter.ts";
import { failure } from "./respond.ts";

/** The media type both routes accept for a JSON body. */
export const JSON_TYPE = "application/json";

/**
 * The status for each kind of provider failure. A key the provider refuses is
 * a 502, not a 401, because the browser's own request was authorised; the
 * failure is between this server and the provider.
 */
export const STATUS_FOR_KIND: Readonly<Record<ProviderErrorKind, number>> = {
  invalid_request: 422,
  rate_limited: 429,
  no_credits: 402,
  auth: 502,
  upstream: 502,
  unreachable: 502,
  timeout: 504,
};

/** A short, plain id is echoed in the 404; anything else is described without being quoted. */
const ECHOABLE_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** The 404's message for an id no provider has, listing the ids that exist. */
function unknownProviderMessage(id: string): string {
  const known = `${PROVIDER_ORDER.slice(0, -1).join(", ")}, or ${PROVIDER_ORDER.at(-1)}`;
  // The placeholder is never echoed: see `isPlaceholder` in env.ts.
  const named =
    ECHOABLE_ID.test(id) && !isPlaceholder(id)
      ? `No provider is named "${id}".`
      : "No provider has that id.";
  return `${named} Use ${known}.`;
}

/** The catalog descriptor whose id is exactly `id`, or undefined. */
function providerById(id: string): ProviderDescriptor | undefined {
  const known = PROVIDER_ORDER.find((candidate) => candidate === id);
  return known === undefined ? undefined : PROVIDERS[known];
}

/** The provider a route names, with its key, or the answer the route gives instead. */
export type ResolvedProvider =
  | { ok: true; provider: ProviderDescriptor; apiKey: string }
  | { ok: false; response: Response };

/**
 * The provider `providerId` names and its key: a 404 when no provider has that
 * id, and a 409, naming the variable to set, when its key is not set.
 */
export function resolveProvider(providerId: string, env: ProviderKeys): ResolvedProvider {
  const provider = providerById(providerId);
  if (provider === undefined) {
    return { ok: false, response: failure(404, unknownProviderMessage(providerId)) };
  }
  const keyName = PROVIDER_KEY_NAMES[provider.id];
  const apiKey = env[keyName];
  if (!isKeySet(apiKey)) {
    return {
      ok: false,
      response: failure(
        409,
        `${provider.displayName} is not set up on this instance. Set ${keyName} to use it.`,
      ),
    };
  }
  return { ok: true, provider, apiKey };
}

/** The media type of a Content-Type header, lower-cased and without parameters. */
export function mediaTypeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/**
 * The body's bytes, or undefined once it is larger than `limit`, held in one
 * copy. A declared Content-Length over the limit is refused without reading.
 * Within the limit, the bytes go straight into one buffer of the declared
 * size, chunk by chunk. Without a declared length, the chunks are kept as the
 * stream hands them over and copied into one buffer once, at the end. Either
 * way the stream is cancelled as soon as the count passes the limit, so an
 * oversized body is never held in full.
 */
export async function readWithin(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
  const declared = declaredLength(request.headers.get("content-length"));
  if (declared !== undefined && declared > limit) return undefined;
  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  // `buffer` holds the bytes while they fit the declared size; `chunks` takes over otherwise.
  let buffer: Uint8Array<ArrayBuffer> | undefined =
    declared === undefined ? undefined : new Uint8Array(declared);
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (received + value.byteLength > limit) {
      await reader.cancel();
      return undefined;
    }
    if (buffer !== undefined && received + value.byteLength <= buffer.byteLength) {
      buffer.set(value, received);
    } else {
      // A body longer than it declared: keep what arrived and continue with chunks.
      if (buffer !== undefined) chunks.push(buffer.subarray(0, received));
      buffer = undefined;
      chunks.push(value);
    }
    received += value.byteLength;
  }

  if (buffer !== undefined) {
    return received === buffer.byteLength ? buffer : buffer.slice(0, received);
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** A request body read as JSON, or the refusal the route answers instead. */
export type Read = { ok: true; value: unknown } | { ok: false; response: Response };

/** A `Read` that refuses the request with `status`, `error`, and an optional detail. */
export function refuse(status: number, error: string, detail?: string): Read {
  return { ok: false, response: failure(status, error, { detail }) };
}

/**
 * The body as text, or undefined when it is not valid UTF-8. A lenient decoder
 * would turn a bad byte into U+FFFD and send the provider text the user never
 * wrote, so the decoder is strict (`fatal: true`).
 */
export function decodeUtf8(bytes: Uint8Array<ArrayBuffer>): string | undefined {
  try {
    // `ignoreBOM: false` is the default (a leading BOM is dropped); the Workers types require it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** `text` parsed as JSON, or a 400 that says the body is empty or not JSON without quoting it. */
export function parseJson(text: string): Read {
  if (text.trim() === "") {
    return refuse(400, "The request body is empty. Send the panel's JSON as the body.");
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    // The parser's own message quotes the body, which is not echoed back.
    return refuse(
      400,
      "The request body is not valid JSON. Check for missing quotes, commas, or brackets.",
    );
  }
}

/** One log line for `route`: its name, then space-separated `name=value` pairs, with text values quoted as JSON. */
export function logLine(
  route: string,
  fields: Record<string, string | number | undefined>,
): string {
  const parts = [`[api] ${route}`];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${name}=${typeof value === "number" ? value : JSON.stringify(value)}`);
  }
  return parts.join(" ");
}

/** The answer for a provider failure: its status, message, detail, and any `Retry-After`. */
export function providerFailure(error: ProviderError): Response {
  const headers =
    error.kind === "rate_limited" && error.retryAfterSeconds !== undefined
      ? { "retry-after": String(error.retryAfterSeconds) }
      : undefined;
  return failure(STATUS_FOR_KIND[error.kind], error.message, { detail: error.detail, headers });
}
