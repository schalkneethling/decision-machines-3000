// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { choiceExample, noulExample, scoreExample } from "../../decision/examples.ts";
import { validateDecisionRequest } from "../../decision/validate.ts";
import type { ValidDecisionRequest } from "../../decision/validate.ts";
import { toRequest, toViewModel } from "./model.ts";
import { createComposer } from "./tree.ts";
import type { Composer } from "./tree.ts";
import { DEFAULT_PROVIDER } from "../../providers/catalog.ts";

type Harness = {
  composer: Composer;
  announcements: string[];
  changes: number;
  get: <T extends HTMLElement = HTMLElement>(selector: string) => T;
  all: (selector: string) => HTMLElement[];
};

function mount(request: ValidDecisionRequest): Harness {
  document.body.replaceChildren();
  const announcements: string[] = [];
  const harness: Harness = {
    composer: undefined as unknown as Composer,
    announcements,
    changes: 0,
    get<T extends HTMLElement = HTMLElement>(selector: string): T {
      const found = document.querySelector<T>(selector);
      if (found === null) throw new Error(`Nothing matches ${selector}.`);
      return found;
    },
    all: (selector) => [...document.querySelectorAll<HTMLElement>(selector)],
  };
  harness.composer = createComposer({
    prefix: "test",
    model: toViewModel(request),
    capabilities: DEFAULT_PROVIDER.capabilities,
    announce: (message) => announcements.push(message),
    onChange: () => {
      harness.changes += 1;
    },
  });
  document.body.append(harness.composer.element);
  return harness;
}

