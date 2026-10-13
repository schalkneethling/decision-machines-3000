/**
 * Schema 1 in Zod Mini: the neutral `DecisionRequest`, built from a provider's
 * capabilities at runtime. Compared against `src/decision/validate.ts`, today's hand-written validator.
 *
 * Design. Messages sit inline on the schema that raises them, as `error`
 * functions. They can name the enclosing question because Zod resolves
 * messages when the error object is first read, after every parent has
 * prepended its key (`finalizeIssue` in node_modules/zod/v4/core/util.js runs
 * the map with the finished `path`; `prefixIssues` fills it in on the way
 * up). The error-customisation docs say the function "receives the issue, so it
 * can use input, code, path, and other properties"
 * (https://zod.dev/error-customization). Schemas whose wording depends on
 * where they sit (`content`, `description`) are small factories that take the
 * map.
 *
 * APIs used, read from node_modules/zod/v4/mini/schemas.d.ts and
 * node_modules/zod/v4/core: `discriminatedUnion`, `strictObject`, `record`,
 * `exactOptional`, `json`, `union`, `nullable`, `literal`, `array`, `tuple`
 * with rest, `pipe`, `.check()`, `refine`, `minLength`, `maxLength`,
 * `safeParse`, the `$ZodErrorMap` and `$ZodRawIssue` types, and `ParsePayload`
 * for the cross-field check.
 */

import * as z from "zod/mini";
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

type ErrorMap = z.core.$ZodErrorMap;
type RawIssue = z.core.$ZodRawIssue;

const NOT_OBJECT = (input: unknown) =>
  `The request must be a JSON object with "primitive", "state", and "questions", not ${describeKind(input)}.`;
const ADD_STATE = `Add a "state" field with the text, object, or list to evaluate.`;
const ADD_QUESTIONS = `Add a "questions" object with at least one question, keyed by an id of your choosing.`;

/** `questions.tone` → `tone`: the question an issue belongs to, read from its finished path. */
function questionIdOf(issue: RawIssue): string {
  return String(issue.path?.[1]);
}

/** `The default "criteria"` or `The "criteria" of question "tone"`, read from the finished path. */
function whereOf(issue: RawIssue): string {
  const path = issue.path ?? [];
  return path[0] === "criteria"
    ? `The default "criteria"`
    : `The "criteria" of question "${String(path[1])}"`;
}

/** The key an issue is about: the last path segment. */
function keyOf(issue: RawIssue): string {
  return String(issue.path?.at(-1));
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Text, an object, or a list, with the wording of the place it is used in. */
export function content(error?: ErrorMap) {
  const json = z.json();
  return z.union([z.string(), z.array(json), z.record(z.string(), json)], { error });
}

/** A description that may be `null`, with the wording of the place it is used in. */
export function description(error?: ErrorMap) {
  return z.nullable(content(error));
}

const state = content((issue) =>
  issue.input === undefined
    ? ADD_STATE
    : `"state" must be text, an object, or a list, not ${describeKind(issue.input)}.`,
).check(z.refine(isNotBlank, `"state" is empty. Add the text, object, or list to evaluate.`));

const instructions = content((issue) =>
  issue.input === undefined
    ? `Question "${questionIdOf(issue)}" has no "instructions". Add the question you want answered.`
    : `The "instructions" of question "${questionIdOf(issue)}" must be text, an object, or a list, not ${describeKind(issue.input)}.`,
).check(
  z.refine(isNotBlank, {
    error: (issue) =>
      `The "instructions" of question "${questionIdOf(issue)}" are empty. Write the question you want answered.`,
  }),
);

const noulDescription = content(
  (issue) =>
    `The "${keyOf(issue)}" description in ${whereOf(issue)} must be text, an object, or a list, not ${describeKind(issue.input)}.`,
);

const noulCriteria = z.strictObject(
  { true: z.exactOptional(noulDescription), false: z.exactOptional(noulDescription) },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? unknownFieldMessage(whereOf(issue), issue.keys[0], NOUL_CRITERIA_KEYS)
        : `${whereOf(issue)} must be an object with optional "true" and "false" descriptions, not ${describeKind(issue.input)}.`,
  },
);

const optionDescription = description(
  (issue) =>
    `The description of option "${keyOf(issue)}" in ${whereOf(issue)} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`,
);

function choiceCriteria({ min, max }: Readonly<CountRange>) {
  const count = (issue: RawIssue) => Object.keys(issue.input as object).length;
  return z
    .record(z.string(), optionDescription, {
      error: (issue) =>
        `${whereOf(issue)} must be an object that maps each option name to its description, not ${describeKind(issue.input)}.`,
    })
    .check(
      z.refine((options) => Object.keys(options).length >= min, {
        error: (issue) =>
          `${whereOf(issue)} needs at least ${countOf(min, "option")} to choose between. It has ${count(issue)}.`,
      }),
      z.refine((options) => max === undefined || Object.keys(options).length <= max, {
        error: (issue) => `${whereOf(issue)} has ${count(issue)} options. Use at most ${max}.`,
      }),
      z.refine((options) => Object.keys(options).every((name) => name.trim() !== ""), {
        error: (issue) => `${whereOf(issue)} has an option with an empty name. Give it a name.`,
      }),
    );
}

const levelDescription = description(
  (issue) =>
    `Level ${keyOf(issue)} in ${whereOf(issue)} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`,
);

