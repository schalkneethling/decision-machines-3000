import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { decisionResponseSchema, warmResponseSchema } from "../decision/contract.ts";
import { openai, subq, typesafe } from "../providers/catalog.ts";
import { providersResponseSchema, toProviderSummary } from "../providers/contract.ts";
import {
  askProvider,
  getProviders,
  isDecisionResponse,
  isProvidersResponse,
  isWarmResponse,
} from "./client.ts";
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
  schema:
    | typeof decisionResponseSchema
    | typeof warmResponseSchema
    | typeof providersResponseSchema,
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

  it("ignores the old connection fields, which a success no longer carries", () => {
    expect(isDecisionResponse({ ...noulResponse, connection: "new", keepAliveSeconds: 5 })).toBe(
      true,
    );
  });

  // The spike's malformed responses, each with the path of its first problem.
  it.each([
    {
      name: "a provider the catalog does not know",
      body: { ...noulResponse, provider: "anthropic" },
      path: "provider",
    },
    {
      name: "a success without its wire record",
      body: replaced(noulResponse, "wire", undefined),
      path: "wire",
    },
    {
      name: "a wire request that is text",
      body: replaced(noulResponse, "wire.request", "{}"),
      path: "wire.request",
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

/** A success as the Worker builds it, round-tripped through JSON as the browser receives it. */
const listed = JSON.parse(
  JSON.stringify({ ok: true, providers: [typesafe, subq, openai].map(toProviderSummary) }),
) as unknown;

const missingKeys = { ok: false, error: "No provider key is set, and at least one is required." };

describe("isProvidersResponse", () => {
  it.each([
    ["every provider, as the Worker lists them", listed],
    ["the failure for an instance with no key", missingKeys],
    // Additive server fields must not break a browser that does not know them yet.
    ["a success with an unknown top-level field", { ...(listed as object), region: "weur" }],
  ])("accepts %s", (_name, body) => {
    expect(isProvidersResponse(body)).toBe(true);
  });

  it("carries each provider's model", () => {
    expect(listed).toMatchObject({ providers: [{ model: typesafe.model }, {}, {}] });
  });

  it.each([
    { name: "a list in place of the response", body: [listed], path: "" },
    { name: "a success without providers", body: { ok: true }, path: "providers" },
    {
      // The server answers 503 instead of an empty list.
      name: "a success with no providers",
      body: { ok: true, providers: [] },
      path: "providers",
    },
    {
      name: "a provider without a model",
      body: replaced(listed, "providers.0.model", undefined),
      path: "providers.0.model",
    },
    {
      name: "a fractional option count",
      body: replaced(listed, "providers.0.capabilities.choiceOptions.max", 2.5),
      path: "providers.0.capabilities.choiceOptions.max",
    },
    {
      name: "a fractional question-name limit",
      body: replaced(listed, "providers.1.capabilities.questionNameMaxLength", 99.9),
      path: "providers.1.capabilities.questionNameMaxLength",
    },
    // `images` is a union with `false`, so Zod reports these at the union itself.
    {
      name: "a fractional image count",
      body: replaced(listed, "providers.2.capabilities.images.maxCount", 1.5),
      path: "providers.2.capabilities.images",
    },
    {
      name: "a fractional byte limit",
      body: replaced(listed, "providers.2.capabilities.images.maxBytesPerImage", 1024.5),
      path: "providers.2.capabilities.images",
    },
    {
      name: "a provider the catalog does not know",
      body: replaced(listed, "providers.0.id", "anthropic"),
      path: "providers.0.id",
    },
    {
      name: "a provider without a display name",
      body: replaced(listed, "providers.0.displayName", undefined),
      path: "providers.0.displayName",
    },
    {
      name: "image support given as true",
      body: replaced(listed, "providers.0.capabilities.images", true),
      path: "providers.0.capabilities.images",
    },
    {
      name: "a score range that is text",
      body: replaced(listed, "providers.1.capabilities.scoreLevels.max", "10"),
      path: "providers.1.capabilities.scoreLevels.max",
    },
    { name: "a failure without an error", body: { ok: false }, path: "error" },
  ])("rejects $name", ({ body, path }) => {
    expect(isProvidersResponse(body)).toBe(false);
    expect(firstIssuePath(providersResponseSchema, body)).toBe(path);
  });
});

describe("getProviders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answering(status: number, body: string) {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(new Response(body, { status })),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("sends GET /api/providers and returns a recognised body", async () => {
    const fetchMock = answering(200, JSON.stringify(listed));

    const result = await getProviders();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("/api/providers");
    expect(init?.method).toBe("GET");
    expect(result).toEqual({ kind: "response", status: 200, response: listed });
  });

  it("returns the 503 failure as a response, so the UI can show its error", async () => {
    answering(503, JSON.stringify(missingKeys));

    expect(await getProviders()).toEqual({
      kind: "response",
      status: 503,
      response: missingKeys,
    });
  });

  it("reports a body that does not match the schema as unrecognised", async () => {
    answering(200, JSON.stringify({ ok: true, providers: [{ id: "openai" }] }));

    expect(await getProviders()).toEqual({ kind: "unrecognised", status: 200 });
  });

  it("reports HTML in place of JSON as a body that is not JSON, with its status", async () => {
    answering(200, "<!doctype html>");

    expect(await getProviders()).toEqual({ kind: "non_json", status: 200 });
  });
});

describe("askProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function answering(response: () => Promise<Response>) {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => response());
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts the JSON text unchanged to the provider's decide route", async () => {
    const fetchMock = answering(() => Promise.resolve(Response.json(noulResponse)));
    const body = '{ "primitive": "noul" }';

    const result = await askProvider("typesafe", body);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("/api/decide/typesafe");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(init?.body).toBe(body);
    expect(result).toEqual({ kind: "response", status: 200, response: noulResponse });
  });

  it("returns a failure body as a response, so the readout can show its error", async () => {
    const conflict = { ok: false, error: "Set OPENAI_API_KEY to use it." };
    answering(() => Promise.resolve(Response.json(conflict, { status: 409 })));

    expect(await askProvider("openai", "{}")).toEqual({
      kind: "response",
      status: 409,
      response: conflict,
    });
  });

  it("tells a 502 page that is not JSON apart from an endpoint it could not reach", async () => {
    answering(() =>
      Promise.resolve(
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    expect(await askProvider("typesafe", "{}")).toEqual({ kind: "non_json", status: 502 });
  });

  it("reports a fetch that rejects as unreachable, with its message as the detail", async () => {
    answering(() => Promise.reject(new TypeError("Failed to fetch")));

    expect(await askProvider("typesafe", "{}")).toEqual({
      kind: "unreachable",
      detail: "Failed to fetch",
    });
  });
});