function control(key: string, name: string): string {
  return `[data-for="${key}"][data-control="${name}"]`;
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

function questionKeys(harness: Harness): string[] {
  return harness.composer.model().questions.map((question) => question.key);
}

function levelKeys(harness: Harness): string[] {
  const criteria = harness.composer.model().criteria;
  return criteria?.kind === "score" ? criteria.levels.map((level) => level.key) : [];
}

describe("setCapabilities", () => {
  it("re-reports a touched row against the new limits, and clears it again", () => {
    const harness = mount(scoreExample);
    // Adding a level touches the shared levels, so their issues show.
    harness.get<HTMLButtonElement>(control("shared", "add")).click();
    const slot = harness.get("#test-shared-issue");
    expect(slot.hidden).toBe(true);

    harness.composer.setCapabilities({
      ...DEFAULT_PROVIDER.capabilities,
      scoreLevels: { min: 2, max: 4 },
    });
    expect(slot.hidden).toBe(false);
    expect(slot.textContent).toBe("Shared levels have 5 levels. Use at most 4. Remove 1.");

    harness.composer.setCapabilities(DEFAULT_PROVIDER.capabilities);
    expect(slot.hidden).toBe(true);
  });

  it("marks a touched field invalid under the new limits, and valid again after", () => {
    const harness = mount(noulExample);
    const [first] = questionKeys(harness);
    const id = harness.get<HTMLInputElement>(control(first!, "id"));
    type(id, "would_recommend");
    expect(id.hasAttribute("aria-invalid")).toBe(false);

    harness.composer.setCapabilities({
      ...DEFAULT_PROVIDER.capabilities,
      questionNameMaxLength: 5,
    });
    expect(id.getAttribute("aria-invalid")).toBe("true");
    expect(harness.get(`#test-${first}-issue`).hidden).toBe(false);

    harness.composer.setCapabilities(DEFAULT_PROVIDER.capabilities);
    expect(id.hasAttribute("aria-invalid")).toBe(false);
    expect(harness.get(`#test-${first}-issue`).hidden).toBe(true);
  });

  it("leaves rows that were never touched alone", () => {
    const harness = mount(scoreExample);
    harness.composer.setCapabilities({
      ...DEFAULT_PROVIDER.capabilities,
      scoreLevels: { min: 2, max: 3 },
    });
    expect(harness.get("#test-shared-issue").hidden).toBe(true);
  });
});

describe("tree structure", () => {
  it("renders the state, shared criteria, each question, and an add button as one spine", () => {
    const harness = mount(choiceExample);
    const branch = harness.get(".tree > .tree-branch");
    const rows = [...branch.children].map((row) => row.getAttribute("data-row"));
    expect(rows).toEqual(["shared", ...questionKeys(harness), "questions"]);
    expect(harness.get("#test-state-state").tagName).toBe("TEXTAREA");
    expect(harness.all(".option-row")).toHaveLength(7);
  });

  it("leads each label with a plain name and names the JSON key after it (issue #103)", () => {
    const harness = mount(choiceExample);
    const state = harness.get<HTMLTextAreaElement>("#test-state-state");
    expect(harness.get(`label[for="${state.id}"]`).textContent).toBe("What the model reads");
    const note = harness.get("#test-state-state-json-key");
    expect(note.textContent).toBe("In JSON: state");
    expect(note.querySelector("code")?.textContent).toBe("state");
    // Read after the label, as the first part of the field's description.
    expect(state.getAttribute("aria-describedby")?.split(" ")[0]).toBe(note.id);

    expect(harness.get("#test-shared-legend").textContent).toBe("Shared options");
    expect(harness.get("#test-shared-json-key").textContent).toBe("In JSON: criteria");
    const [question] = questionKeys(harness);
    expect(harness.get(`#test-${question}-fan-out-field label`).textContent).toBe(
      "Ask once for each item in",
    );
  });

  it("says what the id is for once per request, and no Id field is described by it", () => {
    const harness = mount(noulExample);
    const keys = questionKeys(harness);
    const sentence = "Question ids are for your code only. The model never sees them.";
    expect(keys.length).toBe(4);
    const hints = harness.all(".tree-hint").filter((hint) => hint.textContent === sentence);
    expect(hints).toHaveLength(1);
    expect(hints[0]?.closest(".tree-branch")).toBeNull();
    for (const key of keys) {
      const description = harness.get(control(key, "id")).getAttribute("aria-describedby") ?? "";
      for (const id of description.split(" ")) {
        expect(document.getElementById(id)?.textContent).not.toBe(sentence);
      }
    }
  });

  it("leaves out the id hint when the request has no questions", () => {
    const harness = mount(noulExample);
    harness.composer.setModel({ ...harness.composer.model(), questions: [] });
    expect(harness.all(".field-id")).toHaveLength(0);
    expect(harness.all(".tree-hint").map((hint) => hint.textContent)).not.toContain(
      "Question ids are for your code only. The model never sees them.",
    );
  });

  it("labels every text field and select", () => {
    const harness = mount(scoreExample);
    for (const field of harness.all("input, textarea, select")) {
      expect(document.querySelector(`label[for="${field.id}"]`), field.id).not.toBeNull();
    }
  });

  it("shows the fan-out list chosen and the ids it sends", () => {
    const harness = mount(choiceExample);
    const [question] = questionKeys(harness);
    const select = harness.get<HTMLSelectElement>(control(question!, "fan-out"));
    expect(select.value).toBe("films");
    expect([...select.options].map((option) => option.value)).toEqual(["", "films"]);
    expect(harness.get(`#test-${question}-fan-out-hint`).textContent).toMatch(
      /Sends 6 questions, film_0 to film_5\./,
    );
  });

  it("numbers score levels from 0 and says so under the list", () => {
    const harness = mount(scoreExample);
    const labels = harness
      .all(".level-row .field-description label")
      .map((label) => label.textContent);
    expect(labels).toEqual(["Level 0", "Level 1", "Level 2", "Level 3"]);
    const hint = harness.get("#test-shared-levels-hint");
    expect(hint.textContent).toBe("Levels are numbered from 0, as the model reports them.");
    expect(harness.get(".level-row").closest("ul")?.getAttribute("aria-describedby")).toBe(
      "test-shared-levels-hint test-shared-levels-move-hint",
    );
  });

  it("keeps numbering from 0 when a level is added", () => {
    const harness = mount(scoreExample);
    harness.get<HTMLButtonElement>(control("shared", "add")).click();
    const labels = harness
      .all(".level-row .field-description label")
      .map((label) => label.textContent);
    expect(labels.at(-1)).toBe("Level 4");
  });

  it("gives a question's own levels a hint of its own, next to the shared one", () => {
    const harness = mount(scoreExample);
    const [question] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(question!, "override")).click();

    const hints = harness.all(".level-group > .tree-hint");
    const ids = hints.map((hint) => hint.id);
    expect(ids).toEqual([
      "test-shared-levels-hint",
      "test-shared-levels-move-hint",
      `test-${question}-levels-hint`,
      `test-${question}-levels-move-hint`,
    ]);
    for (const id of ids) {
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
      // A list may name several hints, so the id is one token of its aria-describedby.
      expect(document.querySelector(`[aria-describedby~="${id}"]`)?.tagName).toBe("UL");
    }
  });

  it("leaves option numbering from 1 and shows no levels hint on a choice request", () => {
    const harness = mount(choiceExample);
    expect(document.querySelector("#test-shared-levels-hint")).toBeNull();
    expect(harness.get<HTMLLabelElement>(".option-row label").textContent).toBe("Option 1 name");
  });
});

