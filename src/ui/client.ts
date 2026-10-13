import { DECISION_ENDPOINT, KEEP_ALIVE_SECONDS } from "../decision/contract.ts";
import { isPlainObject } from "../decision/json.ts";
import type {
  ChoiceAnswer,
  ConnectionKind,
  DecisionFailure,
  DecisionResponse,
  DecisionSuccess,
  KeepAliveSeconds,
  NoulAnswer,
  ScoreAnswer,
  WarmResponse,
  WarmSuccess,
} from "../decision/contract.ts";

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

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === "number");
}

function isNoulAnswer(
  value: Record<string, unknown>,
): value is Record<string, unknown> & NoulAnswer {
  return value.type === "noul" && typeof value.noul === "number";
}

function isChoiceAnswer(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ChoiceAnswer {
  return (
    value.type === "choice" &&
    typeof value.choice === "string" &&
    typeof value.confidence === "number" &&
    isNumberRecord(value.probabilities)
  );
}

function isScoreAnswer(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ScoreAnswer {
  return (
    value.type === "score" &&
    typeof value.score === "number" &&
    typeof value.confidence === "number" &&
    isPlainObject(value.legend) &&
    isNumberRecord(value.probabilities)
  );
}

function isAnswer(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    (value.type === "refusal" ||
      isNoulAnswer(value) ||
      isChoiceAnswer(value) ||
      isScoreAnswer(value))
  );
}

function isConnectionKind(value: unknown): value is ConnectionKind {
  return value === "new" || value === "reused";
}

export function isKeepAliveSeconds(value: unknown): value is KeepAliveSeconds {
  return KEEP_ALIVE_SECONDS.some((seconds) => seconds === value);
}

function isDecisionFailure(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DecisionFailure {
  return (
    value.ok === false &&
    typeof value.error === "string" &&
    (value.detail === undefined || typeof value.detail === "string")
  );
}

function isDecisionSuccess(
  value: Record<string, unknown>,
): value is Record<string, unknown> & DecisionSuccess {
  const { usage, answers } = value;
  return (
    value.ok === true &&
    (value.primitive === "noul" || value.primitive === "choice" || value.primitive === "score") &&
    typeof value.model === "string" &&
    typeof value.latencyMs === "number" &&
    isConnectionKind(value.connection) &&
    isKeepAliveSeconds(value.keepAliveSeconds) &&
    isPlainObject(usage) &&
    typeof usage.input_tokens === "number" &&
    typeof usage.output_tokens === "number" &&
    isPlainObject(answers) &&
    Object.values(answers).every(isAnswer)
  );
}

/** Checks the shape of a parsed body against the `DecisionResponse` contract. */
export function isDecisionResponse(value: unknown): value is DecisionResponse {
  return isPlainObject(value) && (isDecisionSuccess(value) || isDecisionFailure(value));
}

function isWarmSuccess(
  value: Record<string, unknown>,
): value is Record<string, unknown> & WarmSuccess {
  return (
    value.ok === true &&
    typeof value.latencyMs === "number" &&
    isConnectionKind(value.connection) &&
    isKeepAliveSeconds(value.keepAliveSeconds)
  );
}

/** Checks the shape of a parsed body against the `WarmResponse` contract. */
export function isWarmResponse(value: unknown): value is WarmResponse {
  return isPlainObject(value) && (isWarmSuccess(value) || isDecisionFailure(value));
}
