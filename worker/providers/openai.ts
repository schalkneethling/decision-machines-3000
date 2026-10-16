/**
 * The OpenAI Decisions adapter: `POST /v1/decisions` with plain `fetch`.
 *
 * OpenAI is the one provider whose wire model differs in structure from the
 * neutral contract, so this adapter translates rather than passes through.
 * Request shape: the recorded exchanges in `fixtures/openai/`, the probe script
 * `scripts/probe/run.mjs`, and the Decisions guide at
 * https://developers.openai.com/api/docs/guides/decisions. No OpenAI SDK is
 * installed, so the wire types are written out below.
 *
 * `toWire` applies these rules:
 * - The neutral `state` becomes `input`: the string itself, or the JSON text
 *   of an object or a list, because OpenAI takes `input` as text. With images,
 *   `input` is instead one user message. Its content is the state as an
 *   `input_text` part, then for each image an `input_text` part holding its
 *   label (`Image 1: photo.jpg`, from `image-labels.ts`) followed by the
 *   `input_image` part, a `data:` URL. The label sits directly before its
 *   image so the model can tell which picture a question about "image 2"
 *   means, and so the wire view shows each label beside the image it names. The
 *   Decisions guide (https://developers.openai.com/api/docs/guides/decisions)
 *   says to "combine `input_text` and `input_image` parts in a user message"
 *   and sets no limit on how many text parts there are or in what order. Its
 *   examples show one text part then one image, so the interleaved order is
 *   the one shape not recorded in `fixtures/openai/`; the live check in
 *   `scenarios/57-image-labels.feature` covers it.
 * - The `questions` map becomes a list, each question's id as its `name`.
 *   OpenAI echoes the name on every answer, which is how `fromWire` places them.
 * - **Yes/no meaning.** OpenAI's yes/no type is `predicate`, and it has no
 *   criteria field, so the neutral `criteria.true` and `criteria.false` are
 *   appended to the instructions as "Yes means: …" and "No means: …", each on
 *   its own line after a blank line. A blank meaning is skipped.
 * - A choice question's criteria map becomes `choices: [{ value, description? }]`,
 *   with a `null` description left out.
 * - **Level labels.** A score question's criteria list becomes
 *   `levels: [{ label, description? }]`. A string level is the label itself.
 *   Any other level is labelled `Level <index>`, counted from 0 like the neutral
 *   legend's keys and the `value` OpenAI reports, and carries the level's JSON
 *   as its description; `null` leaves a level undescribed, so it gets no
 *   description. A blank string level is labelled by its index too, and a
 *   label that repeats an earlier one gets its index appended, so every label
 *   is unique and non-blank.
 * - Any other text OpenAI wants as a string (instructions, descriptions) is a
 *   string as given or the JSON text of a structured value.
 *
 * `fromWire` parses the reply with the schema, then places each answer by its
 * `name`: a name the request did not ask, a name answered twice, a question
 * left unanswered, and an answer of the wrong type are all `upstream` errors,
 * as they are for TypeSafe. The answers come back in the request's order,
 * whatever order the reply used, because the UI renders them in record order.
 * A `predicate` answer becomes `{ type: "noul", noul }` from its
 * `probability`; `probabilities` lists become records keyed by
 * `String(value)`; a score's `legend` is rebuilt from the request's levels by
 * index; a `refusal` passes through as the contract's refusal; and `usage` is
 * the two fields the contract carries.
 *
 * The key is handed to `fetchJson`, which checks it and sends it; this module
 * never builds a header with it.
 */

import type {
  ChoiceCriteria,
  Content,
  JsonValue,
  NoulCriteria,
  ScoreCriteria,
} from "../../src/decision/contract.ts";
import type { ValidDecisionRequest } from "../../src/decision/validate.ts";
import { openai } from "../../src/providers/catalog.ts";
import {
  clip,
  failureFromStatus,
  fetchJson,
  isSuccess,
  parseReply,
  unreadableReply,
} from "./adapter.ts";
import type {
  AdapterResult,
  FailureOverride,
  Fetch,
  ProviderAdapter,
  ProviderDecision,
} from "./adapter.ts";
import { imageLabel } from "./image-labels.ts";
import { decisionReplySchema, errorEnvelopeSchema } from "./openai-schema.ts";
import type { ErrorEnvelope, WireAnswer } from "./openai-schema.ts";

/** The decision endpoint, resolved against the catalog's base URL, so no host is written here. */
const DECISION_URL = `${openai.baseUrl}/v1/decisions`;

// ---------------------------------------------------------------------------
// The wire request
// ---------------------------------------------------------------------------

/**
 * What `toWire` needs of an attached image: its media type and its base64
 * data, treated as opaque text, and its cleaned file name for the label. The
 * route's attachment type has these fields and a byte count; this structural
 * type is all the adapter reads, and it stays here so the adapter imports
 * nothing from the route (#15 settles where the neutral image type lives).
 */
