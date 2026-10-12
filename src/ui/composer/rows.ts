/**
 * DOM builders for the branch composer's rows: fields, text buttons, and the
 * option, level, and yes/no meaning rows. Builders wire their own listeners to
 * the model objects they render and report back through the `RowContext`.
 */

import type { NoulCriteria } from "../../jev/contract.ts";
import { create } from "../dom.ts";
import {
  addLevel,
  addOption,
  contentText,
  looksLikeJson,
  moveByKey,
  readContentText,
  readingHint,
  removeByKey,
} from "./model.ts";
import type { ComposerModel, Description, LevelRow, OptionRow } from "./model.ts";

/** A control to focus after a re-render: the element with `data-for=key` and `data-control=control`. */
export type FocusTarget = {
  key: string;
  control: string;
};

/** A change to the tree's shape: applied, then the tree re-renders, focuses, and announces. */
export type StructuralChange = {
  apply(): void;
  /** Called after `apply`; the first control still in the tree gets focus. */
  focus(): FocusTarget[];
  announce: string;
  /** Row whose issues start showing because of this change. */
  touches?: string;
};

export type RowContext = {
  /** Prefix for element ids, unique per panel. */
  prefix: string;
  model: ComposerModel;
  /** A field changed; `key` is the row it belongs to. */
  edited(key: string): void;
  structural(change: StructuralChange): void;
};

/* Elements */

function visuallyHidden(text: string): HTMLSpanElement {
  return create("span", { className: "visually-hidden", text });
}

export function elementId(prefix: string, key: string, part: string): string {
  return `${prefix}-${key}-${part}`;
}

/** The element that lists a row's problems; controls in the row point at it with aria-describedby. */
export function issueSlot(prefix: string, key: string): HTMLParagraphElement {
  return create("p", {
    className: "tree-issue",
    attributes: { id: elementId(prefix, key, "issue"), "data-issue-for": key, hidden: "" },
  });
}

/** Marks a control as belonging to row `key`, so focus and issue display can find it. */
function tag(control: HTMLElement, key: string, name: string, field?: string): void {
  control.dataset.for = key;
  control.dataset.control = name;
  if (field !== undefined) control.dataset.field = field;
}

function describedBy(
  prefix: string,
  key: string,
  hintIds: (string | undefined)[],
  hasIssues = true,
): string {
  const issueId = hasIssues ? elementId(prefix, key, "issue") : undefined;
  return [...hintIds, issueId].filter(Boolean).join(" ");
}

/** Shows whether text that looks like JSON was read as JSON or as text; hidden for plain prose. */
function updateReadingHint(hint: HTMLElement, text: string): void {
  const shown = looksLikeJson(text);
  const message = shown ? readingHint(readContentText(text)) : "";
  if (hint.hidden !== !shown) hint.hidden = !shown;
  if (hint.textContent !== message) hint.textContent = message;
}

export type TextFieldOptions = {
  key: string;
  control: string;
  label: string | (Node | string)[];
  labelHidden?: boolean;
  value: string;
  multiline?: boolean;
  /** Short one-word values such as ids and option names. */
  slug?: boolean;
  /** Mono font, for JSON. */
  code?: boolean;
  field?: string;
  hint?: string;
  /** Whether the row has an issue slot to describe the control. Defaults to true. */
  hasIssues?: boolean;
  /** Content that can be text or JSON: say which it was read as when that is in doubt. */
  reading?: boolean;
  className?: string;
  onInput(value: string): void;
};

export function textField(ctx: RowContext, options: TextFieldOptions): HTMLDivElement {
  const id = elementId(ctx.prefix, options.key, options.control);
  const input = options.multiline
    ? create("textarea", { attributes: { rows: "1" } })
    : create("input", { attributes: { type: "text" } });
  input.id = id;
  input.value = options.value;
  input.className = options.code ? "tree-field tree-field-code" : "tree-field";
  input.spellcheck = !options.slug && !options.code;
  if (options.slug || options.code) {
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocomplete", "off");
  }
  tag(input, options.key, options.control, options.field);

  const hintId =
    options.hint === undefined
      ? undefined
      : elementId(ctx.prefix, options.key, `${options.control}-hint`);
  const readingId = options.reading
    ? elementId(ctx.prefix, options.key, `${options.control}-reading`)
    : undefined;
  const reading =
    readingId === undefined
      ? undefined
      : create("p", { className: "tree-hint", attributes: { id: readingId } });
  if (reading) updateReadingHint(reading, options.value);

  const description = describedBy(ctx.prefix, options.key, [readingId, hintId], options.hasIssues);
  if (description !== "") input.setAttribute("aria-describedby", description);
  input.addEventListener("input", () => {
    options.onInput(input.value);
    if (reading) updateReadingHint(reading, input.value);
    ctx.edited(options.key);
  });

  const label = create("label", {
    className: options.labelHidden ? "visually-hidden" : "node-label",
    attributes: { for: id },
  });
  label.append(...(typeof options.label === "string" ? [options.label] : options.label));

  const wrapper = create(
    "div",
    { className: ["field", options.className].filter(Boolean).join(" ") },
    [label, input],
  );
  if (reading) wrapper.append(reading);
  if (options.hint !== undefined && hintId !== undefined) {
    wrapper.append(
      create("p", { className: "tree-hint", text: options.hint, attributes: { id: hintId } }),
    );
  }
  return wrapper;
}

