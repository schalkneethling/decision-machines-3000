// The fixtures are read with `import.meta.glob` and the sources with `?raw`, both
// Vite features that Vitest serves. Their types come from `vite/client`, which the
// root tsconfig does not apply to the worker folder, so this file names it itself.
/// <reference types="vite/client" />

import type * as z from "zod/mini";
import { describe, expect, it, vi } from "vite-plus/test";
import type { DecisionRequest } from "../../src/decision/contract.ts";
import { typesafe } from "../../src/providers/catalog.ts";
import {
  ProviderError,
  describeIssue,
  failureFromStatus,
  isSuccess,
  retryAfterSeconds,
} from "./adapter.ts";
import type { Fetch, UpstreamReply } from "./adapter.ts";
import { decide, fromWire, toWire, typesafeAdapter } from "./typesafe.ts";
import typesafeSource from "./typesafe.ts?raw";

/**
 * Flips to `true` the moment any module loads `@typesafe-ai/sdk` at run time.
 * `vi.mock` is hoisted above the imports, so it also covers the static import
 * of `./typesafe.ts` above; an `import type` is erased and never reaches it.
 */
const sdk = vi.hoisted(() => ({ loaded: false }));
vi.mock("@typesafe-ai/sdk", () => {
  sdk.loaded = true;
  return {};
});
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
    // The fixture answers one question, so the request asks that one only.
    const request = { ...choiceRequest, questions: { queue: choiceRequest.questions.queue } };
    const decision = fromWire(request, fixture("choice").body);
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
    const choiceAnswer = (fixture("choice").body as { answers: { queue: unknown } }).answers.queue;
    const body = { model: "jev-1.13.0", answers: { escalate: choiceAnswer }, usage: usage() };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe(
      'answers.escalate.type: expected "noul" or "refusal", received "choice"',
    );
  });

  it("rejects a reply that answers a question the request did not ask", () => {
    const body = {
      model: "jev-1.13.0",
      answers: { escalate: { type: "noul", noul: 0.5 }, extra: { type: "noul", noul: 0.1 } },
      usage: usage(),
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("answers.extra: no question with this id");
  });

  it("rejects a reply that leaves a question unanswered", () => {
    const body = { model: "jev-1.13.0", answers: {}, usage: usage() };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe('answers: no answer for question "escalate"');
  });

  it("truncates a provider-supplied id in the detail to about 300 characters", () => {
    const longId = "x".repeat(1000);
    const body = {
      model: "jev-1.13.0",
      answers: { escalate: { type: "noul", noul: 0.5 }, [longId]: { type: "noul", noul: 0.1 } },
      usage: usage(),
    };
    const error = failure(() => fromWire(noulRequest, body));
    // 300 characters of id, an ellipsis, and the problem after it.
    expect(error.detail?.length).toBeLessThan(340);
    expect(error.detail).toMatch(/^answers\.x{10}/);
    expect(error.detail).toMatch(/…: no question with this id$/);
    expect(error.detail).toContain("…");
  });

  it("rejects a null body at the body itself", () => {
    const error = failure(() => fromWire(noulRequest, null));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("body: expected object, received null");
  });

  it("reports a reply nested too deeply as upstream instead of throwing a RangeError", () => {
    let nested: unknown = "deep";
    for (let depth = 0; depth < 10_000; depth += 1) nested = [nested];
    const body = structuredClone(fixture("score").body) as {
      answers: { acuity: { legend: Record<string, unknown> } };
    };
    body.answers.acuity.legend["0"] = nested;
    const error = failure(() => fromWire(scoreRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("body: nested too deeply");
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
    // A redirect would carry the key header to another host, so none is followed.
    expect(call.init.redirect).toBe("error");
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

  it("maps an abort while the body is being read to timeout", async () => {
    const controller = new AbortController();
    const fetch: Fetch = () => {
      // The headers arrive, then the body stream fails because the exchange was aborted.
      const body = new ReadableStream({
        start(stream) {
          controller.abort();
          stream.error(new DOMException("The operation was aborted.", "AbortError"));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    };
    const error = await rejection(decide(noulRequest, API_KEY, controller.signal, fetch));
    expect(error.kind).toBe("timeout");
  });

  it("maps a rejected fetch to unreachable, describing it by name and code only", async () => {
    const failed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }),
    });
    const fetch: Fetch = () => Promise.reject(failed);
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("unreachable");
    expect(error.message).toBe("Could not reach TypeSafe Jev. Check the connection and try again.");
    expect(error.detail).toBe("TypeError (ECONNREFUSED)");
    expect(error.cause).toStrictEqual({ name: "TypeError", code: "ECONNREFUSED" });
  });

  it("never echoes a transport error whose message holds the key", async () => {
    const leaky = new TypeError(`Headers.append: "Bearer ${API_KEY}" is an invalid header value.`);
    const fetch: Fetch = () => Promise.reject(leaky);
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("unreachable");
    expect(error.detail).toBe("TypeError");
    expectNoKey(error);
  });

  it("describes a rejection that is not an Error by its type, without echoing it", async () => {
    const fetch: Fetch = () => Promise.reject(`socket hung up while sending Bearer ${API_KEY}`);
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("unreachable");
    expect(error.detail).toBe("string");
    expectNoKey(error);
  });

  it.each([
    ["an interior line break", `sk-first-line\nsk-second-line`],
    ["a control character", `sk-bell\u0007key`],
    ["a space", `sk-two words`],
  ])("rejects a key with %s before calling fetch, without echoing it", async (_what, key) => {
    const { fetch, calls } = jsonFetch(200, fixture("noul").body);
    const error = await rejection(decide(noulRequest, key, liveSignal(), fetch));
    expect(calls).toHaveLength(0);
    expect(error.kind).toBe("auth");
    expect(error.message).toBe(
      "The TypeSafe Jev API key contains characters that can't be sent. Check the key for line breaks or spaces.",
    );
    expect(error.detail).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain("sk-");
    expect(String(error.cause)).not.toContain("sk-");
  });

  it("maps a success with an empty body to upstream", async () => {
    const { fetch } = stubFetch(200, "", { "content-type": "application/json" });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("200: the body is empty");
  });

  it("truncates the envelope message in the detail to about 300 characters", async () => {
    const { fetch } = jsonFetch(500, envelope("server_error", "y".repeat(1000)));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.detail?.length).toBeLessThan(330);
    expect(error.detail).toMatch(/^500 server_error: y{10}/);
    expect(error.detail).toContain("…");
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

  it("loads no runtime module from the SDK", async () => {
    // The adapter has been imported and used by every test above, and the SDK mock never ran.
    expect(sdk.loaded).toBe(false);
    // The same mock does run when the SDK is loaded at run time, so the check above is live.
    await import("@typesafe-ai/sdk");
    expect(sdk.loaded).toBe(true);
  });

  it("ends with satisfies ProviderAdapter", () => {
    expect(typesafeSource.trimEnd()).toMatch(/\bsatisfies ProviderAdapter;$/);
  });
});

describe("retryAfterSeconds", () => {
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
  const header = (value: string) => new Headers({ "retry-after": value });

  it.each(["7", "0", "3600"])("reads %s as whole seconds, at least 1", (value) => {
    expect(retryAfterSeconds(header(value), NOW)).toBe(Math.max(1, Number(value)));
  });

  it("clamps a huge value to an hour", () => {
    expect(retryAfterSeconds(header("99999999"), NOW)).toBe(3600);
  });

  it.each(["", "   ", "garbage 5", "12,5", "0x10", "1e3", "-0", "5.5", "+5"])(
    "gives undefined for %j",
    (value) => {
      expect(retryAfterSeconds(header(value), NOW)).toBeUndefined();
    },
  );

  it("reads an HTTP date in the future as seconds from now, rounded up", () => {
    expect(retryAfterSeconds(header("Wed, 14 Oct 2026 12:01:30 GMT"), NOW)).toBe(90);
  });

  it("reads an HTTP date in the past as the minimum wait", () => {
    expect(retryAfterSeconds(header("Wed, 14 Oct 2026 11:00:00 GMT"), NOW)).toBe(1);
  });

  it("clamps a far-future HTTP date to an hour", () => {
    expect(retryAfterSeconds(header("Thu, 15 Oct 2026 12:00:00 GMT"), NOW)).toBe(3600);
  });

  it("does not guess at text that merely parses as a date", () => {
    expect(retryAfterSeconds(header("2026-10-14"), NOW)).toBeUndefined();
    expect(retryAfterSeconds(header("Oct 14 2026"), NOW)).toBeUndefined();
  });

  it("gives undefined when the header is absent", () => {
    expect(retryAfterSeconds(new Headers(), NOW)).toBeUndefined();
  });
});

describe("failureFromStatus", () => {
  const reply = (status: number, headers: Record<string, string> = {}): UpstreamReply => ({
    status,
    headers: new Headers(headers),
    body: undefined,
  });

  it("lets an adapter override the kind and the wording for a status", () => {
    const error = failureFromStatus(typesafe, reply(429), "insufficient_quota: Out of credit.", {
      kind: "auth",
      message: "TypeSafe Jev has no credit left on this key.",
    });
    expect(error.kind).toBe("auth");
    expect(error.message).toBe("TypeSafe Jev has no credit left on this key.");
    expect(error.detail).toBe("429 insufficient_quota: Out of credit.");
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("keeps the default wording when only the kind is overridden", () => {
    const error = failureFromStatus(typesafe, reply(402), undefined, { kind: "invalid_request" });
    expect(error.kind).toBe("invalid_request");
    expect(error.message).toContain("TypeSafe Jev could not process this request");
    expect(error.detail).toBe("402");
  });

  it("reads Retry-After when a status is overridden to rate_limited", () => {
    const error = failureFromStatus(typesafe, reply(503, { "retry-after": "12" }), undefined, {
      kind: "rate_limited",
    });
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.message).toContain("Wait 12 seconds");
  });
});

describe("isSuccess", () => {
  it("is true for 2xx only", () => {
    expect(isSuccess(200)).toBe(true);
    expect(isSuccess(204)).toBe(true);
    expect(isSuccess(299)).toBe(true);
    expect(isSuccess(199)).toBe(false);
    expect(isSuccess(300)).toBe(false);
    expect(isSuccess(404)).toBe(false);
  });
});

describe("describeIssue", () => {
  it("names a discriminated union miss at the discriminator", () => {
    const issue: z.core.$ZodIssue = {
      code: "invalid_union",
      errors: [],
      path: ["answers", "q", "type"],
      message: "Invalid input",
    };
    expect(describeIssue(issue)).toBe("answers.q.type: matches none of the expected shapes");
  });

  it("words any other code from the code itself", () => {
    const issue: z.core.$ZodIssue = {
      code: "too_small",
      origin: "array",
      minimum: 1,
      path: ["answers"],
      message: "Invalid input",
    };
    expect(describeIssue(issue)).toBe("answers: too small");
  });

  it("places a problem with the whole body at body", () => {
    const issue: z.core.$ZodIssue = {
      code: "invalid_type",
      expected: "object",
      input: undefined,
      path: [],
      message: "Invalid input",
    };
    expect(describeIssue(issue)).toBe("body: expected object, received undefined");
  });

  it("truncates a long path segment", () => {
    const issue: z.core.$ZodIssue = {
      code: "too_big",
      origin: "string",
      maximum: 1,
      path: ["answers", "k".repeat(1000)],
      message: "Invalid input",
    };
    const described = describeIssue(issue);
    expect(described.length).toBeLessThan(330);
    expect(described).toMatch(/^answers\.k{10}/);
    expect(described).toContain("…");
  });
});

/** The key must not appear in anything the error carries or prints. */
function expectNoKey(error: ProviderError) {
  expect(error.message).not.toContain(API_KEY);
  expect(error.detail ?? "").not.toContain(API_KEY);
  expect(JSON.stringify(error)).not.toContain(API_KEY);
  expect(String(error.cause)).not.toContain(API_KEY);
  expect(JSON.stringify(error.cause)).not.toContain(API_KEY);
}

function usage() {
  return { input_tokens: 10, output_tokens: 2 };
}

function envelope(error_type: string, message: string) {
  return { detail: { error_type, message } };
}
