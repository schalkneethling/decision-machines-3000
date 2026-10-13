// The fixtures are read with `import.meta.glob` and the sources with `?raw`, both
// Vite features that Vitest serves. Their types come from `vite/client`, which the
// root tsconfig does not apply to the worker folder, so this file names it itself.
/// <reference types="vite/client" />

import { describe, expect, it } from "vite-plus/test";
import type { DecisionRequest } from "../../src/decision/contract.ts";
import { typesafe } from "../../src/providers/catalog.ts";
import { ProviderError } from "./adapter.ts";
import type { Fetch } from "./adapter.ts";
import adapterSource from "./adapter.ts?raw";
import { decide, fromWire, toWire, typesafeAdapter } from "./typesafe.ts";
import typesafeSource from "./typesafe.ts?raw";
import { decisionReplySchema, errorEnvelopeSchema, warmReplySchema } from "./typesafe-schema.ts";

/** One file in `fixtures/typesafe/`, as `scripts/probe/fixtures.mjs` records an exchange. */
type Recorded = {
  request: { method: string; url: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

/**
 * Every recorded exchange, keyed by file name. The fixtures were recorded with
 * `model: "jev-latest"`, so they serve `fromWire` only; `toWire` is checked
 * against the pinned literal below.
 */
const fixtures = import.meta.glob<Recorded>("./fixtures/typesafe/*.json", {
  eager: true,
  import: "default",
});

function fixture(name: string): Recorded {
  const recorded = fixtures[`./fixtures/typesafe/${name}.json`];
  if (recorded === undefined) throw new Error(`No fixture named ${name}.`);
  return recorded;
}

const PINNED_MODEL = "jev-1.13.0";

/** A key that must never appear in an error. Its shape mirrors a real one without being one. */
const API_KEY = "sk-test-0123456789abcdef-never-logged";

const noulRequest: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: "Patient with asthma reports a sore throat and shortness of breath.",
  questions: {
    escalate: {
      instructions: "Should a nurse see this chat before the patient books anything?",
      criteria: { true: "Breathing trouble", false: "Stable symptoms" },
    },
  },
};

const choiceRequest: DecisionRequest<"choice"> = {
  primitive: "choice",
  state: "Patient asks for a repeat prescription.",
  criteria: { nurse_line: "Needs a nurse today", pharmacy: "Refill only", front_desk: null },
  questions: {
    queue: { instructions: "Which team should own this chat?" },
    urgent_queue: {
      instructions: "Which team if the patient cannot breathe?",
      criteria: { nurse_line: "Needs a nurse now", emergency: null },
    },
  },
};

const scoreRequest: DecisionRequest<"score"> = {
  primitive: "score",
  state: "Patient reports a mild cough.",
  questions: {
    acuity: {
      instructions: "How soon should someone respond?",
      criteria: ["Within a week", "Within a day", "Within an hour"],
    },
  },
};

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw new Error(`Expected a ProviderError, received ${String(error)}.`);
  }
  throw new Error("Expected the call to fail, but it succeeded.");
}

function failure(run: () => unknown): ProviderError {
  try {
    run();
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw new Error(`Expected a ProviderError, received ${String(error)}.`);
  }
  throw new Error("Expected the call to fail, but it succeeded.");
}

type Call = { url: string; init: RequestInit };

/** The URL a `fetch` was called with, whichever of its three input forms it came in. */
function urlOf(input: Parameters<Fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

/** The body a `fetch` was sent. `decide` always sends JSON text, so anything else is a test failure. */
function sentBody(init: RequestInit): string {
  if (typeof init.body !== "string") throw new Error("Expected the request body to be a string.");
  return init.body;
}

/** A `fetch` that answers every call with one reply and records what it was asked. */
function stubFetch(
  status: number,
  body: string,
  headers: Record<string, string> = { "content-type": "application/json" },
): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = (input, init) => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve(new Response(body, { status, headers }));
  };
  return { fetch, calls };
}

function jsonFetch(status: number, body: unknown, headers?: Record<string, string>) {
  return stubFetch(status, JSON.stringify(body), {
    "content-type": "application/json",
    ...headers,
  });
}

const liveSignal = () => new AbortController().signal;

