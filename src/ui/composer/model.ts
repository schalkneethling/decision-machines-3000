/**
 * The branch composer's view-model: a request reshaped for tree editing.
 *
 * `toViewModel` turns a validated request into rows with stable keys, collapsing
 * repeated per-item questions into one fan-out question. `toRequest` turns the rows
 * back into the request the JSON view shows and Run sends. Neither touches the DOM.
 *
 * The operations further down (add, remove, move, override) mutate the model they
 * are given; the tree calls them and re-renders.
 */

import type {
  ChoiceCriteria,
  Content,
  CriteriaByPrimitive,
  JevRequest,
  JsonValue,
  NoulCriteria,
  Primitive,
  ScoreCriteria,
} from "../../jev/contract.ts";
import { isPlainObject } from "../../jev/json.ts";
import { MAX_CHOICE_OPTIONS, MAX_SCORE_LEVELS } from "../../jev/validate.ts";
import type { ValidJevRequest } from "../../jev/validate.ts";

/** A criteria description; `null` leaves the outcome undescribed. */
export type Description = Content | null;

export type OptionRow = {
  key: string;
  name: string;
  description: Description;
};

export type LevelRow = {
  key: string;
  description: Description;
};

export type CriteriaModel =
  | { kind: "noul"; meanings: NoulCriteria }
  | { kind: "choice"; options: OptionRow[] }
  | { kind: "score"; levels: LevelRow[] };

export type QuestionModel = {
  key: string;
  /** The question id, or the id prefix when the question fans out. */
  id: string;
  /** For a fan-out question, text with `{{item}}` where each item's path goes. */
  instructions: Content;
  /** Own criteria; `undefined` inherits the shared criteria. */
  criteria?: CriteriaModel;
  /** Top-level array key in the state to ask this question for, once per item. */
  fanOut?: string;
};

export type ComposerModel = {
  primitive: Primitive;
  state: Content;
  /** Request-level criteria that questions without their own inherit. */
  criteria?: CriteriaModel;
  questions: QuestionModel[];
  /** Next number for a row key; keys stay unique for the model's lifetime. */
  nextKey: number;
};

/**
 * The request the tree currently describes. Typed loosely because a request
 * being edited can be incomplete; `validateJevRequest` narrows it before sending.
 */
export type DraftRequest = {
  primitive: Primitive;
  state: Content;
  criteria?: DraftCriteria;
  questions: Record<string, DraftQuestion>;
};

export type DraftCriteria = NoulCriteria | ChoiceCriteria | Description[];

export type DraftQuestion = {
  instructions: Content;
  criteria?: DraftCriteria;
};

/** Slugs for question ids and option names. */
export const SLUG_PATTERN = /^[a-z0-9_]+$/;

/** `{{item}}` or `{{item.some.path}}` in fan-out instructions. */
const PLACEHOLDER_PATTERN = /\{\{item((?:\.[A-Za-z_][A-Za-z0-9_]*)*)\}\}/g;

/** Top-level keys usable in a backticked path such as `films[0]`. */
const PATH_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* Keys */

function takeKey(model: Pick<ComposerModel, "nextKey">, prefix: string): string {
  const key = `${prefix}${model.nextKey}`;
  model.nextKey += 1;
  return key;
}

/* Content as text: how state, instructions, and descriptions appear in a field */

/** Text for a field: strings as they are, structured content as indented JSON. */
export function contentText(value: Description | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

/** Parses `text` as a JSON object or array; anything else is `undefined`. */
function parseStructured(text: string): Content | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    // JSON.parse only ever produces JSON values, so the narrowing below is sound.
    const parsed = JSON.parse(trimmed) as JsonValue;
    if (Array.isArray(parsed) || isPlainObject(parsed)) return parsed;
  } catch {
    // Not JSON: the caller keeps the text.
  }
  return undefined;
}

export type StateReading = "json" | "text";

/** State typed into the tree: a JSON object or array when it parses as one, otherwise the text. */
export function readStateText(text: string): { state: Content; reading: StateReading } {
  const structured = parseStructured(text);
  return structured === undefined
    ? { state: text, reading: "text" }
    : { state: structured, reading: "json" };
}

export function stateReading(state: Content): StateReading {
  return typeof state === "string" ? "text" : "json";
}

/**
 * Instructions or a description typed into a field. Read the same way as the
 * state on every edit: a JSON object or array when the text parses as one,
 * otherwise the text. So content that stops parsing mid-edit becomes structured
 * again as soon as it parses.
 */
