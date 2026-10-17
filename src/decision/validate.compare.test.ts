/**
 * The schema-library spike's comparison set (`spikes/schema-library/compare.test.ts`
 * and `shared/cases.ts` on the branch `issue-31-schema-library-spike`), pointed at
 * the migrated validator. Each expected message and path is what the hand-written
 * validator returned for the same request before the move to Zod Mini, recorded
 * here so the guarantee that none of them changed stays under test.
 *
 * The array cases at the end cover every position where the request expects an
 * object, so the protection Zod gives by default stays explicit.
 */

import { describe, expect, it } from "vite-plus/test";
import { filmExamples } from "./examples.ts";
import { requestSchemaFor, validateDecisionRequest } from "./validate.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import type { ProviderCapabilities } from "../providers/catalog.ts";

const examples = filmExamples.requests;
const typesafe = PROVIDERS.typesafe.capabilities;
const subq = PROVIDERS.subq.capabilities;

function scoreOf(count: number): unknown {
  return {
    primitive: "score",
    state: "Hello",
    criteria: Array.from({ length: count }, (_, index) => `Level ${index}`),
    questions: { warmth: { instructions: "How warm is it?" } },
  };
}

function choiceOf(count: number): unknown {
  return {
    primitive: "choice",
    state: "Hello",
    criteria: Object.fromEntries(Array.from({ length: count }, (_, index) => [`o${index}`, null])),
    questions: { pick: { instructions: "Which?" } },
  };
}

function longIdRequest(length: number): unknown {
  return { ...examples.noul, questions: { ["q".repeat(length)]: { instructions: "Is it?" } } };
}

const truncatedId = `${"q".repeat(40)}…`;

type InvalidCase = {
  name: string;
  request: unknown;
  capabilities?: ProviderCapabilities;
  error: string;
  /** Absent when the problem is the request as a whole. */
  detail?: string;
};

