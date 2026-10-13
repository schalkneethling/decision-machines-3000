/**
 * Validation for the JSON a panel posts to `/api/jev`.
 *
 * Pure and dependency-free so it runs in the browser (to check a textarea
 * before sending) and on the server (to guard the TypeSafe call).
 *
 * Grammar source: https://docs.typesafe.ai/api.md and the `@typesafe-ai/sdk`
 * `EntryType`, `NoulQuestion`, `ChoiceQuestion`, and `ScoreQuestion` types.
 */

import { KEEP_ALIVE_SECONDS } from "./contract.ts";
import { isPlainObject } from "./json.ts";
import type { ProviderCapabilities } from "../providers/catalog.ts";
import type {
  ChoiceCriteria,
  Content,
  CriteriaByPrimitive,
  DecisionRequest,
  JsonValue,
  NoulCriteria,
  Primitive,
  QuestionInput,
  ScoreCriteria,
  WarmRequest,
} from "./contract.ts";

export const PRIMITIVES = ["noul", "choice", "score"] as const satisfies readonly Primitive[];

/** A criteria description; `null` leaves the outcome undescribed. */
type Description = Content | null;

/** A validated request, discriminated on `primitive`, so narrowing it also narrows every criteria shape. */
export type ValidDecisionRequest = { [P in Primitive]: DecisionRequest<P> }[Primitive];

export type ValidationFailure = {
  ok: false;
  /** User-facing explanation of what is wrong and how to fix it. */
  error: string;
  /** Where in the request the problem is, as a dotted path. */
  detail?: string;
};

export type ValidationResult = { ok: true; value: ValidDecisionRequest } | ValidationFailure;

const REQUEST_KEYS = ["primitive", "state", "criteria", "questions"] as const;
const QUESTION_KEYS = ["instructions", "criteria"] as const;
const NOUL_CRITERIA_KEYS = ["true", "false"] as const;

type PlainObject = Record<string, unknown>;

