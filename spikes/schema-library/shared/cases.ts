/**
 * The request test set. The invalid cases are every invalid request in
 * `src/decision/validate.test.ts`: the 16 that were there before PR #30 and the
 * 8 that PR #30 added for capability-driven limits, followed by additional cases
 * that reach messages the test file does not. The expected message and path of
 * each case come from `src/decision/validate.ts` at run time, not from this file.
 */

import { examples } from "../../../src/decision/examples.ts";
import { PROVIDERS } from "../../../src/providers/catalog.ts";
import type { ProviderCapabilities } from "../../../src/providers/catalog.ts";

export type CaseSource = "validate.test.ts before #30" | "validate.test.ts, #30" | "additional";

export type RequestCase = {
  name: string;
  source: CaseSource;
  request: unknown;
  capabilities: ProviderCapabilities;
};

const typesafe = PROVIDERS.typesafe.capabilities;
const subq = PROVIDERS.subq.capabilities;

function scoreOf(count: number): RequestCase["request"] {
  return {
    primitive: "score",
    state: "Hello",
    criteria: Array.from({ length: count }, (_, index) => `Level ${index}`),
    questions: { warmth: { instructions: "How warm is it?" } },
  };
}

function choiceOf(count: number): RequestCase["request"] {
  return {
    primitive: "choice",
    state: "Hello",
    criteria: Object.fromEntries(Array.from({ length: count }, (_, index) => [`o${index}`, null])),
    questions: { pick: { instructions: "Which?" } },
  };
}

function longIdRequest(length: number): RequestCase["request"] {
  return { ...examples.noul, questions: { ["q".repeat(length)]: { instructions: "Is it?" } } };
}

const main = (name: string, request: unknown): RequestCase => ({
  name,
  source: "validate.test.ts before #30",
  request,
  capabilities: typesafe,
});

const branch = (
  name: string,
  request: unknown,
  capabilities: ProviderCapabilities,
): RequestCase => ({
  name,
  source: "validate.test.ts, #30",
  request,
  capabilities,
});

const extra = (name: string, request: unknown, capabilities = typesafe): RequestCase => ({
  name,
  source: "additional",
  request,
  capabilities,
});

