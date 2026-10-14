/**
 * TypeSafe Jev's wire shapes, as Zod Mini schemas (ADR-0004), read from the
 * recorded exchanges in `fixtures/typesafe/` and https://docs.typesafe.ai/api.md.
 *
 * TypeSafe's wire vocabulary is the neutral vocabulary: an answer on the wire
 * has the fields the contract's answer has. The schemas are still written here
 * rather than shared with `src/decision/contract.ts`, because the contract is
 * what this app promises its UI and the wire shape is what a provider happens
 * to send; the two coincide today and must be free to part.
 *
 * `z.object` strips unknown fields, which is the right stance for a reply a
 * provider may extend. No message is customised: `fromWire` reports a rejected
 * reply by its dot path and issue code, not by wording. Zod Mini APIs used,
 * read from node_modules/zod/v4/mini/schemas.d.ts: `object`, `record`,
 * `array`, `discriminatedUnion`, `literal`, `string`, and `number`; `output`
 * from node_modules/zod/v4/mini/in-out.d.ts.
 */

import * as z from "zod/mini";
import { description } from "../../src/decision/contract.ts";

const noulAnswer = z.object({ type: z.literal("noul"), noul: z.number() });

/** `probabilities` is a record keyed by option name, unlike OpenAI's list. */
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

/** The model declined to answer. It passes through to the contract's refusal unchanged. */
const refusalAnswer = z.object({ type: z.literal("refusal") });

/** A 2xx body from `POST /v1/systemone`. An answer with any other `type` fails at `answers.<id>.type`. */
export const decisionReplySchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [noulAnswer, choiceAnswer, scoreAnswer, refusalAnswer]),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** A failed reply's body: `{ detail: { error_type, message } }`, the same envelope SubQ uses. */
export const errorEnvelopeSchema = z.object({
  detail: z.object({ error_type: z.string(), message: z.string() }),
});

/** A 2xx body from `GET /v1/models`, the warm path that costs no tokens. */
export const warmReplySchema = z.object({
  models: z.array(
    z.object({ name: z.string(), description: z.string(), release_date: z.string() }),
  ),
});

export type DecisionReply = z.output<typeof decisionReplySchema>;
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;
export type WarmReply = z.output<typeof warmReplySchema>;