const invalidCases: InvalidCase[] = [
  {
    name: "a request that is not an object",
    request: [],
    error: `The request must be a JSON object with "primitive", "state", and "questions", not a list.`,
  },
  {
    name: "a missing state",
    request: { primitive: "noul", questions: { q: { instructions: "Is it?" } } },
    error: `Add a "state" field with the text, object, or list to evaluate.`,
    detail: "state",
  },
  {
    name: "a null state",
    request: { primitive: "noul", state: null, questions: { q: { instructions: "Is it?" } } },
    error: `"state" must be text, an object, or a list, not null.`,
    detail: "state",
  },
  {
    name: "a numeric state",
    request: { primitive: "noul", state: 42, questions: { q: { instructions: "Is it?" } } },
    error: `"state" must be text, an object, or a list, not a number.`,
    detail: "state",
  },
  {
    name: "a boolean state",
    request: { primitive: "noul", state: true, questions: { q: { instructions: "Is it?" } } },
    error: `"state" must be text, an object, or a list, not true.`,
    detail: "state",
  },
  {
    name: "empty questions",
    request: { primitive: "noul", state: "Hello", questions: {} },
    error: `Add a "questions" object with at least one question, keyed by an id of your choosing.`,
    detail: "questions",
  },
  {
    name: "an unknown top-level key",
    request: { ...examples.noul, model: "jev-latest" },
    error: `The request has an unknown field "model". It can only contain "primitive", "state", "criteria", and "questions".`,
    detail: "model",
  },
  {
    name: "an unknown question key",
    request: {
      primitive: "noul",
      state: "Hello",
      questions: { greeting: { instructions: "Is this a greeting?", type: "noul" } },
    },
    error: `Question "greeting" has an unknown field "type". It can only contain "instructions", and "criteria". The primitive is set once, with "primitive" at the top of the request.`,
    detail: "questions.greeting.type",
  },
  {
    name: "an unknown primitive",
    request: { ...examples.noul, primitive: "rank" },
    error: `Set "primitive" to "noul", "choice", or "score". It is currently "rank".`,
    detail: "primitive",
  },
  {
    name: "empty instructions",
    request: { primitive: "noul", state: "Hello", questions: { q: { instructions: "  " } } },
    error: `The "instructions" of question "q" are empty. Write the question you want answered.`,
    detail: "questions.q.instructions",
  },
  {
    name: "a choice question without criteria",
    request: {
      primitive: "choice",
      state: "Hello",
      questions: { tone: { instructions: "What is the tone?" } },
    },
    error: `Question "tone" has no criteria. Add "criteria" with its options to the question, or a default "criteria" at the top of the request.`,
    detail: "questions.tone.criteria",
  },
  {
    name: "a choice with a single option",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: { only: null },
      questions: { tone: { instructions: "What is the tone?" } },
    },
    error: `The default "criteria" needs at least 2 options to choose between. It has 1.`,
    detail: "criteria",
  },
  {
    name: "a score with one level",
    request: {
      primitive: "score",
      state: "Hello",
      questions: { warmth: { instructions: "How warm is it?", criteria: ["Cold"] } },
    },
    error: `The "criteria" of question "warmth" needs at least 2 levels to score between. It has 1.`,
    detail: "questions.warmth.criteria",
  },
  {
    name: "a score with too many levels",
    request: scoreOf(11),
    error: `The default "criteria" has 11 levels. Use at most 10.`,
    detail: "criteria",
  },
  {
    name: "noul criteria with a key other than true or false",
    request: {
      primitive: "noul",
      state: "Hello",
      questions: { q: { instructions: "Is it?", criteria: { yes: "It is." } } },
    },
    error: `The "criteria" of question "q" has an unknown field "yes". It can only contain "true", and "false".`,
    detail: "questions.q.criteria.yes",
  },
  {
    name: "numeric criteria descriptions",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: { warm: 1, cold: "Distant or curt." },
      questions: { tone: { instructions: "What is the tone?" } },
    },
    error: `The description of option "warm" in The default "criteria" must be text, an object, a list, or null, not a number.`,
    detail: "criteria.warm",
  },
  {
    name: "an 11-level score when scoreLevels.max is 10",
    request: scoreOf(11),
    capabilities: { ...typesafe, scoreLevels: { min: 2, max: 10 } },
    error: `The default "criteria" has 11 levels. Use at most 10.`,
    detail: "criteria",
  },
  {
    name: "four options when choiceOptions.max is 3",
    request: {
      ...examples.choice,
      criteria: { a: null, b: null, c: null, d: null },
      questions: { q: { instructions: "Which?" } },
    },
    capabilities: { ...typesafe, choiceOptions: { min: 2, max: 3 } },
    error: `The default "criteria" has 4 options. Use at most 3.`,
    detail: "criteria",
  },
  {
    name: "a 101-character question id under SubQ",
    request: longIdRequest(101),
    capabilities: subq,
    error: `Question id "${truncatedId}" is 101 characters long. Use at most 100.`,
    detail: `questions.${"q".repeat(101)}`,
  },
  {
    name: "too few levels when scoreLevels.min is 3",
    request: scoreOf(2),
    capabilities: { ...typesafe, scoreLevels: { min: 3, max: 10 } },
    error: `The default "criteria" needs at least 3 levels to score between. It has 2.`,
    detail: "criteria",
  },
  {
    name: "zero options when choiceOptions.min is 1",
    request: choiceOf(0),
    capabilities: { ...typesafe, choiceOptions: { min: 1, max: 255 } },
    error: `The default "criteria" needs at least 1 option to choose between. It has 0.`,
    detail: "criteria",
  },
  {
    name: "a 150-character question id, truncated in the message",
    request: longIdRequest(150),
    capabilities: subq,
    error: `Question id "${truncatedId}" is 150 characters long. Use at most 100.`,
    detail: `questions.${"q".repeat(150)}`,
  },
  {
    name: "256 options",
    request: choiceOf(256),
    error: `The default "criteria" has 256 options. Use at most 255.`,
    detail: "criteria",
  },
  {
    name: "11 levels",
    request: scoreOf(11),
    error: `The default "criteria" has 11 levels. Use at most 10.`,
    detail: "criteria",
  },
  {
    name: "a missing primitive",
    request: { state: "Hello", questions: { q: { instructions: "Is it?" } } },
    error: `Set "primitive" to "noul", "choice", or "score". It is currently missing.`,
    detail: "primitive",
  },
  {
    name: "a numeric primitive",
    request: { primitive: 3, state: "Hello", questions: { q: { instructions: "Is it?" } } },
    error: `Set "primitive" to "noul", "choice", or "score". It is currently a number.`,
    detail: "primitive",
  },
  {
    name: "an empty state",
    request: { primitive: "noul", state: "  ", questions: { q: { instructions: "Is it?" } } },
    error: `"state" is empty. Add the text, object, or list to evaluate.`,
    detail: "state",
  },
  {
    name: "a question that is text",
    request: { primitive: "noul", state: "Hello", questions: { q: "Is it?" } },
    error: `Question "q" must be an object with "instructions" and optional "criteria", not text.`,
    detail: "questions.q",
  },
  {
    name: "a question with an empty id",
    request: { primitive: "noul", state: "Hello", questions: { "  ": { instructions: "Is it?" } } },
    error: `Every question needs a non-empty id.`,
    detail: "questions",
  },
  {
    name: "missing instructions",
    request: { primitive: "noul", state: "Hello", questions: { q: {} } },
    error: `Question "q" has no "instructions". Add the question you want answered.`,
    detail: "questions.q.instructions",
  },
  {
    name: "numeric instructions",
    request: { primitive: "noul", state: "Hello", questions: { q: { instructions: 7 } } },
    error: `The "instructions" of question "q" must be text, an object, or a list, not a number.`,
    detail: "questions.q.instructions",
  },
  {
    name: "a null noul description",
    request: {
      primitive: "noul",
      state: "Hello",
      questions: { q: { instructions: "Is it?", criteria: { true: null } } },
    },
    error: `The "true" description in The "criteria" of question "q" must be text, an object, or a list, not null.`,
    detail: "questions.q.criteria.true",
  },
  {
    name: "an option with an empty name",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: { "": null, cold: null },
      questions: { tone: { instructions: "What is the tone?" } },
    },
    error: `The default "criteria" has an option with an empty name. Give it a name.`,
    detail: "criteria",
  },
  {
    name: "score criteria that are an object",
    request: {
      primitive: "score",
      state: "Hello",
      criteria: { low: null, high: null },
      questions: { warmth: { instructions: "How warm is it?" } },
    },
    error: `The default "criteria" must be a list of level descriptions, lowest level first, not an object.`,
    detail: "criteria",
  },
  {
    name: "a numeric level description",
    request: {
      primitive: "score",
      state: "Hello",
      questions: { warmth: { instructions: "How warm is it?", criteria: ["Cold", 2, "Hot"] } },
    },
    error: `Level 1 in The "criteria" of question "warmth" must be text, an object, a list, or null, not a number.`,
    detail: "questions.warmth.criteria.1",
  },
  {
    name: "a score question without criteria",
    request: {
      primitive: "score",
      state: "Hello",
      questions: { warmth: { instructions: "How warm is it?" } },
    },
    error: `Question "warmth" has no criteria. Add "criteria" with its levels to the question, or a default "criteria" at the top of the request.`,
    detail: "questions.warmth.criteria",
  },
];

