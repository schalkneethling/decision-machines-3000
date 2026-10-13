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

describe("tree structure", () => {
  it("renders the state, shared criteria, each question, and an add button as one spine", () => {
    const harness = mount(choiceExample);
    const branch = harness.get(".tree > .tree-branch");
    const rows = [...branch.children].map((row) => row.getAttribute("data-row"));
    expect(rows).toEqual(["shared", ...questionKeys(harness), "questions"]);
    expect(harness.get("#test-state-state").tagName).toBe("TEXTAREA");
    expect(harness.all(".option-row")).toHaveLength(7);
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
      "Read as JSON. Questions can ask about each item in films, reviews.",
    );
    const [question] = questionKeys(harness);
    const select = harness.get<HTMLSelectElement>(control(question!, "fan-out"));
    expect([...select.options].map((option) => option.value)).toEqual(["", "films", "reviews"]);

    type(state, "A plain sentence.");
    expect(hint.textContent).toBe("Read as text.");
    expect(harness.composer.model().state).toBe("A plain sentence.");
  });

  it("offers no fan-out control on a Noul panel", () => {
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
    expect(hint.textContent).toBe("Read as JSON.");
    expect(field.getAttribute("aria-describedby")).toContain(hint.id);

    type(field, `{\n  "a": 1\n`);
    expect(harness.composer.model().questions[0]?.instructions).toBe(`{\n  "a": 1\n`);
    expect(hint.textContent).toBe("Read as text.");

    type(field, `{\n  "a": 1\n}`);
    expect(harness.composer.model().questions[0]?.instructions).toEqual({ a: 1 });
    expect(hint.textContent).toBe("Read as JSON.");
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
    expect(harness.get(`#test-${added}-description-reading`).textContent).toBe("Read as JSON.");
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
