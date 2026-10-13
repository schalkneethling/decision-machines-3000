/**
 * Schema 1 in Valibot: the neutral `DecisionRequest`, built from a provider's
 * capabilities at runtime. Compared against `src/decision/validate.ts`, today's hand-written validator.
 *
 * Design. The schema declares structure only; `describeRequestIssue` turns the
 * first issue into today's wording. The two are split because Valibot resolves
 * a message the moment an issue is created, before the enclosing object or
 * record prepends its key to the path (`_addIssue` in
 * node_modules/valibot/dist/index.mjs runs the message function at once; the
 * parent's `~run` unshifts the path item afterwards). Wording such as
 * `Question "tone" has no criteria` needs that enclosing key, so it cannot be
 * produced by a message argument on the schema that fails. The only inline
 * message is on the `rawCheck` for the cross-field rule, which has the id in
 * hand.
 *
 * APIs used, read from node_modules/valibot/dist/index.d.mts: `pipe`,
 * `custom`, `variant`, `strictObject`, `record`, `exactOptional`, `lazy`,
 * `union`, `nullable`, `literal`, `array`, `tupleWithRest`, `minEntries`,
 * `maxEntries`, `minLength`, `maxLength`, `check`, `rawCheck`, `finite`,
 * `safeParse`, `getDotPath`, and the `BaseIssue` / `IssuePathItem` types.
 */

import * as v from "valibot";
import type { Content, JsonValue } from "../../../src/decision/contract.ts";
import { isPlainObject } from "../../../src/decision/json.ts";
import type { CountRange, ProviderCapabilities } from "../../../src/providers/catalog.ts";
import { characterCount, countOf, idTooLongMessage } from "../../../src/decision/count.ts";
import {
  NOUL_CRITERIA_KEYS,
  PRIMITIVES,
  QUESTION_KEYS,
  REQUEST_KEYS,
  describeKind,
  isNotBlank,
  quoteChoices,
  unknownFieldMessage,
} from "../shared/wording.ts";
import type { ValidationFailure } from "../shared/wording.ts";

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/**
 * Any JSON value. The explicit type is required because the schema refers to itself.
 * `lazy` sits at the two recursion points rather than around the whole union, because
 * Valibot calls a lazy getter on every parse (`this.getter(dataset.value)` in `lazy`'s
 * `~run`, node_modules/valibot/dist/index.mjs); wrapping the union would rebuild it for
 * every value visited and cost about twice the parse time (measured in bench.ts).
 */
const json: v.GenericSchema<JsonValue> = v.union([
  v.string(),
  v.pipe(v.number(), v.finite()),
  v.boolean(),
  v.null(),
  v.array(v.lazy(() => json)),
  v.record(
    v.string(),
    v.lazy(() => json),
  ),
]);

/** Text, an object, or a list: what a provider accepts as state, instructions, or a description. */
export const content = v.union([v.string(), v.array(json), v.record(v.string(), json)]);

/** A description that may be `null` to leave an outcome undescribed. */
export const description = v.nullable(content);

const notBlank = v.check<Content>(isNotBlank);

/**
 * WORKAROUND: Valibot's object, record, and variant schemas accept arrays, because their
 * type check is `input && typeof input === "object"` (node_modules/valibot/dist/index.mjs,
 * `strictObject`, `record`, and `variant` `~run`). `[]` would pass `strictObject({})` as
 * `{}` and `["a", "b"]` would pass a record as `{ "0": "a", "1": "b" }`. Every object
 * position therefore runs the project's `isPlainObject` first; a pipe may start with
 * `v.custom` and continue with the real schema.
 */
const plainObject = v.custom<Record<string, unknown>>(isPlainObject);

const noulCriteria = v.pipe(
  plainObject,
  v.strictObject({
    true: v.exactOptional(content),
    false: v.exactOptional(content),
  }),
);

function choiceCriteria({ min, max }: Readonly<CountRange>) {
  return v.pipe(
    plainObject,
    v.record(v.string(), description),
    v.minEntries(min),
    // `v.pipe` has one overload per arity, so a conditional action cannot be spread in; an
    // infinite maximum is the same as no maximum.
    v.maxEntries(max ?? Number.POSITIVE_INFINITY),
    v.check((options) => Object.keys(options).every((name) => name.trim() !== "")),
  );
}

function scoreCriteria({ min, max }: Readonly<CountRange>) {
  // The length checks run before the tuple schema, so a short list is reported as "too few
  // levels" at the list's own path instead of as missing items at `criteria.1`. Valibot
  // pipes accept a schema as a later item for this purpose.
  return v.pipe(
    v.array(v.unknown()),
    v.minLength(min),
    v.maxLength(max ?? Number.POSITIVE_INFINITY),
    v.tupleWithRest([description, description], description),
  );
}

