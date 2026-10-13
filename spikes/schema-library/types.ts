/**
 * Compile-time evidence for the Types row of the comparison. This file has no
 * runtime behaviour: `vp exec tsc -p spikes/schema-library/tsconfig.json`
 * passes only if every `Equal` below holds. Each assertion compares a type
 * inferred from a schema with the hand-written type in
 * `src/decision/contract.ts`.
 */

import type * as v from "valibot";
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
} from "../../src/decision/contract.ts";
import type { ValidDecisionRequest as ReferenceValidDecisionRequest } from "../../src/decision/validate.ts";
import type { DecisionRequestSchema as ValibotRequestSchema } from "./valibot/request.ts";
import type { decisionResponse as valibotResponse } from "./valibot/response.ts";
import type { DecisionRequestSchema as ZodRequestSchema } from "./zod-mini/request.ts";
import type { decisionResponse as zodResponse } from "./zod-mini/response.ts";

/** `true` only when `A` and `B` are the same type in both directions, with no `any` leak. */
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Fails to compile unless every member of the tuple is `true`. */
type Assert<T extends true[]> = T;

/**
 * `DecisionResponse` as a union discriminated on `primitive`, which is what a schema
 * infers. `DecisionResponse<Primitive>` itself is wider: its `answers` admit every
 * answer type under every primitive, so the two are compared member by member.
 */
type ResponseUnion = { [P in Primitive]: DecisionSuccess<P> }[Primitive] | DecisionFailure;

// --- Schema 1: the request ------------------------------------------------------------

type ValibotRequest = v.InferOutput<ValibotRequestSchema>;
type ZodRequest = z.output<ZodRequestSchema>;

/** `DecisionRequest<P>` stays generic: pick the member of the inferred union by its primitive. */
type ValibotRequestFor<P extends Primitive> = Extract<ValibotRequest, { primitive: P }>;
type ZodRequestFor<P extends Primitive> = Extract<ZodRequest, { primitive: P }>;

export type RequestAssertions = Assert<
  [
    // The whole union equals the reference validator's output type.
    Equal<ValibotRequest, ReferenceValidDecisionRequest>,
    Equal<ZodRequest, ReferenceValidDecisionRequest>,
    // Each member equals the hand-written generic at that primitive.
    Equal<ValibotRequestFor<"noul">, DecisionRequest<"noul">>,
    Equal<ValibotRequestFor<"choice">, DecisionRequest<"choice">>,
    Equal<ValibotRequestFor<"score">, DecisionRequest<"score">>,
    Equal<ZodRequestFor<"noul">, DecisionRequest<"noul">>,
    Equal<ZodRequestFor<"choice">, DecisionRequest<"choice">>,
    Equal<ZodRequestFor<"score">, DecisionRequest<"score">>,
    // The leaf types survive the recursive JSON schema.
    Equal<ValibotRequestFor<"noul">["state"], Content>,
    Equal<ZodRequestFor<"noul">["state"], Content>,
    Equal<Extract<ValibotRequestFor<"noul">["state"], unknown[]>[number], JsonValue>,
    Equal<Extract<ZodRequestFor<"noul">["state"], unknown[]>[number], JsonValue>,
  ]
>;

// --- Schema 3: the response -----------------------------------------------------------

type ValibotResponse = v.InferOutput<typeof valibotResponse>;
type ZodResponse = z.output<typeof zodResponse>;

export type ResponseAssertions = Assert<
  [
    Equal<ValibotResponse, ResponseUnion>,
    Equal<ZodResponse, ResponseUnion>,
    // The answer-by-primitive mapping is recoverable from the union.
    Equal<
      Extract<ValibotResponse, { primitive: "score" }>["answers"][string],
      ScoreAnswer | RefusalAnswer
    >,
    Equal<
      Extract<ZodResponse, { primitive: "score" }>["answers"][string],
      ScoreAnswer | RefusalAnswer
    >,
  ]
>;