/** Thrown internally to stop at the first problem; never escapes `validateDecisionRequest`. */
class ValidationError extends Error {
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "ValidationError";
    this.detail = detail;
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (isPlainObject(value)) {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function isContent(value: unknown): value is Content {
  return (
    (typeof value === "string" || typeof value === "object") && value !== null && isJsonValue(value)
  );
}

function isDescription(value: unknown): value is Description {
  return value === null || isContent(value);
}

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

function quoteList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

function quoteChoices(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

function rejectUnknownKeys(
  value: PlainObject,
  allowed: readonly string[],
  where: string,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    const hint =
      key === "type"
        ? ` The primitive is set once, with "primitive" at the top of the request.`
        : "";
    throw new ValidationError(
      `${where} has an unknown field "${key}". It can only contain ${quoteList(allowed)}.${hint}`,
      path ? `${path}.${key}` : key,
    );
  }
}

function readPrimitive(value: unknown): Primitive {
  const primitive = PRIMITIVES.find((candidate) => candidate === value);
  if (primitive === undefined) {
    const received = typeof value === "string" ? `"${value}"` : describeKind(value);
    throw new ValidationError(
      `Set "primitive" to ${quoteChoices(PRIMITIVES)}. It is currently ${received}.`,
      "primitive",
    );
  }
  return primitive;
}

function readState(value: unknown): Content {
  if (value === undefined) {
    throw new ValidationError(
      `Add a "state" field with the text, object, or list to evaluate.`,
      "state",
    );
  }
  if (!isContent(value)) {
    throw new ValidationError(
      `"state" must be text, an object, or a list, not ${describeKind(value)}.`,
      "state",
    );
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new ValidationError(
      `"state" is empty. Add the text, object, or list to evaluate.`,
      "state",
    );
  }
  return value;
}

function readInstructions(value: unknown, questionId: string): Content {
  const path = `questions.${questionId}.instructions`;
  if (value === undefined) {
    throw new ValidationError(
      `Question "${questionId}" has no "instructions". Add the question you want answered.`,
      path,
    );
  }
  if (!isContent(value)) {
    throw new ValidationError(
      `The "instructions" of question "${questionId}" must be text, an object, or a list, not ${describeKind(value)}.`,
      path,
    );
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new ValidationError(
      `The "instructions" of question "${questionId}" are empty. Write the question you want answered.`,
      path,
    );
  }
  return value;
}

function requireContent(value: unknown, label: string, path: string): Content {
  if (!isContent(value)) {
    throw new ValidationError(
      `${label} must be text, an object, or a list, not ${describeKind(value)}.`,
      path,
    );
  }
  return value;
}

function requireDescription(value: unknown, label: string, path: string): Description {
  if (!isDescription(value)) {
    throw new ValidationError(
      `${label} must be text, an object, a list, or null, not ${describeKind(value)}.`,
      path,
    );
  }
  return value;
}

function readNoulCriteria(value: unknown, where: string, path: string): NoulCriteria {
  if (!isPlainObject(value)) {
    throw new ValidationError(
      `${where} must be an object with optional "true" and "false" descriptions, not ${describeKind(value)}.`,
      path,
    );
  }
  rejectUnknownKeys(value, NOUL_CRITERIA_KEYS, where, path);
  const criteria: NoulCriteria = {};
  for (const key of NOUL_CRITERIA_KEYS) {
    if (value[key] === undefined) continue;
    criteria[key] = requireContent(
      value[key],
      `The "${key}" description in ${where}`,
      `${path}.${key}`,
    );
  }
  return criteria;
}

function readChoiceCriteria(
  value: unknown,
  where: string,
  path: string,
  { min, max }: ProviderCapabilities["choiceOptions"],
): ChoiceCriteria {
  if (!isPlainObject(value)) {
    throw new ValidationError(
      `${where} must be an object that maps each option name to its description, not ${describeKind(value)}.`,
      path,
    );
  }
  const options = Object.keys(value);
  if (options.length < min) {
    throw new ValidationError(
      `${where} needs at least ${min} options to choose between. It has ${options.length}.`,
      path,
    );
  }
  if (max !== undefined && options.length > max) {
    throw new ValidationError(`${where} has ${options.length} options. Use at most ${max}.`, path);
  }
  const criteria: ChoiceCriteria = {};
  for (const option of options) {
    if (option.trim() === "") {
      throw new ValidationError(`${where} has an option with an empty name. Give it a name.`, path);
    }
    criteria[option] = requireDescription(
      value[option],
      `The description of option "${option}" in ${where}`,
      `${path}.${option}`,
    );
  }
  return criteria;
}

function readScoreCriteria(
  value: unknown,
  where: string,
  path: string,
  { min, max }: ProviderCapabilities["scoreLevels"],
): ScoreCriteria {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `${where} must be a list of level descriptions, lowest level first, not ${describeKind(value)}.`,
      path,
    );
  }
  if (value.length < min) {
    throw new ValidationError(
      `${where} needs at least ${min} levels to score between. It has ${value.length}.`,
      path,
    );
  }
  if (max !== undefined && value.length > max) {
    throw new ValidationError(`${where} has ${value.length} levels. Use at most ${max}.`, path);
  }
  // The tuple type needs two levels, so a provider range can never loosen the floor below 2.
  if (value.length < 2) {
    throw new ValidationError(`${where} needs at least 2 levels to score between.`, path);
  }
  const [first, second, ...rest] = value.map((level: unknown, index) =>
    requireDescription(level, `Level ${index} in ${where}`, `${path}.${index}`),
  );
  return [first, second, ...rest];
}

function readCriteria<P extends Primitive>(
  primitive: P,
  value: unknown,
  where: string,
  path: string,
  capabilities: ProviderCapabilities,
): CriteriaByPrimitive[P];
function readCriteria(
  primitive: Primitive,
  value: unknown,
  where: string,
  path: string,
  capabilities: ProviderCapabilities,
): CriteriaByPrimitive[Primitive] {
  switch (primitive) {
    case "noul":
      return readNoulCriteria(value, where, path);
    case "choice":
      return readChoiceCriteria(value, where, path, capabilities.choiceOptions);
    case "score":
      return readScoreCriteria(value, where, path, capabilities.scoreLevels);
  }
}

