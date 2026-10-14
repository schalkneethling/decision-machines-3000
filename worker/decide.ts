/**
 * `POST /api/decide/{provider}`: runs one decision request on one provider.
 *
 * The route checks, in order: that the provider exists (404), that its key is
 * set (409, naming the variable), that this version has an adapter for it
 * (501), the content type (415), the body size (413), and the request itself
 * (400, with the validator's own message and path). Only then does it call the
 * provider, once, through the adapter, with one 25-second budget and no retry,
 * and map a failure to one status per `ProviderError` kind (`STATUS_FOR_KIND`).
 *
 * The route reads the key from `env` and hands it to the adapter's `decide`,
 * which passes it to `fetchJson` and nowhere else. No message here names a key
 * value: they name environment variable names, catalog ids, and display names.
 */

import type { DecisionSuccess } from "../src/decision/contract.ts";
import { validateDecisionRequest } from "../src/decision/validate.ts";
import type { ValidDecisionRequest } from "../src/decision/validate.ts";
import { PROVIDERS, PROVIDER_ORDER } from "../src/providers/catalog.ts";
import type { ProviderDescriptor, ProviderId } from "../src/providers/catalog.ts";
import { MAX_BODY_BYTES, declaredLength, tooLarge } from "./body-limit.ts";
import { PROVIDER_KEY_NAMES, isKeySet, isPlaceholder } from "./env.ts";
import type { ProviderKeys } from "./env.ts";
import type { HandlerDeps } from "./handler.ts";
import { ProviderError } from "./providers/adapter.ts";
import type { AdapterResult, ProviderAdapter, ProviderErrorKind } from "./providers/adapter.ts";
import { typesafeAdapter } from "./providers/typesafe.ts";
import { failure, json } from "./respond.ts";

/**
 * How long one provider call may take before its signal aborts it. Nothing is
 * retried: a decision spends tokens, so trying again is left to the user. The
 * browser waits 30 seconds (`REQUEST_TIMEOUT_MS` in `src/ui/client.ts`), so
 * this route's 504 always reaches the readout first.
 */
export const PROVIDER_TIMEOUT_MS = 25_000;

const JSON_TYPE = "application/json";
const MULTIPART_TYPE = "multipart/form-data";

/** The adapter for each provider this version can call. */
const ADAPTERS: Readonly<Partial<Record<ProviderId, ProviderAdapter>>> = {
  typesafe: typesafeAdapter,
};

/**
 * The status for each kind of provider failure. A key the provider refuses is
 * a 502, not a 401, because the browser's own request was authorised; the
 * failure is between this server and the provider.
 */
const STATUS_FOR_KIND: Readonly<Record<ProviderErrorKind, number>> = {
  invalid_request: 422,
  rate_limited: 429,
  no_credits: 402,
  auth: 502,
  upstream: 502,
  unreachable: 502,
  timeout: 504,
};

/**
 * The success as the route builds it. `wire.request` is whatever the adapter's
 * `toWire` returned, an `object`, because the SDK's request type is an
 * interface and so does not fit the contract's JSON record; once serialised it
 * is that record, which the browser checks with the contract's schema.
 */
export type DecisionSuccessBody = Omit<DecisionSuccess, "wire"> & {
  wire: { request: object; response: unknown };
};

// ---------------------------------------------------------------------------
// The wire record
// ---------------------------------------------------------------------------

/**
 * One image as the neutral request will carry it once images arrive (#15):
 * its media type, its data as base64, and its decoded size.
 */
export type ImageAttachment = { mediaType: string; base64: string; byteLength: number };

/**
 * A neutral request that may carry images. `state` is named so that a request
 * without images still shares a property with this type, which TypeScript's
 * check for all-optional types requires.
 */
type MayCarryImages = { state: unknown; images?: readonly ImageAttachment[] };

/** A size in binary units, written KB and MB as the plan's placeholders are: `230 KB`. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A copy of `request` whose every image `base64` value is a placeholder such
 * as `<image 1: image/png, 230 KB>`; the request itself is left as it is. A
 * request without images is returned unchanged.
 */
