/**
 * The branch composer: renders a `ComposerModel` as a tree of fields and keeps
 * the model in step with every edit.
 *
 * Typing updates the model in place and only touches the edited row's derived
 * text and the issue messages. Adding, removing, or moving a row re-renders the
 * whole tree, then puts focus back where the reader expects it.
 */

import type { Primitive } from "../../jev/contract.ts";
import {
  addQuestion,
  addSharedCriteria,
  arrayKeys,
  supportsFanOut,
  contentText,
  expandedIds,
  findIssues,
  inheritCriteria,
  moveByKey,
  overrideCriteria,
  QUESTIONS_KEY,
  readContentText,
  readStateText,
  removeByKey,
  removeSharedCriteria,
  SHARED_KEY,
  STATE_KEY,
  stateReading,
} from "./model.ts";
import type { ComposerModel, CriteriaModel, Issue, QuestionModel } from "./model.ts";
import { create } from "../dom.ts";
import {
  addLevelButton,
  addOptionButton,
  elementId,
  issueSlot,
  levelList,
  meaningList,
  movableRow,
  optionList,
  previousFocus,
  rowActions,
  textButton,
  textField,
} from "./rows.ts";
import type { FocusTarget, RowContext, StructuralChange } from "./rows.ts";

export type ComposerOptions = {
  /** Prefix for element ids, unique per panel. */
  prefix: string;
  model: ComposerModel;
  /** Speaks a change through the panel's status line. */
  announce: (message: string) => void;
  /** The model changed; the panel re-derives its request. */
  onChange: () => void;
};

export type Composer = {
  element: HTMLElement;
  model(): ComposerModel;
  setModel(model: ComposerModel): void;
  /** Shows every issue, not only those in rows already edited, and returns them in tree order. */
  revealIssues(): Issue[];
  /** Moves focus to the control an issue is about. */
  focusIssue(issue: Issue): void;
};

/** What the shared and per-question criteria are called in each primitive. */
const CRITERIA_NOUN: Record<Primitive, string> = {
  noul: "yes/no meaning",
  choice: "options",
  score: "levels",
};

const FAN_OUT_NONE = "";

function criteriaCount(criteria: CriteriaModel): string {
  switch (criteria.kind) {
    case "noul": {
      const count = Object.keys(criteria.meanings).length;
      return count === 0
        ? "the shared yes/no meaning, which is empty"
        : "the shared yes/no meaning";
    }
    case "choice":
      return `the shared ${criteria.options.length} options`;
    case "score":
      return `the shared ${criteria.levels.length} levels`;
  }
}

function fanOutHint(question: QuestionModel, model: ComposerModel): string {
  const ids = expandedIds(question, model.state);
  const first = ids[0];
  const last = ids.at(-1);
  const sends =
    first === undefined || last === undefined
      ? "Sends nothing until the list has items."
      : ids.length === 1
        ? `Sends one question, ${first}.`
        : `Sends ${ids.length} questions, ${first} to ${last}.`;
  return `Write {{item}} where the item goes, or {{item.field}} for one of its fields. ${sends}`;
}

function stateHint(model: ComposerModel): string {
  if (stateReading(model.state) === "text") {
    return "Read as text.";
  }
  const lists = arrayKeys(model.state);
  return lists.length === 0
    ? "Read as JSON."
    : `Read as JSON. Questions can ask about each item in ${lists.join(", ")}.`;
}