/**
 * A quiet text button. `context` is appended visually hidden, so "Remove" reads
 * as "Remove level 2" to assistive technology while the visible text stays short.
 */
export function textButton(
  key: string,
  control: string,
  text: string,
  onClick: () => void,
  context?: string,
): HTMLButtonElement {
  const button = create("button", { className: "text-button", attributes: { type: "button" } }, [
    text,
  ]);
  if (context !== undefined) button.append(visuallyHidden(` ${context}`));
  tag(button, key, control);
  button.addEventListener("click", onClick);
  return button;
}

export function rowActions(...buttons: HTMLButtonElement[]): HTMLDivElement {
  return create("div", { className: "row-actions" }, buttons);
}

/**
 * Lets alt+ArrowUp and alt+ArrowDown move `row` when focus is inside it and not
 * inside a nested movable row.
 */
export function movableRow(
  row: HTMLLIElement,
  move: (step: -1 | 1, control: FocusTarget | undefined) => void,
): void {
  row.dataset.movable = "";
  row.addEventListener("keydown", (event) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest("[data-movable]") !== row) return;
    event.preventDefault();
    const { for: key, control } = target.dataset;
    move(event.key === "ArrowUp" ? -1 : 1, key && control ? { key, control } : undefined);
  });
}

/* Descriptions: empty text leaves the outcome undescribed (null) */

function descriptionFromText(text: string): Description {
  return text === "" ? null : readContentText(text);
}

/* Choice options */

/** The option rows, introduced by a hint because the name and description fields have no visible labels. */
export function optionList(
  ctx: RowContext,
  ownerKey: string,
  criteria: { options: OptionRow[] },
  labelledBy: string,
): HTMLDivElement {
  const hintId = elementId(ctx.prefix, ownerKey, "options-hint");
  const list = create("ul", {
    className: "tree-branch tree-rows",
    attributes: { "aria-labelledby": labelledBy, "aria-describedby": hintId },
  });
  criteria.options.forEach((option, index) => {
    list.append(optionRow(ctx, ownerKey, criteria, option, index));
  });
  return create("div", { className: "option-group" }, [
    create("p", {
      className: "tree-hint",
      text: "Each option has a name your code reads and a description Jev reads.",
      attributes: { id: hintId },
    }),
    list,
  ]);
}

function optionRow(
  ctx: RowContext,
  ownerKey: string,
  criteria: { options: OptionRow[] },
  option: OptionRow,
  index: number,
): HTMLLIElement {
  const number = index + 1;
  const name = textField(ctx, {
    key: option.key,
    control: "name",
    field: "name",
    label: `Option ${number} name`,
    labelHidden: true,
    value: option.name,
    slug: true,
    className: "field-name",
    onInput: (value) => {
      option.name = value;
    },
  });
  const description = textField(ctx, {
    key: option.key,
    control: "description",
    label: `Option ${number} description`,
    labelHidden: true,
    value: contentText(option.description),
    multiline: true,
    reading: true,
    className: "field-description",
    onInput: (value) => {
      option.description = descriptionFromText(value);
    },
  });
  const remove = textButton(
    option.key,
    "remove",
    "Remove",
    () => {
      ctx.structural({
        apply: () => removeByKey(criteria.options, option.key),
        focus: () => [
          ...previousFocus(criteria.options, index - 1, "name"),
          { key: ownerKey, control: "add" },
        ],
        announce: `Option ${option.name || number} removed.`,
        touches: ownerKey,
      });
    },
    `option ${option.name || number}`,
  );

  return create(
    "li",
    { className: "tree-row option-row", attributes: { "data-row": option.key } },
    [name, description, rowActions(remove), issueSlot(ctx.prefix, option.key)],
  );
}

