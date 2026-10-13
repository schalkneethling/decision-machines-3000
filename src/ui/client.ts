import * as z from "zod/mini";
import {
  DECISION_ENDPOINT,
  KEEP_ALIVE_SECONDS,
  decisionResponseSchema,
  warmResponseSchema,
} from "../decision/contract.ts";
import type { DecisionResponse, KeepAliveSeconds, WarmResponse } from "../decision/contract.ts";

export const REQUEST_TIMEOUT_MS = 30_000;

/** Everything a POST to one of the decision endpoints can end in, so the caller renders each case explicitly. */
export type PostResult<T> =
  | { kind: "response"; response: T }
  | { kind: "unrecognised"; status: number }
  | { kind: "unreachable"; detail?: string }
  | { kind: "timeout" };

/** Everything a run can end in. */
export type AskResult = PostResult<DecisionResponse>;

/**
 * POSTs JSON text, unchanged, to `endpoint` and checks the body with `isExpected`.
 * Never rejects: network failures, timeouts, and unexpected bodies become results.
 */
export async function postJson<T>(
  endpoint: string,
  body: string,
  isExpected: (value: unknown) => value is T,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<PostResult<T>> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        kind: "unreachable",
        detail: `The endpoint answered with HTTP ${response.status} but the body was not JSON.`,
      };
    }

    if (!isExpected(parsed)) {
      return { kind: "unrecognised", status: response.status };
    }

    return { kind: "response", response: parsed };
  } catch (error) {
    if (timedOut) {
      return { kind: "timeout" };
    }
    return { kind: "unreachable", detail: error instanceof Error ? error.message : undefined };
  } finally {
    clearTimeout(timer);
  }
}

/** POSTs a panel's JSON text, unchanged, to the decision endpoint. Never rejects. */
export function askDecision(body: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<AskResult> {
  return postJson(DECISION_ENDPOINT, body, isDecisionResponse, timeoutMs);
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
