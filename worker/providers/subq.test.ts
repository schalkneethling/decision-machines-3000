// The fixtures are read with `import.meta.glob` and the sources with `?raw`, both
// Vite features that Vitest serves. Their types come from `vite/client`, which the
// root tsconfig does not apply to the worker folder, so this file names it itself.
/// <reference types="vite/client" />

import { describe, expect, it, vi } from "vite-plus/test";
import type { DecisionRequest } from "../../src/decision/contract.ts";
import type { ValidDecisionRequest } from "../../src/decision/validate.ts";
import { subq } from "../../src/providers/catalog.ts";
import type { ProviderKeys } from "../env.ts";
import { handle } from "../handler.ts";
import type { HandlerDeps } from "../handler.ts";
import { ProviderError } from "./adapter.ts";
import type { Fetch } from "./adapter.ts";
import { decide, fromWire, subqAdapter, toWire } from "./subq.ts";
import subqSource from "./subq.ts?raw";
import { decisionReplySchema, errorEnvelopeSchema, warmReplySchema } from "./subq-schema.ts";

/** One file in `fixtures/subq/`, as `scripts/probe/fixtures.mjs` records an exchange. */
type Recorded = {
  request: { method: string; url: string; body?: Record<string, unknown> };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

const fixtures = import.meta.glob<Recorded>("./fixtures/subq/*.json", {
  eager: true,
  import: "default",
});

function fixture(name: string): Recorded {
  const recorded = fixtures[`./fixtures/subq/${name}.json`];
  if (recorded === undefined) throw new Error(`No fixture named ${name}.`);
  return recorded;
}

/** A key that must never appear in an error. Its shape mirrors a real one without being one. */
const API_KEY = "sk-test-0123456789abcdef-never-logged";

const STATE =
  "Patient with asthma reports a sore throat, fever since yesterday, and shortness of breath walking to the kitchen this morning.";

// The three requests below carry the same state, instructions, and criteria as
// `fixtures/subq/three-types.json`, one primitive per request as the neutral
// contract requires. A test compares them with the fixture's recorded body.
const noulRequest: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: STATE,
  questions: {
    escalate: {
      instructions: "Should a nurse see this chat before the patient books anything?",
      criteria: {
        true: "Breathing trouble, chest pain, or a flare of a known condition",
        false: "Stable symptoms the patient can book for themselves",
      },
    },
  },
};

const choiceRequest: DecisionRequest<"choice"> = {
  primitive: "choice",
  state: STATE,
  criteria: {
    nurse_line: "Needs a nurse to assess symptoms today",
    primary_care: "Book with the patient's own doctor",
    pharmacy: "Refill or medication question only",
    front_desk: null,
  },
  questions: { queue: { instructions: "Which team should own this chat?" } },
};

const scoreRequest: DecisionRequest<"score"> = {
  primitive: "score",
  state: STATE,
  questions: {
    acuity: {
      instructions: "How soon should someone respond?",
      criteria: ["Within a week", "Within a day", "Within an hour"],
    },
  },
};

type Fields = Record<string, unknown>;

/** The recorded three-type reply with only the named answer kept, because a neutral request asks one primitive. */
function threeTypesReplyWith(id: string): Fields {
  const body = structuredClone(fixture("three-types").body) as Fields & { answers: Fields };
  body.answers = { [id]: body.answers[id] };
  return body;
}

function envelope(error_type: string, message: string) {
  return { detail: { error_type, message } };
}

function usage() {
  return { input_tokens: 10, output_tokens: 0 };
}

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

function urlOf(input: Parameters<Fetch>[0]): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function sentBody(init: RequestInit): string {
  if (typeof init.body !== "string") throw new Error("Expected the request body to be a string.");
  return init.body;
}

/** A `fetch` that answers every call with one JSON reply and records what it was asked. */
function jsonFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: Fetch = (input, init) => {
    calls.push({ url: urlOf(input), init: init ?? {} });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
  };
  return { fetch, calls };
}

const liveSignal = () => new AbortController().signal;