export type WireImage = { mediaType: string; base64: string; name: string };

/** A validated neutral request, which may carry images once #15 lands. */
export type WireInput = ValidDecisionRequest & { images?: readonly WireImage[] };

type TextPart = { type: "input_text"; text: string };
type ImagePart = { type: "input_image"; image_url: string };
type UserMessage = { role: "user"; content: (TextPart | ImagePart)[] };

type WireChoice = { value: string; description?: string };
type WireLevel = { label: string; description?: string };

type WireQuestion =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: WireChoice[] }
  | { type: "score"; name: string; instructions: string; levels: WireLevel[] };

export type OpenAiRequest = {
  model: string;
  input: string | UserMessage[];
  questions: WireQuestion[];
};

/** OpenAI's name for each neutral primitive's answer type. */
const WIRE_TYPE = { noul: "predicate", choice: "choice", score: "score" } as const;

/** A string as given; an object or a list as its JSON text, because OpenAI takes these fields as text. */
function asText(value: Content | JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The wire request for a validated neutral request, with the model pinned to the catalog's. */
export function toWire(request: WireInput): OpenAiRequest {
  return { model: openai.model, input: toWireInput(request), questions: toWireQuestions(request) };
}

/** `input` as text, or as one user message when the request carries images. */
function toWireInput(request: WireInput): string | UserMessage[] {
  const text = asText(request.state);
  if (request.images === undefined || request.images.length === 0) return text;
  return [
    {
      role: "user",
      content: [
        { type: "input_text", text },
        ...request.images.flatMap((image, index): (TextPart | ImagePart)[] => [
          { type: "input_text", text: imageLabel(image, index) },
          toImagePart(image),
        ]),
      ],
    },
  ];
}

/** One image as an `input_image` part, its bytes carried in a `data:` URL. */
function toImagePart(image: WireImage): ImagePart {
  return { type: "input_image", image_url: `data:${image.mediaType};base64,${image.base64}` };
}

/**
 * One wire question per neutral question, in the map's order. Each primitive
 * is its own branch because TypeScript cannot correlate the primitive with the
 * criteria shape across the union in one.
 */
function toWireQuestions(request: WireInput): WireQuestion[] {
  switch (request.primitive) {
    case "noul":
      return Object.entries(request.questions).map(([name, question]) => ({
        type: "predicate",
        name,
        instructions: withMeanings(
          asText(question.instructions),
          question.criteria ?? request.criteria,
        ),
      }));
    case "choice":
      return Object.entries(request.questions).map(([name, question]) => ({
        type: "choice",
        name,
        instructions: asText(question.instructions),
        choices: toChoices(resolvedCriteria(name, question.criteria ?? request.criteria)),
      }));
    case "score":
      return Object.entries(request.questions).map(([name, question]) => ({
        type: "score",
        name,
        instructions: asText(question.instructions),
        levels: toLevels(resolvedCriteria(name, question.criteria ?? request.criteria)),
      }));
  }
}

/**
 * The instructions with the yes/no meanings appended, each on its own line
 * after a blank line. Only the meanings given are appended, a meaning that is
 * empty or only whitespace is skipped so no dangling "Yes means:" line is
 * sent, and instructions without criteria are returned unchanged.
 */
function withMeanings(instructions: string, criteria: NoulCriteria | undefined): string {
  const lines: string[] = [];
  if (hasText(criteria?.true)) lines.push(`Yes means: ${asText(criteria.true)}`);
  if (hasText(criteria?.false)) lines.push(`No means: ${asText(criteria.false)}`);
  return lines.length === 0 ? instructions : `${instructions}\n\n${lines.join("\n")}`;
}

/** Whether a meaning is worth sending: present, and not a blank string. An object or a list always is. */
function hasText(meaning: Content | undefined): meaning is Content {
  return meaning !== undefined && !isBlank(meaning);
}

/** Whether a value is a string with nothing but whitespace in it. */
function isBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

/** The option map as `[{ value, description? }]`, with a `null` description left out. */
function toChoices(criteria: ChoiceCriteria): WireChoice[] {
  return Object.entries(criteria).map(([value, description]) =>
    description === null ? { value } : { value, description: asText(description) },
  );
}

/**
 * The level list as `[{ label, description? }]`: a string is the label; any
 * other level is `Level <index>` with its JSON as the description, and `null`
 * is `Level <index>` with none. Every label is made unique and non-blank, so
 * OpenAI sees one label per level: a blank string level is labelled
 * `Level <index>`, and a label that repeats an earlier one gets ` (<index>)`
 * appended, again if that is somehow taken too. `fromWire` reads levels by
 * index, so a changed label changes nothing on the way back.
 */
function toLevels(levels: ScoreCriteria): WireLevel[] {
  const taken = new Set<string>();
  return levels.map((level, index) => {
    const named = typeof level === "string" && !isBlank(level);
    let label = named ? level : `Level ${index}`;
    while (taken.has(label)) label = `${label} (${index})`;
    taken.add(label);
    // A string, blank or not, and `null` describe nothing; only a structured level does.
    return typeof level === "string" || level === null
      ? { label }
      : { label, description: JSON.stringify(level) };
  });
}

/**
 * Validation guarantees every Choice and Score question criteria from itself or
 * the request default, so `undefined` is unreachable. The check stays so a
 * validator regression fails loudly here instead of sending a request OpenAI rejects.
 */
function resolvedCriteria<C>(id: string, criteria: C | undefined): C {
  if (criteria === undefined) {
    throw new Error(`Question "${id}" has no criteria, so the request was not validated.`);
  }
  return criteria;
}

// ---------------------------------------------------------------------------
// The wire reply
// ---------------------------------------------------------------------------

type NeutralAnswer = ProviderDecision["answers"][string];

/**
 * The neutral decision read from a parsed 2xx body. The schema runs first, so
 * no field is read from a body it rejects; an unknown answer `type` fails
 * there, at `answers.<index>.type`. The answers must then be exactly the
 * questions asked, each of the request's primitive or a refusal; anything else
 * is an `upstream` error too, so the route never builds a response the
 * contract would refuse. Answer names are provider text, so they are cut
 * before they enter a detail.
 */
export function fromWire(request: ValidDecisionRequest, body: unknown): ProviderDecision {
  const { model, usage, answers } = parseReply(openai, decisionReplySchema, body);
  const placed = new Map<string, NeutralAnswer>();
  answers.forEach((answer, index) => {
    const place = `answers.${index}`;
    if (!Object.hasOwn(request.questions, answer.name)) {
      throw unreadableReply(openai, `${place}.name: no question named "${clip(answer.name)}"`);
    }
    if (placed.has(answer.name)) {
      throw unreadableReply(
        openai,
        `${place}.name: a second answer for question "${clip(answer.name)}"`,
      );
    }
    placed.set(answer.name, toNeutralAnswer(request, answer, place));
  });
  const ids = Object.keys(request.questions);
  const unanswered = ids.find((id) => !placed.has(id));
  if (unanswered !== undefined) {
    throw unreadableReply(openai, `answers: no answer for question "${clip(unanswered)}"`);
  }
  // In the request's order, not the reply's, because the UI renders the record in order. The
  // checks above leave `placed` holding exactly the request's ids, so every id has an index.
  const ordered = [...placed].sort(([a], [b]) => ids.indexOf(a) - ids.indexOf(b));
  return { model, usage, answers: Object.fromEntries(ordered) };
}

/** One answer in the neutral shape, or an `upstream` error when its type is not the request's primitive. */
function toNeutralAnswer(
  request: ValidDecisionRequest,
  answer: WireAnswer,
  place: string,
): NeutralAnswer {
  if (answer.type === "refusal") return { type: "refusal" };
  const expected = WIRE_TYPE[request.primitive];
  if (answer.type !== expected) {
    throw unreadableReply(
      openai,
      `${place}.type: expected "${expected}" or "refusal", received "${answer.type}"`,
    );
  }
  switch (answer.type) {
    case "predicate":
      return { type: "noul", noul: answer.probability };
    case "choice":
      return {
        type: "choice",
        choice: answer.choice,
        confidence: confidenceOf(answer, place),
        probabilities: keyedByValue(answer.probabilities),
      };
    case "score":
      return {
        type: "score",
        score: answer.score,
        confidence: confidenceOf(answer, place),
        legend: legendFor(request, answer.name),
        probabilities: keyedByValue(answer.probabilities),
      };
  }
}

/** The contract requires a confidence, so an answer without one is a reply this app cannot read. */
function confidenceOf(answer: { confidence?: number }, place: string): number {
  if (answer.confidence === undefined) {
    throw unreadableReply(openai, `${place}.confidence: expected number, received undefined`);
  }
  return answer.confidence;
}

/** `[{ value, probability }]` as the neutral record keyed by `String(value)`. */
function keyedByValue(
  probabilities: readonly { value: string | number; probability: number }[],
): Record<string, number> {
  return Object.fromEntries(probabilities.map((entry) => [String(entry.value), entry.probability]));
}

/**
 * The legend the neutral score answer carries, rebuilt from the request's
 * levels by index, because OpenAI returns labels but not the descriptions. The
 * caller has already matched the answer's type to the primitive, so a request
 * of another primitive cannot reach this.
 */
function legendFor(
  request: ValidDecisionRequest,
  id: string,
): Record<string, ScoreCriteria[number]> {
  if (request.primitive !== "score") {
    throw new Error(`Question "${id}" is not a score question, so it has no legend.`);
  }
  const levels = resolvedCriteria(id, request.questions[id].criteria ?? request.criteria);
  return Object.fromEntries(levels.map((level, index) => [String(index), level]));
}

// ---------------------------------------------------------------------------
// Failed replies
// ---------------------------------------------------------------------------

/** OpenAI's envelope, or `undefined` when the body is not one (an HTML error page, say). */
function parseEnvelope(body: unknown): ErrorEnvelope["error"] | undefined {
  const parsed = errorEnvelopeSchema.safeParse(body);
  return parsed.success ? parsed.data.error : undefined;
}

/**
 * `invalid_request_error array_above_max_length at questions[0].levels: Invalid …`:
 * the envelope's type, then its code and param when OpenAI sent them (a bad key
 * sends neither), then the message.
 */
function describeEnvelope(error: ErrorEnvelope["error"]): string {
  const code = error.code === null ? "" : ` ${error.code}`;
  const param = error.param === null ? "" : ` at ${error.param}`;
  return `${error.type}${code}${param}: ${error.message}`;
}

/**
 * The codes OpenAI uses for a spent balance. `credit_balance_exhausted` is in
 * the error guide (https://developers.openai.com/api/docs/guides/error-codes)
 * under 429; the same guide says `insufficient_quota` can appear as the
 * `type`, so both fields are read. Neither was probed (docs/spikes/provider-probes.md,
 * "Not probed"), so their tests are stubbed.
 */
const NO_CREDIT_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
]);

