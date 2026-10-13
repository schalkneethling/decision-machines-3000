/**
 * Schema 3 in Valibot: the server's `DecisionResponse` as the browser checks it
 * in `src/ui/client.ts`, plus the refusal answer PR #30 added to the
 * contract. The browser only needs a yes/no, so `v.is` stands in for today's
 * `isDecisionResponse` type guard.
 *
 * One success schema per primitive keeps `primitive` and the answer type
 * correlated, as `DecisionSuccess<P>` does in `src/decision/contract.ts`.
 */

import * as v from "valibot";
import { KEEP_ALIVE_SECONDS } from "../../../src/decision/contract.ts";
import { description } from "./request.ts";

const noulAnswer = v.object({ type: v.literal("noul"), noul: v.number() });
const choiceAnswer = v.object({
  type: v.literal("choice"),
  choice: v.string(),
  confidence: v.number(),
  probabilities: v.record(v.string(), v.number()),
});
const scoreAnswer = v.object({
  type: v.literal("score"),
  score: v.number(),
  confidence: v.number(),
  legend: v.record(v.string(), description),
  probabilities: v.record(v.string(), v.number()),
});
/** The model declined to answer; it carries no probabilities and fits any primitive. */
const refusalAnswer = v.object({ type: v.literal("refusal") });

function successFor<TPrimitive extends string, TAnswer extends v.VariantOptions<"type">[number]>(
  primitive: TPrimitive,
  answer: TAnswer,
) {
  return v.object({
    ok: v.literal(true),
    primitive: v.literal(primitive),
    model: v.string(),
    usage: v.object({ input_tokens: v.number(), output_tokens: v.number() }),
    latencyMs: v.number(),
    connection: v.picklist(["new", "reused"]),
    keepAliveSeconds: v.picklist(KEEP_ALIVE_SECONDS),
    // `variant` rather than `union`, so an unknown answer type is reported at `….type`.
    answers: v.record(v.string(), v.variant("type", [answer, refusalAnswer])),
  });
}

const failure = v.object({
  ok: v.literal(false),
  error: v.string(),
  detail: v.exactOptional(v.string()),
});

export const decisionResponse = v.variant("ok", [
  v.variant("primitive", [
    successFor("noul", noulAnswer),
    successFor("choice", choiceAnswer),
    successFor("score", scoreAnswer),
  ]),
  failure,
]);

export type DecisionResponse = v.InferOutput<typeof decisionResponse>;

/** Drop-in for `isDecisionResponse` in `src/ui/client.ts`. */
export function isDecisionResponse(value: unknown): value is DecisionResponse {
  return v.is(decisionResponse, value);
}

/** The first issue's dot path and message, for the comparison table. */
export function describeResponseParse(input: unknown) {
  const result = v.safeParse(decisionResponse, input);
  if (result.success) return { success: true as const };
  const [issue] = result.issues;
  return { success: false as const, path: v.getDotPath(issue) ?? "", message: issue.message };
}