type CriteriaSchema = v.GenericSchema<unknown>;

function questionsSchema<TCriteria extends CriteriaSchema>(
  criteria: TCriteria,
  questionNameMaxLength: number | undefined,
) {
  const questionId = v.pipe(
    v.string(),
    v.check(
      (id) => questionNameMaxLength === undefined || characterCount(id) <= questionNameMaxLength,
    ),
  );
  const question = v.pipe(
    plainObject,
    v.strictObject({
      instructions: v.pipe(content, notBlank),
      criteria: v.exactOptional(criteria),
    }),
  );
  return v.pipe(
    plainObject,
    v.record(questionId, question),
    v.minEntries(1),
    // A key issue would carry the path `questions.` for an empty id; the reference reports
    // `questions`, so the rule sits on the record itself.
    v.check((questions) => Object.keys(questions).every((id) => id.trim() !== "")),
  );
}

function requestFor<TPrimitive extends string, TCriteria extends CriteriaSchema>(
  primitive: TPrimitive,
  criteria: TCriteria,
  capabilities: ProviderCapabilities,
) {
  return v.strictObject({
    primitive: v.literal(primitive),
    state: v.pipe(content, notBlank),
    criteria: v.exactOptional(criteria),
    questions: questionsSchema(criteria, capabilities.questionNameMaxLength),
  });
}

/** Builds the request schema for one provider's limits. */
export function decisionRequestSchema(capabilities: ProviderCapabilities) {
  return v.pipe(
    // Without this guard `[]` would be reported as a missing `primitive` (see `plainObject`).
    plainObject,
    v.variant("primitive", [
      requestFor("noul", noulCriteria, capabilities),
      requestFor("choice", choiceCriteria(capabilities.choiceOptions), capabilities),
      requestFor("score", scoreCriteria(capabilities.scoreLevels), capabilities),
    ]),
    // Cross-field rule: a Choice or Score question needs criteria from one of two places.
    // `rawCheck` is Valibot's way to add an issue with a path chosen at run time.
    v.rawCheck(({ dataset, addIssue }) => {
      if (!dataset.typed) return;
      const request = dataset.value;
      if (request.primitive === "noul" || request.criteria !== undefined) return;
      for (const [id, question] of Object.entries(request.questions)) {
        if (question.criteria !== undefined) continue;
        const kind = request.primitive === "choice" ? "options" : "levels";
        addIssue({
          message: `Question "${id}" has no criteria. Add "criteria" with its ${kind} to the question, or a default "criteria" at the top of the request.`,
          path: [
            {
              type: "object",
              origin: "value",
              input: request,
              key: "questions",
              value: request.questions,
            },
            { type: "object", origin: "value", input: request.questions, key: id, value: question },
            { type: "object", origin: "value", input: question, key: "criteria", value: undefined },
          ],
        });
        return;
      }
    }),
  );
}

export type DecisionRequestSchema = ReturnType<typeof decisionRequestSchema>;

/** The validated request: a union discriminated on `primitive`, inferred from the schema. */
export type ValidDecisionRequest = v.InferOutput<DecisionRequestSchema>;

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

const NOT_OBJECT = (input: unknown) =>
  `The request must be a JSON object with "primitive", "state", and "questions", not ${describeKind(input)}.`;
const ADD_STATE = `Add a "state" field with the text, object, or list to evaluate.`;
const ADD_QUESTIONS = `Add a "questions" object with at least one question, keyed by an id of your choosing.`;

type Issue = v.BaseIssue<unknown>;