/**
 * The 429 codes the error guide lists for a reached spend or usage limit.
 * Waiting cannot help, so they are `no_credits` too, worded as a limit rather
 * than an empty balance.
 */
const SPEND_LIMIT_CODES: ReadonlySet<string> = new Set([
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
]);

/**
 * The error guide's one 403, "Country, region, or territory not supported",
 * carries no documented code, so it is recognised by those words in the message.
 */
const REGION_BLOCK = /country, region, or territory/i;

/**
 * Where OpenAI's statuses part from what the status alone implies:
 * - 429 for a spent balance or a reached spend limit is `no_credits`, which the
 *   route answers with 402, while any other 429 stays `rate_limited`;
 * - 403 whose envelope says the region is not supported is worded as such and
 *   kept `upstream`, not `auth`. Any other 403 (a key missing a scope, a
 *   project without access to the model, an organisation that needs
 *   verification, or a body that is not the envelope at all) keeps the shared
 *   default, which is `auth`;
 * - 413 means OpenAI found the request too large, which only images can cause,
 *   so it is `invalid_request` with wording that says so.
 */
function overrideFor(
  status: number,
  error: ErrorEnvelope["error"] | undefined,
): FailureOverride | undefined {
  if (status === 429 && error !== undefined) {
    // The limit codes come first: their `type` can be `insufficient_quota` too, and the
    // code is the more specific of the two signals.
    if (hasCode(error, SPEND_LIMIT_CODES)) {
      return {
        kind: "no_credits",
        message: `${openai.displayName} refused the request because this project or organisation reached its spend limit. Raise the limit, then try again.`,
      };
    }
    if (hasCode(error, NO_CREDIT_CODES)) return { kind: "no_credits" };
  }
  if (status === 403 && error !== undefined && REGION_BLOCK.test(error.message)) {
    return {
      kind: "upstream",
      message: `${openai.displayName} does not serve the country or region this server runs in, so it refused the request.`,
    };
  }
  if (status === 413) {
    return {
      kind: "invalid_request",
      message: `${openai.displayName} refused the request as too large. Remove or shrink the images and try again.`,
    };
  }
  return undefined;
}

/** Whether the envelope's `code` or `type` is one of `codes`. */
function hasCode(error: ErrorEnvelope["error"], codes: ReadonlySet<string>): boolean {
  return (error.code !== null && codes.has(error.code)) || codes.has(error.type);
}

/** Sends the decision to OpenAI with the given `fetch`; `fetchJson` checks the key and sends it. */
export async function decide(
  request: ValidDecisionRequest,
  apiKey: string,
  signal: AbortSignal,
  fetch: Fetch,
): Promise<AdapterResult> {
  const reply = await fetchJson(fetch, signal, openai, apiKey, DECISION_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(toWire(request)),
  });
  if (!isSuccess(reply.status)) {
    const error = parseEnvelope(reply.body);
    throw failureFromStatus(
      openai,
      reply,
      error === undefined ? undefined : describeEnvelope(error),
      overrideFor(reply.status, error),
    );
  }
  return { ...fromWire(request, reply.body), wire: { response: reply.body } };
}

export const openaiAdapter = {
  descriptor: openai,
  toWire,
  fromWire,
  decide,
} satisfies ProviderAdapter;
