/**
 * Compile-time proof that the types inferred from the schemas equal the
 * contract as it was written by hand before the move to Zod Mini (ADR-0004).
 *
 * This file has no runtime behaviour and nothing imports it. `tsc` (run by
 * `vp check` and `vp run build`) fails unless every `Equal` below is `true`.
 * The assertions are the spike's (`spikes/schema-library/types.ts` on the
 * branch `issue-31-schema-library-spike`), applied to the migrated types, plus
 * the response types that are now inferred too. The `Reference` types are the
 * hand-written contract from `src/decision/contract.ts` before the migration,
 * copied unchanged, so a schema change that alters a type fails here. The one
 * deliberate change since: `POST /api/decide/{provider}` (#8) replaced the
 * success's `connection` and `keepAliveSeconds` with `provider` and `wire`.
 */

import type * as z from "zod/mini";
import type {
  Content,
  DecisionFailure,
  DecisionRequest,
  DecisionSuccess,
  JsonValue,
  Primitive,
  RefusalAnswer,
  ScoreAnswer,
  WarmResponse,
  decisionResponseSchema,
  warmResponseSchema,
} from "./contract.ts";
import type { PRIMITIVES, ValidDecisionRequest } from "./validate.ts";

/** `true` only when `A` and `B` are the same type in both directions, with no `any` leak. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless every member of the tuple is `true`. */
type Assert<T extends true[]> = T;

// --- The hand-written contract before the migration -----------------------------------

type ReferenceJsonValue =
  | string
  | number
  | boolean
  | null
  | ReferenceJsonValue[]
  | { [key: string]: ReferenceJsonValue };
type ReferenceContent = string | ReferenceJsonValue[] | { [key: string]: ReferenceJsonValue };
type ReferencePrimitive = "noul" | "choice" | "score";
type ReferenceNoulCriteria = { true?: ReferenceContent; false?: ReferenceContent };
type ReferenceChoiceCriteria = Record<string, ReferenceContent | null>;
type ReferenceScoreCriteria = [
  ReferenceContent | null,
  ReferenceContent | null,
  ...(ReferenceContent | null)[],
];
type ReferenceCriteriaByPrimitive = {
  noul: ReferenceNoulCriteria;
  choice: ReferenceChoiceCriteria;
  score: ReferenceScoreCriteria;
};
type ReferenceQuestionInput<P extends ReferencePrimitive> = {
  instructions: ReferenceContent;
  criteria?: ReferenceCriteriaByPrimitive[P];
};
type ReferenceDecisionRequest<P extends ReferencePrimitive = ReferencePrimitive> = {
  primitive: P;
  state: ReferenceContent;
  criteria?: ReferenceCriteriaByPrimitive[P];
  questions: Record<string, ReferenceQuestionInput<P>>;
};
type ReferenceValidDecisionRequest = {
  [P in ReferencePrimitive]: ReferenceDecisionRequest<P>;
}[ReferencePrimitive];

type ReferenceNoulAnswer = { type: "noul"; noul: number };
type ReferenceChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};
type ReferenceScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  legend: Record<string, ReferenceContent | null>;
  probabilities: Record<string, number>;
};
type ReferenceRefusalAnswer = { type: "refusal" };
type ReferenceAnswerByPrimitive = {
  noul: ReferenceNoulAnswer;
  choice: ReferenceChoiceAnswer;
  score: ReferenceScoreAnswer;
};
type ReferenceKeepAliveSeconds = 4 | 30 | 60;
type ReferenceDecisionSuccess<P extends ReferencePrimitive = ReferencePrimitive> = {
  ok: true;
  primitive: P;
  provider: "typesafe" | "subq" | "openai";
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latencyMs: number;
  answers: Record<string, ReferenceAnswerByPrimitive[P] | ReferenceRefusalAnswer>;
  wire: { request: Record<string, ReferenceJsonValue>; response: ReferenceJsonValue };
};
type ReferenceDecisionFailure = { ok: false; error: string; detail?: string };
type ReferenceWarmSuccess = {
  ok: true;
  latencyMs: number;
  connection: "new" | "reused";
  keepAliveSeconds: ReferenceKeepAliveSeconds;
};

/**
 * The response as a union discriminated on `primitive`, which is what the schema
 * infers. `DecisionSuccess<Primitive>` is wider: its `answers` admit every answer
 * type under every primitive, so the two are compared member by member.
 */
type ReferenceResponseUnion =
  | { [P in ReferencePrimitive]: ReferenceDecisionSuccess<P> }[ReferencePrimitive]
  | ReferenceDecisionFailure;

// --- The request ------------------------------------------------------------------------

/** `DecisionRequest<P>` as the spike wrote it: the member of the inferred union for `P`. */
type RequestFor<P extends Primitive> = Extract<ValidDecisionRequest, { primitive: P }>;

export type RequestAssertions = Assert<
  [
    // The spike's assertions. The whole union equals the hand-written validator's output type.
    Equal<ValidDecisionRequest, ReferenceValidDecisionRequest>,
    // Each member equals the hand-written generic at that primitive.
    Equal<RequestFor<"noul">, ReferenceDecisionRequest<"noul">>,
    Equal<RequestFor<"choice">, ReferenceDecisionRequest<"choice">>,
    Equal<RequestFor<"score">, ReferenceDecisionRequest<"score">>,
    // The leaf types survive the recursive JSON schema.
    Equal<RequestFor<"noul">["state"], ReferenceContent>,
    Equal<Extract<RequestFor<"noul">["state"], unknown[]>[number], ReferenceJsonValue>,

    // The exported generic equals that member at each primitive, and the old wide type at the default.
    Equal<DecisionRequest<"noul">, RequestFor<"noul">>,
    Equal<DecisionRequest<"choice">, RequestFor<"choice">>,
    Equal<DecisionRequest<"score">, RequestFor<"score">>,
    Equal<DecisionRequest, ReferenceDecisionRequest>,
    Equal<Content, ReferenceContent>,
    Equal<JsonValue, ReferenceJsonValue>,
    Equal<Primitive, ReferencePrimitive>,
    Equal<(typeof PRIMITIVES)[number], Primitive>,
  ]
>;

// --- The responses ----------------------------------------------------------------------

type InferredResponse = z.output<typeof decisionResponseSchema>;

export type ResponseAssertions = Assert<
  [
    // The spike's assertions.
    Equal<InferredResponse, ReferenceResponseUnion>,
    // The answer-by-primitive mapping is recoverable from the union.
    Equal<
      Extract<InferredResponse, { primitive: "score" }>["answers"][string],
      ScoreAnswer | RefusalAnswer
    >,
    Equal<ScoreAnswer | RefusalAnswer, ReferenceScoreAnswer | ReferenceRefusalAnswer>,

    // The exported types, now inferred, equal the hand-written ones.
    Equal<DecisionSuccess<"noul">, Extract<InferredResponse, { primitive: "noul" }>>,
    Equal<DecisionSuccess<"choice">, Extract<InferredResponse, { primitive: "choice" }>>,
    Equal<DecisionSuccess<"score">, Extract<InferredResponse, { primitive: "score" }>>,
    Equal<DecisionSuccess, ReferenceDecisionSuccess>,
    Equal<DecisionFailure, ReferenceDecisionFailure>,
    Equal<WarmResponse, ReferenceWarmSuccess | ReferenceDecisionFailure>,
    Equal<z.output<typeof warmResponseSchema>, WarmResponse>,
  ]
>;