describe("editing", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("updates the model on input without re-rendering the row", () => {
    const harness = mount(noulExample);
    const [first] = questionKeys(harness);
    const field = harness.get<HTMLTextAreaElement>(control(first!, "instructions"));
    type(field, "Does the reviewer like the film?");
    expect(harness.get(control(first!, "instructions"))).toBe(field);
    expect(toRequest(harness.composer.model()).questions.recommends?.instructions).toBe(
      "Does the reviewer like the film?",
    );
    expect(harness.changes).toBe(1);
  });

  it("reads the state as JSON or text and updates the hint and fan-out lists", () => {
    const harness = mount(choiceExample);
    const state = harness.get<HTMLTextAreaElement>("#test-state-state");
    const hint = harness.get("#test-state-state-hint");

    type(state, `{"films": [], "reviews": ["a"]}`);
    expect(hint.textContent).toBe(
      "The page reads this as JSON. Questions can ask about each item in films, reviews.",
    );
    const [question] = questionKeys(harness);
    const select = harness.get<HTMLSelectElement>(control(question!, "fan-out"));
    expect([...select.options].map((option) => option.value)).toEqual(["", "films", "reviews"]);

    type(state, "A plain sentence.");
    expect(hint.textContent).toBe("The page reads this as text.");
    expect(harness.composer.model().state).toBe("A plain sentence.");
  });

  it("offers no fan-out control on a Yes or no request", () => {
    const harness = mount(noulExample);
    expect(harness.all('[data-control="fan-out"]')).toEqual([]);
  });

  it("hides the fan-out control until the state holds a list", () => {
    const request = validateDecisionRequest(
      {
        ...choiceExample,
        state: { film: "A radio astronomer intercepts a signal from three years in the future." },
        questions: { genre: { instructions: "Which genre best fits `film`?" } },
      },
      DEFAULT_PROVIDER.capabilities,
    );
    if (!request.ok) throw new Error(request.error);
    const harness = mount(request.value);
    const [question] = questionKeys(harness);
    const field = harness.get(`#test-${question}-fan-out-field`);
    expect(field.hidden).toBe(true);

    type(harness.get<HTMLTextAreaElement>("#test-state-state"), `{"films": ["a", "b"]}`);
    expect(field.hidden).toBe(false);

    type(harness.get<HTMLTextAreaElement>("#test-state-state"), `{"film": "a"}`);
    expect(field.hidden).toBe(true);
  });

  it("shows an issue next to an edited row and marks the field invalid", () => {
    const harness = mount(noulExample);
    const [first] = questionKeys(harness);
    const id = harness.get<HTMLInputElement>(control(first!, "id"));
    type(id, "Recommends");
    const issue = harness.get(`#test-${first}-issue`);
    expect(issue.hidden).toBe(false);
    expect(issue.textContent).toBe(
      "Question ids use lowercase letters, digits, and underscores only.",
    );
    expect(id.getAttribute("aria-invalid")).toBe("true");
    expect(id.getAttribute("aria-describedby")).toContain(issue.id);
  });

  it("waits to show issues in untouched rows until they are revealed", () => {
    const harness = mount(noulExample);
    const [, second] = questionKeys(harness);
    harness.composer.model().questions[1]!.instructions = "";
    const issue = harness.get(`#test-${second}-issue`);
    expect(issue.hidden).toBe(true);
    const issues = harness.composer.revealIssues();
    expect(issues.map((found) => found.message)).toEqual(["Write the question you want answered."]);
    expect(issue.hidden).toBe(false);
  });
});