/** The path of an issue inside the criteria value, given where the criteria sit and which primitive they serve. */
function describeCriteriaIssue(
  issue: Issue,
  below: readonly v.IssuePathItem[],
  where: string,
  primitive: unknown,
): string {
  const [item] = below;
  if (item === undefined) {
    // The criteria value itself. Its type issue comes from the `plainObject` guard
    // (`custom`) for Noul and Choice, and from `array` for Score.
    switch (issue.type) {
      case "custom":
        return primitive === "noul"
          ? `${where} must be an object with optional "true" and "false" descriptions, not ${describeKind(issue.input)}.`
          : `${where} must be an object that maps each option name to its description, not ${describeKind(issue.input)}.`;
      case "min_entries":
        return `${where} needs at least ${countOf(Number(issue.requirement), "option")} to choose between. It has ${Object.keys(issue.input as object).length}.`;
      case "max_entries":
        return `${where} has ${Object.keys(issue.input as object).length} options. Use at most ${String(issue.requirement)}.`;
      case "check":
        return `${where} has an option with an empty name. Give it a name.`;
      case "array":
        return `${where} must be a list of level descriptions, lowest level first, not ${describeKind(issue.input)}.`;
      case "min_length":
        return `${where} needs at least ${countOf(Number(issue.requirement), "level")} to score between. It has ${(issue.input as unknown[]).length}.`;
      case "max_length":
        return `${where} has ${(issue.input as unknown[]).length} levels. Use at most ${String(issue.requirement)}.`;
    }
    return issue.message;
  }
  if (item.origin === "key") {
    // Only the Noul criteria object rejects keys.
    return unknownFieldMessage(where, String(item.key), NOUL_CRITERIA_KEYS);
  }
  switch (primitive) {
    case "noul":
      return `The "${String(item.key)}" description in ${where} must be text, an object, or a list, not ${describeKind(issue.input)}.`;
    case "choice":
      return `The description of option "${String(item.key)}" in ${where} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`;
    case "score":
      return `Level ${String(item.key)} in ${where} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`;
  }
  return issue.message;
}

/**
 * Today's wording for the first issue of a failed parse. Every branch reads the
 * enclosing keys from `issue.path`, which Valibot fills in after the message was set.
 */
export function describeRequestIssue(issue: Issue, capabilities: ProviderCapabilities): string {
  if (issue.type === "raw_check") return issue.message;
  const path = issue.path ?? [];
  const [head, second, third] = path;
  if (head === undefined) return NOT_OBJECT(issue.input);
  const request = head.input as Record<string, unknown>;
  if (head.origin === "key") {
    if (issue.expected === "never") {
      return unknownFieldMessage("The request", String(head.key), REQUEST_KEYS);
    }
    if (head.key === "state") return ADD_STATE;
    if (head.key === "questions") return ADD_QUESTIONS;
  }
  switch (head.key) {
    case "primitive": {
      const received =
        typeof issue.input === "string" ? `"${issue.input}"` : describeKind(issue.input);
      return `Set "primitive" to ${quoteChoices(PRIMITIVES)}. It is currently ${received}.`;
    }
    case "state":
      return issue.type === "check"
        ? `"state" is empty. Add the text, object, or list to evaluate.`
        : `"state" must be text, an object, or a list, not ${describeKind(issue.input)}.`;
    case "criteria":
      return describeCriteriaIssue(
        issue,
        path.slice(1),
        `The default "criteria"`,
        request.primitive,
      );
    case "questions": {
      if (second === undefined) {
        return issue.type === "check" ? `Every question needs a non-empty id.` : ADD_QUESTIONS;
      }
      const id = String(second.key);
      if (second.origin === "key") {
        return idTooLongMessage(id, capabilities.questionNameMaxLength ?? Number.POSITIVE_INFINITY);
      }
      if (third === undefined) {
        return `Question "${id}" must be an object with "instructions" and optional "criteria", not ${describeKind(issue.input)}.`;
      }
      if (third.origin === "key") {
        return issue.expected === "never"
          ? unknownFieldMessage(`Question "${id}"`, String(third.key), QUESTION_KEYS)
          : `Question "${id}" has no "instructions". Add the question you want answered.`;
      }
      if (third.key === "instructions") {
        return issue.type === "check"
          ? `The "instructions" of question "${id}" are empty. Write the question you want answered.`
          : `The "instructions" of question "${id}" must be text, an object, or a list, not ${describeKind(issue.input)}.`;
      }
      return describeCriteriaIssue(
        issue,
        path.slice(3),
        `The "criteria" of question "${id}"`,
        request.primitive,
      );
    }
  }
  return issue.message;
}

// ---------------------------------------------------------------------------
// The validator a migration would export
// ---------------------------------------------------------------------------

export type ValidationResult = { ok: true; value: ValidDecisionRequest } | ValidationFailure;

/** Same signature and result shape as the reference `validateDecisionRequest`. */
export function validateDecisionRequest(
  input: unknown,
  capabilities: ProviderCapabilities,
): ValidationResult {
  // `abortEarly` stops at the first problem, as the hand-written validator does.
  const result = v.safeParse(decisionRequestSchema(capabilities), input, { abortEarly: true });
  if (result.success) return { ok: true, value: result.output };
  const [issue] = result.issues;
  const failure: ValidationFailure = {
    ok: false,
    error: describeRequestIssue(issue, capabilities),
  };
  const detail = v.getDotPath(issue);
  if (detail !== null) failure.detail = detail;
  return failure;
}
