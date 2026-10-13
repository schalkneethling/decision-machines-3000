/**
 * Schema 2 in Zod Mini: the three providers' wire shapes, parsed from the
 * recorded fixtures in `worker/providers/fixtures/`. No custom messages, so the
 * comparison can show each library's default wording for a broken response.
 *
 * Shapes and sources are the same as in `../valibot/provider.ts`.
 *
 * `z.object` strips unknown fields, which is the right stance for a response a
 * provider may extend. APIs used, read from node_modules/zod/v4/mini/schemas.d.ts:
 * `object`, `record`, `array`, `discriminatedUnion`, `union`, `literal`,
 * `nullable`, `exactOptional`, `string`, `number`, `boolean`, `unknown`,
 * `safeParse`, and `z.core.toDotPath`.
 */

import * as z from "zod/mini";
import { description } from "./request.ts";

const usage = z.object({ input_tokens: z.number(), output_tokens: z.number() });

// --- TypeSafe Jev and SubQ Snap: the same wire shape ------------------------

const jevNoul = z.object({ type: z.literal("noul"), noul: z.number() });
const jevChoice = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});
const jevScore = z.object({
  type: z.literal("score"),
  score: z.number(),
  confidence: z.number(),
  legend: z.record(z.string(), description()),
  probabilities: z.record(z.string(), z.number()),
});

export const jevDecision = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.discriminatedUnion("type", [jevNoul, jevChoice, jevScore])),
  usage,
});

/** 401, 403, and 422 bodies from both Jev-style providers. */
export const jevError = z.object({
  detail: z.object({ error_type: z.string(), message: z.string() }),
});

export const typesafeModels = z.object({
  models: z.array(
    z.object({ name: z.string(), description: z.string(), release_date: z.string() }),
  ),
});

export const subqModels = z.object({
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

// --- OpenAI Decisions -------------------------------------------------------

const name = z.nullable(z.string());
const openaiPredicate = z.object({ type: z.literal("predicate"), name, probability: z.number() });
const openaiChoice = z.object({
  type: z.literal("choice"),
  name,
  choice: z.union([z.string(), z.boolean()]),
  confidence: z.exactOptional(z.number()),
  probabilities: z.array(
    z.object({ value: z.union([z.string(), z.boolean()]), probability: z.number() }),
  ),
});
const openaiScore = z.object({
  type: z.literal("score"),
  name,
  score: z.number(),
  confidence: z.exactOptional(z.number()),
  probabilities: z.array(
    z.object({ value: z.number(), label: z.string(), probability: z.number() }),
  ),
});
const openaiRefusal = z.object({ type: z.literal("refusal"), name });

export const openaiDecision = z.object({
  model: z.string(),
  answers: z.array(
    z.discriminatedUnion("type", [openaiPredicate, openaiChoice, openaiScore, openaiRefusal]),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
  }),
});

/** 400 and 401 bodies. `param` and `code` are `null` on a bad key (see `openai/bad-key.json`). */
export const openaiError = z.object({
  error: z.object({
    message: z.string(),
    type: z.string(),
    param: z.nullable(z.string()),
    code: z.nullable(z.string()),
  }),
});

const openaiModel = z.object({
  id: z.string(),
  object: z.literal("model"),
  created: z.number(),
  owned_by: z.string(),
  shutdown_date: z.nullable(z.string()),
});

/** `GET /v1/models` returns a list; `GET /v1/models/{id}` returns one model. */
export const openaiModels = z.union([
  z.object({ object: z.literal("list"), data: z.array(openaiModel) }),
  openaiModel,
]);

export type JevDecision = z.output<typeof jevDecision>;
export type OpenAiDecision = z.output<typeof openaiDecision>;

/** `{ success, dotPath, message }` of the first issue, for the comparison table. */
export function describeParse(schema: z.ZodMiniType, input: unknown) {
  const result = schema.safeParse(input);
  if (result.success) return { success: true as const };
  const [issue] = result.error.issues;
  return {
    success: false as const,
    path: issue.path.map(String).join("."),
    message: issue.message,
  };
}