/**
 * A list at every position where the request expects an object. The spike's
 * "questions that are a list", "noul criteria that are a list", and "choice
 * criteria that are a list" cases are among them.
 */
const arrayCases: InvalidCase[] = [
  {
    name: "the request",
    request: [],
    error: `The request must be a JSON object with "primitive", "state", and "questions", not a list.`,
  },
  {
    name: "the questions record",
    request: { primitive: "noul", state: "Hello", questions: [] },
    error: `Add a "questions" object with at least one question, keyed by an id of your choosing.`,
    detail: "questions",
  },
  {
    name: "one question",
    request: { primitive: "noul", state: "Hello", questions: { q: [] } },
    error: `Question "q" must be an object with "instructions" and optional "criteria", not a list.`,
    detail: "questions.q",
  },
  {
    name: "the default Noul criteria",
    request: {
      primitive: "noul",
      state: "Hello",
      criteria: [],
      questions: { q: { instructions: "Is it?" } },
    },
    error: `The default "criteria" must be an object with optional "true" and "false" descriptions, not a list.`,
    detail: "criteria",
  },
  {
    name: "a question's Noul criteria",
    request: {
      primitive: "noul",
      state: "Hello",
      questions: { q: { instructions: "Is it?", criteria: [] } },
    },
    error: `The "criteria" of question "q" must be an object with optional "true" and "false" descriptions, not a list.`,
    detail: "questions.q.criteria",
  },
  {
    name: "the default Choice criteria",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: ["warm", "cold"],
      questions: { tone: { instructions: "What is the tone?" } },
    },
    error: `The default "criteria" must be an object that maps each option name to its description, not a list.`,
    detail: "criteria",
  },
  {
    name: "a question's Choice criteria",
    request: {
      primitive: "choice",
      state: "Hello",
      questions: { q: { instructions: "Which?", criteria: ["a", "b"] } },
    },
    error: `The "criteria" of question "q" must be an object that maps each option name to its description, not a list.`,
    detail: "questions.q.criteria",
  },
  {
    name: "a question's Choice criteria, empty",
    request: {
      primitive: "choice",
      state: "Hello",
      questions: { q: { instructions: "Which?", criteria: [] } },
    },
    error: `The "criteria" of question "q" must be an object that maps each option name to its description, not a list.`,
    detail: "questions.q.criteria",
  },
];

