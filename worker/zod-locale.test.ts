import { afterEach, describe, expect, it } from "vite-plus/test";
import * as z from "zod/mini";
import { validateDecisionRequest } from "../src/decision/validate.ts";
import { subq, typesafe } from "../src/providers/catalog.ts";
import { useEnglishZodMessages } from "./zod-locale.ts";

afterEach(() => {
  // The setting is per realm, so it is turned off again for any file that shares this one's.
  z.config({ localeError: undefined });
});

/** Requests that fail validation, one per kind of problem the validator words. */
const invalidRequests: [string, unknown][] = [
  ["a list in place of the request", []],
  ["no primitive", { state: "x", questions: { q: { instructions: "?" } } }],
  ["an unknown primitive", { primitive: "maybe", state: "x", questions: {} }],
  [
    "state that is a number",
    { primitive: "noul", state: 4, questions: { q: { instructions: "?" } } },
  ],
  ["no questions", { primitive: "noul", state: "x", questions: {} }],
  ["questions that are a list", { primitive: "noul", state: "x", questions: [] }],
  ["a question that is text", { primitive: "noul", state: "x", questions: { q: "?" } }],
  [
    "instructions that are a number",
    { primitive: "noul", state: "x", questions: { q: { instructions: 1 } } },
  ],
  [
    "an unknown request field",
    { primitive: "noul", state: "x", questions: { q: { instructions: "?" } }, extra: 1 },
  ],
  [
    "an unknown question field",
    { primitive: "noul", state: "x", questions: { q: { instructions: "?", type: "noul" } } },
  ],
  [
    "Yes/no criteria that are a list",
    { primitive: "noul", state: "x", criteria: [], questions: { q: { instructions: "?" } } },
  ],
  [
    "an unknown Yes/no criteria field",
    {
      primitive: "noul",
      state: "x",
      criteria: { maybe: "?" },
      questions: { q: { instructions: "?" } },
    },
  ],
  [
    "a Choice question without criteria",
    { primitive: "choice", state: "x", questions: { q: { instructions: "?" } } },
  ],
  [
    "one Choice option",
    {
      primitive: "choice",
      state: "x",
      criteria: { a: null },
      questions: { q: { instructions: "?" } },
    },
  ],
  [
    "a Choice option with an empty name",
    {
      primitive: "choice",
      state: "x",
      criteria: { "": null, b: null },
      questions: { q: { instructions: "?" } },
    },
  ],
  [
    "a Choice description that is a number",
    {
      primitive: "choice",
      state: "x",
      criteria: { a: 1, b: null },
      questions: { q: { instructions: "?" } },
    },
  ],
  [
    "one Score level",
    { primitive: "score", state: "x", questions: { q: { instructions: "?", criteria: [null] } } },
  ],
  [
    "eleven Score levels",
    {
      primitive: "score",
      state: "x",
      questions: { q: { instructions: "?", criteria: Array.from({ length: 11 }, () => null) } },
    },
  ],
  [
    "a Score level that is a number",
    {
      primitive: "score",
      state: "x",
      questions: { q: { instructions: "?", criteria: [1, null] } },
    },
  ],
  [
    "an empty question id",
    { primitive: "noul", state: "x", questions: { "": { instructions: "?" } } },
  ],
];

describe("Zod's English messages", () => {
  it("are what useEnglishZodMessages turns on", () => {
    const schema = z.object({ tokens: z.number() });
    expect(schema.safeParse({ tokens: "many" }).error?.issues[0]?.message).toBe("Invalid input");

    useEnglishZodMessages();

    expect(schema.safeParse({ tokens: "many" }).error?.issues[0]?.message).toBe(
      "Invalid input: expected number, received string",
    );
  });

  it.each(invalidRequests)(
    "leave the validator's message and path for %s unchanged",
    (_name, request) => {
      const before = [
        validateDecisionRequest(request, typesafe.capabilities),
        validateDecisionRequest(request, subq.capabilities),
      ];
      expect(before.every((result) => !result.ok)).toBe(true);

      useEnglishZodMessages();
      const after = [
        validateDecisionRequest(request, typesafe.capabilities),
        validateDecisionRequest(request, subq.capabilities),
      ];

      expect(after).toEqual(before);
    },
  );

  it("leave a long question id on SubQ worded by the validator", () => {
    const request = {
      primitive: "noul",
      state: "x",
      questions: { ["q".repeat(101)]: { instructions: "?" } },
    };
    const before = validateDecisionRequest(request, subq.capabilities);
    expect(before.ok).toBe(false);

    useEnglishZodMessages();

    expect(validateDecisionRequest(request, subq.capabilities)).toEqual(before);
  });
});
