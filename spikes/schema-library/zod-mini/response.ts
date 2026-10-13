/**
 * Schema 3 in Zod Mini: the server's `DecisionResponse` as the browser checks it
 * in `src/ui/client.ts`, plus the refusal answer PR #30 added to the
 * contract. The browser only needs a yes/no, so `z.validate` (a type guard
 * exported from `zod/mini`, see node_modules/zod/v4/core/parse.d.ts) stands in
 * for today's `isDecisionResponse`.
 *
 * One success schema per primitive keeps `primitive` and the answer type
 * correlated, as `DecisionSuccess<P>` does in `src/decision/contract.ts`.
 */

import * as z from "zod/mini";
import { KEEP_ALIVE_SECONDS } from "../../../src/decision/contract.ts";
import { description } from "./request.ts";

const noulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });
const choiceAnswer = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});
const scoreAnswer = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  legend: z.record(z.string(), description()),
  probabilities: z.record(z.string(), z.number()),
});
/** The model declined to answer; it carries no probabilities and fits any primitive. */
const refusalAnswer = z.object({ type: z.literal("refusal") });

function successFor<TPrimitive extends string, TAnswer extends z.core.$ZodTypeDiscriminable>(
  primitive: TPrimitive,
  answer: TAnswer,
) {
  return z.object({
    ok: z.literal(true),
    primitive: z.literal(primitive),
    model: z.string(),
    usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
    latencyMs: z.number(),
    connection: z.enum(["new", "reused"]),
    keepAliveSeconds: z.literal(KEEP_ALIVE_SECONDS),
    answers: z.record(z.string(), z.discriminatedUnion("type", [answer, refusalAnswer])),
  });
}

const failure = z.object({
  ok: z.literal(false),
  error: z.string(),
  detail: z.exactOptional(z.string()),
});

export const decisionResponse = z.discriminatedUnion("ok", [
  z.discriminatedUnion("primitive", [
    successFor("noul", noulAnswer),
    successFor("choice", choiceAnswer),
    successFor("score", scoreAnswer),
  ]),
  failure,
]);

export type DecisionResponse = z.output<typeof decisionResponse>;

/** Drop-in for `isDecisionResponse` in `src/ui/client.ts`. */
export function isDecisionResponse(value: unknown): value is DecisionResponse {
  return z.validate(decisionResponse, value);
}

/** The first issue's dot path and message, for the comparison table. */
export function describeResponseParse(input: unknown) {
  const result = decisionResponse.safeParse(input);
  if (result.success) return { success: true as const };
  const [issue] = result.error.issues;
  return {
    success: false as const,
    path: issue.path.map(String).join("."),
    message: issue.message,
  };
}