function expectedFailure({ error, detail }: InvalidCase) {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

describe("validateDecisionRequest keeps every message and path of the hand-written validator", () => {
  it.each(invalidCases)("rejects $name", (testCase) => {
    expect(validateDecisionRequest(testCase.request, testCase.capabilities ?? typesafe)).toEqual(
      expectedFailure(testCase),
    );
  });
});

describe("validateDecisionRequest rejects a list where an object is expected", () => {
  it.each(arrayCases)("at $name", (testCase) => {
    expect(validateDecisionRequest(testCase.request, typesafe)).toEqual(expectedFailure(testCase));
  });
});

type ValidCase = { name: string; request: unknown; capabilities?: ProviderCapabilities };

const validCases: ValidCase[] = [
  { name: "the noul example", request: examples.noul },
  { name: "the choice example", request: examples.choice },
  { name: "the score example", request: examples.score },
  {
    name: "questions that inherit the default criteria",
    request: {
      primitive: "score",
      state: "Thanks so much!",
      criteria: ["Cold", "Neutral", "Warm"],
      questions: {
        inherits: { instructions: "How warm is the message?" },
        overrides: { instructions: "How polite is it?", criteria: ["Rude", "Polite"] },
      },
    },
  },
  {
    name: "noul questions without any criteria",
    request: {
      primitive: "noul",
      state: ["a", "list", "state"],
      questions: { q: { instructions: { question: "Is `state` a list?" } } },
    },
  },
  {
    name: "an 11-level score when scoreLevels.max is undefined",
    request: scoreOf(11),
    capabilities: { ...typesafe, scoreLevels: { min: 2 } },
  },
  {
    name: "a 100-character question id under SubQ",
    request: longIdRequest(100),
    capabilities: subq,
  },
  { name: "a 101-character question id under TypeSafe", request: longIdRequest(101) },
  { name: "exactly 10 levels", request: scoreOf(10) },
  { name: "exactly 255 options", request: choiceOf(255) },
  {
    name: "sixty emoji as a question id under SubQ",
    request: {
      ...examples.noul,
      questions: { ["\u{1F600}".repeat(60)]: { instructions: "Is it?" } },
    },
    capabilities: subq,
  },
];

describe("validateDecisionRequest accepts what the hand-written validator accepted", () => {
  it.each(validCases)("accepts $name and returns it unchanged", ({ request, capabilities }) => {
    expect(validateDecisionRequest(request, capabilities ?? typesafe)).toEqual({
      ok: true,
      value: request,
    });
  });

  it("accepts the examples after a JSON round trip and returns them unchanged", () => {
    for (const example of Object.values(examples)) {
      expect(validateDecisionRequest(JSON.parse(JSON.stringify(example)), typesafe)).toEqual({
        ok: true,
        value: example,
      });
    }
  });
});

/*
 * Behaviours of the hand-written validator that the first version of the schemas lost,
 * found in review. Each expected value is what the hand-written validator returned.
 */

const question = { instructions: "Is it?" };

/** An unknown field is reported before any problem with the object's known fields. */
const unknownFieldFirstCases: InvalidCase[] = [
  {
    name: "a misspelt state, which also leaves state missing",
    request: { primitive: "noul", statee: "Hello", questions: { q: question } },
    error: `The request has an unknown field "statee". It can only contain "primitive", "state", "criteria", and "questions".`,
    detail: "statee",
  },
  {
    name: "question written for questions",
    request: { primitive: "noul", state: "Hello", question: { q: question } },
    error: `The request has an unknown field "question". It can only contain "primitive", "state", "criteria", and "questions".`,
    detail: "question",
  },
  {
    name: "a misspelt primitive",
    request: { primitve: "noul", state: "Hello", questions: { q: question } },
    error: `The request has an unknown field "primitve". It can only contain "primitive", "state", "criteria", and "questions".`,
    detail: "primitve",
  },
  {
    name: "an unknown top-level field with an unknown primitive",
    request: { primitive: "rank", stat: "Hello", questions: { q: question } },
    error: `The request has an unknown field "stat". It can only contain "primitive", "state", "criteria", and "questions".`,
    detail: "stat",
  },
  {
    name: "a misspelt instructions, which also leaves instructions missing",
    request: { primitive: "noul", state: "Hello", questions: { q: { instruction: "Is it?" } } },
    error: `Question "q" has an unknown field "instruction". It can only contain "instructions", and "criteria".`,
    detail: "questions.q.instruction",
  },
  {
    name: "a type field in a question without instructions, with the primitive hint",
    request: { primitive: "noul", state: "Hello", questions: { q: { type: "noul" } } },
    error: `Question "q" has an unknown field "type". It can only contain "instructions", and "criteria". The primitive is set once, with "primitive" at the top of the request.`,
    detail: "questions.q.type",
  },
  {
    name: "an unknown Noul criteria field with a broken description",
    request: {
      primitive: "noul",
      state: "Hello",
      questions: { q: { instructions: "Is it?", criteria: { yes: "It is.", true: 5 } } },
    },
    error: `The "criteria" of question "q" has an unknown field "yes". It can only contain "true", and "false".`,
    detail: "questions.q.criteria.yes",
  },
  {
    name: "an unknown top-level field with an unknown question field",
    request: { primitive: "noul", stat: "Hello", questions: { q: { instruction: "Is it?" } } },
    error: `The request has an unknown field "stat". It can only contain "primitive", "state", "criteria", and "questions".`,
    detail: "stat",
  },
  {
    name: "a broken state before an unknown question field",
    request: { primitive: "noul", state: 5, questions: { q: { instruction: "Is it?" } } },
    error: `"state" must be text, an object, or a list, not a number.`,
    detail: "state",
  },
];

/** A blank key is reported at its record before anything about its value. */
const blankKeyCases: InvalidCase[] = [
  {
    name: "an empty question id whose question is not an object",
    request: { primitive: "noul", state: "Hello", questions: { "": 5 } },
    error: `Every question needs a non-empty id.`,
    detail: "questions",
  },
  {
    name: "a broken question before an empty question id",
    request: { primitive: "noul", state: "Hello", questions: { a: 5, "": question } },
    error: `Question "a" must be an object with "instructions" and optional "criteria", not a number.`,
    detail: "questions.a",
  },
  {
    name: "an empty option name whose description is a number",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: { "": 5, cold: null },
      questions: { q: question },
    },
    error: `The default "criteria" has an option with an empty name. Give it a name.`,
    detail: "criteria",
  },
  {
    name: "an empty option name in too few options",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: { "": null },
      questions: { q: question },
    },
    error: `The default "criteria" needs at least 2 options to choose between. It has 1.`,
    detail: "criteria",
  },
];