describe("toWire", () => {
  it("matches the body recorded in the three-types fixture, question by question", () => {
    const recorded = fixture("three-types").request.body as {
      state: string;
      questions: Record<string, unknown>;
    };
    expect(toWire(noulRequest).questions.escalate).toStrictEqual(recorded.questions.escalate);
    expect(toWire(choiceRequest).questions.queue).toStrictEqual(recorded.questions.queue);
    expect(toWire(scoreRequest).questions.acuity).toStrictEqual(recorded.questions.acuity);
    expect(toWire(noulRequest).state).toBe(recorded.state);
  });

  it("pins the model to the catalog's subq-snap-preview", () => {
    expect(toWire(noulRequest).model).toBe("subq-snap-preview");
    expect(toWire(noulRequest).model).toBe(subq.model);
  });

  it("passes a Noul question through with type noul and its fields unchanged", () => {
    expect(toWire(noulRequest).questions).toStrictEqual({
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
    const own = { nurse_line: "Needs a nurse now", emergency: null };
    const wire = toWire({
      ...choiceRequest,
      questions: {
        ...choiceRequest.questions,
        urgent_queue: { instructions: "Which team if the patient cannot breathe?", criteria: own },
      },
    });
    expect(wire.questions.queue).toStrictEqual({
      type: "choice",
      instructions: "Which team should own this chat?",
      criteria: choiceRequest.criteria,
    });
    expect(wire.questions.urgent_queue).toMatchObject({ type: "choice", criteria: own });
  });

  it("passes a Score question through with its ordered levels", () => {
    expect(toWire(scoreRequest).questions.acuity).toStrictEqual({
      type: "score",
      instructions: "How soon should someone respond?",
      criteria: ["Within a week", "Within a day", "Within an hour"],
    });
  });

  it("sends only model, state, and questions when the request has no images", () => {
    expect(Object.keys(toWire(noulRequest)).sort()).toEqual(["model", "questions", "state"]);
  });

  describe("with images", () => {
    const image = {
      mediaType: "image/png",
      base64:
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=",
      byteLength: 77,
    };

    it("copies each image as { mediaType, base64 } with the data untouched and no data: prefix", () => {
      const wire = toWire({ ...noulRequest, images: [image] });
      expect(wire.images).toStrictEqual([{ mediaType: "image/png", base64: image.base64 }]);
      expect(wire.images?.[0]?.base64.startsWith("data:")).toBe(false);
    });

    it("sends the same images field the recorded plain-base64 exchange did", () => {
      const recorded = fixture("image-png-plain-base64").request.body as { images: unknown };
      const wire = toWire({ ...noulRequest, images: [image] });
      expect(wire.images).toStrictEqual(recorded.images);
    });

    it("keeps several images in order and drops the byte count", () => {
      const second = { mediaType: "image/jpeg", base64: "AAAA", byteLength: 3 };
      const wire = toWire({ ...noulRequest, images: [image, second] });
      expect(wire.images?.map((entry) => entry.mediaType)).toEqual(["image/png", "image/jpeg"]);
      expect(JSON.stringify(wire)).not.toContain("byteLength");
    });

    it("has no images field when the list is empty", () => {
      expect("images" in toWire({ ...noulRequest, images: [] })).toBe(false);
    });
  });
});

describe("fromWire", () => {
  /** The recorded answer for one question id, to compare with what `fromWire` returns. */
  function recordedAnswer(id: string): unknown {
    return (fixture("three-types").body as { answers: Fields }).answers[id];
  }

  it("passes the recorded Yes/no answer straight through, with no confidence", () => {
    const decision = fromWire(noulRequest, threeTypesReplyWith("escalate"));
    expect(decision.answers).toStrictEqual({ escalate: recordedAnswer("escalate") });
    expect(recordedAnswer("escalate")).toStrictEqual({ type: "noul", noul: expect.any(Number) });
    expect(decision.model).toBe("subq-snap-preview");
    expect(decision.usage).toStrictEqual({ input_tokens: 260, output_tokens: 0 });
  });

  it("copies the recorded Choice answer field for field", () => {
    const decision = fromWire(choiceRequest, threeTypesReplyWith("queue"));
    expect(decision.answers).toStrictEqual({ queue: recordedAnswer("queue") });
    expect(decision.answers.queue).toMatchObject({
      type: "choice",
      choice: "nurse_line",
      confidence: expect.any(Number),
    });
  });

  it("copies the recorded Score answer field for field", () => {
    const decision = fromWire(scoreRequest, threeTypesReplyWith("acuity"));
    expect(decision.answers).toStrictEqual({ acuity: recordedAnswer("acuity") });
    expect(decision.answers.acuity).toMatchObject({
      type: "score",
      legend: { "0": "Within a week", "1": "Within a day", "2": "Within an hour" },
    });
  });

  it("strips fields the schema does not know", () => {
    const body = {
      model: "subq-snap-preview",
      answers: { escalate: { type: "noul", noul: 0.5, debug: "trace" } },
      usage: usage(),
      request_id: "abc",
    };
    expect(fromWire(noulRequest, body)).toStrictEqual({
      model: "subq-snap-preview",
      answers: { escalate: { type: "noul", noul: 0.5 } },
      usage: usage(),
    });
  });

  it("rejects a deliberately broken copy of the fixture at its dot path", () => {
    const broken = threeTypesReplyWith("escalate") as { answers: { escalate: { noul: unknown } } };
    broken.answers.escalate.noul = "0.95";
    const error = failure(() => fromWire(noulRequest, broken));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("answers.escalate.noul: expected number, received string");
    expect(error.message).toBe("SubQ Snap answered in a shape this app cannot read.");
  });

  it("rejects a refusal, because SubQ cannot refuse, at the answer's type", () => {
    const body = {
      model: "subq-snap-preview",
      answers: { escalate: { type: "refusal" } },
      usage: usage(),
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toMatch(/^answers\.escalate\.type: /);
  });

  it("rejects an answer for a primitive the request did not ask", () => {
    const choiceAnswer = (threeTypesReplyWith("queue") as { answers: Fields }).answers.queue;
    const body = {
      model: "subq-snap-preview",
      answers: { escalate: choiceAnswer },
      usage: usage(),
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.detail).toBe('answers.escalate.type: expected "noul", received "choice"');
  });

  it("rejects a reply that answers a question the request did not ask", () => {
    const body = {
      model: "subq-snap-preview",
      answers: { escalate: { type: "noul", noul: 0.5 }, extra: { type: "noul", noul: 0.1 } },
      usage: usage(),
    };
    expect(failure(() => fromWire(noulRequest, body)).detail).toBe(
      "answers.extra: no question with this id",
    );
  });

  it("rejects a reply that leaves a question unanswered", () => {
    const body = { model: "subq-snap-preview", answers: {}, usage: usage() };
    expect(failure(() => fromWire(noulRequest, body)).detail).toBe(
      'answers: no answer for question "escalate"',
    );
  });

  it("truncates a provider-supplied id in the detail to about 300 characters", () => {
    const body = {
      model: "subq-snap-preview",
      answers: {
        escalate: { type: "noul", noul: 0.5 },
        ["x".repeat(1000)]: { type: "noul", noul: 0.1 },
      },
      usage: usage(),
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.detail?.length).toBeLessThan(340);
    expect(error.detail).toMatch(/…: no question with this id$/);
  });

  it("rejects a null body at the body itself", () => {
    expect(failure(() => fromWire(noulRequest, null)).detail).toBe(
      "body: expected object, received null",
    );
  });
});

describe("fromWire on a reply of the wrong shape", () => {
  type Mutate = (reply: Fields & { answers: Record<string, Fields>; usage: unknown }) => unknown;

  /** An array where an object belongs, at each place the reply holds one. */
  const arrayWhereObjectBelongs: [string, ValidDecisionRequest, string, Mutate][] = [
    ["the body", noulRequest, "body", () => []],
    ["answers", noulRequest, "answers", (reply) => ({ ...reply, answers: [] })],
    [
      "a single answer",
      noulRequest,
      "answers.escalate",
      (reply) => ({ ...reply, answers: { escalate: [] } }),
    ],
    ["usage", noulRequest, "usage", (reply) => ({ ...reply, usage: [] })],
    [
      "choice probabilities",
      choiceRequest,
      "answers.queue.probabilities",
      (reply) => ({ ...reply, answers: { queue: { ...reply.answers.queue, probabilities: [] } } }),
    ],
    [
      "score legend",
      scoreRequest,
      "answers.acuity.legend",
      (reply) => ({ ...reply, answers: { acuity: { ...reply.answers.acuity, legend: [] } } }),
    ],
    [
      "score probabilities",
      scoreRequest,
      "answers.acuity.probabilities",
      (reply) => ({
        ...reply,
        answers: { acuity: { ...reply.answers.acuity, probabilities: [] } },
      }),
    ],
  ];

  it.each(arrayWhereObjectBelongs)(
    "rejects an array in place of an object at %s as upstream",
    (_place, request, path, mutate) => {
      const id = Object.keys(request.questions)[0] ?? "";
      const reply = threeTypesReplyWith(id) as Parameters<Mutate>[0];
      const error = failure(() => fromWire(request, mutate(reply)));
      expect(error.kind).toBe("upstream");
      expect(error.detail?.startsWith(path)).toBe(true);
    },
  );

  it("reports a reply nested too deeply as upstream instead of throwing a RangeError", () => {
    let nested: unknown = "deep";
    for (let depth = 0; depth < 10_000; depth += 1) nested = [nested];
    const body = threeTypesReplyWith("acuity") as { answers: { acuity: { legend: Fields } } };
    body.answers.acuity.legend["0"] = nested;
    const error = failure(() => fromWire(scoreRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("body: nested too deeply");
  });
});

describe("the schemas against every recorded fixture", () => {
  const names = Object.keys(fixtures).map((path) => path.slice("./fixtures/subq/".length, -5));
  const failedNames = names.filter((name) => fixture(name).status >= 300);
  const succeededNames = names.filter((name) => fixture(name).status < 300);

  it("finds recorded exchanges, and every one is matched by a selector below", () => {
    expect(names.length).toBeGreaterThan(0);
    const selected = [...failedNames, ...succeededNames];
    expect(selected.sort()).toEqual([...names].sort());
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

  it.each(failedNames)(
    "rejects the recorded failure %s as a decision reply, as upstream",
    (name) => {
      const error = failure(() => fromWire(noulRequest, fixture(name).body));
      expect(error.kind).toBe("upstream");
    },
  );
});

describe("decide", () => {
  it("posts the wire request to /v1/systemone with the injected fetch and the key in the header", async () => {
    const { fetch, calls } = jsonFetch(200, threeTypesReplyWith("escalate"));
    const signal = liveSignal();
    const decision = await decide(noulRequest, API_KEY, signal, fetch);

    expect(decision).toStrictEqual({
      ...fromWire(noulRequest, threeTypesReplyWith("escalate")),
      wire: { response: threeTypesReplyWith("escalate") },
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://api.subq.ai/v1/systemone");
    expect(call.init.method).toBe("POST");
    expect(call.init.signal).toBe(signal);
    expect(call.init.redirect).toBe("error");
    expect(call.init.headers).toStrictEqual({
      accept: "application/json",
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(sentBody(call.init))).toStrictEqual(toWire(noulRequest));
  });

  it("returns the key redacted in wire.response when the provider's reply quotes it", async () => {
    const quoted = { ...threeTypesReplyWith("escalate"), note: `echoed ${API_KEY}` };
    const { fetch } = jsonFetch(200, quoted);
    const decision = await decide(noulRequest, API_KEY, liveSignal(), fetch);

    expect(decision.wire.response).toStrictEqual({
      ...threeTypesReplyWith("escalate"),
      note: "echoed [redacted]",
    });
    expect(JSON.stringify(decision)).not.toContain(API_KEY);
  });

  it.each(["bad-key", "bad-key-sk-prefix", "missing-key"])(
    "maps the recorded %s reply to auth, keeping SubQ's message and not the key",
    async (name) => {
      const recorded = fixture(name);
      const { fetch } = jsonFetch(recorded.status, recorded.body);
      const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

      const { error_type, message } = (recorded.body as ReturnType<typeof envelope>).detail;
      expect([401, 403]).toContain(recorded.status);
      expect(error.kind).toBe("auth");
      expect(error.message).toBe("SubQ Snap rejected the API key.");
      expect(error.detail).toBe(`${recorded.status} ${error_type}: ${message}`);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
    },
  );

  it("maps the recorded 422 to invalid_request with SubQ's message in the detail", async () => {
    const recorded = fixture("invalid-body");
    const { fetch } = jsonFetch(recorded.status, recorded.body);
    const error = await rejection(decide(choiceRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("invalid_request");
    expect(error.detail).toMatch(/^422 validation_error: questions\/queue\/type: must be equal/);
  });

  it("maps a 402 to no_credits with wording that names the provider", async () => {
    // 402 was never probed (provider-probes.md), so this envelope is an assumed shape.
    const { fetch } = jsonFetch(402, envelope("payment_required", "No credit."));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("no_credits");
    expect(error.message).toBe(
      "SubQ Snap has no credit left on this account. Add credit, then try again.",
    );
    expect(error.detail).toBe("402 payment_required: No credit.");
  });

  it("maps a 429 to rate_limited carrying Retry-After in seconds", async () => {
    const { fetch } = jsonFetch(429, envelope("rate_limit_error", "Slow down."), {
      "retry-after": "7",
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.message).toBe(
      "SubQ Snap is rate limiting requests. Wait 7 seconds and try again.",
    );
  });

  it.each([
    [400, "invalid_request"],
    [404, "upstream"],
    [500, "upstream"],
    [529, "upstream"],
  ] as const)("maps a %i to %s", async (status, kind) => {
    const { fetch } = jsonFetch(status, envelope("some_error", "Something."));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe(kind);
    expect(error.detail).toBe(`${status} some_error: Something.`);
  });

  it("redacts the key when SubQ's error message quotes it", async () => {
    const { fetch } = jsonFetch(
      401,
      envelope("authentication_error", `The key ${API_KEY} is not valid.`),
    );
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.detail).toBe("401 authentication_error: The key [redacted] is not valid.");
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it("reports a failed status whose body is not the envelope by its status alone", async () => {
    const fetch: Fetch = () =>
      Promise.resolve(new Response("<html>Bad gateway</html>", { status: 502 }));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("502");
  });

  it("maps a success whose schema fails to upstream with the dot path", async () => {
    const { fetch } = jsonFetch(200, {
      model: "subq-snap-preview",
      answers: {},
      usage: { input_tokens: 1 },
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("usage.output_tokens: expected number, received undefined");
  });

  it("maps a rejected fetch to unreachable, describing it by name and code only", async () => {
    const failed = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED 1.2.3.4:443"), { code: "ECONNREFUSED" }),
    });
    const error = await rejection(
      decide(noulRequest, API_KEY, liveSignal(), () => Promise.reject(failed)),
    );
    expect(error.kind).toBe("unreachable");
    expect(error.detail).toBe("TypeError (ECONNREFUSED)");
  });
});

describe("POST /api/decide/subq", () => {
  const ORIGIN = "https://decisionmachines3000.example";
  const withSubq: ProviderKeys = { SUBQ_API_KEY: API_KEY };

  function deps(fetch: Fetch) {
    return {
      fetch: vi.fn(fetch),
      timeoutSignal: () => new AbortController().signal,
      log: vi.fn<(line: string) => void>(),
    } satisfies HandlerDeps;
  }

  async function post(fetch: Fetch) {
    const request = new Request(`${ORIGIN}/api/decide/subq`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(noulRequest),
    });
    const handlerDeps = deps(fetch);
    const response = await handle(request, withSubq, handlerDeps);
    const text = await response.text();
    return { response, text, body: JSON.parse(text) as Record<string, unknown>, handlerDeps };
  }

  it("answers 200 through the SubQ adapter, no longer 501", async () => {
    const { fetch, calls } = jsonFetch(200, threeTypesReplyWith("escalate"));
    const { response, body } = await post(fetch);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      primitive: "noul",
      provider: "subq",
      model: "subq-snap-preview",
      usage: { input_tokens: 260, output_tokens: 0 },
    });
    expect(calls[0]?.url).toBe(`${subq.baseUrl}/v1/systemone`);
  });

  it("answers 422 and carries SubQ's validation message in the detail", async () => {
    const recorded = fixture("invalid-body");
    const { fetch } = jsonFetch(recorded.status, recorded.body);
    const { response, body } = await post(fetch);

    expect(response.status).toBe(422);
    expect(body.detail).toEqual(expect.stringContaining("must have required property 'criteria'"));
    expect(body.detail).toEqual(expect.stringContaining("validation_error"));
  });

  it("answers 402 and says SubQ Snap has no credit", async () => {
    const { fetch } = jsonFetch(402, envelope("payment_required", "No credit."));
    const { response, body } = await post(fetch);

    expect(response.status).toBe(402);
    expect(body.error).toBe(
      "SubQ Snap has no credit left on this account. Add credit, then try again.",
    );
  });

  it.each([401, 403])(
    "answers a %i from SubQ with a 502 that blames the key, not the browser",
    async (status) => {
      const { fetch } = jsonFetch(status, envelope("permission_error", "Access denied."));
      const { response, body, text } = await post(fetch);

      expect(response.status).toBe(502);
      expect(body.error).toBe("SubQ Snap rejected the API key.");
      expect(text).not.toContain(API_KEY);
    },
  );

  it("logs the provider and status without the key", async () => {
    const { fetch } = jsonFetch(200, threeTypesReplyWith("escalate"));
    const { handlerDeps } = await post(fetch);

    const [line] = handlerDeps.log.mock.calls[0] as [string];
    expect(line).toMatch(
      /^\[api\] decide provider="subq" primitive="noul" questions=1 status=200 latencyMs=\d+$/,
    );
  });
});

describe("the adapter object", () => {
  it("bundles the catalog descriptor with the three functions", () => {
    expect(subqAdapter.descriptor).toBe(subq);
    expect(subqAdapter.toWire).toBe(toWire);
    expect(subqAdapter.fromWire).toBe(fromWire);
    expect(subqAdapter.decide).toBe(decide);
  });

  it("ends with satisfies ProviderAdapter", () => {
    expect(subqSource.trimEnd()).toMatch(/\bsatisfies ProviderAdapter;$/);
  });

  it("imports nothing from the TypeSafe adapter", () => {
    expect(subqSource).not.toMatch(/from\s+["'][^"']*typesafe/);
  });
});