export function readContentText(text: string): Content {
  return readStateText(text).state;
}

/**
 * Whether a field's reading is worth pointing out: text that starts like JSON
 * could be either, so the field says which it was read as. Plain prose is only
 * ever text.
 */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** The hint for a field whose text looks like JSON. */
export function readingHint(value: Content): string {
  return typeof value === "string" ? "Read as text." : "Read as JSON.";
}

/** Top-level keys of the state whose value is a list, in state order. */
export function arrayKeys(state: Content): string[] {
  if (!isPlainObject(state)) return [];
  return Object.entries(state)
    .filter(([key, value]) => Array.isArray(value) && PATH_KEY_PATTERN.test(key))
    .map(([key]) => key);
}

function arrayLength(state: Content, key: string): number | undefined {
  if (!isPlainObject(state)) return undefined;
  const value = state[key];
  return Array.isArray(value) ? value.length : undefined;
}

/* Fan-out */

export function hasPlaceholder(template: string): boolean {
  return new RegExp(PLACEHOLDER_PATTERN.source).test(template);
}

/** Instructions for item `index`: `{{item}}` becomes `` `path[index]` ``, `{{item.x}}` becomes `` `path[index].x` ``. */
export function expandTemplate(template: string, path: string, index: number): string {
  return template.replace(
    new RegExp(PLACEHOLDER_PATTERN.source, "g"),
    (_match, rest: string) => `\`${path}[${index}]${rest}\``,
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The inverse of `expandTemplate` for one item. */
function toTemplate(instructions: string, path: string, index: number): string {
  const itemPath = new RegExp(
    `\`${escapeRegExp(path)}\\[${index}\\]((?:\\.[A-Za-z_][A-Za-z0-9_]*)*)\``,
    "g",
  );
  return instructions.replace(itemPath, (_match, rest: string) => `{{item${rest}}}`);
}

/** The ids a question sends: its own, or one per item for a fan-out. */
export function expandedIds(question: QuestionModel, state: Content): string[] {
  if (question.fanOut === undefined) return [question.id];
  const length = arrayLength(state, question.fanOut) ?? 0;
  return Array.from({ length }, (_, index) => `${question.id}_${index}`);
}

/* Request -> view-model */

function optionRows(model: Pick<ComposerModel, "nextKey">, criteria: ChoiceCriteria): OptionRow[] {
  return Object.entries(criteria).map(([name, description]) => ({
    key: takeKey(model, "o"),
    name,
    description,
  }));
}

function levelRows(model: Pick<ComposerModel, "nextKey">, criteria: ScoreCriteria): LevelRow[] {
  return criteria.map((description) => ({ key: takeKey(model, "l"), description }));
}

/** Deep equality for parsed JSON: object key order is ignored, array order is not. */
function sameContent(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameContent(item, b[index]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && sameContent(a[key], b[key]))
    );
  }
  return a === b;
}

type SourceQuestion = {
  instructions: Content;
  criteria?: unknown;
};

type QuestionEntry = [id: string, question: SourceQuestion];

type FanOutMatch = {
  id: string;
  path: string;
  template: string;
  count: number;
};

/**
 * Whether a panel offers "ask for each item in" expansion. A Noul asks one yes/no
 * statement about the state as a whole, so it never fans out.
 */
export function supportsFanOut(primitive: Primitive): boolean {
  return primitive !== "noul";
}

/**
 * Looks for `<id>_0 … <id>_<n-1>` starting at `start`, one per item of a top-level
 * array in the state, whose instructions differ only by that item's path.
 */
function matchFanOut(
  entries: QuestionEntry[],
  start: number,
  state: Content,
): FanOutMatch | undefined {
  const [firstId] = entries[start];
  const idMatch = /^([a-z0-9_]+)_0$/.exec(firstId);
  if (idMatch === null) return undefined;
  const id = idMatch[1];

  for (const path of arrayKeys(state)) {
    const count = arrayLength(state, path) ?? 0;
    if (count < 2 || start + count > entries.length) continue;
    const run = entries.slice(start, start + count);

    const templates = run.map(([questionId, question], index) =>
      questionId === `${id}_${index}` && typeof question.instructions === "string"
        ? toTemplate(question.instructions, path, index)
        : undefined,
    );
    const [template] = templates;
    if (template === undefined || !hasPlaceholder(template)) continue;
    if (!templates.every((candidate) => candidate === template)) continue;

    const criteria = run[0][1].criteria;
    if (!run.every(([, question]) => sameContent(question.criteria, criteria))) continue;

    const expandsBack = run.every(
      ([, question], index) => expandTemplate(template, path, index) === question.instructions,
    );
    if (!expandsBack) continue;

    return { id, path, template, count };
  }
  return undefined;
}