export function createComposer(options: ComposerOptions): Composer {
  const { prefix, announce, onChange } = options;
  let model = options.model;
  const element = create("div", { className: "tree" });
  /** Rows whose issues show; the rest wait until they are edited or Run reveals them. */
  let touched = new Set<string>();
  let revealAll = false;

  /*
   * References into the rendered tree, collected once per render so typing never
   * searches the DOM. `shown` mirrors what the issue slots and aria-invalid
   * currently say, so an edit writes only to rows whose issues changed.
   */
  let slots = new Map<string, HTMLElement>();
  let fields = new Map<string, HTMLElement[]>();
  let questionParts = new Map<string, QuestionParts>();
  let stateHintElement: HTMLElement | null = null;
  let shown = new Map<string, ShownIssues>();

  const ctx: RowContext = {
    prefix,
    get model() {
      return model;
    },
    edited(key) {
      touched.add(key);
      onChange();
      refreshDerived(key);
      showIssues();
    },
    structural,
  };

  function structural(change: StructuralChange): void {
    change.apply();
    if (change.touches !== undefined) touched.add(change.touches);
    render();
    focusFirst(change.focus());
    announce(change.announce);
    onChange();
  }

  function focusFirst(targets: FocusTarget[]): void {
    for (const { key, control } of targets) {
      const found = element.querySelector<HTMLElement>(
        `[data-for="${CSS.escape(key)}"][data-control="${CSS.escape(control)}"]`,
      );
      if (found && !(found instanceof HTMLButtonElement && found.disabled)) {
        found.focus();
        return;
      }
    }
  }

  /* Issues */

  function collectReferences(): void {
    slots = new Map();
    for (const slot of element.querySelectorAll<HTMLElement>("[data-issue-for]")) {
      slots.set(slot.dataset.issueFor ?? "", slot);
    }
    fields = new Map();
    for (const control of element.querySelectorAll<HTMLElement>("[data-field]")) {
      const key = control.dataset.for ?? "";
      fields.set(key, [...(fields.get(key) ?? []), control]);
    }
    const byId = new Map<string, HTMLElement>();
    for (const node of element.querySelectorAll<HTMLElement>("[id]")) byId.set(node.id, node);
    questionParts = new Map();
    for (const question of model.questions) {
      const select = byId.get(elementId(prefix, question.key, "fan-out"));
      questionParts.set(question.key, {
        legendId: byId.get(elementId(prefix, question.key, "legend-id")) ?? null,
        fanOutField: byId.get(elementId(prefix, question.key, "fan-out-field")) ?? null,
        select: select instanceof HTMLSelectElement ? select : null,
        hint: byId.get(elementId(prefix, question.key, "fan-out-hint")) ?? null,
      });
    }
    stateHintElement = byId.get(elementId(prefix, STATE_KEY, "state-hint")) ?? null;
    // A fresh render shows no issues yet.
    shown = new Map();
  }

  /**
   * Brings the issue slots and aria-invalid in line with the model. Finding the
   * issues is plain data work over the model; the DOM is written only for rows
   * whose messages or invalid fields differ from what they show now.
   */
  function showIssues(): Issue[] {
    const issues = findIssues(model);
    const next = new Map<string, ShownIssues>();
    for (const issue of issues) {
      if (!revealAll && !touched.has(issue.key)) continue;
      const entry = next.get(issue.key) ?? { message: "", fields: new Set<string>() };
      entry.message = entry.message === "" ? issue.message : `${entry.message} ${issue.message}`;
      entry.fields.add(issue.field);
      next.set(issue.key, entry);
    }

    for (const key of new Set([...shown.keys(), ...next.keys()])) {
      const before = shown.get(key);
      const after = next.get(key);
      if (before?.message !== after?.message) {
        const slot = slots.get(key);
        if (slot) {
          slot.textContent = after?.message ?? "";
          slot.hidden = after === undefined;
        }
      }
      if (!sameFields(before?.fields, after?.fields)) {
        for (const control of fields.get(key) ?? []) {
          if (after?.fields.has(control.dataset.field ?? "")) {
            control.setAttribute("aria-invalid", "true");
          } else {
            control.removeAttribute("aria-invalid");
          }
        }
      }
    }
    shown = next;
    return issues;
  }

  function focusIssue(issue: Issue): void {
    const controls: Record<Issue["field"], string> = {
      state: "state",
      id: "id",
      instructions: "instructions",
      fanOut: "fan-out",
      name: "name",
      list: "add",
      criteria: "override",
    };
    focusFirst([{ key: issue.key, control: controls[issue.field] }]);
  }

  /*
   * Text that depends on other fields, updated in place while typing. An edit to
   * a question refreshes only that question; an edit to the state refreshes the
   * state hint and every question's fan-out list, since those read the state.
   */

  function refreshDerived(key: string): void {
    if (key === STATE_KEY) {
      if (stateHintElement) setText(stateHintElement, stateHint(model));
      for (const question of model.questions) refreshQuestion(question);
      return;
    }
    const question = model.questions.find((candidate) => candidate.key === key);
    if (question) refreshQuestion(question);
  }

  function refreshQuestion(question: QuestionModel): void {
    const parts = questionParts.get(question.key);
    if (!parts) return;
    if (parts.legendId) setText(parts.legendId, question.id === "" ? "" : ` ${question.id}`);
    if (parts.fanOutField) {
      const hidden = fanOutHidden(question);
      if (parts.fanOutField.hidden !== hidden) parts.fanOutField.hidden = hidden;
    }
    if (parts.select) fillFanOutOptions(parts.select, question);
    if (parts.hint) {
      const hidden = question.fanOut === undefined;
      if (parts.hint.hidden !== hidden) parts.hint.hidden = hidden;
      setText(parts.hint, hidden ? "" : fanOutHint(question, model));
    }
  }

  /** The control only appears once the state holds a list to fan out over. */
  function fanOutHidden(question: QuestionModel): boolean {
    return question.fanOut === undefined && arrayKeys(model.state).length === 0;
  }

  function fillFanOutOptions(select: HTMLSelectElement, question: QuestionModel): void {
    const keys = arrayKeys(model.state);
    const choices = [
      { value: FAN_OUT_NONE, label: "Nothing, ask once" },
      ...keys.map((key) => ({ value: key, label: key })),
    ];
    if (question.fanOut !== undefined && !keys.includes(question.fanOut)) {
      choices.push({ value: question.fanOut, label: `${question.fanOut}, not in the state` });
    }
    const current = [...select.options]
      .map((option) => `${option.value}\n${option.text}`)
      .join("\n\n");
    const next = choices.map((choice) => `${choice.value}\n${choice.label}`).join("\n\n");
    if (current !== next) {
      select.replaceChildren(
        ...choices.map((choice) =>
          create("option", { text: choice.label, attributes: { value: choice.value } }),
        ),
      );
    }
    const value = question.fanOut ?? FAN_OUT_NONE;
    if (select.value !== value) select.value = value;
  }

  /* State */

  function stateNode(): HTMLElement {
    const field = textField(ctx, {
      key: STATE_KEY,
      control: "state",
      field: "state",
      label: "State",
      value: contentText(model.state),
      multiline: true,
      code: true,
      hint: stateHint(model),
      className: "field-state",
      onInput: (value) => {
        model.state = readStateText(value).state;
      },
    });
    return create("div", { className: "tree-trunk", attributes: { "data-row": STATE_KEY } }, [
      field,
      issueSlot(prefix, STATE_KEY),
    ]);
  }

  /* Criteria editors */

  function criteriaEditor(
    ownerKey: string,
    criteria: CriteriaModel,
    labelledBy: string,
  ): HTMLElement[] {
    switch (criteria.kind) {
      case "noul":
        return [meaningList(ctx, ownerKey, criteria.meanings, labelledBy)];
      case "choice":
        return [
          optionList(ctx, ownerKey, criteria, labelledBy),
          rowActions(addOptionButton(ctx, ownerKey, criteria)),
        ];
      case "score":
        return [
          levelList(ctx, ownerKey, criteria, labelledBy),
          rowActions(addLevelButton(ctx, ownerKey, criteria)),
        ];
    }
  }

  function sharedNode(): HTMLLIElement {
    const noun = CRITERIA_NOUN[model.primitive];
    const row = create("li", { className: "tree-node", attributes: { "data-row": SHARED_KEY } });
    const shared = model.criteria;

    if (shared === undefined) {
      row.append(
        textButton(SHARED_KEY, "add-shared", `Add shared ${noun}`, () => {
          structural({
            apply: () => addSharedCriteria(model),
            focus: () => [
              { key: `${SHARED_KEY}-true`, control: "meaning" },
              ...firstRowFocus(model.criteria),
            ],
            announce: `Shared ${noun} added.`,
          });
        }),
        create("p", {
          className: "tree-hint",
          text: `Questions without their own ${noun} use the shared ${noun}.`,
        }),
      );
      return row;
    }

    const legendId = elementId(prefix, SHARED_KEY, "legend");
    const remove = textButton(SHARED_KEY, "remove-shared", `Remove shared ${noun}`, () => {
      structural({
        apply: () => removeSharedCriteria(model),
        focus: () => [{ key: SHARED_KEY, control: "add-shared" }],
        announce: `Shared ${noun} removed. Questions that used them keep a copy.`,
      });
    });

    const editor = criteriaEditor(SHARED_KEY, shared, legendId);
    const actions = editor.at(-1);
    if (actions instanceof HTMLDivElement && actions.classList.contains("row-actions")) {
      actions.append(remove);
    } else {
      editor.push(rowActions(remove));
    }

    row.append(
      create("fieldset", { className: "node" }, [
        create("legend", {
          className: "node-label",
          text: `Shared ${noun}`,
          attributes: { id: legendId },
        }),
        create("p", {
          className: "tree-hint",
          text: `Questions without their own ${noun} use ${model.primitive === "noul" ? "this one" : "these"}.`,
        }),
        ...editor,
        issueSlot(prefix, SHARED_KEY),
      ]),
    );
    return row;
  }

  function firstRowFocus(criteria: CriteriaModel | undefined): FocusTarget[] {
    if (criteria?.kind === "choice") return previousFocus(criteria.options, 0, "name");
    if (criteria?.kind === "score") return previousFocus(criteria.levels, 0, "description");
    return [];
  }

  function questionCriteria(question: QuestionModel): HTMLElement {
    const noun = CRITERIA_NOUN[model.primitive];
    const block = create("div", { className: "criteria" });
    const shared = model.criteria;
    const own = question.criteria;

    const override = () => {
      structural({
        apply: () => overrideCriteria(model, question),
        focus: () => [
          { key: `${question.key}-true`, control: "meaning" },
          ...firstRowFocus(question.criteria),
          { key: question.key, control: "add" },
        ],
        announce:
          shared === undefined
            ? `Question ${question.id} now has its own ${noun}.`
            : `Question ${question.id} now has its own copy of the shared ${noun}.`,
        touches: question.key,
      });
    };

    if (own === undefined) {
      if (shared !== undefined) {
        block.append(
          create("p", { className: "tree-hint", text: `Uses ${criteriaCount(shared)}.` }),
          rowActions(textButton(question.key, "override", "Override for this question", override)),
        );
      } else {
        const label =
          model.primitive === "noul" ? "Add yes/no meaning" : `Add ${noun} for this question`;
        block.append(rowActions(textButton(question.key, "override", label, override)));
      }
      return block;
    }

    const labelId = elementId(prefix, question.key, "criteria-label");
    const heading =
      shared === undefined ? capitalise(noun) : `${capitalise(noun)} for this question`;
    block.append(
      create("p", { className: "node-label", text: heading, attributes: { id: labelId } }),
      ...criteriaEditor(question.key, own, labelId),
    );

    const dropLabel =
      shared !== undefined
        ? `Use the shared ${noun}`
        : model.primitive === "noul"
          ? "Remove yes/no meaning"
          : undefined;
    if (dropLabel !== undefined) {
      const drop = textButton(question.key, "inherit", dropLabel, () => {
        structural({
          apply: () => inheritCriteria(question),
          focus: () => [{ key: question.key, control: "override" }],
          announce:
            shared !== undefined
              ? `Question ${question.id} uses the shared ${noun} again.`
              : `Yes/no meaning removed from question ${question.id}.`,
        });
      });
      const actions = block.lastElementChild;
      if (actions instanceof HTMLDivElement && actions.classList.contains("row-actions")) {
        actions.append(drop);
      } else {
        block.append(rowActions(drop));
      }
    }
    return block;
  }

  /* Questions */

  function questionNode(question: QuestionModel, index: number): HTMLLIElement {
    const count = model.questions.length;
    const name = () => `question ${question.id || index + 1}`;

    const move = (step: -1 | 1, focus: FocusTarget | undefined) => {
      const to = index + step;
      if (to < 0 || to >= count) return;
      structural({
        apply: () => moveByKey(model.questions, question.key, step),
        focus: () => [
          focus ?? { key: question.key, control: step === -1 ? "up" : "down" },
          { key: question.key, control: "id" },
        ],
        announce: `${capitalise(name())} moved ${step === -1 ? "up" : "down"}.`,
      });
    };

    const legendIdSpan = create("span", {
      className: "visually-hidden",
      text: question.id === "" ? "" : ` ${question.id}`,
      attributes: { id: elementId(prefix, question.key, "legend-id") },
    });

    const id = textField(ctx, {
      key: question.key,
      control: "id",
      field: "id",
      label: "Id",
      value: question.id,
      slug: true,
      hint: "For your code only. Jev never sees the id.",
      className: "field-id",
      onInput: (value) => {
        question.id = value;
      },
    });

    const instructions = textField(ctx, {
      key: question.key,
      control: "instructions",
      field: "instructions",
      label: "Instructions",
      value: contentText(question.instructions),
      multiline: true,
      reading: true,
      className: "field-description",
      onInput: (value) => {
        question.instructions = readContentText(value);
      },
    });

    const fanOut = supportsFanOut(model.primitive) ? fanOutField(question) : null;

    const up = textButton(question.key, "up", "Move up", () => move(-1, undefined), name());
    up.disabled = index === 0;
    const down = textButton(question.key, "down", "Move down", () => move(1, undefined), name());
    down.disabled = index === count - 1;
    const remove = textButton(
      question.key,
      "remove",
      "Remove question",
      () => {
        structural({
          apply: () => removeByKey(model.questions, question.key),
          focus: () => [
            ...previousFocus(model.questions, index - 1, "id"),
            { key: QUESTIONS_KEY, control: "add" },
          ],
          announce: `${capitalise(name())} removed.`,
          touches: QUESTIONS_KEY,
        });
      },
      question.id || undefined,
    );

    const row = create("li", { className: "tree-node", attributes: { "data-row": question.key } }, [
      create("fieldset", { className: "node" }, [
        create("legend", { className: "node-label" }, ["Question", legendIdSpan]),
        id,
        instructions,
        ...(fanOut ? [fanOut] : []),
        questionCriteria(question),
        rowActions(up, down, remove),
        issueSlot(prefix, question.key),
      ]),
    ]);
    movableRow(row, move);
    return row;
  }

  function fanOutField(question: QuestionModel): HTMLElement {
    const selectId = elementId(prefix, question.key, "fan-out");
    const hintId = elementId(prefix, question.key, "fan-out-hint");
    const select = create("select", {
      className: "tree-field tree-select",
      attributes: {
        id: selectId,
        "aria-describedby": `${hintId} ${elementId(prefix, question.key, "issue")}`,
      },
    });
    select.dataset.for = question.key;
    select.dataset.control = "fan-out";
    select.dataset.field = "fanOut";
    fillFanOutOptions(select, question);
    select.addEventListener("change", () => {
      if (select.value === FAN_OUT_NONE) {
        delete question.fanOut;
      } else {
        question.fanOut = select.value;
      }
      ctx.edited(question.key);
    });

    const hint = create("p", {
      className: "tree-hint",
      text: question.fanOut === undefined ? "" : fanOutHint(question, model),
      attributes: { id: hintId },
    });
    hint.hidden = question.fanOut === undefined;

    const field = create(
      "div",
      {
        className: "field field-fan-out",
        attributes: { id: elementId(prefix, question.key, "fan-out-field") },
      },
      [
        create("label", {
          className: "node-label",
          text: "Ask for each item in",
          attributes: { for: selectId },
        }),
        select,
        hint,
      ],
    );
    field.hidden = fanOutHidden(question);
    return field;
  }

  function addQuestionNode(): HTMLLIElement {
    const add = textButton(QUESTIONS_KEY, "add", "Add question", () => {
      let added: QuestionModel | undefined;
      structural({
        apply: () => {
          added = addQuestion(model);
        },
        focus: () => (added ? [{ key: added.key, control: "id" }] : []),
        announce: "Question added.",
        touches: QUESTIONS_KEY,
      });
    });
    add.setAttribute("aria-describedby", elementId(prefix, QUESTIONS_KEY, "issue"));
    return create("li", { className: "tree-node", attributes: { "data-row": QUESTIONS_KEY } }, [
      add,
      issueSlot(prefix, QUESTIONS_KEY),
    ]);
  }

  /* Whole tree */

  function render(): void {
    const branch = create("ul", {
      className: "tree-branch",
      attributes: { "aria-label": "Shared criteria and questions" },
    });
    branch.append(sharedNode(), ...model.questions.map(questionNode), addQuestionNode());
    element.replaceChildren(stateNode(), branch);
    collectReferences();
    showIssues();
  }

  render();

  return {
    element,
    model: () => model,
    setModel(next) {
      model = next;
      touched = new Set();
      revealAll = false;
      render();
    },
    revealIssues() {
      revealAll = true;
      return showIssues();
    },
    focusIssue,
  };
}

type QuestionParts = {
  legendId: Element | null;
  fanOutField: HTMLElement | null;
  select: HTMLSelectElement | null;
  hint: HTMLElement | null;
};

/** What a row's issue slot and invalid fields currently show. */
type ShownIssues = {
  message: string;
  fields: Set<string>;
};

function sameFields(a: Set<string> | undefined, b: Set<string> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.size === b.size && [...a].every((field) => b.has(field));
}

/** Writes text only when it changed, so an unchanged row is left untouched. */
function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
