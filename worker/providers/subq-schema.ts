/**
 * SubQ Snap's wire shapes, as Zod Mini schemas (ADR-0004), read from the
 * recorded exchanges in `fixtures/subq/` and the findings in
 * `docs/spikes/provider-probes.md`.
 *
 * SubQ answers with the same shapes TypeSafe does, with two differences that
 * matter here: a Yes/no (`noul`) answer carries no `confidence`, and SubQ has
 * no refusal answer (`canRefuse: false`), so an answer of type `refusal` fails
 * at `answers.<id>.type` like any other unknown type. The schemas are written
 * here, not imported from the TypeSafe adapter, because each adapter owns its
 * provider's wire format and the two must be free to part.
 *
 * `z.object` strips unknown fields. Zod Mini APIs used, read from
 * node_modules/zod/v4/mini/schemas.d.ts: `object`, `record`, `array`,
 * `discriminatedUnion`, `literal`, `string`, and `number`; `output` from
 * node_modules/zod/v4/mini/in-out.d.ts.
 */

import * as z from "zod/mini";
import { description } from "../../src/decision/contract.ts";

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

/** A 2xx body from `POST /v1/systemone`. SubQ reports `output_tokens: 0` every time; the schema only requires a number. */
export const decisionReplySchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [noulAnswer, choiceAnswer, scoreAnswer]),
  ),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
});

/** A failed reply's body: `{ detail: { error_type, message } }`. Seen with 401, 403, and 422. */
export const errorEnvelopeSchema = z.object({
  detail: z.object({ error_type: z.string(), message: z.string() }),
});

/** A 2xx body from `GET /v1/models`, the warm path that costs no tokens. Its shape is OpenAI-style. */
export const warmReplySchema = z.object({
  object: z.literal("list"),
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      object: z.literal("model"),
      created: z.number(),
      owned_by: z.string(),
    }),
  ),
});

export type DecisionReply = z.output<typeof decisionReplySchema>;
export type ErrorEnvelope = z.output<typeof errorEnvelopeSchema>;
export type WarmReply = z.output<typeof warmReplySchema>;