export function addOptionButton(
  ctx: RowContext,
  ownerKey: string,
  criteria: { options: OptionRow[] },
): HTMLButtonElement {
  return textButton(ownerKey, "add", "Add option", () => {
    let added: OptionRow | undefined;
    ctx.structural({
      apply: () => {
        added = addOption(ctx.model, criteria);
      },
      focus: () => (added ? [{ key: added.key, control: "name" }] : []),
      announce: `Option ${criteria.options.length + 1} added.`,
      touches: ownerKey,
    });
  });
}

/* Score levels */

export function levelList(
  ctx: RowContext,
  ownerKey: string,
  criteria: { levels: LevelRow[] },
  labelledBy: string,
): HTMLUListElement {
  const list = create("ul", {
    className: "tree-branch tree-rows",
    attributes: { "aria-labelledby": labelledBy },
  });
  criteria.levels.forEach((level, index) => {
    list.append(levelRow(ctx, ownerKey, criteria, level, index));
  });
  return list;
}

function levelRow(
  ctx: RowContext,
  ownerKey: string,
  criteria: { levels: LevelRow[] },
  level: LevelRow,
  index: number,
): HTMLLIElement {
  const levelName = `level ${index}`;
  const move = (step: -1 | 1, focus: FocusTarget | undefined) => {
    const to = index + step;
    if (to < 0 || to >= criteria.levels.length) return;
    ctx.structural({
      apply: () => moveByKey(criteria.levels, level.key, step),
      focus: () => [
        focus ?? { key: level.key, control: step === -1 ? "up" : "down" },
        { key: level.key, control: "description" },
      ],
      announce: `Level ${index} is now level ${to}.`,
      touches: ownerKey,
    });
  };

  const field = textField(ctx, {
    key: level.key,
    control: "description",
    label: `Level ${index}`,
    value: contentText(level.description),
    multiline: true,
    reading: true,
    className: "field-description",
    onInput: (value) => {
      level.description = descriptionFromText(value);
    },
  });

  const up = textButton(level.key, "up", "Move up", () => move(-1, undefined), levelName);
  up.disabled = index === 0;
  const down = textButton(level.key, "down", "Move down", () => move(1, undefined), levelName);
  down.disabled = index === criteria.levels.length - 1;
  const remove = textButton(
    level.key,
    "remove",
    "Remove",
    () => {
      ctx.structural({
        apply: () => removeByKey(criteria.levels, level.key),
        focus: () => [
          ...previousFocus(criteria.levels, index - 1, "description"),
          { key: ownerKey, control: "add" },
        ],
        announce: `Level ${index} removed.`,
        touches: ownerKey,
      });
    },
    levelName,
  );

  const row = create(
    "li",
    { className: "tree-row level-row", attributes: { "data-row": level.key } },
    [field, rowActions(up, down, remove), issueSlot(ctx.prefix, level.key)],
  );
  movableRow(row, move);
  return row;
}

export function addLevelButton(
  ctx: RowContext,
  ownerKey: string,
  criteria: { levels: LevelRow[] },
): HTMLButtonElement {
  return textButton(ownerKey, "add", "Add level", () => {
    let added: LevelRow | undefined;
    ctx.structural({
      apply: () => {
        added = addLevel(ctx.model, criteria);
      },
      focus: () => (added ? [{ key: added.key, control: "description" }] : []),
      announce: `Level ${criteria.levels.length} added.`,
      touches: ownerKey,
    });
  });
}

/* Noul yes/no meanings */

const MEANINGS = [
  { key: "true", label: "Yes means" },
  { key: "false", label: "No means" },
] as const;

export function meaningList(
  ctx: RowContext,
  ownerKey: string,
  meanings: NoulCriteria,
  labelledBy: string,
): HTMLUListElement {
  const list = create("ul", {
    className: "tree-branch tree-rows",
    attributes: { "aria-labelledby": labelledBy },
  });
  for (const meaning of MEANINGS) {
    const rowKey = `${ownerKey}-${meaning.key}`;
    const field = textField(ctx, {
      key: rowKey,
      control: "meaning",
      label: meaning.label,
      value: contentText(meanings[meaning.key]),
      multiline: true,
      hasIssues: false,
      reading: true,
      className: "field-description",
      onInput: (value) => {
        if (value === "") {
          delete meanings[meaning.key];
        } else {
          meanings[meaning.key] = readContentText(value);
        }
      },
    });
    list.append(
      create("li", { className: "tree-row", attributes: { "data-row": rowKey } }, [field]),
    );
  }
  return list;
}

/**
 * Focus for a control in the row now at `index`, if there is one. After a removal,
 * `index - 1` is the row that came before the removed one.
 */
export function previousFocus(
  rows: readonly { key: string }[],
  index: number,
  control: string,
): FocusTarget[] {
  const previous = index >= 0 ? rows[index] : undefined;
  return previous ? [{ key: previous.key, control }] : [];
}