describe("add, remove, and move", () => {
  it("adds a question, focuses its id, and announces it", () => {
    const harness = mount(noulExample);
    harness.get<HTMLButtonElement>(control("questions", "add")).click();
    const keys = questionKeys(harness);
    expect(keys).toHaveLength(5);
    expect(document.activeElement).toBe(harness.get(control(keys.at(-1)!, "id")));
    expect(harness.announcements).toEqual(["Question added."]);
  });

  it("removes a question and focuses the previous question's id", () => {
    const harness = mount(noulExample);
    const [first, second] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(second!, "remove")).click();
    expect(questionKeys(harness)).not.toContain(second);
    expect(document.activeElement).toBe(harness.get(control(first!, "id")));
    expect(harness.announcements).toEqual(["Question reveals_ending removed."]);
  });

  it("focuses Add question after removing the first question", () => {
    const harness = mount(noulExample);
    const [first] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(first!, "remove")).click();
    expect(document.activeElement).toBe(harness.get(control("questions", "add")));
  });

  it("moves a level down with its button and keeps focus on the moved row", () => {
    const harness = mount(scoreExample);
    const [first, second] = levelKeys(harness);
    harness.get<HTMLButtonElement>(control(first!, "down")).click();
    expect(levelKeys(harness).slice(0, 2)).toEqual([second, first]);
    expect(document.activeElement).toBe(harness.get(control(first!, "down")));
    expect(harness.announcements).toEqual(["Level 0 is now level 1."]);
    expect(toRequest(harness.composer.model()).criteria).toEqual([
      scoreExample.criteria?.[1],
      scoreExample.criteria?.[0],
      scoreExample.criteria?.[2],
      scoreExample.criteria?.[3],
    ]);
  });

  it("moves a level up with alt+ArrowUp and keeps focus in the same field", () => {
    const harness = mount(scoreExample);
    const [first, second] = levelKeys(harness);
    const field = harness.get(control(second!, "description"));
    field.focus();
    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }),
    );
    expect(levelKeys(harness).slice(0, 2)).toEqual([second, first]);
    expect(document.activeElement).toBe(harness.get(control(second!, "description")));
  });

  it("moves a question with alt+ArrowDown but not a level inside it", () => {
    const harness = mount(noulExample);
    const [first, second] = questionKeys(harness);
    const id = harness.get(control(first!, "id"));
    id.focus();
    id.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
    );
    expect(questionKeys(harness).slice(0, 2)).toEqual([second, first]);
    expect(document.activeElement).toBe(harness.get(control(first!, "id")));
  });

  it("disables moving the first row up and the last row down", () => {
    const harness = mount(scoreExample);
    const keys = levelKeys(harness);
    expect(harness.get<HTMLButtonElement>(control(keys[0]!, "up")).disabled).toBe(true);
    expect(harness.get<HTMLButtonElement>(control(keys.at(-1)!, "down")).disabled).toBe(true);
  });

  it("removes a level, focuses the previous level, and flags too few levels", () => {
    const harness = mount(scoreExample);
    const criteria = harness.composer.model().criteria;
    if (criteria?.kind !== "score") throw new Error("Expected levels.");
    criteria.levels.splice(2);
    harness.composer.setModel(harness.composer.model());
    const [first, second] = levelKeys(harness);
    harness.get<HTMLButtonElement>(control(second!, "remove")).click();
    expect(document.activeElement).toBe(harness.get(control(first!, "description")));
    expect(harness.get("#test-shared-issue").textContent).toBe(
      "Shared levels need at least 2 levels. Add one more.",
    );
  });

  it("adds an option and focuses its name", () => {
    const harness = mount(choiceExample);
    harness.get<HTMLButtonElement>(control("shared", "add")).click();
    const names = harness.all(`.option-row [data-control="name"]`);
    expect(names).toHaveLength(8);
    expect(document.activeElement).toBe(names.at(-1));
  });
});

