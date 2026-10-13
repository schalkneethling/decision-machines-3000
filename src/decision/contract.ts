/**
 * Request/response contract between the browser UI and the `/api/jev` endpoint.
 *
 * The browser never talks to TypeSafe directly: the API key stays on the server.
 * Each panel in the UI targets exactly one primitive, so the request names the
 * primitive once and every question in it is built with that primitive.
 *
 * The shapes are Zod Mini schemas (ADR-0004), and every type below is inferred
 * from one, so a type cannot drift from the check that guards it. The request
 * schema lives in `validate.ts`, beside the wording of its messages; the
 * response schemas live here because they carry no wording of their own. The
 * constants (the keep-alive durations and the endpoints) stay hand-written.
 *
 * Grammar source: https://docs.typesafe.ai/api.md and the `@typesafe-ai/sdk`
 * `noul()`, `choice()`, and `score()` builders. Zod Mini APIs used, read from
 * node_modules/zod/v4/mini/schemas.d.ts: `json`, `union`, `array`, `record`,
 * `nullable`, `object`, `literal`, `enum`, `exactOptional`, and
 * `discriminatedUnion`; `output` from node_modules/zod/v4/mini/in-out.d.ts.
 */

import * as z from "zod/mini";
// A type-only import: the request schema imports this module's constants and
// `content` builder at run time, and this module only names its inferred type.
import type { ValidDecisionRequest } from "./validate.ts";

/** How long, in seconds, the server may keep an idle connection to TypeSafe open. 4 is Node's default. */
export const KEEP_ALIVE_SECONDS = [4, 30, 60] as const;

export type KeepAliveSeconds = (typeof KEEP_ALIVE_SECONDS)[number];

/** The keep-alive the server starts with: Node's own default. */
export const DEFAULT_KEEP_ALIVE_SECONDS: KeepAliveSeconds = 4;

export const DECISION_ENDPOINT = "/api/jev";

/**
 * `POST /api/jev/warm`: sets the keep-alive and opens a connection to TypeSafe
 * with a call that costs no tokens, so the next run skips the handshakes.
 */
export const WARM_ENDPOINT = "/api/jev/warm";

// ---------------------------------------------------------------------------
// Content: what TypeSafe accepts as state, instructions, or a description
// ---------------------------------------------------------------------------

/**
 * Text, an object, or a list, which is what TypeSafe accepts as `state`,
 * `instructions`, or a criteria description. Bare numbers, booleans, and null
 * are rejected at the top level. `error` words the failure for the place the
 * schema is used in; the request schema passes one, the response schemas do not.
 */
export function content(error?: z.core.$ZodErrorMap) {
  const json = z.json();
  return z.union([z.string(), z.array(json), z.record(z.string(), json)], { error });
}

/** A criteria description; `null` leaves the outcome undescribed. */
export function description(error?: z.core.$ZodErrorMap) {
  return z.nullable(content(error));
}

/** Any JSON value; used for nested content inside structured state and questions. */
export type JsonValue = z.output<z.ZodMiniJSONSchema>;

/** Text, an object, or a list. */
export type Content = z.output<ReturnType<typeof content>>;

// ---------------------------------------------------------------------------
// The request, inferred from the schema in validate.ts
// ---------------------------------------------------------------------------

export type Primitive = ValidDecisionRequest["primitive"];

/** One object type instead of an intersection, so it compares equal to an inferred object type. */
type Flatten<T> = { [K in keyof T]: T[K] };

/** The member of the schema's union for one primitive. */
type RequestMember<P extends Primitive> = Extract<ValidDecisionRequest, { primitive: P }>;

export type CriteriaByPrimitive = {
  [P in Primitive]: Exclude<RequestMember<P>["criteria"], undefined>;
};

/** One question as typed into a panel. `criteria` may be omitted to inherit the request-level default. */
export type QuestionInput<P extends Primitive> = Flatten<
  Omit<RequestMember<P>["questions"][string], "criteria"> & { criteria?: CriteriaByPrimitive[P] }
>;

/**
 * The JSON document a panel textarea holds and posts to `/api/jev`, for one primitive.
 *
 * - `state`: what the model evaluates.
 * - `criteria`: default criteria applied to every question that omits its own.
 *   Choice and Score questions must end up with criteria from one of the two places.
 * - `questions`: at least one question, keyed by an id of your choosing.
 *
 * At each primitive this equals `Extract<ValidDecisionRequest, { primitive: P }>`,
 * which `contract.type-check.ts` asserts. It is not written as that `Extract`,
 * because code that is generic over `P` (the composer's `buildModel`) must read
 * `criteria` as `CriteriaByPrimitive[P]`, and TypeScript resolves a property of
 * an `Extract` over a type parameter to the criteria of every primitive at once.
 */
export type DecisionRequest<P extends Primitive = Primitive> = Flatten<
  Omit<ValidDecisionRequest, "primitive" | "criteria" | "questions"> & {
    primitive: P;
    criteria?: CriteriaByPrimitive[P];
    questions: Record<string, QuestionInput<P>>;
  }
>;

