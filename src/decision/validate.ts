/**
 * Validation for the JSON a panel posts to `/api/jev`.
 *
 * Pure, so it runs in the browser (to check a textarea before sending) and on
 * the server (to guard the TypeSafe call).
 *
 * The request is a Zod Mini schema (ADR-0004) built from a provider's
 * capabilities. Every message sits on the schema that raises it, as an `error`
 * function. A message can name the enclosing question because Zod words an
 * issue only after every parent has added its key to `issue.path`
 * (`finalizeIssue` in node_modules/zod/v4/core/util.js), and the
 * error-customisation guide says the function "receives the issue, so it can
 * use input, code, path, and other properties" (https://zod.dev/error-customization).
 *
 * Grammar source: https://docs.typesafe.ai/api.md and the `@typesafe-ai/sdk`
 * `EntryType`, `NoulQuestion`, `ChoiceQuestion`, and `ScoreQuestion` types.
 * Zod Mini APIs used, read from node_modules/zod/v4/mini/schemas.d.ts and
 * checks.d.ts and node_modules/zod/v4/core/errors.d.ts: `discriminatedUnion`,
 * `strictObject`, `record`, `exactOptional`, `literal`, `array`, `unknown`,
 * `tuple` with a rest item, `pipe`, `.check()`, `refine`, `minLength`,
 * `maxLength`, `safeParse`, and the `$ZodErrorMap` and `$ZodRawIssue` types.
 */

import * as z from "zod/mini";
import { KEEP_ALIVE_SECONDS, content, description } from "./contract.ts";
import type { WarmRequest } from "./contract.ts";
import { characterCount, countOf, idTooLongMessage } from "./count.ts";
import { isPlainObject } from "./json.ts";
import type { CountRange, ProviderCapabilities } from "../providers/catalog.ts";

/**
 * The primitives a request can name, for the message that lists them. Not
 * checked against `Primitive` here, because `Primitive` is inferred from the
 * schema whose message uses this list; `contract.type-check.ts` checks it.
 */
export const PRIMITIVES = ["noul", "choice", "score"] as const;

export type ValidationFailure = {
  ok: false;
  /** User-facing explanation of what is wrong and how to fix it. */
  error: string;
  /** Where in the request the problem is, as a dotted path. */
  detail?: string;
};

const REQUEST_KEYS = ["primitive", "state", "criteria", "questions"] as const;
const QUESTION_KEYS = ["instructions", "criteria"] as const;
const NOUL_CRITERIA_KEYS = ["true", "false"] as const;

type RawIssue = z.core.$ZodRawIssue;

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

/** Plain-language name for a value's kind, for "…, not a number" style messages. */
function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return `${value}`;
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/** `"a", "b", and "c"`: how a message lists the fields an object may contain. */
function quoteList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

/** `"a", "b", or "c"`: how a message lists the values a field may take. */
function quoteChoices(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

/** The message for an unknown field, with a hint when the field is `type`. */
function unknownFieldMessage(where: string, key: string, allowed: readonly string[]): string {
  const hint =
    key === "type" ? ` The primitive is set once, with "primitive" at the top of the request.` : "";
  return `${where} has an unknown field "${key}". It can only contain ${quoteList(allowed)}.${hint}`;
}

/** Text must hold more than whitespace. Objects and lists always pass. */
function isNotBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() !== "";
}

const NOT_AN_OBJECT = (input: unknown) =>
  `The request must be a JSON object with "primitive", "state", and "questions", not ${describeKind(input)}.`;
const ADD_STATE = `Add a "state" field with the text, object, or list to evaluate.`;
const ADD_QUESTIONS = `Add a "questions" object with at least one question, keyed by an id of your choosing.`;

// Messages read where they are from the finished path: `questions.<id>.…` or `criteria.…`.

/** `questions.tone.criteria` → `tone`: the question an issue belongs to. */
function questionIdOf(issue: RawIssue): string {
  return String(issue.path?.[1]);
}

/** `The default "criteria"` or `The "criteria" of question "tone"`. */
function criteriaPlaceOf(issue: RawIssue): string {
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
// The parts every provider shares
// ---------------------------------------------------------------------------

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
    `The "${keyOf(issue)}" description in ${criteriaPlaceOf(issue)} must be text, an object, or a list, not ${describeKind(issue.input)}.`,
);