function scoreCriteria({ min, max }: Readonly<CountRange>) {
  const length = (issue: RawIssue) => (issue.input as unknown[]).length;
  // The length checks run before the tuple, so a short list is reported as "too few levels"
  // at the list's own path instead of as missing items at `criteria.1`. `z.pipe` stops at
  // the first side's issues.
  const list = z
    .array(z.unknown(), {
      error: (issue) =>
        `${whereOf(issue)} must be a list of level descriptions, lowest level first, not ${describeKind(issue.input)}.`,
    })
    .check(
      z.minLength(min, {
        error: (issue) =>
          `${whereOf(issue)} needs at least ${countOf(min, "level")} to score between. It has ${length(issue)}.`,
      }),
      ...(max === undefined
        ? []
        : [
            z.maxLength(max, {
              error: (issue) =>
                `${whereOf(issue)} has ${length(issue)} levels. Use at most ${max}.`,
            }),
          ]),
    );
  return z.pipe(list, z.tuple([levelDescription, levelDescription], levelDescription));
}

type CriteriaSchema = z.ZodMiniType;

function questionsSchema<TCriteria extends CriteriaSchema>(
  criteria: TCriteria,
  questionNameMaxLength: number | undefined,
) {
  const questionId = z
    .string()
    .check(
      z.refine(
        (id) => questionNameMaxLength === undefined || characterCount(id) <= questionNameMaxLength,
      ),
    );
  const question = z.strictObject(
    { instructions, criteria: z.exactOptional(criteria) },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? unknownFieldMessage(`Question "${questionIdOf(issue)}"`, issue.keys[0], QUESTION_KEYS)
          : `Question "${questionIdOf(issue)}" must be an object with "instructions" and optional "criteria", not ${describeKind(issue.input)}.`,
    },
  );
  return z
    .record(questionId, question, {
      // A failed key arrives as `invalid_key` with the key as `input`; the record's own map
      // words it, because the key schema's issue is nested inside.
      error: (issue) =>
        issue.code === "invalid_key" && typeof issue.input === "string"
          ? idTooLongMessage(issue.input, questionNameMaxLength ?? Number.POSITIVE_INFINITY)
          : ADD_QUESTIONS,
    })
    .check(
      z.refine((questions) => Object.keys(questions).length > 0, ADD_QUESTIONS),
      // A key issue would carry the path `questions.` for an empty id; the reference reports
      // `questions`, so the rule sits on the record itself.
      z.refine(
        (questions) => Object.keys(questions).every((id) => id.trim() !== ""),
        `Every question needs a non-empty id.`,
      ),
    );
}

function requestFor<TPrimitive extends string, TCriteria extends CriteriaSchema>(
  primitive: TPrimitive,
  criteria: TCriteria,
  capabilities: ProviderCapabilities,
) {
  return z.strictObject(
    {
      primitive: z.literal(primitive),
      state,
      criteria: z.exactOptional(criteria),
      questions: questionsSchema(criteria, capabilities.questionNameMaxLength),
    },
    {
      error: (issue) =>
        issue.code === "unrecognized_keys"
          ? unknownFieldMessage("The request", issue.keys[0], REQUEST_KEYS)
          : NOT_OBJECT(issue.input),
    },
  );
}

/** Builds the request schema for one provider's limits. */
export function decisionRequestSchema(capabilities: ProviderCapabilities) {
  return (
    z
      .discriminatedUnion(
        "primitive",
        [
          requestFor("noul", noulCriteria, capabilities),
          requestFor("choice", choiceCriteria(capabilities.choiceOptions), capabilities),
          requestFor("score", scoreCriteria(capabilities.scoreLevels), capabilities),
        ],
        {
          error: (issue) => {
            // The declared issue type of a discriminated union is `invalid_union` only, but its
            // parser also raises `invalid_type` for a non-object input (node_modules/zod/v4/core/
            // schemas.js, `$ZodDiscriminatedUnion`), hence the negative test.
            if (issue.code !== "invalid_union") return NOT_OBJECT(issue.input);
            const primitive = (issue.input as Record<string, unknown>).primitive;
            const received =
              typeof primitive === "string" ? `"${primitive}"` : describeKind(primitive);
            return `Set "primitive" to ${quoteChoices(PRIMITIVES)}. It is currently ${received}.`;
          },
        },
      )
      // Cross-field rule: a Choice or Score question needs criteria from one of two places.
      // `.check` with a payload is Zod's way to add an issue with a path chosen at run time.
      .check((payload) => {
        const request = payload.value;
        if (request.primitive === "noul" || request.criteria !== undefined) return;
        for (const [id, question] of Object.entries(request.questions)) {
          if (question.criteria !== undefined) continue;
          const kind = request.primitive === "choice" ? "options" : "levels";
          payload.issues.push({
            code: "custom",
            input: request,
            path: ["questions", id, "criteria"],
            message: `Question "${id}" has no criteria. Add "criteria" with its ${kind} to the question, or a default "criteria" at the top of the request.`,
          });
          return;
        }
      })
  );
}

export type DecisionRequestSchema = ReturnType<typeof decisionRequestSchema>;

/** The validated request: a union discriminated on `primitive`, inferred from the schema. */
export type ValidDecisionRequest = z.output<DecisionRequestSchema>;

export type ValidationResult = { ok: true; value: ValidDecisionRequest } | ValidationFailure;

/**
 * Same signature and result shape as the reference `validateDecisionRequest`.
 *
 * Two WORKAROUNDS in the result mapping. An `unrecognized_keys` issue sits on the object
 * and lists the keys separately, so the key is appended to make `questions.greeting.type`.
 * The dot path is joined by hand because `z.core.toDotPath` writes numbers as `[0]` and
 * today's paths use `criteria.0`.
 */
export function validateDecisionRequest(
  input: unknown,
  capabilities: ProviderCapabilities,
): ValidationResult {
  const result = decisionRequestSchema(capabilities).safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  const [issue] = result.error.issues;
  const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
  const failure: ValidationFailure = { ok: false, error: issue.message };
  if (path.length > 0) failure.detail = path.map(String).join(".");
  return failure;
}
