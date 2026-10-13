import { describe, expect, it } from "vite-plus/test";
import { examples } from "./examples.ts";
import { validateDecisionRequest, validateWarmRequest } from "./validate.ts";
import type { ValidationResult } from "./validate.ts";
import { DEFAULT_PROVIDER, PROVIDERS } from "../providers/catalog.ts";
import type { ProviderCapabilities } from "../providers/catalog.ts";

function expectFailure(result: ValidationResult) {
  if (result.ok) {
    throw new Error("Expected validation to fail, but it passed.");
  }
  return result;
}

describe("validateDecisionRequest", () => {
  it.each(Object.entries(examples))("accepts the %s example", (_name, example) => {
    const result = validateDecisionRequest(example, DEFAULT_PROVIDER.capabilities);
    expect(result).toEqual({ ok: true, value: example });
  });

  it("accepts the examples after a JSON round trip", () => {
    for (const example of Object.values(examples)) {
      expect(
        validateDecisionRequest(JSON.parse(JSON.stringify(example)), DEFAULT_PROVIDER.capabilities)
          .ok,
      ).toBe(true);
    }
  });

  it("rejects a request that is not an object", () => {
    const failure = expectFailure(validateDecisionRequest([], DEFAULT_PROVIDER.capabilities));
    expect(failure.error).toMatch(/must be a JSON object/);
  });

  it("rejects a missing state", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        { primitive: "noul", questions: { q: { instructions: "Is it?" } } },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toMatch(/Add a "state" field/);
    expect(failure.detail).toBe("state");
  });

  it("rejects a null or numeric state", () => {
    for (const state of [null, 42, true]) {
      const failure = expectFailure(
        validateDecisionRequest(
          {
            primitive: "noul",
            state,
            questions: { q: { instructions: "Is it?" } },
          },
          DEFAULT_PROVIDER.capabilities,
        ),
      );
      expect(failure.detail).toBe("state");
    }
  });

  it("rejects empty questions", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        { primitive: "noul", state: "Hello", questions: {} },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toMatch(/at least one question/);
    expect(failure.detail).toBe("questions");
  });

  it("rejects an unknown top-level key and names it", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        { ...examples.noul, model: "jev-latest" },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toContain('"model"');
    expect(failure.detail).toBe("model");
  });

  it("rejects an unknown question key and names the question", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "noul",
          state: "Hello",
          questions: { greeting: { instructions: "Is this a greeting?", type: "noul" } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toContain('"greeting"');
    expect(failure.error).toContain('"type"');
    expect(failure.detail).toBe("questions.greeting.type");
  });

  it("rejects an unknown primitive", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        { ...examples.noul, primitive: "rank" },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toMatch(/Set "primitive" to "noul", "choice", or "score"/);
  });

  it("rejects empty instructions", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "noul",
          state: "Hello",
          questions: { q: { instructions: "  " } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.detail).toBe("questions.q.instructions");
  });

  it("rejects a choice question without criteria and names the question", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "choice",
          state: "Hello",
          questions: { tone: { instructions: "What is the tone?" } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toContain('Question "tone" has no criteria');
    expect(failure.detail).toBe("questions.tone.criteria");
  });

  it("rejects a choice with a single option", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "choice",
          state: "Hello",
          criteria: { only: null },
          questions: { tone: { instructions: "What is the tone?" } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toMatch(/at least 2 options/);
  });

  it("rejects a score with one level", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "score",
          state: "Hello",
          questions: { warmth: { instructions: "How warm is it?", criteria: ["Cold"] } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toMatch(/at least 2 levels/);
    expect(failure.detail).toBe("questions.warmth.criteria");
  });

  it("rejects a score with too many levels", () => {
    const levels = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "score",
          state: "Hello",
          criteria: levels,
          questions: { warmth: { instructions: "How warm is it?" } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toMatch(/at most 10/);
  });

  it("rejects noul criteria with a key other than true or false", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "noul",
          state: "Hello",
          questions: { q: { instructions: "Is it?", criteria: { yes: "It is." } } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.error).toContain('"yes"');
    expect(failure.detail).toBe("questions.q.criteria.yes");
  });

  it("rejects numeric criteria descriptions", () => {
    const failure = expectFailure(
      validateDecisionRequest(
        {
          primitive: "choice",
          state: "Hello",
          criteria: { warm: 1, cold: "Distant or curt." },
          questions: { tone: { instructions: "What is the tone?" } },
        },
        DEFAULT_PROVIDER.capabilities,
      ),
    );
    expect(failure.detail).toBe("criteria.warm");
  });

  it("lets questions inherit request-level default criteria", () => {
    const request = {
      primitive: "score",
      state: "Thanks so much!",
      criteria: ["Cold", "Neutral", "Warm"],
      questions: {
        inherits: { instructions: "How warm is the message?" },
        overrides: { instructions: "How polite is it?", criteria: ["Rude", "Polite"] },
      },
    };
    const result = validateDecisionRequest(request, DEFAULT_PROVIDER.capabilities);
    expect(result).toEqual({ ok: true, value: request });
    if (result.ok && result.value.primitive === "score") {
      expect(result.value.questions.inherits?.criteria).toBeUndefined();
      expect(result.value.criteria).toEqual(["Cold", "Neutral", "Warm"]);
    }
  });

  it("accepts noul questions without any criteria", () => {
    const result = validateDecisionRequest(
      {
        primitive: "noul",
        state: ["a", "list", "state"],
        questions: { q: { instructions: { question: "Is `state` a list?" } } },
      },
      DEFAULT_PROVIDER.capabilities,
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateWarmRequest", () => {
  it.each([4, 30, 60])("accepts a keep-alive of %i seconds", (keepAliveSeconds) => {
    expect(validateWarmRequest({ keepAliveSeconds })).toEqual({
      ok: true,
      value: { keepAliveSeconds },
    });
  });

  it.each([[5], [0], ["30"], [null], [undefined]])(
    "rejects a keep-alive of %j",
    (keepAliveSeconds) => {
      const result = validateWarmRequest({ keepAliveSeconds });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^"keepAliveSeconds" must be 4, 30, or 60 seconds, not /);
        expect(result.detail).toBe("keepAliveSeconds");
      }
    },
  );

  it("names a number it rejects", () => {
    const result = validateWarmRequest({ keepAliveSeconds: 5 });
    expect(result).toEqual({
      ok: false,
      error: '"keepAliveSeconds" must be 4, 30, or 60 seconds, not 5.',
      detail: "keepAliveSeconds",
    });
  });

  it("rejects a body that is not an object", () => {
    expect(validateWarmRequest([30])).toEqual({
      ok: false,
      error: 'The request must be a JSON object with "keepAliveSeconds", not a list.',
    });
  });

  it("rejects unknown fields", () => {
    expect(validateWarmRequest({ keepAliveSeconds: 30, primitive: "noul" })).toEqual({
      ok: false,
      error:
        'The request has an unknown field "primitive". It can only contain "keepAliveSeconds".',
      detail: "primitive",
    });
  });
});