describe("the Alt + Arrow move shortcut", () => {
  it("names it on each question's Move up and Move down buttons, and hints at it above the question list", () => {
    const harness = mount(noulExample);
    const keys = questionKeys(harness);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    for (const key of keys) {
      expect(harness.get(control(key, "up")).getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp");
      expect(harness.get(control(key, "down")).getAttribute("aria-keyshortcuts")).toBe(
        "Alt+ArrowDown",
      );
    }
    // Only the move buttons carry the shortcut, two per question.
    expect(document.querySelectorAll("[aria-keyshortcuts]")).toHaveLength(keys.length * 2);

    const hint = harness.get("#test-questions-move-hint");
    expect(hint.textContent).toBe("Press Alt and an arrow key to move the focused question.");
    expect(hint.className).toBe("tree-hint");
    expect(
      harness
        .get("ul[aria-label='Shared criteria and questions']")
        .getAttribute("aria-describedby"),
    ).toBe("test-questions-move-hint");
  });

  it("names it on each score level's Move up and Move down buttons, and hints at it above the level list", () => {
    const harness = mount(scoreExample);
    const rows = harness.all(".level-row");
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.querySelector('[data-control="up"]')?.getAttribute("aria-keyshortcuts")).toBe(
        "Alt+ArrowUp",
      );
      expect(row.querySelector('[data-control="down"]')?.getAttribute("aria-keyshortcuts")).toBe(
        "Alt+ArrowDown",
      );
    }
    // Questions carry the same two buttons, so they are counted too.
    const movable = rows.length + questionKeys(harness).length;
    expect(document.querySelectorAll("[aria-keyshortcuts]")).toHaveLength(movable * 2);

    const hint = harness.get("#test-shared-levels-move-hint");
    expect(hint.textContent).toBe("Press Alt and an arrow key to move the focused level.");
    expect(hint.className).toBe("tree-hint");
  });

  it("names it on the levels of a question's own list too", () => {
    const harness = mount(scoreExample);
    const [question] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(question!, "override")).click();
    const own = harness.get(`#test-${question}-levels-move-hint`);
    const list = own.parentElement?.querySelector("ul");
    expect(list?.getAttribute("aria-describedby")).toBe(
      `test-${question}-levels-hint test-${question}-levels-move-hint`,
    );
    for (const row of list?.querySelectorAll(".level-row") ?? []) {
      expect(row.querySelector('[data-control="down"]')?.getAttribute("aria-keyshortcuts")).toBe(
        "Alt+ArrowDown",
      );
    }
  });
});

