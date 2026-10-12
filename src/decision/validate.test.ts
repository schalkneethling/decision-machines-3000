import { describe, expect, it } from "vite-plus/test";
import { examples } from "./examples.ts";
import { MAX_SCORE_LEVELS, validateDecisionRequest, validateWarmRequest } from "./validate.ts";
import type { ValidationResult } from "./validate.ts";

function expectFailure(result: ValidationResult) {
  if (result.ok) {
    throw new Error("Expected validation to fail, but it passed.");
  }
  return result;
}

describe("validateDecisionRequest", () => {
  it.each(Object.entries(examples))("accepts the %s example", (_name, example) => {
    const result = validateDecisionRequest(example);
    expect(result).toEqual({ ok: true, value: example });
  });

  it("accepts the examples after a JSON round trip", () => {
    for (const example of Object.values(examples)) {
      expect(validateDecisionRequest(JSON.parse(JSON.stringify(example))).ok).toBe(true);
    }
  });

  it("rejects a request that is not an object", () => {
    const failure = expectFailure(validateDecisionRequest([]));
    expect(failure.error).toMatch(/must be a JSON object/);
  });

  it("rejects a missing state", () => {
    const failure = expectFailure(
      validateDecisionRequest({ primitive: "noul", questions: { q: { instructions: "Is it?" } } }),
    );
    expect(failure.error).toMatch(/Add a "state" field/);
    expect(failure.detail).toBe("state");
  });

  it("rejects a null or numeric state", () => {
    for (const state of [null, 42, true]) {
      const failure = expectFailure(
        validateDecisionRequest({
          primitive: "noul",
          state,
          questions: { q: { instructions: "Is it?" } },
        }),
      );
      expect(failure.detail).toBe("state");
    }
  });

  it("rejects empty questions", () => {
    const failure = expectFailure(
      validateDecisionRequest({ primitive: "noul", state: "Hello", questions: {} }),
    );
    expect(failure.error).toMatch(/at least one question/);
    expect(failure.detail).toBe("questions");
  });

  it("rejects an unknown top-level key and names it", () => {
    const failure = expectFailure(
      validateDecisionRequest({ ...examples.noul, model: "jev-latest" }),
    );
    expect(failure.error).toContain('"model"');
    expect(failure.detail).toBe("model");
  });

  it("rejects an unknown question key and names the question", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "noul",
        state: "Hello",
        questions: { greeting: { instructions: "Is this a greeting?", type: "noul" } },
      }),
    );
    expect(failure.error).toContain('"greeting"');
    expect(failure.error).toContain('"type"');
    expect(failure.detail).toBe("questions.greeting.type");
  });

  it("rejects an unknown primitive", () => {
    const failure = expectFailure(validateDecisionRequest({ ...examples.noul, primitive: "rank" }));
    expect(failure.error).toMatch(/Set "primitive" to "noul", "choice", or "score"/);
  });

  it("rejects empty instructions", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "noul",
        state: "Hello",
        questions: { q: { instructions: "  " } },
      }),
    );
    expect(failure.detail).toBe("questions.q.instructions");
  });

  it("rejects a choice question without criteria and names the question", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "choice",
        state: "Hello",
        questions: { tone: { instructions: "What is the tone?" } },
      }),
    );
    expect(failure.error).toContain('Question "tone" has no criteria');
    expect(failure.detail).toBe("questions.tone.criteria");
  });

  it("rejects a choice with a single option", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "choice",
        state: "Hello",
        criteria: { only: null },
        questions: { tone: { instructions: "What is the tone?" } },
      }),
    );
    expect(failure.error).toMatch(/at least two options/);
  });

  it("rejects a score with one level", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "score",
        state: "Hello",
        questions: { warmth: { instructions: "How warm is it?", criteria: ["Cold"] } },
      }),
    );
    expect(failure.error).toMatch(/at least two levels/);
    expect(failure.detail).toBe("questions.warmth.criteria");
  });

  it("rejects a score with too many levels", () => {
    const levels = Array.from({ length: MAX_SCORE_LEVELS + 1 }, (_, index) => `Level ${index}`);
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "score",
        state: "Hello",
        criteria: levels,
        questions: { warmth: { instructions: "How warm is it?" } },
      }),
    );
    expect(failure.error).toMatch(/at most 10/);
  });

  it("rejects noul criteria with a key other than true or false", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "noul",
        state: "Hello",
        questions: { q: { instructions: "Is it?", criteria: { yes: "It is." } } },
      }),
    );
    expect(failure.error).toContain('"yes"');
    expect(failure.detail).toBe("questions.q.criteria.yes");
  });

  it("rejects numeric criteria descriptions", () => {
    const failure = expectFailure(
      validateDecisionRequest({
        primitive: "choice",
        state: "Hello",
        criteria: { warm: 1, cold: "Distant or curt." },
        questions: { tone: { instructions: "What is the tone?" } },
      }),
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
    const result = validateDecisionRequest(request);
    expect(result).toEqual({ ok: true, value: request });
    if (result.ok && result.value.primitive === "score") {
      expect(result.value.questions.inherits?.criteria).toBeUndefined();
      expect(result.value.criteria).toEqual(["Cold", "Neutral", "Warm"]);
    }
  });

  it("accepts noul questions without any criteria", () => {
    const result = validateDecisionRequest({
      primitive: "noul",
      state: ["a", "list", "state"],
      questions: { q: { instructions: { question: "Is `state` a list?" } } },
    });
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