function readRequest<P extends Primitive>(
  primitive: P,
  body: PlainObject,
  capabilities: ProviderCapabilities,
): DecisionRequest<P> {
  const state = readState(body.state);

  const defaultCriteria =
    body.criteria === undefined
      ? undefined
      : readCriteria(primitive, body.criteria, `The default "criteria"`, "criteria", capabilities);

  if (!isPlainObject(body.questions) || Object.keys(body.questions).length === 0) {
    throw new ValidationError(
      `Add a "questions" object with at least one question, keyed by an id of your choosing.`,
      "questions",
    );
  }

  const questions: Record<string, QuestionInput<P>> = {};
  for (const [questionId, rawQuestion] of Object.entries(body.questions)) {
    const path = `questions.${questionId}`;
    if (questionId.trim() === "") {
      throw new ValidationError(`Every question needs a non-empty id.`, "questions");
    }
    const { questionNameMaxLength } = capabilities;
    if (questionNameMaxLength !== undefined && questionId.length > questionNameMaxLength) {
      throw new ValidationError(
        `Question id "${questionId}" is ${questionId.length} characters long. Use at most ${questionNameMaxLength}.`,
        path,
      );
    }
    if (!isPlainObject(rawQuestion)) {
      throw new ValidationError(
        `Question "${questionId}" must be an object with "instructions" and optional "criteria", not ${describeKind(rawQuestion)}.`,
        path,
      );
    }
    rejectUnknownKeys(rawQuestion, QUESTION_KEYS, `Question "${questionId}"`, path);

    const question: QuestionInput<P> = {
      instructions: readInstructions(rawQuestion.instructions, questionId),
    };
    if (rawQuestion.criteria !== undefined) {
      question.criteria = readCriteria(
        primitive,
        rawQuestion.criteria,
        `The "criteria" of question "${questionId}"`,
        `${path}.criteria`,
        capabilities,
      );
    } else if (primitive !== "noul" && defaultCriteria === undefined) {
      const kind = primitive === "choice" ? "options" : "levels";
      throw new ValidationError(
        `Question "${questionId}" has no criteria. Add "criteria" with its ${kind} to the question, or a default "criteria" at the top of the request.`,
        `${path}.criteria`,
      );
    }
    questions[questionId] = question;
  }

  const request: DecisionRequest<P> = { primitive, state, questions };
  if (defaultCriteria !== undefined) {
    request.criteria = defaultCriteria;
  }
  return request;
}

/**
 * Check that `value` is a request `/api/jev` can send to a provider.
 *
 * The limits on options, levels, and question ids come from `capabilities`.
 * Stops at the first problem and explains how to fix it.
 */
export function validateDecisionRequest(
  value: unknown,
  capabilities: ProviderCapabilities,
): ValidationResult {
  try {
    if (!isPlainObject(value)) {
      throw new ValidationError(
        `The request must be a JSON object with "primitive", "state", and "questions", not ${describeKind(value)}.`,
      );
    }
    rejectUnknownKeys(value, REQUEST_KEYS, "The request", "");
    const primitive = readPrimitive(value.primitive);
    return { ok: true, value: readRequestFor(primitive, value, capabilities) };
  } catch (error) {
    if (error instanceof ValidationError) {
      const failure: ValidationFailure = { ok: false, error: error.message };
      if (error.detail !== undefined) {
        failure.detail = error.detail;
      }
      return failure;
    }
    throw error;
  }
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

/** Keeps `primitive` and the criteria shapes correlated in the returned union member. */
function readRequestFor(
  primitive: Primitive,
  body: PlainObject,
  capabilities: ProviderCapabilities,
): ValidDecisionRequest {
  switch (primitive) {
    case "noul":
      return readRequest(primitive, body, capabilities);
    case "choice":
      return readRequest(primitive, body, capabilities);
    case "score":
      return readRequest(primitive, body, capabilities);
  }
}
