import * as z from "zod/mini";
import {
  KEEP_ALIVE_SECONDS,
  decideEndpoint,
  decisionResponseSchema,
  warmResponseSchema,
} from "../decision/contract.ts";
import type { DecisionResponse, KeepAliveSeconds, WarmResponse } from "../decision/contract.ts";
import type { ProviderId } from "../providers/catalog.ts";
import { PROVIDERS_ENDPOINT, providersResponseSchema } from "../providers/contract.ts";
import type { ProvidersResponse } from "../providers/contract.ts";

export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Everything a request to one of the `/api` endpoints can end in, so the caller renders each case explicitly:
 * - `response`: a JSON body in the expected shape, a success or a failure, with the HTTP status it came with.
 * - `unrecognised`: a JSON body in another shape.
 * - `non_json`: an answer whose body is not JSON, such as a proxy's HTML error page.
 * - `unreachable`: no answer arrived at all, because `fetch` rejected.
 * - `timeout`: no answer arrived in time.
 */
export type ApiResult<T> =
  | { kind: "response"; status: number; response: T }
  | { kind: "unrecognised"; status: number }
  | { kind: "non_json"; status: number }
  | { kind: "unreachable"; detail?: string }
  | { kind: "timeout" };

/** Everything a run can end in. */
export type AskResult = ApiResult<DecisionResponse>;

/** Everything `GET /api/providers` can end in. */
export type ProvidersResult = ApiResult<ProvidersResponse>;

/**
 * Runs the shape check. A check that throws, such as Zod's recursion running out
 * of stack on a deeply nested body, means the body is not in the expected shape;
 * it must not be mistaken for a network failure.
 */
function isCheckedAs<T>(isExpected: (value: unknown) => value is T, value: unknown): value is T {
  try {
    return isExpected(value);
  } catch {
    return false;
  }
}

/**
 * Sends one request to `endpoint` and checks the JSON body with `isExpected`.
 * Never rejects: network failures, timeouts, and unexpected bodies become results.
 */
async function requestJson<T>(
  endpoint: string,
  init: Omit<RequestInit, "signal">,
  isExpected: (value: unknown) => value is T,
  timeoutMs: number,
): Promise<ApiResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(endpoint, { ...init, signal: controller.signal });
    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "non_json", status: response.status };
    }

    if (!isCheckedAs(isExpected, parsed)) {
      return { kind: "unrecognised", status: response.status };
    }

    return { kind: "response", status: response.status, response: parsed };
  } catch (error) {
    if (timedOut) {
      return { kind: "timeout" };
    }
    return { kind: "unreachable", detail: error instanceof Error ? error.message : undefined };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What a POST carries: JSON text, sent unchanged and declared as such, or a
 * `FormData`, for which no Content-Type is set here. MDN (Using FormData
 * Objects) warns that a hand-set header would stop the browser from writing
 * `multipart/form-data` with the boundary it needs, so the browser sets it.
 */
export type PostBody = string | FormData;

/** POSTs `body` to `endpoint` and checks the JSON answer with `isExpected`. Never rejects. */
export function post<T>(
  endpoint: string,
  body: PostBody,
  isExpected: (value: unknown) => value is T,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ApiResult<T>> {
  const init: Omit<RequestInit, "signal"> =
    typeof body === "string"
      ? { method: "POST", headers: { "content-type": "application/json" }, body }
      : { method: "POST", body };
  return requestJson(endpoint, init, isExpected, timeoutMs);
}

/** POSTs JSON text, unchanged, to `endpoint` and checks the body with `isExpected`. Never rejects. */
export function postJson<T>(
  endpoint: string,
  body: string,
  isExpected: (value: unknown) => value is T,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ApiResult<T>> {
  return post(endpoint, body, isExpected, timeoutMs);
}

/** Asks the server which providers this instance has a key for. Never rejects. */
export function getProviders(timeoutMs = REQUEST_TIMEOUT_MS): Promise<ProvidersResult> {
  return requestJson(PROVIDERS_ENDPOINT, { method: "GET" }, isProvidersResponse, timeoutMs);
}

/**
 * POSTs a panel's request to the decide route of `providerId`: its JSON text,
 * unchanged, or the multipart form that carries that text and the images. Never rejects.
 */
export function askProvider(
  providerId: ProviderId,
  body: PostBody,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<AskResult> {
  return post(decideEndpoint(providerId), body, isDecisionResponse, timeoutMs);
}

export function isKeepAliveSeconds(value: unknown): value is KeepAliveSeconds {
  return KEEP_ALIVE_SECONDS.some((seconds) => seconds === value);
}

/** Checks the shape of a parsed body against the `DecisionResponse` schema, refusals included. */
export function isDecisionResponse(value: unknown): value is DecisionResponse {
  return z.validate(decisionResponseSchema, value);
}

/** Checks the shape of a parsed body against the `WarmResponse` schema. */
export function isWarmResponse(value: unknown): value is WarmResponse {
  return z.validate(warmResponseSchema, value);
}

/** Checks the shape of a parsed body against the `ProvidersResponse` schema. */
export function isProvidersResponse(value: unknown): value is ProvidersResponse {
  return z.validate(providersResponseSchema, value);
}