describe("the move hints need two or more rows to move between", () => {
  const QUESTIONS_LIST = "ul[aria-label='Shared criteria and questions']";

  it("shows no question hint with one question, and points nothing at it, but keeps the buttons' shortcuts", () => {
    const harness = mount({ ...noulExample, questions: { only: { instructions: "Is it good?" } } });
    const [only] = questionKeys(harness);
    expect(document.querySelector("#test-questions-move-hint")).toBeNull();
    expect(document.querySelector(QUESTIONS_LIST)?.hasAttribute("aria-describedby")).toBe(false);
    expect(harness.get(control(only!, "up")).getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp");
    expect(harness.get(control(only!, "down")).getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowDown",
    );
  });

  it("shows no question hint on an empty list", () => {
    mount({ ...noulExample, questions: {} });
    expect(document.querySelector("#test-questions-move-hint")).toBeNull();
    expect(document.querySelector(QUESTIONS_LIST)?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows the question hint when a second question is added, and drops it when one is left", () => {
    const harness = mount({ ...noulExample, questions: { only: { instructions: "Is it good?" } } });
    harness.get<HTMLButtonElement>(control("questions", "add")).click();
    expect(harness.get("#test-questions-move-hint").textContent).toBe(
      "Press Alt and an arrow key to move the focused question.",
    );
    expect(document.querySelector(QUESTIONS_LIST)?.getAttribute("aria-describedby")).toBe(
      "test-questions-move-hint",
    );

    const [, added] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(added!, "remove")).click();
    expect(document.querySelector("#test-questions-move-hint")).toBeNull();
    expect(document.querySelector(QUESTIONS_LIST)?.hasAttribute("aria-describedby")).toBe(false);
  });

  it("shows no levels hint with one level, and points the list only at its numbering hint", () => {
    const harness = mount(scoreExample);
    const [first, ...rest] = levelKeys(harness);
    for (const key of rest) harness.get<HTMLButtonElement>(control(key!, "remove")).click();
    expect(levelKeys(harness)).toEqual([first]);

    expect(document.querySelector("#test-shared-levels-move-hint")).toBeNull();
    expect(harness.get(".level-row").closest("ul")?.getAttribute("aria-describedby")).toBe(
      "test-shared-levels-hint",
    );
    expect(harness.get(control(first!, "up")).getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowUp",
    );
    expect(harness.get(control(first!, "down")).getAttribute("aria-keyshortcuts")).toBe(
      "Alt+ArrowDown",
    );
  });

  it("shows the levels hint again when a second level is added", () => {
    const harness = mount(scoreExample);
    const [first, ...rest] = levelKeys(harness);
    for (const key of rest) harness.get<HTMLButtonElement>(control(key!, "remove")).click();
    harness.get<HTMLButtonElement>(control("shared", "add")).click();
    expect(levelKeys(harness)).toHaveLength(2);
    expect(levelKeys(harness)[0]).toBe(first);
    expect(harness.get("#test-shared-levels-move-hint").textContent).toBe(
      "Press Alt and an arrow key to move the focused level.",
    );
  });
});

describe("inherit or override", () => {
  it("says a question uses the shared options and overrides with a copy", () => {
    const harness = mount(choiceExample);
    const [question] = questionKeys(harness);
    expect(harness.get(`[data-row="${question}"] .criteria`).textContent).toContain(
      "Uses the shared 7 options.",
    );
    harness.get<HTMLButtonElement>(control(question!, "override")).click();
    expect(harness.all(`[data-row="${question}"] .option-row`)).toHaveLength(7);
    expect(harness.announcements).toEqual([
      "Question film now has its own copy of the shared options.",
    ]);
    const request = toRequest(harness.composer.model());
    expect(request.questions.film_0?.criteria).toEqual(choiceExample.criteria);

    harness.get<HTMLButtonElement>(control(question!, "inherit")).click();
    expect(toRequest(harness.composer.model())).toStrictEqual(choiceExample);
    expect(document.activeElement).toBe(harness.get(control(question!, "override")));
  });

  it("reveals yes/no meaning fields for a Noul question", () => {
    const harness = mount(noulExample);
    const [first] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(first!, "override")).click();
    const yes = harness.get<HTMLTextAreaElement>(control(`${first}-true`, "meaning"));
    expect(document.activeElement).toBe(yes);
    type(yes, "The reviewer says to watch it.");
    expect(toRequest(harness.composer.model()).questions.recommends?.criteria).toEqual({
      true: "The reviewer says to watch it.",
    });
  });
});

