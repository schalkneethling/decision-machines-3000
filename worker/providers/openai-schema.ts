/**
 * OpenAI Decisions' wire shapes, as Zod Mini schemas (ADR-0004), read from the
 * recorded exchanges in `fixtures/openai/` and the Decisions guide at
 * https://developers.openai.com/api/docs/guides/decisions. The spike's draft in
 * `spikes/schema-library/zod-mini/provider.ts` (branch `issue-31-schema-library-spike`)
 * was the starting point.
 *
 * OpenAI's wire vocabulary is not the neutral one: answers arrive as a list
 * that carries each question's `name`, a yes/no answer is a `predicate` with a
 * `probability`, `probabilities` is a list of `{ value, probability }` rather
 * than a record, and `confidence` is present on the recorded choice and score
 * answers but absent on the predicate answer. The model may also decline one
 * question with a `refusal` answer. No fixture holds a refusal; its shape
 * `{ type: "refusal", name }` comes from the guide's sample code, which checks
 * `answer.type === "refusal"` and reads `answer.name`.
 *
 * `name` is required, not nullable as in the spike, because `toWire` names
 * every question and `fromWire` maps answers to questions by that name; an
 * unnamed answer could not be placed and is a reply this app cannot read.
 *
 * `z.object` strips unknown fields, which is the right stance for a reply a
 * provider may extend: `usage` loses `total_tokens` and the token-detail
 * objects, keeping the two fields the contract carries. No message is
 * customised: `fromWire` reports a rejected reply by its dot path and issue
 * code, not by wording. Zod Mini APIs used, read from
 * node_modules/zod/v4/mini/schemas.d.ts: `object`, `array`, `union`,
 * `discriminatedUnion`, `literal`, `string`, `number`, `nullable`, and
 * `exactOptional`; `output` from node_modules/zod/v4/mini/in-out.d.ts.
 */

import * as z from "zod/mini";

/** The question id, echoed back as `toWire` sent it. */
const name = z.string();

/** OpenAI's yes/no answer. `probability` is the chance of yes, the neutral `noul`. */
const predicateAnswer = z.object({ type: z.literal("predicate"), name, probability: z.number() });

/**
 * `probabilities` is a list, unlike the neutral record. `confidence` is
 * optional on the wire; the contract requires it, so `fromWire` reports its
 * absence rather than inventing a number.
 */
const choiceAnswer = z.object({
  type: z.literal("choice"),
  name,
  choice: z.string(),
  confidence: z.exactOptional(z.number()),
  probabilities: z.array(z.object({ value: z.string(), probability: z.number() })),
});

/** `value` is the level's index, as the recorded answers show, and `label` echoes the request's. */
const scoreAnswer = z.object({
  type: z.literal("score"),
  name,
  score: z.number(),
  confidence: z.exactOptional(z.number()),
  probabilities: z.array(
    z.object({ value: z.number(), label: z.string(), probability: z.number() }),
  ),
});

/** The model declined this one question. The other answers still arrive. */
const refusalAnswer = z.object({ type: z.literal("refusal"), name });

/** A 2xx body from `POST /v1/decisions`. An answer with any other `type` fails at `answers.<index>.type`. */
export const decisionReplySchema = z.object({
  model: z.string(),
  answers: z.array(
    z.discriminatedUnion("type", [predicateAnswer, choiceAnswer, scoreAnswer, refusalAnswer]),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/**
 * A failed reply's body, the standard OpenAI envelope. A bad key arrives as
 * 401 with `code: null` and `param: null` (`fixtures/openai/bad-key.json`), so
 * the key failure is recognised from the status, never from the code.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.nullable(z.string()),
    code: z.nullable(z.string()),
  }),
});

const modelSchema = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number(),
  owned_by: z.string(),
  shutdown_date: z.nullable(z.string()),
});

/**
 * A 2xx body from the warm path. The catalog's warm path is the single model,
 * `GET /v1/models/gpt-6-luna`, because the full list weighs 21 KB and took the
 * server 1.6 s (docs/spikes/provider-probes.md, section 7). The list shape is
 * kept so the recorded list exchange still parses.
 */
export const warmReplySchema = z.union([
  modelSchema,
  z.object({ object: z.literal("list"), data: z.array(modelSchema) }),
]);

export type DecisionReply = z.output<typeof decisionReplySchema>;
export type WireAnswer = DecisionReply["answers"][number];
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;
export type WarmReply = z.output<typeof warmReplySchema>;