function buildModel<P extends Primitive>(
  request: JevRequest<P>,
  toCriteria: (model: ComposerModel, criteria: CriteriaByPrimitive[P]) => CriteriaModel,
): ComposerModel {
  const model: ComposerModel = {
    primitive: request.primitive,
    state: request.state,
    questions: [],
    nextKey: 0,
  };
  if (request.criteria !== undefined) {
    model.criteria = toCriteria(model, request.criteria);
  }

  const entries = Object.entries(request.questions);
  let index = 0;
  while (index < entries.length) {
    const fanOut = supportsFanOut(request.primitive)
      ? matchFanOut(entries, index, request.state)
      : undefined;
    const [id, source] = entries[index];
    const question: QuestionModel = fanOut
      ? {
          key: takeKey(model, "q"),
          id: fanOut.id,
          instructions: fanOut.template,
          fanOut: fanOut.path,
        }
      : { key: takeKey(model, "q"), id, instructions: source.instructions };
    if (source.criteria !== undefined) {
      question.criteria = toCriteria(model, source.criteria);
    }
    model.questions.push(question);
    index += fanOut ? fanOut.count : 1;
  }
  return model;
}

/** Reshapes a valid request for the tree. Per-item questions collapse into one fan-out question. */
export function toViewModel(request: ValidJevRequest): ComposerModel {
  switch (request.primitive) {
    case "noul":
      return buildModel(request, (_model, meanings) => ({
        kind: "noul",
        meanings: { ...meanings },
      }));
    case "choice":
      return buildModel(request, (model, criteria) => ({
        kind: "choice",
        options: optionRows(model, criteria),
      }));
    case "score":
      return buildModel(request, (model, criteria) => ({
        kind: "score",
        levels: levelRows(model, criteria),
      }));
  }
}

/* View-model -> request */

function draftCriteria(criteria: CriteriaModel): DraftCriteria {
  switch (criteria.kind) {
    case "noul":
      return { ...criteria.meanings };
    case "choice":
      return Object.fromEntries(
        criteria.options.map((option) => [option.name, option.description]),
      );
    case "score":
      return criteria.levels.map((level) => level.description);
  }
}

/** The request the tree describes, with fan-out questions expanded to one question per item. */
export function toRequest(model: ComposerModel): DraftRequest {
  const questions: Record<string, DraftQuestion> = {};
  for (const question of model.questions) {
    const criteria = question.criteria === undefined ? undefined : draftCriteria(question.criteria);
    const ids = expandedIds(question, model.state);
    ids.forEach((id, index) => {
      const instructions =
        question.fanOut !== undefined && typeof question.instructions === "string"
          ? expandTemplate(question.instructions, question.fanOut, index)
          : question.instructions;
      questions[id] = criteria === undefined ? { instructions } : { instructions, criteria };
    });
  }

  return model.criteria === undefined
    ? { primitive: model.primitive, state: model.state, questions }
    : {
        primitive: model.primitive,
        state: model.state,
        criteria: draftCriteria(model.criteria),
        questions,
      };
}

/* Issues: what stops the tree from making a request Jev accepts */

/**
 * Where an issue shows: next to the row with `key`. `field` names the control
 * that is wrong; `list` means the row's option or level list as a whole.
 */
export type Issue = {
  key: string;
  field: "state" | "id" | "instructions" | "fanOut" | "name" | "list" | "criteria";
  message: string;
};

/** The row key issues about the state attach to. */
export const STATE_KEY = "state";
/** The row key issues about the shared criteria attach to. */
export const SHARED_KEY = "shared";
/** The row key issues about the question list as a whole attach to. */
export const QUESTIONS_KEY = "questions";

function isBlank(value: Content): boolean {
  return typeof value === "string" && value.trim() === "";
}