export function withImagePlaceholders<T extends MayCarryImages>(request: T): T {
  if (request.images === undefined) return request;
  return {
    ...request,
    images: request.images.map((image, index) => ({
      ...image,
      base64: `<image ${index + 1}: ${image.mediaType}, ${formatBytes(image.byteLength)}>`,
    })),
  };
}

/**
 * What the success reports as sent: the adapter's own `toWire`, called a
 * second time on a copy of the request whose image data are placeholders. The
 * adapter places a placeholder wherever it places image data, so no adapter
 * needs redaction code of its own, and the record cannot drift from what was
 * sent.
 */
export function wireRecord(
  adapter: ProviderAdapter,
  request: ValidDecisionRequest,
): { request: object } {
  return { request: adapter.toWire(withImagePlaceholders(request)) };
}

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

/** A short, plain id is echoed in the 404; anything else is described without being quoted. */
const ECHOABLE_ID = /^[A-Za-z0-9_-]{1,40}$/;

function unknownProviderMessage(id: string): string {
  const known = `${PROVIDER_ORDER.slice(0, -1).join(", ")}, or ${PROVIDER_ORDER.at(-1)}`;
  // The placeholder is never echoed: see `isPlaceholder` in env.ts.
  const named =
    ECHOABLE_ID.test(id) && !isPlaceholder(id)
      ? `No provider is named "${id}".`
      : "No provider has that id.";
  return `${named} Use ${known}.`;
}

function providerById(id: string): ProviderDescriptor | undefined {
  const known = PROVIDER_ORDER.find((candidate) => candidate === id);
  return known === undefined ? undefined : PROVIDERS[known];
}