const noulCriteria = z.strictObject(
  { true: z.exactOptional(noulDescription), false: z.exactOptional(noulDescription) },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? unknownFieldMessage(criteriaPlaceOf(issue), issue.keys[0], NOUL_CRITERIA_KEYS)
        : `${criteriaPlaceOf(issue)} must be an object with optional "true" and "false" descriptions, not ${describeKind(issue.input)}.`,
  },
);

const optionDescription = description(
  (issue) =>
    `The description of option "${keyOf(issue)}" in ${criteriaPlaceOf(issue)} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`,
);

const levelDescription = description(
  (issue) =>
    `Level ${keyOf(issue)} in ${criteriaPlaceOf(issue)} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`,
);

// ---------------------------------------------------------------------------
// The parts a provider's capabilities limit
// ---------------------------------------------------------------------------

/**
 * Choice criteria: option name to description. Zod has no record-size check,
 * so the option count is a `refine` with the limits in a closure.
 */
function choiceCriteria({ min, max }: Readonly<CountRange>) {
  const optionCount = (issue: RawIssue) => Object.keys(issue.input as object).length;
  return z
    .record(z.string(), optionDescription, {
      error: (issue) =>
        `${criteriaPlaceOf(issue)} must be an object that maps each option name to its description, not ${describeKind(issue.input)}.`,
    })
    .check(
      z.refine((options) => Object.keys(options).length >= min, {
        error: (issue) =>
          `${criteriaPlaceOf(issue)} needs at least ${countOf(min, "option")} to choose between. It has ${optionCount(issue)}.`,
      }),
      z.refine((options) => max === undefined || Object.keys(options).length <= max, {
        error: (issue) =>
          `${criteriaPlaceOf(issue)} has ${optionCount(issue)} options. Use at most ${max}.`,
      }),
      z.refine((options) => Object.keys(options).every((name) => name.trim() !== ""), {
        error: (issue) =>
          `${criteriaPlaceOf(issue)} has an option with an empty name. Give it a name.`,
      }),
    );
}

/**
 * Score criteria: level descriptions, lowest first. The length checks run
 * before the tuple, so a short list is reported as too few levels at the list's
 * own path rather than as a missing item at `criteria.1`; `z.pipe` stops at the
 * first side's issues. The tuple of two plus a rest item keeps the inferred
 * type at least two levels long, whatever a provider's range says.
 */
function scoreCriteria({ min, max }: Readonly<CountRange>) {
  const levelCount = (issue: RawIssue) => (issue.input as unknown[]).length;
  const list = z
    .array(z.unknown(), {
      error: (issue) =>
        `${criteriaPlaceOf(issue)} must be a list of level descriptions, lowest level first, not ${describeKind(issue.input)}.`,
    })
    .check(
      z.minLength(min, {
        error: (issue) =>
          `${criteriaPlaceOf(issue)} needs at least ${countOf(min, "level")} to score between. It has ${levelCount(issue)}.`,
      }),
      ...(max === undefined
        ? []
        : [
            z.maxLength(max, {
              error: (issue) =>
                `${criteriaPlaceOf(issue)} has ${levelCount(issue)} levels. Use at most ${max}.`,
            }),
          ]),
    );
  return z.pipe(list, z.tuple([levelDescription, levelDescription], levelDescription));
}

/** The questions record, keyed by question id, with the provider's id-length limit. */
function questionsSchema<C extends z.ZodMiniType>(
  criteria: C,
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
      // A key that fails its schema arrives as one `invalid_key` issue whose `input` is the
      // key, so the record words it rather than the key schema.
      error: (issue) =>
        issue.code === "invalid_key" && typeof issue.input === "string"
          ? idTooLongMessage(issue.input, questionNameMaxLength ?? Number.POSITIVE_INFINITY)
          : ADD_QUESTIONS,
    })
    .check(
      z.refine((questions) => Object.keys(questions).length > 0, ADD_QUESTIONS),
      // On the record rather than the key schema, because a key issue for an empty id would
      // carry the path `questions.` and the message belongs at `questions`.
      z.refine(
        (questions) => Object.keys(questions).every((id) => id.trim() !== ""),
        `Every question needs a non-empty id.`,
      ),
    );
}

function requestFor<P extends string, C extends z.ZodMiniType>(
  primitive: P,
  criteria: C,
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
          : NOT_AN_OBJECT(issue.input),
    },
  );
}