function criteriaIssues(criteria: CriteriaModel, ownerKey: string, where: string): Issue[] {
  const issues: Issue[] = [];
  if (criteria.kind === "choice") {
    const { options } = criteria;
    if (options.length < 2) {
      issues.push({
        key: ownerKey,
        field: "list",
        message: `${where} need at least two options. Add ${options.length === 0 ? "two" : "one more"}.`,
      });
    }
    if (options.length > MAX_CHOICE_OPTIONS) {
      issues.push({
        key: ownerKey,
        field: "list",
        message: `${where} have ${options.length} options. Jev accepts at most ${MAX_CHOICE_OPTIONS}.`,
      });
    }
    const seen = new Set<string>();
    for (const option of options) {
      if (option.name === "") {
        issues.push({ key: option.key, field: "name", message: "Give this option a name." });
      } else if (!SLUG_PATTERN.test(option.name)) {
        issues.push({
          key: option.key,
          field: "name",
          message: "Option names use lowercase letters, digits, and underscores only.",
        });
      } else if (seen.has(option.name)) {
        issues.push({
          key: option.key,
          field: "name",
          message: `Another option is already called "${option.name}". Give this one a different name.`,
        });
      }
      seen.add(option.name);
    }
  }
  if (criteria.kind === "score") {
    const { levels } = criteria;
    if (levels.length < 2) {
      issues.push({
        key: ownerKey,
        field: "list",
        message: `${where} need at least two levels. Add ${levels.length === 0 ? "two" : "one more"}.`,
      });
    }
    if (levels.length > MAX_SCORE_LEVELS) {
      issues.push({
        key: ownerKey,
        field: "list",
        message: `${where} have ${levels.length} levels. Jev accepts at most ${MAX_SCORE_LEVELS}. Remove ${levels.length - MAX_SCORE_LEVELS}.`,
      });
    }
  }
  return issues;
}

function fanOutIssues(question: QuestionModel, state: Content): Issue[] {
  const path = question.fanOut;
  if (path === undefined) return [];
  const length = arrayLength(state, path);
  if (length === undefined) {
    return [
      {
        key: question.key,
        field: "fanOut",
        message: `The state has no list called "${path}". Pick a list from the state or ask once.`,
      },
    ];
  }
  if (length === 0) {
    return [
      {
        key: question.key,
        field: "fanOut",
        message: `The list "${path}" in the state is empty, so nothing would be asked. Add items or ask once.`,
      },
    ];
  }
  if (typeof question.instructions !== "string" || !hasPlaceholder(question.instructions)) {
    return [
      {
        key: question.key,
        field: "instructions",
        message: "Write {{item}} in the instructions where each item goes.",
      },
    ];
  }
  return [];
}

/** Every problem in the model, in tree order, so the first one is the first a reader meets. */
export function findIssues(model: ComposerModel): Issue[] {
  const issues: Issue[] = [];

  if (isBlank(model.state)) {
    issues.push({
      key: STATE_KEY,
      field: "state",
      message: "The state is empty. Add the text, object, or list Jev should evaluate.",
    });
  }

  const noun = model.primitive === "score" ? "levels" : "options";
  if (model.criteria !== undefined) {
    issues.push(...criteriaIssues(model.criteria, SHARED_KEY, `Shared ${noun}`));
  }

  if (model.questions.length === 0) {
    issues.push({
      key: QUESTIONS_KEY,
      field: "list",
      message: "Add at least one question.",
    });
  }

  const owners = new Map<string, string[]>();
  for (const question of model.questions) {
    for (const id of expandedIds(question, model.state)) {
      owners.set(id, [...(owners.get(id) ?? []), question.key]);
    }
  }

  for (const question of model.questions) {
    if (question.id === "") {
      issues.push({ key: question.key, field: "id", message: "Give this question an id." });
    } else if (!SLUG_PATTERN.test(question.id)) {
      issues.push({
        key: question.key,
        field: "id",
        message: "Question ids use lowercase letters, digits, and underscores only.",
      });
    } else {
      const clash = expandedIds(question, model.state).find(
        (id) => (owners.get(id) ?? []).length > 1,
      );
      if (clash !== undefined) {
        issues.push({
          key: question.key,
          field: "id",
          message: `Another question also uses the id "${clash}". Give this one a different id.`,
        });
      }
    }

    if (isBlank(question.instructions)) {
      issues.push({
        key: question.key,
        field: "instructions",
        message: "Write the question you want Jev to answer.",
      });
    }
    issues.push(...fanOutIssues(question, model.state));

    if (question.criteria !== undefined) {
      issues.push(...criteriaIssues(question.criteria, question.key, `This question's ${noun}`));
    } else if (model.primitive !== "noul" && model.criteria === undefined) {
      issues.push({
        key: question.key,
        field: "criteria",
        message: `This question has no ${noun}. Add ${noun} for it, or add shared ${noun}.`,
      });
    }
  }

  return issues;
}

