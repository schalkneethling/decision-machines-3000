import { describe, expect, it } from "vite-plus/test";
import type { DecisionRequest } from "../../decision/contract.ts";
import { EXAMPLE_SETS, choiceExample, noulExample, scoreExample } from "../../decision/examples.ts";
import { validateDecisionRequest } from "../../decision/validate.ts";
import type { ValidDecisionRequest } from "../../decision/validate.ts";
import {
  addLevel,
  addOption,
  addQuestion,
  arrayKeys,
  expandTemplate,
  findIssues,
  inheritCriteria,
  moveByKey,
  overrideCriteria,
  readContentText,
  readStateText,
  removeByKey,
  removeSharedCriteria,
  supportsFanOut,
  toRequest,
  toViewModel,
} from "./model.ts";
import type { ComposerModel, CriteriaModel, QuestionModel } from "./model.ts";
import { DEFAULT_PROVIDER, PROVIDERS } from "../../providers/catalog.ts";

function question(model: ComposerModel, index = 0): QuestionModel {
  const found = model.questions[index];
  if (found === undefined) throw new Error(`No question at ${index}.`);
  return found;
}

function options(criteria: CriteriaModel | undefined) {
  if (criteria?.kind !== "choice") throw new Error("Expected choice criteria.");
  return criteria;
}

function levels(criteria: CriteriaModel | undefined) {
  if (criteria?.kind !== "score") throw new Error("Expected score criteria.");
  return criteria;
}

function messages(model: ComposerModel): string[] {
  return findIssues(model, DEFAULT_PROVIDER.capabilities).map((issue) => issue.message);
}

/** Every request of every example set, named "film noul", "images choice", and so on. */
const examples = Object.values(EXAMPLE_SETS).flatMap((set) =>
  Object.entries(set.requests).map(([primitive, request]): [string, ValidDecisionRequest] => [
    `${set.id} ${primitive}`,
    request,
  ]),
);