/** Whatever a provider's minimum, a Score question needs two levels. */
const scoreFloorCases: InvalidCase[] = [
  {
    name: "one level when scoreLevels.min is 1",
    request: { primitive: "score", state: "Hello", criteria: ["Cold"], questions: { q: question } },
    capabilities: { ...typesafe, scoreLevels: { min: 1, max: 10 } },
    error: `The default "criteria" needs at least 2 levels to score between.`,
    detail: "criteria",
  },
  {
    name: "no levels when scoreLevels.min is 0",
    request: { primitive: "score", state: "Hello", criteria: [], questions: { q: question } },
    capabilities: { ...typesafe, scoreLevels: { min: 0 } },
    error: `The default "criteria" needs at least 2 levels to score between.`,
    detail: "criteria",
  },
];

/** An explicit `undefined` inside a list or as an option's description is still refused. */
const undefinedValueCases: InvalidCase[] = [
  {
    name: "an undefined criteria on a Choice question with no default",
    request: {
      primitive: "choice",
      state: "Hello",
      questions: { q: { instructions: "Which?", criteria: undefined } },
    },
    error: `Question "q" has no criteria. Add "criteria" with its options to the question, or a default "criteria" at the top of the request.`,
    detail: "questions.q.criteria",
  },
  {
    name: "an undefined level",
    request: {
      primitive: "score",
      state: "Hello",
      criteria: ["Cold", undefined, "Hot"],
      questions: { q: question },
    },
    error: `Level 1 in The default "criteria" must be text, an object, a list, or null, not missing.`,
    detail: "criteria.1",
  },
  {
    name: "an undefined option description",
    request: {
      primitive: "choice",
      state: "Hello",
      criteria: { a: undefined, b: null },
      questions: { q: question },
    },
    error: `The description of option "a" in The default "criteria" must be text, an object, a list, or null, not missing.`,
    detail: "criteria.a",
  },
];

