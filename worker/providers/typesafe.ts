/**
 * The TypeSafe Jev adapter: `POST /v1/systemone` with plain `fetch`.
 *
 * The SDK is used for its types only (`import type`), so the Worker carries no
 * runtime from it: no retry policy, no runtime detection, and the same code
 * path as the other two adapters. Decision recorded in the pull request for
 * issue #7. The request body is the SDK's `SystemOneRequestPayload`, so a
 * change to the wire format shows up here as a type error.
 *
 * TypeSafe's wire vocabulary is the neutral vocabulary, so `toWire` passes
 * `noul`, `choice`, and `score` questions straight through, resolving each
 * question's criteria from itself or the request default and adding the
 * pinned model from the catalog. `fromWire` parses the reply with the schema
 * before reading a field, checks that the answers are exactly the questions
 * asked, and passes a refusal through as the contract defines it. The key is
 * handed to `fetchJson`, which checks it and sends it; this module never
 * builds a header with it.
 */

import type { Questions, SystemOneRequestPayload } from "@typesafe-ai/sdk";
import type { ValidDecisionRequest } from "../../src/decision/validate.ts";
import { typesafe } from "../../src/providers/catalog.ts";
import {
  clip,
  failureFromStatus,
  fetchJson,
  isSuccess,
  parseReply,
  unreadableReply,
} from "./adapter.ts";
import type { Fetch, ProviderAdapter, ProviderDecision } from "./adapter.ts";
import { decisionReplySchema, errorEnvelopeSchema } from "./typesafe-schema.ts";

/** The SDK's default API root (`node_modules/@typesafe-ai/sdk/dist/index.mjs`). */
const BASE_URL = "https://api.typesafe.ai";

const DECISION_URL = `${BASE_URL}/v1/systemone`;

/** The wire request for a validated neutral request, with the model pinned to the catalog's. */
export function toWire(request: ValidDecisionRequest): SystemOneRequestPayload {
  return { model: typesafe.model, state: request.state, questions: toWireQuestions(request) };
}

/**
 * One wire question per neutral question, typed as the request's primitive.
 * Each primitive is its own loop because TypeScript cannot correlate the
 * primitive with the criteria shape across the union in one.
 */
function toWireQuestions(request: ValidDecisionRequest): Questions {
  const questions: Questions = {};
  switch (request.primitive) {
    case "noul":
      for (const [id, question] of Object.entries(request.questions)) {
        const criteria = question.criteria ?? request.criteria;
        questions[id] =
          criteria === undefined
            ? { type: "noul", instructions: question.instructions }
            : { type: "noul", instructions: question.instructions, criteria };
      }
      break;
    case "choice":
      for (const [id, question] of Object.entries(request.questions)) {
        questions[id] = {
          type: "choice",
          instructions: question.instructions,
          criteria: resolvedCriteria(id, question.criteria ?? request.criteria),
        };
      }
      break;
    case "score":
      for (const [id, question] of Object.entries(request.questions)) {
        questions[id] = {
          type: "score",
          instructions: question.instructions,
          criteria: resolvedCriteria(id, question.criteria ?? request.criteria),
        };
      }
      break;
  }
  return questions;
}

/**
 * Validation guarantees every Choice and Score question criteria from itself or
 * the request default, so `undefined` is unreachable. The check stays so a
 * validator regression fails loudly here instead of sending a request TypeSafe rejects.
 */
function resolvedCriteria<C>(id: string, criteria: C | undefined): C {
  if (criteria === undefined) {
    throw new Error(`Question "${id}" has no criteria, so the request was not validated.`);
  }
  return criteria;
}

/**
 * The neutral decision read from a parsed 2xx body. The schema runs first, so
 * no field is read from a body it rejects; an unknown answer `type` fails there,
 * at `answers.<id>.type`. The answers must then be exactly the questions asked,
 * each of the request's primitive or a refusal; anything else is an `upstream`
 * error too, so the route never builds a response the contract would refuse.
 * Answer ids are provider text, so they are cut before they enter a detail.
 */
export function fromWire(request: ValidDecisionRequest, body: unknown): ProviderDecision {
  const { model, usage, answers } = parseReply(typesafe, decisionReplySchema, body);
  const unanswered = Object.keys(request.questions).find((id) => !Object.hasOwn(answers, id));
  if (unanswered !== undefined) {
    throw unreadableReply(typesafe, `answers: no answer for question "${clip(unanswered)}"`);
  }
  for (const [id, answer] of Object.entries(answers)) {
    if (!Object.hasOwn(request.questions, id)) {
      throw unreadableReply(typesafe, `${clip(`answers.${id}`)}: no question with this id`);
    }
    if (answer.type !== "refusal" && answer.type !== request.primitive) {
      throw unreadableReply(
        typesafe,
        `answers.${clip(id)}.type: expected "${request.primitive}" or "refusal", received "${answer.type}"`,
      );
    }
  }
  return { model, usage, answers };
}

/** `authentication_error: Cannot authenticate…` from TypeSafe's error envelope, or `undefined` when the body is not one. */
function describeEnvelope(body: unknown): string | undefined {
  const parsed = errorEnvelopeSchema.safeParse(body);
  return parsed.success
    ? `${parsed.data.detail.error_type}: ${parsed.data.detail.message}`
    : undefined;
}

/** Sends the decision to TypeSafe with the given `fetch`; `fetchJson` checks the key and sends it. */
export async function decide(
  request: ValidDecisionRequest,
  apiKey: string,
  signal: AbortSignal,
  fetch: Fetch,
): Promise<ProviderDecision> {
  const reply = await fetchJson(fetch, signal, typesafe, apiKey, DECISION_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(toWire(request)),
  });
  if (!isSuccess(reply.status)) {
    throw failureFromStatus(typesafe, reply, describeEnvelope(reply.body));
  }
  return fromWire(request, reply.body);
}

export const typesafeAdapter = {
  descriptor: typesafe,
  toWire,
  fromWire,
  decide,
} satisfies ProviderAdapter;