describe("round trip", () => {
  it.each(examples)(
    "turns the %s example into a view-model and back unchanged",
    (_name, example) => {
      const request = toRequest(toViewModel(example));
      expect(request).toStrictEqual(example);
      expect(JSON.stringify(request)).toBe(JSON.stringify(example));
    },
  );

  it.each(examples)("produces a request that passes validation for %s", (_name, example) => {
    expect(
      validateDecisionRequest(toRequest(toViewModel(example)), DEFAULT_PROVIDER.capabilities).ok,
    ).toBe(true);
  });

  it.each(examples)("finds no issues in the %s example", (_name, example) => {
    expect(findIssues(toViewModel(example), DEFAULT_PROVIDER.capabilities)).toEqual([]);
  });

  it("gives every row a unique key", () => {
    const model = toViewModel(choiceExample);
    const keys = [
      ...model.questions.map((entry) => entry.key),
      ...options(model.criteria).options.map((option) => option.key),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("fan-out", () => {
  it("collapses the six Choice film questions into one question over films", () => {
    const model = toViewModel(choiceExample);
    expect(model.questions).toHaveLength(1);
    expect(question(model)).toMatchObject({
      id: "film",
      fanOut: "films",
      instructions: "Which genre best fits the film described in {{item}}?",
    });
  });

  it("collapses the Score questions and keeps the path below the item", () => {
    const model = toViewModel(scoreExample);
    expect(model.questions).toHaveLength(1);
    expect(question(model)).toMatchObject({
      id: "film",
      fanOut: "films",
      instructions: "How intense is the content described in {{item.notes}} for a young audience?",
    });
  });

  it("treats criteria with the same keys in a different order as equal", () => {
    const criteria = (reversed: boolean) => {
      const entries = Object.entries({ drama: "Serious.", comedy: "Funny." });
      return Object.fromEntries(reversed ? entries.reverse() : entries);
    };
    const questions = Object.fromEntries(
      Object.entries(choiceExample.questions).map(([id, entry], index) => [
        id,
        { ...entry, criteria: criteria(index % 2 === 1) },
      ]),
    );
    const validation = validateDecisionRequest(
      { ...choiceExample, questions },
      DEFAULT_PROVIDER.capabilities,
    );
    if (!validation.ok) throw new Error(validation.error);
    const model = toViewModel(validation.value);
    expect(model.questions).toHaveLength(1);
    expect(question(model).fanOut).toBe("films");
  });

  it("keeps questions apart when their criteria differ in value", () => {
    const questions = Object.fromEntries(
      Object.entries(choiceExample.questions).map(([id, entry], index) => [
        id,
        { ...entry, criteria: { drama: index === 0 ? "Serious." : "Grave.", comedy: "Funny." } },
      ]),
    );
    const validation = validateDecisionRequest(
      { ...choiceExample, questions },
      DEFAULT_PROVIDER.capabilities,
    );
    if (!validation.ok) throw new Error(validation.error);
    expect(toViewModel(validation.value).questions.length).toBeGreaterThan(1);
  });

  it("leaves unrelated Noul questions as plain questions", () => {
    const model = toViewModel(noulExample);
    expect(model.questions.map((entry) => entry.id)).toEqual(Object.keys(noulExample.questions));
    expect(model.questions.every((entry) => entry.fanOut === undefined)).toBe(true);
  });

  it("expands a template into backticked paths", () => {
    expect(expandTemplate("Is {{item}} longer than {{item.notes}}?", "films", 3)).toBe(
      "Is `films[3]` longer than `films[3].notes`?",
    );
  });

  it("expands to one question per item, following the current state", () => {
    const model = toViewModel(choiceExample);
    model.state = { films: ["a", "b"] };
    expect(Object.keys(toRequest(model).questions)).toEqual(["film_0", "film_1"]);
    expect(toRequest(model).questions.film_1?.instructions).toBe(
      "Which genre best fits the film described in `films[1]`?",
    );
  });

  it("keeps questions plain when one instruction differs beyond the index", () => {
    const request: ValidDecisionRequest = {
      ...choiceExample,
      questions: {
        ...choiceExample.questions,
        film_2: { instructions: "Which genre fits `films[2]` best?" },
      },
    };
    const model = toViewModel(request);
    expect(model.questions).toHaveLength(6);
    expect(toRequest(model)).toStrictEqual(request);
  });

  it("keeps questions plain when the count does not match the list length", () => {
    const { film_5: _dropped, ...fewer } = choiceExample.questions;
    const request: ValidDecisionRequest = { ...choiceExample, questions: fewer };
    const model = toViewModel(request);
    expect(model.questions).toHaveLength(5);
    expect(toRequest(model)).toStrictEqual(request);
  });

  it("keeps questions plain when their criteria differ", () => {
    const request: DecisionRequest<"score"> = {
      ...scoreExample,
      questions: {
        ...scoreExample.questions,
        film_1: { ...scoreExample.questions.film_1!, criteria: ["Calm", "Tense"] },
      },
    };
    const model = toViewModel(request);
    expect(model.questions).toHaveLength(4);
    expect(toRequest(model)).toStrictEqual(request);
  });

  it("collapses questions that share their own criteria and keeps those criteria", () => {
    const criteria: [string, string] = ["Calm", "Tense"];
    const request: DecisionRequest<"score"> = {
      primitive: "score",
      state: { films: ["a", "b"] },
      questions: {
        film_0: { instructions: "How tense is `films[0]`?", criteria },
        film_1: { instructions: "How tense is `films[1]`?", criteria },
      },
    };
    const model = toViewModel(request);
    expect(model.questions).toHaveLength(1);
    expect(levels(question(model).criteria).levels).toHaveLength(2);
    expect(toRequest(model)).toStrictEqual(request);
  });

  it("reports a missing list, an empty list, and a missing placeholder", () => {
    const model = toViewModel(choiceExample);
    const fanOut = question(model);

    fanOut.fanOut = "reviews";
    expect(messages(model)).toEqual([
      `The state has no list called "reviews". Pick a list from the state or ask once.`,
    ]);

    model.state = { films: [] };
    fanOut.fanOut = "films";
    expect(messages(model)[0]).toMatch(/is empty/);

    model.state = { films: ["a"] };
    fanOut.instructions = "Which genre is it?";
    expect(messages(model)).toEqual(["Write {{item}} in the instructions where each item goes."]);
  });
});

describe("question ids", () => {
  it("rejects empty and non-slug ids", () => {
    const model = toViewModel(noulExample);
    question(model, 0).id = "";
    question(model, 1).id = "Reveals Ending";
    expect(messages(model)).toEqual([
      "Give this question an id.",
      "Question ids use lowercase letters, digits, and underscores only.",
    ]);
  });

  it("flags every question that shares an id", () => {
    const model = toViewModel(noulExample);
    question(model, 1).id = "recommends";
    const issues = findIssues(model, DEFAULT_PROVIDER.capabilities);
    expect(issues.map((issue) => issue.key)).toEqual([
      question(model, 0).key,
      question(model, 1).key,
    ]);
    expect(issues.every((issue) => issue.field === "id")).toBe(true);
  });

  it("flags a plain id that clashes with a fan-out's expanded ids", () => {
    const model = toViewModel(choiceExample);
    const plain = addQuestion(model);
    plain.id = "film_2";
    plain.instructions = "Is this a film?";
    expect(findIssues(model, DEFAULT_PROVIDER.capabilities).map((issue) => issue.key)).toEqual([
      question(model).key,
      plain.key,
    ]);
  });

  it("gives an added question an unused id", () => {
    const model = toViewModel(noulExample);
    question(model, 0).id = "question_5";
    expect(addQuestion(model).id).toBe("question_6");
  });
});

describe("options and levels", () => {
  it("rejects option names that are empty, not slugs, or repeated", () => {
    const model = toViewModel(choiceExample);
    const shared = options(model.criteria);
    addOption(model, shared);
    addOption(model, shared).name = "Film Noir";
    addOption(model, shared).name = "horror";
    expect(messages(model)).toEqual([
      "Give this option a name.",
      "Option names use lowercase letters, digits, and underscores only.",
      `Another option is already called "horror". Give this one a different name.`,
    ]);
  });

  it("needs at least 2 options and 2 levels", () => {
    const choice = toViewModel(choiceExample);
    options(choice.criteria).options.splice(1);
    expect(messages(choice)).toEqual(["Shared options need at least 2 options. Add one more."]);

    const score = toViewModel(scoreExample);
    levels(score.criteria).levels.splice(0);
    expect(messages(score)).toEqual(["Shared levels need at least 2 levels. Add 2 more."]);
  });

  it("moves and removes levels by key", () => {
    const model = toViewModel(scoreExample);
    const shared = levels(model.criteria);
    const [first, second] = shared.levels;
    expect(moveByKey(shared.levels, first!.key, 1)).toBe(1);
    expect(shared.levels[0]).toBe(second);
    expect(moveByKey(shared.levels, second!.key, -1)).toBe(-1);
    expect(removeByKey(shared.levels, first!.key)).toBe(1);
    expect(shared.levels).toHaveLength(3);
    addLevel(model, shared);
    expect(toRequest(model).criteria).toHaveLength(4);
  });
});

describe("state and instructions", () => {
  it("empty instructions and an empty state are issues", () => {
    const model = toViewModel(noulExample);
    model.state = "  ";
    question(model, 2).instructions = "";
    expect(findIssues(model, DEFAULT_PROVIDER.capabilities).map((issue) => issue.field)).toEqual([
      "state",
      "instructions",
    ]);
  });

  it("reads state as JSON when it is an object or a list, otherwise as text", () => {
    expect(readStateText(`{"films": [1, 2]}`)).toEqual({
      state: { films: [1, 2] },
      reading: "json",
    });
    expect(readStateText(`[1, 2]`).reading).toBe("json");
    expect(readStateText(`{"films": `)).toEqual({ state: `{"films": `, reading: "text" });
    expect(readStateText("42").reading).toBe("text");
  });

  it("detects top-level list keys usable as fan-out paths", () => {
    expect(arrayKeys({ films: [], title: "x", "bad key": [], reviews: [1] })).toEqual([
      "films",
      "reviews",
    ]);
    expect(arrayKeys(["a"])).toEqual([]);
    expect(arrayKeys("text")).toEqual([]);
  });

  it("reads content as JSON whenever it parses as an object or list", () => {
    expect(readContentText(`{"a": 1}`)).toEqual({ a: 1 });
    expect(readContentText(`[1, 2]`)).toEqual([1, 2]);
    expect(readContentText(`{"a": `)).toBe(`{"a": `);
    expect(readContentText("Is it good?")).toBe("Is it good?");
  });

  it("becomes structured again after an edit breaks and then repairs the JSON", () => {
    const model = toViewModel({
      ...noulExample,
      questions: { structured: { instructions: { a: 1 } } },
    });
    const edited = question(model);
    edited.instructions = readContentText(`{\n  "a": 1\n`);
    expect(edited.instructions).toBe(`{\n  "a": 1\n`);
    edited.instructions = readContentText(`{\n  "a": 1\n}`);
    expect(edited.instructions).toEqual({ a: 1 });
    expect(toRequest(model).questions.structured?.instructions).toEqual({ a: 1 });
  });
});

describe("inherit or override criteria", () => {
  it("inherits shared criteria by default and sends no criteria of its own", () => {
    const model = toViewModel(choiceExample);
    expect(question(model).criteria).toBeUndefined();
    expect(toRequest(model).questions.film_0).not.toHaveProperty("criteria");
  });

  it("overrides with a copy of the shared criteria that edits independently", () => {
    const model = toViewModel(choiceExample);
    const own = options(overrideCriteria(model, question(model)));
    const shared = options(model.criteria);
    expect(own.options.map((option) => option.name)).toEqual(
      shared.options.map((option) => option.name),
    );
    expect(own.options[0]!.key).not.toBe(shared.options[0]!.key);

    own.options[0]!.name = "sci_fi";
    expect(shared.options[0]!.name).toBe("science_fiction");
    expect(Object.keys(toRequest(model).questions.film_0?.criteria ?? {})[0]).toBe("sci_fi");
  });

  it("inherits again after the override is dropped", () => {
    const model = toViewModel(scoreExample);
    overrideCriteria(model, question(model));
    inheritCriteria(question(model));
    expect(toRequest(model)).toStrictEqual(scoreExample);
  });

  it("starts a Noul override with no meanings when there is nothing shared", () => {
    const model = toViewModel(noulExample);
    expect(overrideCriteria(model, question(model))).toEqual({ kind: "noul", meanings: {} });
  });

  it("copies shared criteria into inheriting questions when shared criteria are removed", () => {
    const model = toViewModel(scoreExample);
    removeSharedCriteria(model);
    const request = toRequest(model);
    expect(request).not.toHaveProperty("criteria");
    expect(request.questions.film_0?.criteria).toEqual(scoreExample.criteria);
    expect(validateDecisionRequest(request, DEFAULT_PROVIDER.capabilities).ok).toBe(true);
  });

  it("reports a Choice question with no options anywhere", () => {
    const model = toViewModel(choiceExample);
    delete model.criteria;
    expect(messages(model)).toEqual([
      "This question has no options. Add options for it, or add shared options.",
    ]);
  });
});

describe("fan-out by primitive", () => {
  it("is offered for choice and score but not noul", () => {
    expect(supportsFanOut("noul")).toBe(false);
    expect(supportsFanOut("choice")).toBe(true);
    expect(supportsFanOut("score")).toBe(true);
  });

  it("never collapses noul questions, even when they look like a fan-out", () => {
    const request = validateDecisionRequest(
      {
        primitive: "noul",
        state: { reviews: ["Loved it.", "Hated it."] },
        questions: {
          positive_0: { instructions: "Is `reviews[0]` positive?" },
          positive_1: { instructions: "Is `reviews[1]` positive?" },
        },
      },
      DEFAULT_PROVIDER.capabilities,
    );
    if (!request.ok) throw new Error(request.error);
    const model = toViewModel(request.value);
    expect(model.questions.map((entry) => entry.id)).toEqual(["positive_0", "positive_1"]);
    expect(model.questions.every((entry) => entry.fanOut === undefined)).toBe(true);
    expect(toRequest(model)).toEqual(request.value);
  });
});

describe("question id length", () => {
  const subq = PROVIDERS.subq.capabilities;
  const typesafe = PROVIDERS.typesafe.capabilities;

  it("flags a 101-character id on the id field under SubQ", () => {
    const model = toViewModel(noulExample);
    question(model, 0).id = "q".repeat(101);
    const issues = findIssues(model, subq);
    expect(issues).toEqual([
      {
        key: question(model, 0).key,
        field: "id",
        message: `Question id "${"q".repeat(40)}…" is 101 characters long. Use at most 100.`,
      },
    ]);
  });

  it("accepts a 100-character id under SubQ", () => {
    const model = toViewModel(noulExample);
    question(model, 0).id = "q".repeat(100);
    expect(findIssues(model, subq)).toEqual([]);
  });

  it("flags a fan-out whose expanded ids pass 100 characters", () => {
    const model = toViewModel(choiceExample);
    const fanOut = question(model);
    model.state = { films: ["a", "b"] };
    fanOut.fanOut = "films";
    fanOut.instructions = "Which genre is {{item}}?";
    fanOut.id = "q".repeat(99);
    const issues = findIssues(model, subq);
    expect(issues.map((issue) => [issue.key, issue.field])).toEqual([[fanOut.key, "id"]]);
    expect(issues[0]?.message).toMatch(/is 101 characters long. Use at most 100./);
  });

  it("does not flag the same ids under TypeSafe", () => {
    const model = toViewModel(noulExample);
    question(model, 0).id = "q".repeat(101);
    expect(findIssues(model, typesafe)).toEqual([]);
  });
});

describe("a blank state with images", () => {
  const subq = PROVIDERS.subq.capabilities;
  const typesafe = PROVIDERS.typesafe.capabilities;

  function blankState(): ComposerModel {
    const model = toViewModel(noulExample);
    model.state = "  ";
    return model;
  }

  it("is not an issue when an image goes with the request", () => {
    expect(findIssues(blankState(), subq, 1)).toEqual([]);
  });

  it("offers attaching an image when none is attached and the provider takes images", () => {
    expect(findIssues(blankState(), subq).map((issue) => issue.message)).toEqual([
      "The state is empty. Add the text, object, or list to evaluate, or attach an image.",
    ]);
  });

  it("does not offer an image to a text-only provider", () => {
    expect(findIssues(blankState(), typesafe).map((issue) => issue.message)).toEqual([
      "The state is empty. Add the text, object, or list to evaluate.",
    ]);
  });
});