describe("validateDecisionRequest limits taken from capabilities", () => {
  const typesafe = PROVIDERS.typesafe.capabilities;
  const subq = PROVIDERS.subq.capabilities;

  function scoreRequest(levelCount: number) {
    return {
      primitive: "score",
      state: "Hello",
      criteria: Array.from({ length: levelCount }, (_, index) => `Level ${index}`),
      questions: { warmth: { instructions: "How warm is it?" } },
    };
  }

  function longIdRequest(length: number) {
    return { ...examples.noul, questions: { ["q".repeat(length)]: { instructions: "Is it?" } } };
  }

  it("fails an 11-level score and names the limit when scoreLevels.max is 10", () => {
    const capabilities: ProviderCapabilities = { ...typesafe, scoreLevels: { min: 2, max: 10 } };
    const failure = expectFailure(validateDecisionRequest(scoreRequest(11), capabilities));
    expect(failure.error).toMatch(/at most 10/);
  });

  it("passes an 11-level score when scoreLevels.max is undefined", () => {
    const capabilities: ProviderCapabilities = { ...typesafe, scoreLevels: { min: 2 } };
    expect(validateDecisionRequest(scoreRequest(11), capabilities).ok).toBe(true);
  });

  it("uses the choice limit from the capabilities", () => {
    const capabilities: ProviderCapabilities = { ...typesafe, choiceOptions: { min: 2, max: 3 } };
    const criteria = { a: null, b: null, c: null, d: null };
    const request = { ...examples.choice, criteria, questions: { q: { instructions: "Which?" } } };
    const failure = expectFailure(validateDecisionRequest(request, capabilities));
    expect(failure.error).toMatch(/at most 3/);
  });

  it("fails a 101-character question id under SubQ and names the 100-character limit", () => {
    const failure = expectFailure(validateDecisionRequest(longIdRequest(101), subq));
    expect(failure.error).toMatch(/at most 100/);
    expect(failure.detail).toBe(`questions.${"q".repeat(101)}`);
  });

  it("accepts a 100-character question id under SubQ", () => {
    expect(validateDecisionRequest(longIdRequest(100), subq).ok).toBe(true);
  });

  it("accepts a 101-character question id under TypeSafe", () => {
    expect(validateDecisionRequest(longIdRequest(101), typesafe).ok).toBe(true);
  });
});
