/**
 * Request/response contract between the browser UI and the `/api/jev` endpoint.
 *
 * The browser never talks to TypeSafe directly: the API key stays on the server.
 * Each panel in the UI targets exactly one primitive, so the request names the
 * primitive once and every question in it is built with that primitive.
 *
 * Grammar source: https://docs.typesafe.ai/api.md and the `@typesafe-ai/sdk`
 * `noul()`, `choice()`, and `score()` builders.
 */

/** Any JSON value; used for nested content inside structured state and questions. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * What TypeSafe accepts as `state`, `instructions`, or a criteria description:
 * text, an object, or an array. Bare numbers, booleans, and null are rejected at the top level.
 */
export type Content = string | JsonValue[] | { [key: string]: JsonValue };

export type Primitive = "noul" | "choice" | "score";

/** Optional clarification of what a yes and a no mean for a Noul question. */
export type NoulCriteria = {
  true?: Content;
  false?: Content;
};

/** Option name mapped to its description (or null for an undescribed option). Up to 255 options. */
export type ChoiceCriteria = Record<string, Content | null>;

/** Ordered level descriptions, index 0 first. Between two and ten entries; null leaves a level undescribed. */
export type ScoreCriteria = [Content | null, Content | null, ...(Content | null)[]];

export type CriteriaByPrimitive = {
  noul: NoulCriteria;
  choice: ChoiceCriteria;
  score: ScoreCriteria;
};

/** One question as typed into a panel. `criteria` may be omitted to inherit the request-level default. */
export type QuestionInput<P extends Primitive> = {
  instructions: Content;
  criteria?: CriteriaByPrimitive[P];
};

/**
 * The JSON document a panel textarea holds and posts to `/api/jev`.
 *
 * - `state`: what the model evaluates.
 * - `criteria`: default criteria applied to every question that omits its own.
 *   Choice and Score questions must end up with criteria from one of the two places.
 * - `questions`: at least one question, keyed by an id of your choosing.
 */
export type DecisionRequest<P extends Primitive = Primitive> = {
  primitive: P;
  state: Content;
  criteria?: CriteriaByPrimitive[P];
  questions: Record<string, QuestionInput<P>>;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, Content | null>;
  probabilities: Record<string, number>;
};

/**
 * The model declined to answer this question. It carries no probabilities, so
 * it has no primitive of its own and can stand in for any primitive's answer.
 */
export type RefusalAnswer = {
  type: "refusal";
};

export type AnswerByPrimitive = {
  noul: NoulAnswer;
  choice: ChoiceAnswer;
  score: ScoreAnswer;
};

/**
 * Whether the server opened a connection to TypeSafe while answering (`new`:
 * TCP and TLS handshakes included in the latency) or sent the request over an
 * idle connection kept from an earlier call (`reused`).
 */
export type ConnectionKind = "new" | "reused";

/** How long, in seconds, the server may keep an idle connection to TypeSafe open. 4 is Node's default. */
export const KEEP_ALIVE_SECONDS = [4, 30, 60] as const;

export type KeepAliveSeconds = (typeof KEEP_ALIVE_SECONDS)[number];

/** The keep-alive the server starts with: Node's own default. */
export const DEFAULT_KEEP_ALIVE_SECONDS: KeepAliveSeconds = 4;

export type DecisionSuccess<P extends Primitive = Primitive> = {
  ok: true;
  primitive: P;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  /** Wall-clock milliseconds the server spent waiting on TypeSafe. */
  latencyMs: number;
  connection: ConnectionKind;
  /** The keep-alive the server's connection to TypeSafe had when it answered. */
  keepAliveSeconds: KeepAliveSeconds;
  answers: Record<string, AnswerByPrimitive[P] | RefusalAnswer>;
};

export type DecisionFailure = {
  ok: false;
  /** Short, user-facing explanation of what went wrong and how to fix it. */
  error: string;
  /** Extra detail such as an upstream status code or validation path. */
  detail?: string;
};

export type DecisionResponse<P extends Primitive = Primitive> =
  | DecisionSuccess<P>
  | DecisionFailure;

export const DECISION_ENDPOINT = "/api/jev";

/** The JSON body `POST /api/jev/warm` accepts. */
export type WarmRequest = {
  keepAliveSeconds: KeepAliveSeconds;
};

export type WarmSuccess = {
  ok: true;
  /** Wall-clock milliseconds the warming call to TypeSafe took. */
  latencyMs: number;
  connection: ConnectionKind;
  keepAliveSeconds: KeepAliveSeconds;
};

export type WarmResponse = WarmSuccess | DecisionFailure;

/**
 * `POST /api/jev/warm`: sets the keep-alive and opens a connection to TypeSafe
 * with a call that costs no tokens, so the next run skips the handshakes.
 */
export const WARM_ENDPOINT = "/api/jev/warm";
