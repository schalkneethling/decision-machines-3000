/**
 * Schema 2 in Valibot: the three providers' wire shapes, parsed from the
 * recorded fixtures in `worker/providers/fixtures/`. No custom messages, so the
 * comparison can show each library's default wording for a broken response.
 *
 * Shapes come from the fixtures themselves and `docs/spikes/provider-probes.md`.
 * The OpenAI refusal answer `{ "type": "refusal", "name": ... }` is not in any
 * fixture; its shape comes from the OpenAI-compatible Decisions reference at
 * https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions, which
 * states it implements the same response shapes as OpenAI, and from the code
 * samples in OpenAI's own guide, which check `answer.type === "refusal"` and
 * read `answer.name`.
 *
 * `v.object` strips unknown fields, which is the right stance for a response a
 * provider may extend. APIs used, read from node_modules/valibot/dist/index.d.mts:
 * `object`, `record`, `array`, `variant`, `literal`, `picklist`, `nullable`,
 * `optional`, `exactOptional`, `string`, `number`, `safeParse`, `getDotPath`.
 */

import * as v from "valibot";
import { description } from "./request.ts";

const usage = v.object({ input_tokens: v.number(), output_tokens: v.number() });

// --- TypeSafe Jev and SubQ Snap: the same wire shape ------------------------

const jevNoul = v.object({ type: v.literal("noul"), noul: v.number() });
const jevChoice = v.object({
  type: v.literal("choice"),
  choice: v.string(),
  confidence: v.number(),
  probabilities: v.record(v.string(), v.number()),
});
const jevScore = v.object({
  type: v.literal("score"),
  score: v.number(),
  confidence: v.number(),
  legend: v.record(v.string(), description),
  probabilities: v.record(v.string(), v.number()),
});

export const jevDecision = v.object({
  model: v.string(),
  answers: v.record(v.string(), v.variant("type", [jevNoul, jevChoice, jevScore])),
  usage,
});

/** 401, 403, and 422 bodies from both Jev-style providers. */
export const jevError = v.object({
  detail: v.object({ error_type: v.string(), message: v.string() }),
});

export const typesafeModels = v.object({
  models: v.array(
    v.object({ name: v.string(), description: v.string(), release_date: v.string() }),
  ),
});

export const subqModels = v.object({
  object: v.literal("list"),
  data: v.array(
    v.object({
      id: v.string(),
      name: v.string(),
      object: v.literal("model"),
      created: v.number(),
      owned_by: v.string(),
    }),
  ),
});

// --- OpenAI Decisions -------------------------------------------------------

const name = v.nullable(v.string());
const openaiPredicate = v.object({ type: v.literal("predicate"), name, probability: v.number() });
const openaiChoice = v.object({
  type: v.literal("choice"),
  name,
  choice: v.union([v.string(), v.boolean()]),
  confidence: v.exactOptional(v.number()),
  probabilities: v.array(
    v.object({ value: v.union([v.string(), v.boolean()]), probability: v.number() }),
  ),
});
const openaiScore = v.object({
  type: v.literal("score"),
  name,
  score: v.number(),
  confidence: v.exactOptional(v.number()),
  probabilities: v.array(
    v.object({ value: v.number(), label: v.string(), probability: v.number() }),
  ),
});
const openaiRefusal = v.object({ type: v.literal("refusal"), name });

export const openaiDecision = v.object({
  model: v.string(),
  answers: v.array(v.variant("type", [openaiPredicate, openaiChoice, openaiScore, openaiRefusal])),
  usage: v.object({
    input_tokens: v.number(),
    output_tokens: v.number(),
    total_tokens: v.number(),
  }),
});

/** 400 and 401 bodies. `param` and `code` are `null` on a bad key (see `openai/bad-key.json`). */
export const openaiError = v.object({
  error: v.object({
    message: v.string(),
    type: v.string(),
    param: v.nullable(v.string()),
    code: v.nullable(v.string()),
  }),
});

const openaiModel = v.object({
  id: v.string(),
  object: v.literal("model"),
  created: v.number(),
  owned_by: v.string(),
  shutdown_date: v.nullable(v.string()),
});

/** `GET /v1/models` returns a list; `GET /v1/models/{id}` returns one model. */
export const openaiModels = v.union([
  v.object({ object: v.literal("list"), data: v.array(openaiModel) }),
  openaiModel,
]);

export type JevDecision = v.InferOutput<typeof jevDecision>;
export type OpenAiDecision = v.InferOutput<typeof openaiDecision>;

/** `{ success, dotPath, message }` of the first issue, for the comparison table. */
export function describeParse(schema: v.GenericSchema, input: unknown) {
  const result = v.safeParse(schema, input);
  if (result.success) return { success: true as const };
  const [issue] = result.issues;
  return { success: false as const, path: v.getDotPath(issue) ?? "", message: issue.message };
}
