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
 * `object`, `strictObject`, `record`, `optional`, `exactOptional`, `literal`,
 * `unknown`, `custom`, `transform`, `tuple` with a rest item, `pipe`,
 * `.check()`, `refine`, `minLength`, `maxLength`, `safeParse`, and the
 * `$ZodErrorMap`, `$ZodRawIssue`, and `$ZodIssue` types. How a record reports a
 * failed key (`invalid_key`, with the key as the last path segment, and its
 * value skipped) and how an object treats a present `undefined` were read from
 * `$ZodRecord` and `handlePropertyResult` in node_modules/zod/v4/core/schemas.js.
 */

import * as z from "zod/mini";
import { KEEP_ALIVE_SECONDS, content, description } from "./contract.ts";
import type { WarmRequest } from "./contract.ts";
import { characterCount, countOf, idTooLongMessage } from "./count.ts";
import { isPlainObject } from "./json.ts";
import type { CountRange, ProviderCapabilities } from "../providers/catalog.ts";
import { isPlaceholder } from "../providers/placeholder.ts";

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

/**
 * "an unknown field \"statee\"", or just "an unknown field" when the name is
 * the Deploy button's placeholder, which is never echoed (see
 * `src/providers/placeholder.ts`). Both validators name unknown fields with it.
 */
function unknownField(key: string): string {
  return isPlaceholder(key) ? "an unknown field" : `an unknown field "${key}"`;
}

/** The first field an unknown-field issue names. Zod only raises this issue for at least one key. */
function firstUnknownKey(issue: { keys: readonly string[] }): string {
  const [key] = issue.keys;
  if (key === undefined) throw new Error("Zod reported unknown fields without naming one.");
  return key;
}