describe("toWire", () => {
  it("pins the model to the catalog's jev-1.13.0, never the fixture's jev-latest", () => {
    const wire = toWire(noulRequest);
    expect(wire.model).toBe(PINNED_MODEL);
    expect(wire.model).toBe(typesafe.model);
    expect(fixture("noul").request.body).toMatchObject({ model: "jev-latest" });
  });

  it("passes a Noul question through with type noul and its fields unchanged", () => {
    const wire = toWire(noulRequest);
    expect(wire.state).toBe(noulRequest.state);
    expect(wire.questions).toStrictEqual({
      escalate: {
        type: "noul",
        instructions: noulRequest.questions.escalate.instructions,
        criteria: noulRequest.questions.escalate.criteria,
      },
    });
  });

  it("omits criteria from a Noul question that has none", () => {
    const wire = toWire({
      primitive: "noul",
      state: "s",
      questions: { q: { instructions: "Is it?" } },
    });
    expect(wire.questions).toStrictEqual({ q: { type: "noul", instructions: "Is it?" } });
  });

  it("gives a Choice question the request default criteria unless it has its own", () => {
    const wire = toWire(choiceRequest);
    expect(wire.questions).toStrictEqual({
      queue: {
        type: "choice",
        instructions: choiceRequest.questions.queue.instructions,
        criteria: choiceRequest.criteria,
      },
      urgent_queue: {
        type: "choice",
        instructions: choiceRequest.questions.urgent_queue.instructions,
        criteria: choiceRequest.questions.urgent_queue.criteria,
      },
    });
  });

  it("passes a Score question through with its ordered levels", () => {
    const wire = toWire(scoreRequest);
    expect(wire.questions).toStrictEqual({
      acuity: {
        type: "score",
        instructions: scoreRequest.questions.acuity.instructions,
        criteria: ["Within a week", "Within a day", "Within an hour"],
      },
    });
  });

  it("sends only model, state, and questions", () => {
    expect(Object.keys(toWire(noulRequest)).sort()).toEqual(["model", "questions", "state"]);
  });
});