/** Builds the request schema for one provider's limits. */
function decisionRequestSchema(capabilities: ProviderCapabilities) {
  return z
    .discriminatedUnion(
      "primitive",
      [
        requestFor("noul", noulCriteria, capabilities),
        requestFor("choice", choiceCriteria(capabilities.choiceOptions), capabilities),
        requestFor("score", scoreCriteria(capabilities.scoreLevels), capabilities),
      ],
      {
        error: (issue) => {
          // The declared issue type is `invalid_union` only, but the parser also raises
          // `invalid_type` for an input that is not an object (`$ZodDiscriminatedUnion` in
          // node_modules/zod/v4/core/schemas.js), hence the negative test.
          if (issue.code !== "invalid_union") return NOT_AN_OBJECT(issue.input);
          const primitive = (issue.input as Record<string, unknown>).primitive;
          const received =
            typeof primitive === "string" ? `"${primitive}"` : describeKind(primitive);
          return `Set "primitive" to ${quoteChoices(PRIMITIVES)}. It is currently ${received}.`;
        },
      },
    )
    .check((payload) => {
      // A Choice or Score question needs criteria on itself or a default at the top.
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
    });
}

type DecisionRequestSchema = ReturnType<typeof decisionRequestSchema>;

/**
 * A validated request, inferred from the schema and discriminated on
 * `primitive`, so narrowing it also narrows every criteria shape.
 */
export type ValidDecisionRequest = z.output<DecisionRequestSchema>;

export type ValidationResult = { ok: true; value: ValidDecisionRequest } | ValidationFailure;

/**
 * One schema per capabilities object. The catalog's descriptors are long-lived,
 * so each provider's schema is built once; a `WeakMap` lets a capabilities
 * object made for a single call, as the tests do, be collected with its schema.
 * A capabilities object must not be changed after its first use, because the
 * schema read its limits when it was built.
 */
const schemas = new WeakMap<ProviderCapabilities, DecisionRequestSchema>();

function schemaFor(capabilities: ProviderCapabilities): DecisionRequestSchema {
  let schema = schemas.get(capabilities);
  if (schema === undefined) {
    schema = decisionRequestSchema(capabilities);
    schemas.set(capabilities, schema);
  }
  return schema;
}

/**
 * Check that `value` is a request `/api/jev` can send to a provider.
 *
 * The limits on options, levels, and question ids come from `capabilities`.
 * Reports the first problem and explains how to fix it.
 */
export function validateDecisionRequest(
  value: unknown,
  capabilities: ProviderCapabilities,
): ValidationResult {
  const result = schemaFor(capabilities).safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  const [issue] = result.error.issues;
  // An unknown-field issue sits on the object and names the field in `keys`, so the field
  // is added to the path to point at it, as in `questions.greeting.type`.
  const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
  const failure: ValidationFailure = { ok: false, error: issue.message };
  // Joined by hand: `z.core.toDotPath` writes a list index as `[0]`, and paths here read `criteria.0`.
  if (path.length > 0) failure.detail = path.map(String).join(".");
  return failure;
}

export type WarmValidationResult = { ok: true; value: WarmRequest } | ValidationFailure;

const WARM_KEYS = ["keepAliveSeconds"] as const;

/** Check that `value` is a body `/api/jev/warm` accepts: one of the offered keep-alive durations. */
export function validateWarmRequest(value: unknown): WarmValidationResult {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: `The request must be a JSON object with "keepAliveSeconds", not ${describeKind(value)}.`,
    };
  }
  const unknownKey = Object.keys(value).find((key) => !WARM_KEYS.some((known) => known === key));
  if (unknownKey !== undefined) {
    return {
      ok: false,
      error: `The request has an unknown field "${unknownKey}". It can only contain "keepAliveSeconds".`,
      detail: unknownKey,
    };
  }
  const keepAliveSeconds = KEEP_ALIVE_SECONDS.find((seconds) => seconds === value.keepAliveSeconds);
  if (keepAliveSeconds === undefined) {
    const received = value.keepAliveSeconds;
    return {
      ok: false,
      error: `"keepAliveSeconds" must be ${KEEP_ALIVE_SECONDS.slice(0, -1).join(", ")}, or ${KEEP_ALIVE_SECONDS.at(-1)} seconds, not ${typeof received === "number" ? received : describeKind(received)}.`,
      detail: "keepAliveSeconds",
    };
  }
  return { ok: true, value: { keepAliveSeconds } };
}