/** The media type of a Content-Type header, lower-cased and without parameters. */
function mediaTypeOf(contentType: string | null): string {
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
async function readWithin(
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

type Read = { ok: true; value: unknown } | { ok: false; response: Response };

function refuse(status: number, error: string, detail?: string): Read {
  return { ok: false, response: failure(status, error, { detail }) };
}

const UNSUPPORTED_TYPE = `Send the request as ${JSON_TYPE}, or as ${MULTIPART_TYPE} with a "request" part and one "image" part per image.`;

/**
 * The text of the `request` part of a multipart body, or a refusal. Image parts
 * are checked against the provider's capabilities; reading them arrives with
 * image input (#15).
 */
async function requestPart(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  provider: ProviderDescriptor,
): Promise<{ ok: true; text: string } | { ok: false; read: Read }> {
  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return {
      ok: false,
      read: refuse(400, "The multipart body could not be read. Check its boundary and parts."),
    };
  }

  const names = new Set(form.keys());
  if ([...names].some((name) => name !== "request" && name !== "image")) {
    return {
      ok: false,
      read: refuse(400, 'A multipart request may hold only a "request" part and "image" parts.'),
    };
  }
  const parts = form.getAll("request");
  const [part] = parts;
  if (parts.length !== 1 || typeof part !== "string") {
    return {
      ok: false,
      read: refuse(400, 'Send exactly one "request" part, holding the request as JSON text.'),
    };
  }
  if (names.has("image")) {
    const reason =
      provider.capabilities.images === false
        ? `${provider.displayName} does not accept images. Remove them and run again.`
        : "This version cannot send images yet. Remove them and run again.";
    return { ok: false, read: refuse(400, reason) };
  }
  return { ok: true, text: part };
}

const NOT_UTF8 = "The request body is not valid UTF-8. Send the panel's JSON as UTF-8 text.";

/**
 * The body as text, or undefined when it is not valid UTF-8. A lenient decoder
 * would turn a bad byte into U+FFFD and send the provider text the user never
 * wrote, so the decoder is strict (`fatal: true`).
 */
function decodeUtf8(bytes: Uint8Array<ArrayBuffer>): string | undefined {
  try {
    // `ignoreBOM: false` is the default (a leading BOM is dropped); the Workers types require it.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): Read {
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

/** The parsed request from a JSON or multipart body, or the refusal to send instead. */
async function readDecisionRequest(request: Request, provider: ProviderDescriptor): Promise<Read> {
  const contentType = request.headers.get("content-type");
  const mediaType = mediaTypeOf(contentType);
  if (mediaType !== JSON_TYPE && mediaType !== MULTIPART_TYPE) {
    return refuse(415, UNSUPPORTED_TYPE);
  }

  const bytes = await readWithin(request, MAX_BODY_BYTES);
  if (bytes === undefined) return { ok: false, response: tooLarge() };

  if (mediaType === JSON_TYPE) {
    const text = decodeUtf8(bytes);
    return text === undefined ? refuse(400, NOT_UTF8) : parseJson(text);
  }
  const part = await requestPart(bytes, contentType ?? MULTIPART_TYPE, provider);
  return part.ok ? parseJson(part.text) : part.read;
}

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

/** One log line: space-separated `name=value` pairs, with text values quoted as JSON. */
function logLine(fields: Record<string, string | number | undefined>): string {
  const parts = ["[api] decide"];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    parts.push(`${name}=${typeof value === "number" ? value : JSON.stringify(value)}`);
  }
  return parts.join(" ");
}

/** The answer for a provider failure: its status, message, detail, and any `Retry-After`. */
function providerFailure(error: ProviderError): Response {
  const headers =
    error.kind === "rate_limited" && error.retryAfterSeconds !== undefined
      ? { "retry-after": String(error.retryAfterSeconds) }
      : undefined;
  return failure(STATUS_FOR_KIND[error.kind], error.message, { detail: error.detail, headers });
}

/** Answers `POST /api/decide/{providerId}`; `providerId` is the raw path segment. */
export async function decide(
  providerId: string,
  request: Request,
  env: ProviderKeys,
  deps: HandlerDeps,
): Promise<Response> {
  const provider = providerById(providerId);
  if (provider === undefined) {
    return failure(404, unknownProviderMessage(providerId));
  }
  const keyName = PROVIDER_KEY_NAMES[provider.id];
  const apiKey = env[keyName];
  if (!isKeySet(apiKey)) {
    return failure(
      409,
      `${provider.displayName} is not set up on this instance. Set ${keyName} to use it.`,
    );
  }
  const adapter = ADAPTERS[provider.id];
  if (adapter === undefined) {
    return failure(501, `${provider.displayName} is not available in this version yet.`);
  }

  const read = await readDecisionRequest(request, provider);
  if (!read.ok) return read.response;
  const validation = validateDecisionRequest(read.value, provider.capabilities);
  if (!validation.ok) {
    return failure(400, validation.error, { detail: validation.detail });
  }

  const valid = validation.value;
  const fields = {
    provider: provider.id,
    primitive: valid.primitive,
    questions: Object.keys(valid.questions).length,
  };
  const signal = deps.timeoutSignal(PROVIDER_TIMEOUT_MS);
  const startedAt = performance.now();
  let decision: AdapterResult;
  try {
    decision = await adapter.decide(valid, apiKey, signal, deps.fetch);
  } catch (thrown) {
    const latencyMs = Math.round(performance.now() - startedAt);
    if (thrown instanceof ProviderError) {
      const response = providerFailure(thrown);
      deps.log(
        logLine({
          ...fields,
          status: response.status,
          latencyMs,
          kind: thrown.kind,
          detail: thrown.detail,
          schema: thrown.schemaMessage,
        }),
      );
      return response;
    }
    // Not a provider failure, so a bug in this app: log its class name only, never its message.
    const name = thrown instanceof Error ? thrown.name : typeof thrown;
    deps.log(logLine({ ...fields, status: 500, latencyMs, unexpected: name }));
    return failure(
      500,
      `Something went wrong on the server while asking ${provider.displayName}. Check the server log.`,
    );
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  deps.log(logLine({ ...fields, status: 200, latencyMs }));
  const body: DecisionSuccessBody = {
    ok: true,
    primitive: valid.primitive,
    provider: provider.id,
    model: decision.model,
    usage: decision.usage,
    latencyMs,
    answers: decision.answers,
    wire: { ...wireRecord(adapter, valid), response: decision.wire.response },
  };
  return json(body, 200);
}