/** The message for an unknown field, with a hint when the field is `type`. */
function unknownFieldMessage(where: string, key: string, allowed: readonly string[]): string {
  const hint =
    key === "type" ? ` The primitive is set once, with "primitive" at the top of the request.` : "";
  return `${where} has ${unknownField(key)}. It can only contain ${quoteList(allowed)}.${hint}`;
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

const stateContent = content((issue) =>
  issue.input === undefined
    ? ADD_STATE
    : `"state" must be text, an object, or a list, not ${describeKind(issue.input)}.`,
);
const stateNotBlank = stateContent.check(
  z.refine(isNotBlank, `"state" is empty. Add the text, object, or list to evaluate.`),
);
const stateNotBlankOrImage = stateContent.check(
  z.refine(
    isNotBlank,
    `"state" is empty. Add the text, object, or list to evaluate, or attach an image.`,
  ),
);

/**
 * `state` may be blank when images go with the request, because the images are
 * then what the questions ask about. Without images it needs content, and the
 * message offers an image only where the provider takes one.
 */
function stateSchema(capabilities: ProviderCapabilities, imageCount: number) {
  if (imageCount > 0) return stateContent;
  return capabilities.images === false ? stateNotBlank : stateNotBlankOrImage;
}

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

/** `{ a: 1, b: undefined }` → `{ a: 1 }`: a field set to `undefined` counts as absent. */
function withoutUndefined(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/**
 * Runs `schema` on an object only after checking that every field is one of
 * `keys`, and drops the fields set to `undefined` first.
 *
 * Why a stage of its own: an unknown field is often a typo ("statee",
 * "instruction", or "type" in a question), and the message that names it is
 * the useful one, so it has to win over the "missing field" message the typo
 * also causes. Zod checks an object's known fields before its unknown keys, and
 * a discriminated union with a mistyped "primitive" never reaches its members'
 * keys at all, so `schema` alone would report the missing field instead. A
 * field set to `undefined` is treated as absent, so a request built in memory
 * can leave optional criteria `undefined`.
 *
 * `error` words both of this stage's problems: a value that is not an object,
 * and an `unrecognized_keys` issue, whose first key it names.
 */
function knownFieldsFirst<S extends z.core.$ZodType<unknown, Record<string, unknown>>>(
  keys: readonly string[],
  error: z.core.$ZodErrorMap,
  schema: S,
) {
  const known = z.strictObject(
    Object.fromEntries(keys.map((key) => [key, z.optional(z.unknown())])),
    { error },
  );
  return z.pipe(z.pipe(known, z.transform(withoutUndefined)), schema);
}

const noulCriteria = knownFieldsFirst(
  NOUL_CRITERIA_KEYS,
  (issue) =>
    issue.code === "unrecognized_keys"
      ? unknownFieldMessage(criteriaPlaceOf(issue), firstUnknownKey(issue), NOUL_CRITERIA_KEYS)
      : `${criteriaPlaceOf(issue)} must be an object with optional "true" and "false" descriptions, not ${describeKind(issue.input)}.`,
  z.object({ true: z.exactOptional(noulDescription), false: z.exactOptional(noulDescription) }),
);

const optionDescription = description(
  (issue) =>
    `The description of option "${keyOf(issue)}" in ${criteriaPlaceOf(issue)} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`,
);

const levelDescription = description(
  (issue) =>
    `Level ${keyOf(issue)} in ${criteriaPlaceOf(issue)} must be text, an object, a list, or null, not ${describeKind(issue.input)}.`,
);

/** A name or id that holds more than whitespace. */
const nonBlankKey = z.string().check(z.refine((key) => key.trim() !== ""));

// ---------------------------------------------------------------------------
// The parts a provider's capabilities limit
// ---------------------------------------------------------------------------

/**
 * Choice criteria: option name to description. Zod has no record-size check,
 * so the option count is a `refine` with the limits in a closure. The count is
 * checked in a first stage, before any option, and each option's name before
 * its description, which is the order the messages had before the schemas.
 */
function choiceCriteria({ min, max }: Readonly<CountRange>) {
  const optionCount = (issue: RawIssue) => Object.keys(issue.input as object).length;
  const counted = z
    .record(z.string(), z.unknown(), {
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
    );
  const options = z.record(nonBlankKey, optionDescription, {
    // A blank name is the only way the key schema fails.
    error: (issue) => `${criteriaPlaceOf(issue)} has an option with an empty name. Give it a name.`,
  });
  return z.pipe(counted, options);
}

/** The fewest levels a Score question can have, whatever a provider's range says. */
const SCORE_LEVEL_FLOOR = 2;

/** `["Cold", , "Hot"]` → `["Cold", null, "Hot"]`: a hole in a list is an undescribed level. */
function holesAsNull(levels: unknown[]): unknown[] {
  return Array.from(levels, (level, index) => (index in levels ? level : null));
}

/**
 * Score criteria: level descriptions, lowest first. The length checks run
 * before the tuple, so a short list is reported as too few levels at the list's
 * own path rather than as a missing item at `criteria.1`; `z.pipe` stops at the
 * first side's issues. The tuple of two plus a rest item keeps the inferred type
 * at least two levels long, and the floor check keeps the runtime there too when
 * a provider's minimum is lower. A hole in the list, which only a request built
 * in memory can have, becomes `null`; an explicit `undefined` is still refused.
 */
function scoreCriteria({ min, max }: Readonly<CountRange>) {
  const levelCount = (issue: RawIssue) => (issue.input as unknown[]).length;
  const list = z
    .custom<unknown[]>((value) => Array.isArray(value), {
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
      z.minLength(SCORE_LEVEL_FLOOR, {
        error: (issue) =>
          `${criteriaPlaceOf(issue)} needs at least ${SCORE_LEVEL_FLOOR} levels to score between.`,
      }),
    );
  return z.pipe(
    z.pipe(list, z.transform(holesAsNull)),
    z.tuple([levelDescription, levelDescription], levelDescription),
  );
}

/** The questions record, keyed by question id, with the provider's id-length limit. */
function questionsSchema<C extends z.ZodMiniType>(
  criteria: C,
  questionNameMaxLength: number | undefined,
) {
  const questionId = nonBlankKey.check(
    z.refine(
      (id) => questionNameMaxLength === undefined || characterCount(id) <= questionNameMaxLength,
    ),
  );
  const question = knownFieldsFirst(
    QUESTION_KEYS,
    (issue) =>
      issue.code === "unrecognized_keys"
        ? unknownFieldMessage(
            `Question "${questionIdOf(issue)}"`,
            firstUnknownKey(issue),
            QUESTION_KEYS,
          )
        : `Question "${questionIdOf(issue)}" must be an object with "instructions" and optional "criteria", not ${describeKind(issue.input)}.`,
    z.object({ instructions, criteria: z.exactOptional(criteria) }),
  );
  return z
    .record(questionId, question, {
      // A key that fails its schema arrives as one `invalid_key` issue whose `input` is the
      // key, so the record words it rather than the key schema. The record checks each id
      // before its question, so an empty id is named even when its question is broken too.
      error: (issue) => {
        if (issue.code !== "invalid_key") return ADD_QUESTIONS;
        // The key is the last segment of the issue's path, `questions.<id>`.
        const id = keyOf(issue);
        return id.trim() === ""
          ? `Every question needs a non-empty id.`
          : idTooLongMessage(id, questionNameMaxLength ?? Number.POSITIVE_INFINITY);
      },
    })
    .check(z.refine((questions) => Object.keys(questions).length > 0, ADD_QUESTIONS));
}

function requestFor<P extends string, C extends z.ZodMiniType>(
  primitive: P,
  criteria: C,
  capabilities: ProviderCapabilities,
  imageCount: number,
) {
  return z.object({
    primitive: z.literal(primitive),
    state: stateSchema(capabilities, imageCount),
    criteria: z.exactOptional(criteria),
    questions: questionsSchema(criteria, capabilities.questionNameMaxLength),
  });
}

/** Builds the request schema for one provider's limits and the number of images sent with it. */
function decisionRequestSchema(capabilities: ProviderCapabilities, imageCount: number) {
  const request = z
    .discriminatedUnion(
      "primitive",
      [
        requestFor("noul", noulCriteria, capabilities, imageCount),
        requestFor("choice", choiceCriteria(capabilities.choiceOptions), capabilities, imageCount),
        requestFor("score", scoreCriteria(capabilities.scoreLevels), capabilities, imageCount),
      ],
      {
        error: (issue) => {
          // The declared issue type is `invalid_union` only, but the parser also raises
          // `invalid_type` for an input that is not an object (`$ZodDiscriminatedUnion` in
          // node_modules/zod/v4/core/schemas.js). `knownFieldsFirst` rejects such an input
          // before this schema runs, but the error map still has to word it.
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
      const value = payload.value;
      if (value.primitive === "noul" || value.criteria !== undefined) return;
      for (const [id, question] of Object.entries(value.questions)) {
        if (question.criteria !== undefined) continue;
        const kind = value.primitive === "choice" ? "options" : "levels";
        payload.issues.push({
          code: "custom",
          input: value,
          path: ["questions", id, "criteria"],
          message: `Question "${id}" has no criteria. Add "criteria" with its ${kind} to the question, or a default "criteria" at the top of the request.`,
        });
        return;
      }
    });
  return knownFieldsFirst(
    REQUEST_KEYS,
    (issue) =>
      issue.code === "unrecognized_keys"
        ? unknownFieldMessage("The request", firstUnknownKey(issue), REQUEST_KEYS)
        : NOT_AN_OBJECT(issue.input),
    request,
  );
}

type DecisionRequestSchema = ReturnType<typeof decisionRequestSchema>;

/**
 * A validated request, inferred from the schema and discriminated on
 * `primitive`, so narrowing it also narrows every criteria shape.
 */
export type ValidDecisionRequest = z.output<DecisionRequestSchema>;

export type ValidationResult = { ok: true; value: ValidDecisionRequest } | ValidationFailure;

/**
 * One schema per distinct set of limits, keyed by the limits the schema reads.
 * Keying by value rather than by the capabilities object means a changed limit
 * takes effect on the next call, as it did when the limits were read on every
 * call, while the providers that share limits share one schema. The number of
 * entries is the number of distinct limit sets in use, a handful in practice.
 */
const schemas = new Map<string, DecisionRequestSchema>();

function limitsKey(
  { choiceOptions, scoreLevels, questionNameMaxLength, images }: ProviderCapabilities,
  imageCount: number,
) {
  return JSON.stringify([
    choiceOptions.min,
    choiceOptions.max ?? null,
    scoreLevels.min,
    scoreLevels.max ?? null,
    questionNameMaxLength ?? null,
    images !== false,
    imageCount > 0,
  ]);
}

/**
 * The request schema for `capabilities`' limits and a request sent with
 * `imageCount` images, built on first use and reused after that.
 */
export function requestSchemaFor(
  capabilities: ProviderCapabilities,
  imageCount = 0,
): DecisionRequestSchema {
  const key = limitsKey(capabilities, imageCount);
  let schema = schemas.get(key);
  if (schema === undefined) {
    schema = decisionRequestSchema(capabilities, imageCount);
    schemas.set(key, schema);
  }
  return schema;
}

const TOO_DEEP = `The request is nested too deeply to check. Use fewer levels of lists and objects inside each other.`;

/**
 * Check that `value` is a request `/api/jev` can send to a provider.
 *
 * The limits on options, levels, and question ids come from `capabilities`.
 * `imageCount` is how many images go to the provider with the request; with
 * one or more, `state` may be blank. Reports the first problem and explains
 * how to fix it.
 */
export function validateDecisionRequest(
  value: unknown,
  capabilities: ProviderCapabilities,
  imageCount = 0,
): ValidationResult {
  let result: ReturnType<DecisionRequestSchema["safeParse"]>;
  try {
    result = requestSchemaFor(capabilities, imageCount).safeParse(value);
  } catch (error) {
    // Zod checks nested JSON by recursion, so thousands of levels exhaust the call stack.
    // That is a problem with the request, not a crash, and is reported like any other.
    if (error instanceof RangeError) return { ok: false, error: TOO_DEEP };
    throw error;
  }
  if (result.success) return { ok: true, value: result.data };
  const [issue] = result.error.issues;
  if (issue === undefined) throw new Error("Zod reported a failed check without an issue.");
  const failure: ValidationFailure = { ok: false, error: issue.message };
  const path = pathOf(issue);
  // Joined by hand: `z.core.toDotPath` writes a list index as `[0]`, and paths here read `criteria.0`.
  if (path.length > 0) failure.detail = path.map(String).join(".");
  return failure;
}

/** Where an issue points, adjusted so a dotted path can show it. */
function pathOf(issue: z.core.$ZodIssue): PropertyKey[] {
  // An unknown-field issue sits on the object and names the field in `keys`, so the field
  // is added to point at it, as in `questions.greeting.type`.
  // A field named like the placeholder is left out of the path, so it is never echoed.
  if (issue.code === "unrecognized_keys") {
    const key = firstUnknownKey(issue);
    return isPlaceholder(key) ? issue.path : [...issue.path, key];
  }
  // A blank key cannot be read at the end of a dotted path (`questions.`), so an empty
  // question id or option name is reported at its record, `questions` or `criteria`.
  if (issue.code === "invalid_key" && String(issue.path.at(-1)).trim() === "") {
    return issue.path.slice(0, -1);
  }
  return issue.path;
}

export type WarmValidationResult = { ok: true; value: WarmRequest } | ValidationFailure;

const WARM_KEYS = ["keepAliveSeconds"] as const;

/** Check that `value` is a body `POST /api/warm/{provider}` accepts: one of the offered keep-alive durations. */
export function validateWarmRequest(value: unknown): WarmValidationResult {
  if (!isPlainObject(value)) {
    return {
      ok: false,
      error: `The request must be a JSON object with "keepAliveSeconds", not ${describeKind(value)}.`,
    };
  }
  const unknownKey = Object.keys(value).find((key) => !WARM_KEYS.some((known) => known === key));
  if (unknownKey !== undefined) {
    const error = `The request has ${unknownField(unknownKey)}. It can only contain "keepAliveSeconds".`;
    return isPlaceholder(unknownKey)
      ? { ok: false, error }
      : { ok: false, error, detail: unknownKey };
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