describe("validateDecisionRequest keeps the order the hand-written validator reported problems in", () => {
  it.each([
    ...unknownFieldFirstCases,
    ...blankKeyCases,
    ...scoreFloorCases,
    ...undefinedValueCases,
  ])("rejects $name", (testCase) => {
    expect(validateDecisionRequest(testCase.request, testCase.capabilities ?? typesafe)).toEqual(
      expectedFailure(testCase),
    );
  });
});

/** A list with a hole at index 1, as only a request built in memory can be. */
function sparseLevels(): unknown[] {
  const levels: unknown[] = ["Cold"];
  levels[2] = "Hot";
  return levels;
}

describe("validateDecisionRequest treats a field set to undefined as absent", () => {
  it.each([
    {
      name: "an undefined default and question criteria on a Noul request",
      request: {
        primitive: "noul",
        state: "Hello",
        criteria: undefined,
        questions: { q: { instructions: "Is it?", criteria: undefined } },
      },
      value: { primitive: "noul", state: "Hello", questions: { q: { instructions: "Is it?" } } },
    },
    {
      name: "an undefined Noul description",
      request: {
        primitive: "noul",
        state: "Hello",
        questions: { q: { instructions: "Is it?", criteria: { true: undefined, false: "No." } } },
      },
      value: {
        primitive: "noul",
        state: "Hello",
        questions: { q: { instructions: "Is it?", criteria: { false: "No." } } },
      },
    },
    {
      name: "an undefined default criteria on a Choice request",
      request: {
        primitive: "choice",
        state: "Hello",
        criteria: undefined,
        questions: { q: { instructions: "Which?", criteria: { a: null, b: null } } },
      },
      value: {
        primitive: "choice",
        state: "Hello",
        questions: { q: { instructions: "Which?", criteria: { a: null, b: null } } },
      },
    },
    {
      name: "an undefined question criteria under a Score default",
      request: {
        primitive: "score",
        state: "Hello",
        criteria: ["Cold", "Hot"],
        questions: { q: { instructions: "How warm?", criteria: undefined } },
      },
      value: {
        primitive: "score",
        state: "Hello",
        criteria: ["Cold", "Hot"],
        questions: { q: { instructions: "How warm?" } },
      },
    },
  ])("accepts $name and leaves the field out", ({ request, value }) => {
    expect(validateDecisionRequest(request, typesafe)).toStrictEqual({ ok: true, value });
  });

  it("accepts a hole in a score list as an undescribed level", () => {
    // The hand-written validator returned `undefined` in the hole; the schema returns
    // `null`, the type's own value for an undescribed level, which is what JSON sends.
    expect(
      validateDecisionRequest(
        {
          primitive: "score",
          state: "Hello",
          criteria: sparseLevels(),
          questions: { q: question },
        },
        typesafe,
      ),
    ).toStrictEqual({
      ok: true,
      value: {
        primitive: "score",
        state: "Hello",
        criteria: ["Cold", null, "Hot"],
        questions: { q: question },
      },
    });
  });
});

describe("validateDecisionRequest builds one schema per set of limits", () => {
  it("applies a limit changed after the first call", () => {
    const capabilities: ProviderCapabilities = { ...typesafe, scoreLevels: { min: 2, max: 10 } };
    expect(validateDecisionRequest(scoreOf(11), capabilities).ok).toBe(false);

    capabilities.scoreLevels = { min: 2 };
    expect(validateDecisionRequest(scoreOf(11), capabilities).ok).toBe(true);
  });

  it("reuses one schema for equal limits and builds another for different ones", () => {
    const schema = requestSchemaFor(typesafe);
    expect(requestSchemaFor({ ...typesafe })).toBe(schema);
    expect(requestSchemaFor(PROVIDERS.openai.capabilities)).toBe(schema);
    expect(requestSchemaFor(subq)).not.toBe(schema);
  });
});

describe("validateDecisionRequest on a deeply nested request", () => {
  it("reports that it is too deep instead of throwing", () => {
    // Built in a loop, so building it needs no stack.
    let state: unknown = "leaf";
    for (let depth = 0; depth < 100_000; depth++) state = [state];
    expect(
      validateDecisionRequest({ primitive: "noul", state, questions: { q: question } }, typesafe),
    ).toEqual({
      ok: false,
      error: `The request is nested too deeply to check. Use fewer levels of lists and objects inside each other.`,
    });
  });
});