describe("fromWire", () => {
  it("passes the recorded Noul answer straight through", () => {
    const decision = fromWire(noulRequest, fixture("noul").body);
    expect(decision.answers).toStrictEqual({ escalate: { type: "noul", noul: 0.92 } });
    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.usage).toStrictEqual({ input_tokens: 343, output_tokens: 22 });
  });

  it("passes the recorded Choice answer through with its probabilities record", () => {
    const decision = fromWire(choiceRequest, fixture("choice").body);
    expect(decision.answers).toStrictEqual({
      queue: {
        type: "choice",
        choice: "nurse_line",
        confidence: 1,
        probabilities: { nurse_line: 1, primary_care: 0, pharmacy: 0, front_desk: 0 },
      },
    });
    expect(decision.usage.output_tokens).toBe(55);
  });

  it("passes the recorded Score answer through with its legend", () => {
    const decision = fromWire(scoreRequest, fixture("score").body);
    expect(decision.answers).toStrictEqual({
      acuity: {
        type: "score",
        score: 1.84,
        confidence: 0.76,
        legend: { "0": "Within a week", "1": "Within a day", "2": "Within an hour" },
        probabilities: { "0": 0, "1": 0.16, "2": 0.84 },
      },
    });
    expect(decision.usage.output_tokens).toBe(18);
  });

  it("passes a refusal through unchanged", () => {
    const body = {
      model: "jev-1.13.0",
      answers: { escalate: { type: "refusal" } },
      usage: usage(),
    };
    expect(fromWire(noulRequest, body).answers).toStrictEqual({ escalate: { type: "refusal" } });
  });

  it("strips fields the schema does not know", () => {
    const body = {
      model: "jev-1.13.0",
      answers: { escalate: { type: "noul", noul: 0.5, debug: "trace" } },
      usage: usage(),
      request_id: "abc",
    };
    const decision = fromWire(noulRequest, body);
    expect(decision).toStrictEqual({
      model: "jev-1.13.0",
      answers: { escalate: { type: "noul", noul: 0.5 } },
      usage: usage(),
    });
  });

  it("rejects an unknown answer type as upstream, naming its path", () => {
    const body = {
      model: "jev-1.13.0",
      answers: { escalate: { type: "mystery", value: 1 } },
      usage: usage(),
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toMatch(/^answers\.escalate\.type: /);
    expect(error.message).toBe("TypeSafe Jev answered in a shape this app cannot read.");
  });

  it("rejects a deliberately broken copy of the fixture at its dot path", () => {
    const broken = structuredClone(fixture("noul").body) as {
      answers: { escalate: { noul: unknown } };
    };
    broken.answers.escalate.noul = "0.92";
    const error = failure(() => fromWire(noulRequest, broken));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("answers.escalate.noul: expected number, received string");
  });

  it("rejects a body that is not an object at the body itself", () => {
    const error = failure(() => fromWire(noulRequest, "not json"));
    expect(error.detail).toBe("body: expected object, received string");
  });

  it("rejects an answer for a primitive the request did not ask", () => {
    const error = failure(() => fromWire(noulRequest, fixture("choice").body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe(
      'answers.queue.type: expected "noul" or "refusal", received "choice"',
    );
  });
});

describe("the schemas against every recorded fixture", () => {
  const names = Object.keys(fixtures).map((path) => path.slice("./fixtures/typesafe/".length, -5));

  it("covers the five recorded exchanges", () => {
    expect(names.sort()).toEqual(["bad-key", "choice", "models-list", "noul", "score"]);
  });

  it.each(names)("parses %s with the schema its URL and status select", (name) => {
    const { request, status, body } = fixture(name);
    const schema =
      status >= 300
        ? errorEnvelopeSchema
        : request.url.endsWith("/v1/models")
          ? warmReplySchema
          : decisionReplySchema;
    expect(schema.safeParse(body).success).toBe(true);
  });
});

describe("decide", () => {
  it("posts the wire request to /v1/systemone with the injected fetch and the key in the header", async () => {
    const { fetch, calls } = jsonFetch(200, fixture("noul").body);
    const signal = liveSignal();
    const decision = await decide(noulRequest, API_KEY, signal, fetch);

    expect(decision).toStrictEqual(fromWire(noulRequest, fixture("noul").body));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.init.method).toBe("POST");
    expect(call.init.signal).toBe(signal);
    expect(call.init.headers).toStrictEqual({
      accept: "application/json",
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(sentBody(call.init))).toStrictEqual(toWire(noulRequest));
  });

  it("maps a 401 to auth, names the provider, and keeps the key out of the error", async () => {
    const recorded = fixture("bad-key");
    const { fetch } = jsonFetch(recorded.status, recorded.body);
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("auth");
    expect(error.message).toContain("TypeSafe Jev rejected the API key");
    expect(error.detail).toBe(
      "401 authentication_error: Cannot authenticate with the server. Please check your API key and try again.",
    );
    expect(error.message).not.toContain(API_KEY);
    expect(error.detail).not.toContain(API_KEY);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it("maps a 429 to rate_limited carrying Retry-After in seconds", async () => {
    const { fetch } = jsonFetch(429, envelope("rate_limit_error", "Slow down."), {
      "retry-after": "7",
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.message).toBe(
      "TypeSafe Jev is rate limiting requests. Wait 7 seconds and try again.",
    );
    expect(error.detail).toBe("429 rate_limit_error: Slow down.");
  });

  it("maps a 429 without Retry-After to a wait of a moment", async () => {
    const { fetch } = jsonFetch(429, envelope("rate_limit_error", "Slow down."));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.retryAfterSeconds).toBeUndefined();
    expect(error.message).toContain("Wait a moment");
  });

  it.each([
    [403, "auth"],
    [400, "invalid_request"],
    [422, "invalid_request"],
    [404, "upstream"],
    [500, "upstream"],
    [529, "upstream"],
  ] as const)("maps a %i to %s", async (status, kind) => {
    const { fetch } = jsonFetch(status, envelope("some_error", "Something."));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe(kind);
    expect(error.detail).toBe(`${status} some_error: Something.`);
    expect(error.message).toContain("TypeSafe Jev");
  });

  it("reports a failed status whose body is not the envelope by its status alone", async () => {
    const { fetch } = stubFetch(502, "<html>Bad gateway</html>", { "content-type": "text/html" });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("502");
  });

  it("maps an aborted exchange to timeout", async () => {
    const controller = new AbortController();
    const fetch: Fetch = (_input, init) => {
      controller.abort();
      return Promise.reject(init?.signal?.reason ?? new Error("aborted"));
    };
    const error = await rejection(decide(noulRequest, API_KEY, controller.signal, fetch));
    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("TypeSafe Jev took too long to answer");
  });

  it("maps a rejected fetch to unreachable with the cause's message", async () => {
    const fetch: Fetch = () => Promise.reject(new TypeError("fetch failed"));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("unreachable");
    expect(error.message).toBe("Could not reach TypeSafe Jev. Check the connection and try again.");
    expect(error.detail).toBe("fetch failed");
  });

  it("maps a success whose body is not JSON to upstream", async () => {
    const { fetch } = stubFetch(200, "<html>ok</html>", { "content-type": "text/html" });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.message).toBe("TypeSafe Jev answered with a body that is not JSON.");
    expect(error.detail).toBe("200: the body is not JSON");
  });

  it("maps a success whose schema fails to upstream with the dot path", async () => {
    const { fetch } = jsonFetch(200, {
      model: "jev-1.13.0",
      answers: {},
      usage: { input_tokens: 1 },
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("usage.output_tokens: expected number, received undefined");
  });
});

describe("the adapter object", () => {
  it("bundles the catalog descriptor with the three functions", () => {
    expect(typesafeAdapter.descriptor).toBe(typesafe);
    expect(typesafeAdapter.toWire).toBe(toWire);
    expect(typesafeAdapter.fromWire).toBe(fromWire);
    expect(typesafeAdapter.decide).toBe(decide);
  });

  it("imports the SDK for its types only", () => {
    const sdkImports = typesafeSource.match(/^import .* from "@typesafe-ai\/sdk";$/gm) ?? [];
    expect(sdkImports.length).toBeGreaterThan(0);
    for (const line of sdkImports) expect(line).toMatch(/^import type /);
  });

  it("declares ProviderAdapter as a type alias, no interface, and ends with satisfies", () => {
    expect(adapterSource).toMatch(/^export type ProviderAdapter = \{/m);
    expect(adapterSource).not.toMatch(/\binterface\b/);
    expect(typesafeSource).not.toMatch(/\binterface\b/);
    expect(typesafeSource.trimEnd()).toMatch(/\} satisfies ProviderAdapter;$/);
  });
});

function usage() {
  return { input_tokens: 10, output_tokens: 2 };
}

function envelope(error_type: string, message: string) {
  return { detail: { error_type, message } };
}
