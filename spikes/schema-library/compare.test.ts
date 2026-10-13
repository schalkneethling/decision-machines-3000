/**
 * The comparison itself, run by `vp test`. Each `describe` is one row of the
 * table in docs/spikes/schema-library.md. Both libraries face the same inputs
 * and the same assertions.
 */

import { describe, expect, it } from "vite-plus/test";
import { examples } from "../../src/decision/examples.ts";
// The oracle: today's hand-written validator. Every message and path a library
// produces must equal what it returns.
import { validateDecisionRequest as validateReference } from "../../src/decision/validate.ts";
import { PROVIDERS } from "../../src/providers/catalog.ts";
import { choiceResponse } from "../../src/ui/fixtures/choice.ts";
import { noulResponse } from "../../src/ui/fixtures/noul.ts";
import { scoreResponse } from "../../src/ui/fixtures/score.ts";
import { invalidCases, validCases } from "./shared/cases.ts";
import { loadFixtures, wireShapeOf } from "./shared/fixtures.ts";
import type { Fixture } from "./shared/fixtures.ts";
import * as valibotProvider from "./valibot/provider.ts";
import { validateDecisionRequest as validateWithValibot } from "./valibot/request.ts";
import * as valibotResponse from "./valibot/response.ts";
import * as zodProvider from "./zod-mini/provider.ts";
import { validateDecisionRequest as validateWithZodMini } from "./zod-mini/request.ts";
import * as zodResponse from "./zod-mini/response.ts";

const libraries = [
  {
    name: "Valibot",
    validate: validateWithValibot,
    provider: valibotProvider,
    response: valibotResponse,
  },
  { name: "Zod Mini", validate: validateWithZodMini, provider: zodProvider, response: zodResponse },
] as const;

describe.each(libraries)("schema 1 in $name reproduces the reference validator", ({ validate }) => {
  it.each(invalidCases)("rejects $name with the same message and path [$source]", (c) => {
    const expected = validateReference(c.request, c.capabilities);
    expect(expected.ok).toBe(false);
    expect(validate(c.request, c.capabilities)).toEqual(expected);
  });

  it.each(validCases)("accepts $name and returns it unchanged [$source]", (c) => {
    const expected = validateReference(c.request, c.capabilities);
    expect(expected.ok).toBe(true);
    const result = validate(c.request, c.capabilities);
    expect(result).toEqual(expected);
    expect(result).toEqual({ ok: true, value: c.request });
  });

  it("accepts the examples after a JSON round trip", () => {
    for (const example of Object.values(examples)) {
      const result = validate(JSON.parse(JSON.stringify(example)), PROVIDERS.typesafe.capabilities);
      expect(result).toEqual({ ok: true, value: example });
    }
  });
});

/** The schema a recorded exchange must parse with, by provider and wire shape. */
function schemaFor(library: (typeof libraries)[number]["provider"], fixture: Fixture) {
  const shape = wireShapeOf(fixture);
  if (fixture.provider === "openai") {
    return shape === "decision"
      ? library.openaiDecision
      : shape === "error"
        ? library.openaiError
        : library.openaiModels;
  }
  if (shape === "decision") return library.jevDecision;
  if (shape === "error") return library.jevError;
  return fixture.provider === "typesafe" ? library.typesafeModels : library.subqModels;
}

const fixtures = loadFixtures();

/** A deep copy with one value replaced, addressed by a dot path. */
function broken(body: unknown, dotPath: string, replacement: unknown): unknown {
  const copy = structuredClone(body) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys.at(-1) ?? ""] = replacement;
  return copy;
}

const fixtureOf = (provider: Fixture["provider"], name: string) =>
  fixtures.find((f) => f.provider === provider && f.name === name) ??
  (() => {
    throw new Error(`No fixture ${provider}/${name}`);
  })();

export const brokenFixtures = [
  {
    name: "a TypeSafe choice probability that is text",
    fixture: fixtureOf("typesafe", "choice"),
    path: "answers.queue.probabilities.nurse_line",
    replacement: "1",
  },
  {
    name: "an OpenAI score probability that is text",
    fixture: fixtureOf("openai", "three-types"),
    path: "answers.2.probabilities.1.probability",
    replacement: "0.1",
  },
  {
    name: "a SubQ answer with an unknown type",
    fixture: fixtureOf("subq", "three-types"),
    path: "answers.acuity.type",
    replacement: "rank",
  },
  {
    name: "an OpenAI error without a message",
    fixture: fixtureOf("openai", "bad-key"),
    path: "error.message",
    replacement: undefined,
  },
];

describe.each(libraries)("schema 2 in $name parses the recorded fixtures", ({ provider }) => {
  it("sees all 33 recorded exchanges", () => {
    expect(fixtures.length).toBe(33);
  });

  it.each(fixtures)("parses $provider/$name", (fixture) => {
    const result = provider.describeParse(schemaFor(provider, fixture) as never, fixture.body);
    expect(result).toEqual({ success: true });
  });

  it("parses a synthetic OpenAI refusal answer", () => {
    const body = structuredClone(fixtureOf("openai", "three-types").body) as {
      answers: unknown[];
    };
    body.answers.push({ type: "refusal", name: "escalate" });
    expect(provider.describeParse(provider.openaiDecision as never, body)).toEqual({
      success: true,
    });
  });

  it.each(brokenFixtures)("rejects $name and names the path", ({ fixture, path, replacement }) => {
    const result = provider.describeParse(
      schemaFor(provider, fixture) as never,
      broken(fixture.body, path, replacement),
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    // The unknown answer type is reported at the discriminator, one level below the answer.
    expect(result.path).toBe(path);
  });
});

const refusalResponse = {
  ...noulResponse,
  answers: { ...noulResponse.answers, recommends: { type: "refusal" } },
};
const failureResponse = { ok: false, error: 'Set "primitive" to …', detail: "primitive" };

export const brokenResponses = [
  {
    name: "a keep-alive the server does not offer",
    body: { ...noulResponse, keepAliveSeconds: 5 },
    path: "keepAliveSeconds",
  },
  {
    name: "an answer of an unknown type",
    body: broken(noulResponse, "answers.recommends.type", "rank"),
    path: "answers.recommends.type",
  },
  {
    name: "a choice answer under the score primitive",
    body: { ...scoreResponse, answers: choiceResponse.answers },
    path: "answers.film_0.type",
  },
  { name: "a failure without an error", body: { ok: false, detail: "primitive" }, path: "error" },
];

describe.each(libraries)(
  "schema 3 in $name checks the browser's DecisionResponse",
  ({ response }) => {
    it.each([
      ["the noul fixture", noulResponse],
      ["the choice fixture", choiceResponse],
      ["the score fixture", scoreResponse],
      ["a response with a refusal answer", refusalResponse],
      ["a failure", failureResponse],
    ])("accepts %s", (_name, body) => {
      expect(response.isDecisionResponse(body)).toBe(true);
      expect(response.describeResponseParse(body)).toEqual({ success: true });
    });

    it.each(brokenResponses)("rejects $name and names the path", ({ body, path }) => {
      expect(response.isDecisionResponse(body)).toBe(false);
      const result = response.describeResponseParse(body);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.path).toBe(path);
    });
  },
);