/* Operations the tree performs */

function emptyCriteria(model: ComposerModel): CriteriaModel {
  switch (model.primitive) {
    case "noul":
      return { kind: "noul", meanings: {} };
    case "choice":
      return {
        kind: "choice",
        options: [
          { key: takeKey(model, "o"), name: "", description: null },
          { key: takeKey(model, "o"), name: "", description: null },
        ],
      };
    case "score":
      return {
        kind: "score",
        levels: [
          { key: takeKey(model, "l"), description: null },
          { key: takeKey(model, "l"), description: null },
        ],
      };
  }
}

/** A copy of `criteria` with fresh row keys, so the copy edits independently. */
export function copyCriteria(model: ComposerModel, criteria: CriteriaModel): CriteriaModel {
  switch (criteria.kind) {
    case "noul":
      return { kind: "noul", meanings: structuredClone(criteria.meanings) };
    case "choice":
      return {
        kind: "choice",
        options: criteria.options.map((option) => ({
          key: takeKey(model, "o"),
          name: option.name,
          description: structuredClone(option.description),
        })),
      };
    case "score":
      return {
        kind: "score",
        levels: criteria.levels.map((level) => ({
          key: takeKey(model, "l"),
          description: structuredClone(level.description),
        })),
      };
  }
}

/** Appends a question with an unused id. It inherits shared criteria when there are any. */
export function addQuestion(model: ComposerModel): QuestionModel {
  const taken = new Set(model.questions.flatMap((question) => expandedIds(question, model.state)));
  let number = model.questions.length + 1;
  while (taken.has(`question_${number}`)) number += 1;

  const question: QuestionModel = {
    key: takeKey(model, "q"),
    id: `question_${number}`,
    instructions: "",
  };
  if (model.primitive !== "noul" && model.criteria === undefined) {
    question.criteria = emptyCriteria(model);
  }
  model.questions.push(question);
  return question;
}

/** Gives the question its own criteria: a copy of the shared ones, or an empty set to fill in. */
export function overrideCriteria(model: ComposerModel, question: QuestionModel): CriteriaModel {
  const criteria =
    model.criteria === undefined ? emptyCriteria(model) : copyCriteria(model, model.criteria);
  question.criteria = criteria;
  return criteria;
}

/** Drops the question's own criteria so it inherits the shared ones again. */
export function inheritCriteria(question: QuestionModel): void {
  delete question.criteria;
}

/** Adds request-level criteria that every question without its own inherits. */
export function addSharedCriteria(model: ComposerModel): CriteriaModel {
  const criteria = emptyCriteria(model);
  model.criteria = criteria;
  return criteria;
}

/**
 * Removes the request-level criteria. Questions that inherited them keep a copy,
 * so no question changes meaning.
 */
export function removeSharedCriteria(model: ComposerModel): void {
  const shared = model.criteria;
  if (shared === undefined) return;
  for (const question of model.questions) {
    if (question.criteria === undefined) {
      question.criteria = copyCriteria(model, shared);
    }
  }
  delete model.criteria;
}

export function addOption(model: ComposerModel, criteria: { options: OptionRow[] }): OptionRow {
  const option: OptionRow = { key: takeKey(model, "o"), name: "", description: null };
  criteria.options.push(option);
  return option;
}

export function addLevel(model: ComposerModel, criteria: { levels: LevelRow[] }): LevelRow {
  const level: LevelRow = { key: takeKey(model, "l"), description: null };
  criteria.levels.push(level);
  return level;
}

/** Removes the item with `key`; returns its former index, or -1 when it is not there. */
export function removeByKey<T extends { key: string }>(list: T[], key: string): number {
  const index = list.findIndex((item) => item.key === key);
  if (index !== -1) list.splice(index, 1);
  return index;
}

/**
 * Moves the item with `key` one place up (`-1`) or down (`1`).
 * Returns its new index, or -1 when it cannot move that way.
 */
export function moveByKey<T extends { key: string }>(list: T[], key: string, step: -1 | 1): number {
  const from = list.findIndex((item) => item.key === key);
  const to = from + step;
  if (from === -1 || to < 0 || to >= list.length) return -1;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  return to;
}