export const invalidCases: RequestCase[] = [
  main("a request that is not an object", []),
  main("a missing state", { primitive: "noul", questions: { q: { instructions: "Is it?" } } }),
  main("a null state", {
    primitive: "noul",
    state: null,
    questions: { q: { instructions: "Is it?" } },
  }),
  main("a numeric state", {
    primitive: "noul",
    state: 42,
    questions: { q: { instructions: "Is it?" } },
  }),
  main("a boolean state", {
    primitive: "noul",
    state: true,
    questions: { q: { instructions: "Is it?" } },
  }),
  main("empty questions", { primitive: "noul", state: "Hello", questions: {} }),
  main("an unknown top-level key", { ...examples.noul, model: "jev-latest" }),
  main("an unknown question key", {
    primitive: "noul",
    state: "Hello",
    questions: { greeting: { instructions: "Is this a greeting?", type: "noul" } },
  }),
  main("an unknown primitive", { ...examples.noul, primitive: "rank" }),
  main("empty instructions", {
    primitive: "noul",
    state: "Hello",
    questions: { q: { instructions: "  " } },
  }),
  main("a choice question without criteria", {
    primitive: "choice",
    state: "Hello",
    questions: { tone: { instructions: "What is the tone?" } },
  }),
  main("a choice with a single option", {
    primitive: "choice",
    state: "Hello",
    criteria: { only: null },
    questions: { tone: { instructions: "What is the tone?" } },
  }),
  main("a score with one level", {
    primitive: "score",
    state: "Hello",
    questions: { warmth: { instructions: "How warm is it?", criteria: ["Cold"] } },
  }),
  main("a score with too many levels", scoreOf(11)),
  main("noul criteria with a key other than true or false", {
    primitive: "noul",
    state: "Hello",
    questions: { q: { instructions: "Is it?", criteria: { yes: "It is." } } },
  }),
  main("numeric criteria descriptions", {
    primitive: "choice",
    state: "Hello",
    criteria: { warm: 1, cold: "Distant or curt." },
    questions: { tone: { instructions: "What is the tone?" } },
  }),

  branch("an 11-level score when scoreLevels.max is 10", scoreOf(11), {
    ...typesafe,
    scoreLevels: { min: 2, max: 10 },
  }),
  branch(
    "four options when choiceOptions.max is 3",
    {
      ...examples.choice,
      criteria: { a: null, b: null, c: null, d: null },
      questions: { q: { instructions: "Which?" } },
    },
    { ...typesafe, choiceOptions: { min: 2, max: 3 } },
  ),
  branch("a 101-character question id under SubQ", longIdRequest(101), subq),
  branch("too few levels when scoreLevels.min is 3", scoreOf(2), {
    ...typesafe,
    scoreLevels: { min: 3, max: 10 },
  }),
  branch("zero options when choiceOptions.min is 1", choiceOf(0), {
    ...typesafe,
    choiceOptions: { min: 1, max: 255 },
  }),
  branch("a 150-character question id, truncated in the message", longIdRequest(150), subq),
  branch("256 options", choiceOf(256), typesafe),
  branch("11 levels", scoreOf(11), typesafe),

  extra("a missing primitive", { state: "Hello", questions: { q: { instructions: "Is it?" } } }),
  extra("a numeric primitive", {
    primitive: 3,
    state: "Hello",
    questions: { q: { instructions: "Is it?" } },
  }),
  extra("an empty state", {
    primitive: "noul",
    state: "  ",
    questions: { q: { instructions: "Is it?" } },
  }),
  extra("questions that are a list", { primitive: "noul", state: "Hello", questions: [] }),
  extra("a question that is text", {
    primitive: "noul",
    state: "Hello",
    questions: { q: "Is it?" },
  }),
  extra("a question with an empty id", {
    primitive: "noul",
    state: "Hello",
    questions: { "  ": { instructions: "Is it?" } },
  }),
  extra("missing instructions", { primitive: "noul", state: "Hello", questions: { q: {} } }),
  extra("numeric instructions", {
    primitive: "noul",
    state: "Hello",
    questions: { q: { instructions: 7 } },
  }),
  extra("a null noul description", {
    primitive: "noul",
    state: "Hello",
    questions: { q: { instructions: "Is it?", criteria: { true: null } } },
  }),
  extra("noul criteria that are a list", {
    primitive: "noul",
    state: "Hello",
    questions: { q: { instructions: "Is it?", criteria: [] } },
  }),
  extra("choice criteria that are a list", {
    primitive: "choice",
    state: "Hello",
    criteria: ["warm", "cold"],
    questions: { tone: { instructions: "What is the tone?" } },
  }),
  extra("an option with an empty name", {
    primitive: "choice",
    state: "Hello",
    criteria: { "": null, cold: null },
    questions: { tone: { instructions: "What is the tone?" } },
  }),
  extra("score criteria that are an object", {
    primitive: "score",
    state: "Hello",
    criteria: { low: null, high: null },
    questions: { warmth: { instructions: "How warm is it?" } },
  }),
  extra("a numeric level description", {
    primitive: "score",
    state: "Hello",
    questions: { warmth: { instructions: "How warm is it?", criteria: ["Cold", 2, "Hot"] } },
  }),
  extra("a score question without criteria", {
    primitive: "score",
    state: "Hello",
    questions: { warmth: { instructions: "How warm is it?" } },
  }),
];

export const validCases: RequestCase[] = [
  main("the noul example", examples.noul),
  main("the choice example", examples.choice),
  main("the score example", examples.score),
  main("questions that inherit the default criteria", {
    primitive: "score",
    state: "Thanks so much!",
    criteria: ["Cold", "Neutral", "Warm"],
    questions: {
      inherits: { instructions: "How warm is the message?" },
      overrides: { instructions: "How polite is it?", criteria: ["Rude", "Polite"] },
    },
  }),
  main("noul questions without any criteria", {
    primitive: "noul",
    state: ["a", "list", "state"],
    questions: { q: { instructions: { question: "Is `state` a list?" } } },
  }),
  branch("an 11-level score when scoreLevels.max is undefined", scoreOf(11), {
    ...typesafe,
    scoreLevels: { min: 2 },
  }),
  branch("a 100-character question id under SubQ", longIdRequest(100), subq),
  branch("a 101-character question id under TypeSafe", longIdRequest(101), typesafe),
  branch("exactly 10 levels", scoreOf(10), typesafe),
  branch("exactly 255 options", choiceOf(255), typesafe),
  branch(
    "sixty emoji as a question id under SubQ",
    { ...examples.noul, questions: { ["\u{1F600}".repeat(60)]: { instructions: "Is it?" } } },
    subq,
  ),
];
