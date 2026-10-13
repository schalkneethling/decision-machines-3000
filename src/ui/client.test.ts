import { describe, expect, it } from "vite-plus/test";
import { decisionResponseSchema, warmResponseSchema } from "../decision/contract.ts";
import { isDecisionResponse, isWarmResponse } from "./client.ts";
import { choiceResponse } from "./fixtures/choice.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { scoreResponse } from "./fixtures/score.ts";

/** A deep copy with the value at a dotted path replaced. */
function replaced(body: unknown, dotPath: string, replacement: unknown): unknown {
  const copy = structuredClone(body) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let node = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys.at(-1) ?? ""] = replacement;
  return copy;
}

/** The dotted path of the first problem the schema finds, or undefined when it accepts the body. */
function firstIssuePath(
  schema: typeof decisionResponseSchema | typeof warmResponseSchema,
  body: unknown,
) {
  const result = schema.safeParse(body);
  return result.success ? undefined : result.error.issues[0]?.path.map(String).join(".");
}

const refusalResponse = {
  ...noulResponse,
  answers: { ...noulResponse.answers, recommends: { type: "refusal" } },
};

const failure = { ok: false, error: 'Set "primitive" to …', detail: "primitive" };

const warmed = { ok: true, latencyMs: 950, connection: "new", keepAliveSeconds: 30 };

describe("isDecisionResponse", () => {
  it.each([
    ["the noul fixture", noulResponse],
    ["the choice fixture", choiceResponse],
    ["the score fixture", scoreResponse],
    ["a response with a refusal answer", refusalResponse],
    ["a failure", failure],
  ])("accepts %s", (_name, body) => {
    expect(isDecisionResponse(body)).toBe(true);
  });

  // The spike's malformed responses, each with the path of its first problem.
  it.each([
    {
      name: "a keep-alive the server does not offer",
      body: { ...noulResponse, keepAliveSeconds: 5 },
      path: "keepAliveSeconds",
    },
    {
      name: "an answer of an unknown type",
      body: replaced(noulResponse, "answers.recommends.type", "rank"),
      path: "answers.recommends.type",
    },
    {
      name: "a refusal answer without its type",
      body: replaced(refusalResponse, "answers.recommends", {}),
      path: "answers.recommends.type",
    },
    {
      name: "a choice answer under the score primitive",
      body: { ...scoreResponse, answers: choiceResponse.answers },
      path: "answers.film_0.type",
    },
    { name: "a failure without an error", body: { ok: false, detail: "primitive" }, path: "error" },
  ])("rejects $name at $path", ({ body, path }) => {
    expect(isDecisionResponse(body)).toBe(false);
    expect(firstIssuePath(decisionResponseSchema, body)).toBe(path);
  });
});

describe("isDecisionResponse rejects a list where an object is expected", () => {
  it.each([
    { name: "the response", body: [noulResponse], path: "" },
    { name: "usage", body: replaced(noulResponse, "usage", [452, 80]), path: "usage" },
    { name: "answers", body: replaced(noulResponse, "answers", []), path: "answers" },
    {
      name: "one answer",
      body: replaced(noulResponse, "answers.recommends", [{ type: "noul", noul: 0.93 }]),
      path: "answers.recommends",
    },
    {
      name: "the probabilities",
      body: replaced(choiceResponse, "answers.film_0.probabilities", [0, 1]),
      path: "answers.film_0.probabilities",
    },
    {
      name: "the score legend",
      body: replaced(scoreResponse, "answers.film_0.legend", ["Gentle", "Tense"]),
      path: "answers.film_0.legend",
    },
  ])("at $name", ({ body, path }) => {
    expect(isDecisionResponse(body)).toBe(false);
    expect(firstIssuePath(decisionResponseSchema, body)).toBe(path);
  });
});

describe("isWarmResponse", () => {
  it.each([
    ["a warm success", warmed],
    ["a failure", failure],
  ])("accepts %s", (_name, body) => {
    expect(isWarmResponse(body)).toBe(true);
  });

  it.each([
    { name: "a list in place of the response", body: [warmed], path: "" },
    {
      name: "a keep-alive the server does not offer",
      body: { ...warmed, keepAliveSeconds: 5 },
      path: "keepAliveSeconds",
    },
    {
      name: "an unknown connection kind",
      body: { ...warmed, connection: "warm" },
      path: "connection",
    },
    { name: "a latency that is text", body: { ...warmed, latencyMs: "950" }, path: "latencyMs" },
  ])("rejects $name", ({ body, path }) => {
    expect(isWarmResponse(body)).toBe(false);
    expect(firstIssuePath(warmResponseSchema, body)).toBe(path);
  });
});