describe("typing touches only the edited row", () => {
  const manyQuestions: ValidDecisionRequest = {
    primitive: "noul",
    state: "A review.",
    questions: Object.fromEntries(
      Array.from({ length: 50 }, (_, index) => [
        `question_${index}`,
        { instructions: `Is statement ${index} true?` },
      ]),
    ),
  };

  function observe(harness: Harness): MutationObserver {
    const observer = new MutationObserver(() => {});
    observer.observe(harness.composer.element, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    return observer;
  }

  function mutatedRows(records: MutationRecord[]): Set<string | null> {
    return new Set(
      records.map((record) => {
        const target =
          record.target instanceof Element ? record.target : record.target.parentElement;
        return target?.closest("[data-row]")?.getAttribute("data-row") ?? null;
      }),
    );
  }

  it("writes only inside the edited question among 50", () => {
    const harness = mount(manyQuestions);
    const keys = questionKeys(harness);
    const rowsBefore = harness.all(".tree > .tree-branch > li");
    const edited = keys[25]!;
    const observer = observe(harness);

    type(harness.get<HTMLInputElement>(control(edited, "id")), "Not A Slug");
    type(harness.get<HTMLTextAreaElement>(control(edited, "instructions")), "Is it true?");
    const records = observer.takeRecords();
    observer.disconnect();

    expect(records.length).toBeGreaterThan(0);
    expect(mutatedRows(records)).toEqual(new Set([edited]));
    expect(harness.all(".tree > .tree-branch > li")).toEqual(rowsBefore);
  });

  it("clears a resolved id clash without touching other rows", () => {
    const harness = mount(manyQuestions);
    const keys = questionKeys(harness);
    type(harness.get<HTMLInputElement>(control(keys[40]!, "id")), "question_10");
    const observer = observe(harness);

    type(harness.get<HTMLInputElement>(control(keys[40]!, "id")), "question_40");
    const records = observer.takeRecords();
    observer.disconnect();

    // Question 10 was never edited, so its clash only showed on question 40.
    expect(mutatedRows(records)).toEqual(new Set([keys[40]]));
    expect(harness.get(`#test-${keys[40]}-issue`).hidden).toBe(true);
  });
});

describe("text or JSON content", () => {
  it("reads instructions as JSON again after an edit breaks and repairs them", () => {
    const harness = mount({
      ...noulExample,
      questions: { structured: { instructions: { a: 1 } } },
    });
    const [key] = questionKeys(harness);
    const field = harness.get<HTMLTextAreaElement>(control(key!, "instructions"));
    const hint = harness.get(`#test-${key}-instructions-reading`);
    expect(field.value).toBe(`{\n  "a": 1\n}`);
    expect(hint.textContent).toBe("The page reads this as JSON.");
    expect(field.getAttribute("aria-describedby")).toContain(hint.id);

    type(field, `{\n  "a": 1\n`);
    expect(harness.composer.model().questions[0]?.instructions).toBe(`{\n  "a": 1\n`);
    expect(hint.textContent).toBe("The page reads this as text.");

    type(field, `{\n  "a": 1\n}`);
    expect(harness.composer.model().questions[0]?.instructions).toEqual({ a: 1 });
    expect(hint.textContent).toBe("The page reads this as JSON.");
  });

  it("reads JSON typed into a field that started empty", () => {
    const harness = mount(scoreExample);
    harness.get<HTMLButtonElement>(control("shared", "add")).click();
    const levels = levelKeys(harness);
    const added = levels.at(-1)!;
    const field = harness.get<HTMLTextAreaElement>(control(added, "description"));
    expect(field.value).toBe("");
    expect(harness.get(`#test-${added}-description-reading`).hidden).toBe(true);

    type(field, `["calm", "tense"]`);
    const criteria = toRequest(harness.composer.model()).criteria;
    expect(Array.isArray(criteria) ? criteria.at(-1) : undefined).toEqual(["calm", "tense"]);
    expect(harness.get(`#test-${added}-description-reading`).textContent).toBe(
      "The page reads this as JSON.",
    );
  });

  it("does not label plain prose", () => {
    const harness = mount(noulExample);
    const [key] = questionKeys(harness);
    expect(harness.get(`#test-${key}-instructions-reading`).hidden).toBe(true);
  });
});

describe("the question list", () => {
  it("shows the missing-question issue as soon as the last question is removed", () => {
    const harness = mount({ ...noulExample, questions: { only: { instructions: "Is it good?" } } });
    const [only] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(only!, "remove")).click();
    const issue = harness.get("#test-questions-issue");
    expect(issue.hidden).toBe(false);
    expect(issue.textContent).toBe("Add at least one question.");
    expect(document.activeElement).toBe(harness.get(control("questions", "add")));
  });

  it("hides the missing-question issue once a question is added", () => {
    const harness = mount({ ...noulExample, questions: { only: { instructions: "Is it good?" } } });
    const [only] = questionKeys(harness);
    harness.get<HTMLButtonElement>(control(only!, "remove")).click();
    harness.get<HTMLButtonElement>(control("questions", "add")).click();
    expect(harness.get("#test-questions-issue").hidden).toBe(true);
  });
});
