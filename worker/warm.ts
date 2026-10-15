/**
 * `POST /api/warm/{provider}`: opens a connection to one provider ahead of a
 * run, with a call that costs no tokens, so the run after it can skip the TCP
 * and TLS handshakes.
 *
 * Only a host that passes a connection pool (`deps.connections`) can warm,
 * because only it can set the keep-alive and tell a new connection from a
 * reused one. That is the Node dev host. The Worker passes no pool, so this
 * route answers 501 there (ADR-0002).
 *
 * The route checks, in order: that the host has a pool (501), that the
 * provider exists (404), that its key is set (409, naming the variable), that
 * its descriptor declares a warm path (404), the content type (415), the body
 * size (413), and the body itself (400). Only then does it set the pool's
 * keep-alive and send one GET to the warm path, through `fetchJson`, which is
 * the only code that touches the key. Nothing is retried.
 */

import { validateWarmRequest } from "../src/decision/validate.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import type { ProviderKeys } from "./env.ts";
import type { HandlerDeps } from "./handler.ts";
import { ProviderError, failureFromStatus, fetchJson, isSuccess } from "./providers/adapter.ts";
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
 * How long the warming call may take before its signal aborts it. It is one
 * small GET, so it gets less time than a decision; the browser still waits
 * 30 seconds, so this route's 504 reaches the status line first.
 */
export const WARM_TIMEOUT_MS = 10_000;

/** The largest body the route reads. Its one field, `keepAliveSeconds`, needs a few bytes. */
export const MAX_WARM_BODY_BYTES = 1024;

/** What the Worker answers, because it cannot see or keep its connections to providers. */
export const WARM_UNAVAILABLE_MESSAGE =
  "Warming a connection works only on the Node dev host (vp dev), because this host cannot see or keep its connections to providers.";

/** The URL a provider is warmed with, or undefined when its descriptor declares no warm path. */
export function warmUrl(provider: ProviderDescriptor): string | undefined {
  return provider.warmPath === undefined ? undefined : `${provider.baseUrl}${provider.warmPath}`;
}

/** The parsed body, or the refusal to send instead. Only JSON is accepted. */
async function readWarmRequest(request: Request): Promise<Read> {
  if (mediaTypeOf(request.headers.get("content-type")) !== JSON_TYPE) {
    return refuse(415, `Send the request as ${JSON_TYPE}, holding "keepAliveSeconds".`);
  }
  const bytes = await readWithin(request, MAX_WARM_BODY_BYTES);
  if (bytes === undefined) {
    return refuse(
      413,
      `The request is too large. It holds only "keepAliveSeconds", in under ${MAX_WARM_BODY_BYTES / 1024} KB.`,
    );
  }
  const text = decodeUtf8(bytes);
  return text === undefined ? refuse(400, "The request body is not valid UTF-8.") : parseJson(text);
}

/**
 * The error to answer with. `fetchJson`'s timeout message is worded for a
 * decision ("ask fewer questions"), so a timeout is reworded for this call.
 */
function warmError(provider: ProviderDescriptor, error: ProviderError): ProviderError {
  if (error.kind !== "timeout") return error;
  return new ProviderError(
    "timeout",
    `${provider.displayName} did not answer the warming call within ${WARM_TIMEOUT_MS / 1000} seconds. Try again.`,
  );
}

/** Answers `POST /api/warm/{providerId}`; `providerId` is the raw path segment. */
export async function warm(
  providerId: string,
  request: Request,
  env: ProviderKeys,
  deps: HandlerDeps,
): Promise<Response> {
  const { connections } = deps;
  if (connections === undefined) {
    return failure(501, WARM_UNAVAILABLE_MESSAGE);
  }
  const resolved = resolveProvider(providerId, env);
  if (!resolved.ok) return resolved.response;
  const { provider, apiKey } = resolved;
  const url = warmUrl(provider);
  if (url === undefined) {
    return failure(404, `${provider.displayName} has no call to warm a connection with.`);
  }

  const read = await readWarmRequest(request);
  if (!read.ok) return read.response;
  const validation = validateWarmRequest(read.value);
  if (!validation.ok) {
    return failure(400, validation.error, { detail: validation.detail });
  }

  // A new keep-alive replaces the pool's agent, so the call below opens a connection with it.
  // That is also why a warm that fails still leaves the new keep-alive in place: it has to be
  // set before the call, and the agent it replaced is already closing.
  connections.setKeepAlive(validation.value.keepAliveSeconds);
  const signal = deps.timeoutSignal(WARM_TIMEOUT_MS);
  const tracked = connections.track(provider.baseUrl);
  const startedAt = performance.now();
  try {
    const reply = await fetchJson(deps.fetch, signal, provider, apiKey, url, { method: "GET" });
    if (!isSuccess(reply.status)) throw failureFromStatus(provider, reply);
  } catch (thrown) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const connection = tracked.finish();
    const fields = { provider: provider.id, latencyMs, connection };
    if (thrown instanceof ProviderError) {
      const error = warmError(provider, thrown);
      const response = providerFailure(error);
      deps.log(
        logLine("warm", {
          ...fields,
          status: response.status,
          kind: error.kind,
          detail: error.detail,
        }),
      );
      return response;
    }
    // Not a provider failure, so a bug in this app: log its class name only, never its message.
    const name = thrown instanceof Error ? thrown.name : typeof thrown;
    deps.log(logLine("warm", { ...fields, status: 500, unexpected: name }));
    return failure(
      500,
      `Something went wrong on the server while warming ${provider.displayName}. Check the server log.`,
    );
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  const connection = tracked.finish();
  deps.log(logLine("warm", { provider: provider.id, status: 200, latencyMs, connection }));
  return json(
    {
      ok: true,
      provider: provider.id,
      latencyMs,
      connection,
      // What this request set, so a warm racing it cannot change what this reply says.
      keepAliveSeconds: validation.value.keepAliveSeconds,
    },
    200,
  );
}
