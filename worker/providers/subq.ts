/**
 * The SubQ Snap adapter: `POST /v1/systemone` with plain `fetch`.
 *
 * SubQ's wire vocabulary is the neutral vocabulary, so `toWire` passes `noul`,
 * `choice`, and `score` questions straight through, resolving each question's
 * criteria from itself or the request default and adding the pinned model from
 * the catalog. The wire shapes were measured by the probes in
 * `docs/spikes/provider-probes.md`, whose fixtures are in `fixtures/subq/`.
 * SubQ has no SDK, so the wire types are written below. This module shares
 * nothing with the TypeSafe adapter beyond `adapter.ts`, because the two wire
 * formats are free to part.
 *
 * Three things differ from TypeSafe. SubQ takes an `images` array of
 * `{ mediaType, base64 }` and `toWire` copies it as it is: `base64` is plain
 * one-line base64 with no `data:` prefix (a `data:` URL and wrapped lines both
 * return 422). Checking that shape belongs to request validation (#15), not to
 * this translation. SubQ answers 403 as well as 401 for a bad key, and
 * `errorKindForStatus` already treats both as `auth`. SubQ cannot refuse, so
 * its schema has no refusal answer.
 *
 * `fromWire` parses the reply with the schema before reading a field and checks
 * that the answers are exactly the questions asked. The key is handed to
 * `fetchJson`, which checks it and sends it; this module never builds a header
 * with it.
 */

import type {
  ChoiceCriteria,
  Content,
  NoulCriteria,
  ScoreCriteria,
} from "../../src/decision/contract.ts";
import type { ValidDecisionRequest } from "../../src/decision/validate.ts";
import { subq } from "../../src/providers/catalog.ts";
import type { ImageAttachment } from "../decide.ts";
import {
  clip,
  failureFromStatus,
  fetchJson,
  isSuccess,
  parseReply,
  unreadableReply,
} from "./adapter.ts";
import type { Fetch, ProviderAdapter, ProviderDecision } from "./adapter.ts";
import { decisionReplySchema, errorEnvelopeSchema } from "./subq-schema.ts";

/** The decision endpoint, resolved against the catalog's base URL, so no host is written here. */
const DECISION_URL = `${subq.baseUrl}/v1/systemone`;

/** One question as SubQ's `POST /v1/systemone` takes it. A Yes/no question's criteria are optional. */
type WireQuestion =
  | { type: "noul"; instructions: Content; criteria?: NoulCriteria }
  | { type: "choice"; instructions: Content; criteria: ChoiceCriteria }
  | { type: "score"; instructions: Content; criteria: ScoreCriteria };

/** One image as SubQ takes it: the media type and plain one-line base64. */
type WireImage = { mediaType: string; base64: string };

/** The body of `POST /v1/systemone`. `images` is present only when the request carries some. */
export type SubqWireRequest = {
  model: string;
  state: Content;
  images?: WireImage[];
  questions: Record<string, WireQuestion>;
};

/**
 * A validated request that may carry images. Images arrive with request
 * validation (#15); until then no caller sets them. The route's record of what
 * was sent calls this `toWire` on a copy whose image data is already replaced,
 * so this module needs no redaction code.
 */
type RequestWithImages = ValidDecisionRequest & { images?: readonly ImageAttachment[] };

/** The wire request for a validated neutral request, with the model pinned to the catalog's. */
export function toWire(request: RequestWithImages): SubqWireRequest {
  const wire: SubqWireRequest = {
    model: subq.model,
    state: request.state,
    questions: toWireQuestions(request),
  };
  if (request.images !== undefined && request.images.length > 0) {
    // Only the two fields SubQ reads; `byteLength` is this app's own bookkeeping.
    wire.images = request.images.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
  }
  return wire;
}

/**
 * One wire question per neutral question, typed as the request's primitive.
 * Each primitive is its own loop because TypeScript cannot correlate the
 * primitive with the criteria shape across the union in one.
 */
function toWireQuestions(request: ValidDecisionRequest): Record<string, WireQuestion> {
  const questions: Record<string, WireQuestion> = {};
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
 * validator regression fails loudly here instead of sending a request SubQ rejects.
 */
function resolvedCriteria<C>(id: string, criteria: C | undefined): C {
  if (criteria === undefined) {
    throw new Error(`Question "${id}" has no criteria, so the request was not validated.`);
  }
  return criteria;
}

/**
 * The neutral decision read from a parsed 2xx body. The schema runs first, so
 * no field is read from a body it rejects; an unknown answer `type`, a refusal
 * included, fails there at `answers.<id>.type`. The answers must then be
 * exactly the questions asked, each of the request's primitive; anything else
 * is an `upstream` error too, so the route never builds a response the contract
 * would refuse. Answer ids are provider text, so they are cut before they enter
 * a detail.
 */
export function fromWire(request: ValidDecisionRequest, body: unknown): ProviderDecision {
  const { model, usage, answers } = parseReply(subq, decisionReplySchema, body);
  const unanswered = Object.keys(request.questions).find((id) => !Object.hasOwn(answers, id));
  if (unanswered !== undefined) {
    throw unreadableReply(subq, `answers: no answer for question "${clip(unanswered)}"`);
  }
  for (const [id, answer] of Object.entries(answers)) {
    if (!Object.hasOwn(request.questions, id)) {
      throw unreadableReply(subq, `${clip(`answers.${id}`)}: no question with this id`);
    }
    if (answer.type !== request.primitive) {
      throw unreadableReply(
        subq,
        `answers.${clip(id)}.type: expected "${request.primitive}", received "${answer.type}"`,
      );
    }
  }
  return { model, usage, answers };
}

/** `validation_error: questions/queue: …` from SubQ's error envelope, or `undefined` when the body is not one. */
function describeEnvelope(body: unknown): string | undefined {
  const parsed = errorEnvelopeSchema.safeParse(body);
  return parsed.success
    ? `${parsed.data.detail.error_type}: ${parsed.data.detail.message}`
    : undefined;
}

/** Sends the decision to SubQ with the given `fetch`; `fetchJson` checks the key and sends it. */
export async function decide(
  request: ValidDecisionRequest,
  apiKey: string,
  signal: AbortSignal,
  fetch: Fetch,
): Promise<ProviderDecision> {
  const reply = await fetchJson(fetch, signal, subq, apiKey, DECISION_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(toWire(request)),
  });
  if (!isSuccess(reply.status)) {
    throw failureFromStatus(subq, reply, describeEnvelope(reply.body));
  }
  return fromWire(request, reply.body);
}

export const subqAdapter = {
  descriptor: subq,
  toWire,
  fromWire,
  decide,
} satisfies ProviderAdapter;