/** Optional clarification of what a yes and a no mean for a Noul question. */
export type NoulCriteria = CriteriaByPrimitive["noul"];

/** Option name mapped to its description (or null for an undescribed option). */
export type ChoiceCriteria = CriteriaByPrimitive["choice"];

/** Ordered level descriptions, index 0 first, at least two; null leaves a level undescribed. */
export type ScoreCriteria = CriteriaByPrimitive["score"];

// ---------------------------------------------------------------------------
// The response
// ---------------------------------------------------------------------------

const noulAnswerSchema = z.object({ type: z.literal("noul"), noul: z.number() });

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  legend: z.record(z.string(), description()),
  probabilities: z.record(z.string(), z.number()),
});

/**
 * The model declined to answer this question. It carries no probabilities, so
 * it has no primitive of its own and can stand in for any primitive's answer.
 */
const refusalAnswerSchema = z.object({ type: z.literal("refusal") });

/**
 * Whether the server opened a connection to TypeSafe while answering (`new`:
 * TCP and TLS handshakes included in the latency) or sent the request over an
 * idle connection kept from an earlier call (`reused`).
 */
const connectionKindSchema = z.enum(["new", "reused"]);

const keepAliveSecondsSchema = z.literal(KEEP_ALIVE_SECONDS);

/** Built once, so the three success members share one `usage` type. */
const usageSchema = z.object({ input_tokens: z.number(), output_tokens: z.number() });

/** One success schema per primitive, so `primitive` decides which answers are allowed. */
function decisionSuccessFor<P extends Primitive, A extends z.core.$ZodTypeDiscriminable>(
  primitive: P,
  answer: A,
) {
  return z.object({
    ok: z.literal(true),
    primitive: z.literal(primitive),
    model: z.string(),
    usage: usageSchema,
    /** Wall-clock milliseconds the server spent waiting on TypeSafe. */
    latencyMs: z.number(),
    connection: connectionKindSchema,
    /** The keep-alive the server's connection to TypeSafe had when it answered. */
    keepAliveSeconds: keepAliveSecondsSchema,
    answers: z.record(z.string(), z.discriminatedUnion("type", [answer, refusalAnswerSchema])),
  });
}

const decisionSuccessSchema = z.discriminatedUnion("primitive", [
  decisionSuccessFor("noul", noulAnswerSchema),
  decisionSuccessFor("choice", choiceAnswerSchema),
  decisionSuccessFor("score", scoreAnswerSchema),
]);

const decisionFailureSchema = z.object({
  ok: z.literal(false),
  /** Short, user-facing explanation of what went wrong and how to fix it. */
  error: z.string(),
  /** Extra detail such as an upstream status code or validation path. */
  detail: z.exactOptional(z.string()),
});

/** What `POST /api/jev` answers: a success for one primitive, or a failure. */
export const decisionResponseSchema = z.discriminatedUnion("ok", [
  decisionSuccessSchema,
  decisionFailureSchema,
]);

const warmSuccessSchema = z.object({
  ok: z.literal(true),
  /** Wall-clock milliseconds the warming call to TypeSafe took. */
  latencyMs: z.number(),
  connection: connectionKindSchema,
  keepAliveSeconds: keepAliveSecondsSchema,
});

/** What `POST /api/jev/warm` answers. */
export const warmResponseSchema = z.discriminatedUnion("ok", [
  warmSuccessSchema,
  decisionFailureSchema,
]);

export type NoulAnswer = z.output<typeof noulAnswerSchema>;
export type ChoiceAnswer = z.output<typeof choiceAnswerSchema>;
export type ScoreAnswer = z.output<typeof scoreAnswerSchema>;
export type RefusalAnswer = z.output<typeof refusalAnswerSchema>;

export type AnswerByPrimitive = {
  noul: NoulAnswer;
  choice: ChoiceAnswer;
  score: ScoreAnswer;
};

export type ConnectionKind = z.output<typeof connectionKindSchema>;

/** The fields every success shares, whatever its primitive. */
type SharedSuccessFields = Omit<z.output<typeof decisionSuccessSchema>, "primitive" | "answers">;

/**
 * A successful answer for primitive `P`. At one primitive it equals that member
 * of the response schema. At the default, `Primitive`, it is the wider shape
 * the server builds before it knows which primitive it answered (any answer
 * type under any primitive), which `Extract` over the schema's union cannot
 * express, so only `primitive` and `answers` are spelled out here.
 */
export type DecisionSuccess<P extends Primitive = Primitive> = Flatten<
  SharedSuccessFields & {
    primitive: P;
    answers: Record<string, AnswerByPrimitive[P] | RefusalAnswer>;
  }
>;

export type DecisionFailure = z.output<typeof decisionFailureSchema>;

export type DecisionResponse<P extends Primitive = Primitive> =
  | DecisionSuccess<P>
  | DecisionFailure;

/** The JSON body `POST /api/jev/warm` accepts. `validateWarmRequest` checks it by hand. */
export type WarmRequest = {
  keepAliveSeconds: KeepAliveSeconds;
};

export type WarmSuccess = z.output<typeof warmSuccessSchema>;

export type WarmResponse = z.output<typeof warmResponseSchema>;
