/**
 * `POST /api/decide/{provider}`: runs one decision request on one provider.
 *
 * The route checks, in order: that the provider exists (404), that its key is
 * set (409, naming the variable), the content type (415), the body size (413),
 * and the request itself (400, with the validator's own message and path).
 * Only then does it call the provider, once, through the adapter, with one
 * 25-second budget and no retry, and map a failure to one status per
 * `ProviderError` kind (`STATUS_FOR_KIND` in `provider-route.ts`). On a host
 * that passes a connection pool (the Node dev host), the success also says
 * which connection the call used and the pool's keep-alive.
 *
 * The route reads the key from `env` and hands it to the adapter's `decide`,
 * which passes it to `fetchJson` and nowhere else. No message here names a key
 * value: they name environment variable names, catalog ids, and display names.
 */

import type { DecisionSuccess } from "../src/decision/contract.ts";
import { validateDecisionRequest } from "../src/decision/validate.ts";
import type { ValidDecisionRequest } from "../src/decision/validate.ts";
import type { ProviderDescriptor, ProviderId } from "../src/providers/catalog.ts";
import { MAX_BODY_BYTES, tooLarge } from "./body-limit.ts";
import type { ProviderKeys } from "./env.ts";
import type { HandlerDeps, TrackedCall } from "./handler.ts";
import { ProviderError } from "./providers/adapter.ts";
import type { AdapterResult, ProviderAdapter } from "./providers/adapter.ts";
import { openaiAdapter } from "./providers/openai.ts";
import { subqAdapter } from "./providers/subq.ts";
import { typesafeAdapter } from "./providers/typesafe.ts";
import {
  JSON_TYPE,
  decodeUtf8,
  logLine,
  mediaTypeOf,
  parseJson,
  providerFailure,
  readWithin,
  refuse,
  resolveProvider,
} from "./provider-route.ts";
import type { Read } from "./provider-route.ts";
import { failure, json } from "./respond.ts";

/**
 * How long one provider call may take before its signal aborts it. Nothing is
 * retried: a decision spends tokens, so trying again is left to the user. The
 * browser waits 30 seconds (`REQUEST_TIMEOUT_MS` in `src/ui/client.ts`), so
 * this route's 504 always reaches the readout first.
 */
export const PROVIDER_TIMEOUT_MS = 25_000;

const MULTIPART_TYPE = "multipart/form-data";

/** The adapter for each provider. Adding a provider to the catalog without one is a type error. */
const ADAPTERS: Readonly<Record<ProviderId, ProviderAdapter>> = {
  typesafe: typesafeAdapter,
  subq: subqAdapter,
  openai: openaiAdapter,
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
// The provider's reply, for display
// ---------------------------------------------------------------------------

/**
 * How many levels of arrays and objects a provider reply may nest and still be
 * shown. The browser checks the whole success with a recursive schema, which
 * throws near 5,000 levels, and `json()` throws past about 8,000. The answers
 * are valid in those cases, so only the display copy is replaced.
 */
export const MAX_WIRE_DEPTH = 64;

/**
 * The most serialised text of a provider reply the wire view shows, 256 KiB.
 * A larger reply would freeze the tab while it is laid out, and nobody can read
 * it there anyway.
 */
export const MAX_WIRE_RESPONSE_CHARACTERS = 256 * 1024;

/** True when `value` nests arrays or objects more than `limit` levels deep. Iterative, so depth cannot overflow the stack. */
function nestsDeeperThan(value: unknown, limit: number): boolean {
  const pending: { node: unknown; depth: number }[] = [{ node: value, depth: 0 }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { node, depth } = next;
    if (typeof node !== "object" || node === null) continue;
    if (depth + 1 > limit) return true;
    for (const child of Object.values(node)) pending.push({ node: child, depth: depth + 1 });
  }
  return false;
}

/**
 * The provider's reply as the success carries it: the reply itself, or a
 * placeholder string that says which limit it hit, so one odd reply can never
 * stop the answers from arriving. The depth is checked first, because only a
 * body within the depth limit is safe to serialise for its size.
 */
export function displayableResponse(response: unknown): unknown {
  if (nestsDeeperThan(response, MAX_WIRE_DEPTH)) {
    return `<provider reply not shown: nested more than ${MAX_WIRE_DEPTH} levels>`;
  }
  const characters = JSON.stringify(response)?.length ?? 0;
  if (characters > MAX_WIRE_RESPONSE_CHARACTERS) {
    return `<provider reply not shown: ${formatBytes(characters)}, over the ${formatBytes(MAX_WIRE_RESPONSE_CHARACTERS)} display limit>`;
  }
  return response;
}

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

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

/**
 * Which connection a finished call used and the pool's keep-alive, or no
 * fields at all on a host without a connection pool (the Worker), so the
 * success there carries neither.
 */
function connectionFields(
  deps: HandlerDeps,
  tracked: TrackedCall | undefined,
): Pick<DecisionSuccess, "connection" | "keepAliveSeconds"> {
  if (deps.connections === undefined || tracked === undefined) return {};
  return { connection: tracked.finish(), keepAliveSeconds: deps.connections.keepAliveSeconds };
}

/** Answers `POST /api/decide/{providerId}`; `providerId` is the raw path segment. */
export async function decide(
  providerId: string,
  request: Request,
  env: ProviderKeys,
  deps: HandlerDeps,
): Promise<Response> {
  const resolved = resolveProvider(providerId, env);
  if (!resolved.ok) return resolved.response;
  const { provider, apiKey } = resolved;
  const adapter = ADAPTERS[provider.id];

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
  const tracked = deps.connections?.track(provider.baseUrl);
  const startedAt = performance.now();
  let decision: AdapterResult;
  try {
    decision = await adapter.decide(valid, apiKey, signal, deps.fetch);
  } catch (thrown) {
    const latencyMs = Math.round(performance.now() - startedAt);
    tracked?.finish();
    if (thrown instanceof ProviderError) {
      const response = providerFailure(thrown);
      deps.log(
        logLine("decide", {
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
    deps.log(logLine("decide", { ...fields, status: 500, latencyMs, unexpected: name }));
    return failure(
      500,
      `Something went wrong on the server while asking ${provider.displayName}. Check the server log.`,
    );
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  const connection = connectionFields(deps, tracked);
  deps.log(logLine("decide", { ...fields, status: 200, latencyMs, ...connection }));
  const body: DecisionSuccessBody = {
    ok: true,
    primitive: valid.primitive,
    provider: provider.id,
    model: decision.model,
    usage: decision.usage,
    latencyMs,
    ...connection,
    answers: decision.answers,
    wire: { ...wireRecord(adapter, valid), response: displayableResponse(decision.wire.response) },
  };
  return json(body, 200);
}
