// The fixtures are read with `import.meta.glob` and the source with `?raw`, both
// Vite features that Vitest serves. Their types come from `vite/client`, which the
// root tsconfig does not apply to the worker folder, so this file names it itself.
/// <reference types="vite/client" />

import { describe, expect, it, vi } from "vite-plus/test";
import type { DecisionRequest } from "../../src/decision/contract.ts";
import { choiceExample, noulExample, scoreExample } from "../../src/decision/examples.ts";
import { validateDecisionRequest } from "../../src/decision/validate.ts";
import type { ValidDecisionRequest } from "../../src/decision/validate.ts";
import { openai } from "../../src/providers/catalog.ts";
import type { ProviderKeys } from "../env.ts";
import { handle } from "../handler.ts";
import type { HandlerDeps } from "../handler.ts";
import { ProviderError } from "./adapter.ts";
import type { Fetch } from "./adapter.ts";
import { decisionReplySchema, errorEnvelopeSchema, warmReplySchema } from "./openai-schema.ts";
import { decide, fromWire, openaiAdapter, toWire } from "./openai.ts";
import type { OpenAiRequest } from "./openai.ts";
import openaiSource from "./openai.ts?raw";

/** One file in `fixtures/openai/`, as `scripts/probe/fixtures.mjs` records an exchange. */
type Recorded = {
  request: { method: string; url: string; body?: unknown };
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

/** The recorded success body: the answers list is all the tests reshape. */
type RecordedReply = { model: string; answers: { name: string }[]; usage: unknown };

/** The recorded request body of a decision exchange. */
type RecordedRequest = { model: string; input: unknown; questions: { name: string }[] };

/** Every recorded exchange, keyed by file name. */
const fixtures = import.meta.glob<Recorded>("./fixtures/openai/*.json", {
  eager: true,
  import: "default",
});

function fixture(name: string): Recorded {
  const recorded = fixtures[`./fixtures/openai/${name}.json`];
  if (recorded === undefined) throw new Error(`No fixture named ${name}.`);
  return recorded;
}

/** The recorded reply body with only the named answers kept, so a one-primitive request can read it. */
function replyWith(name: string, ...kept: string[]): RecordedReply {
  const body = structuredClone(fixture(name).body) as RecordedReply;
  return { ...body, answers: body.answers.filter((answer) => kept.includes(answer.name)) };
}

function recordedRequest(name: string): RecordedRequest {
  return fixture(name).request.body as RecordedRequest;
}

const PINNED_MODEL = "gpt-6-luna";

/** A key that must never appear in an error. Its shape mirrors a real one without being one. */
const API_KEY = "sk-test-0123456789abcdef-never-logged";

/** The state every recorded decision exchange sent. */
const STATE =
  "Patient with asthma reports a sore throat, fever since yesterday, and shortness of breath walking to the kitchen this morning.";

/** The neutral request behind the recorded `escalate` predicate question. */
const noulRequest: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: STATE,
  questions: {
    escalate: { instructions: "Should a nurse see this chat before the patient books anything?" },
  },
};

/** The neutral request behind the recorded `queue` choice question. */
const choiceRequest: DecisionRequest<"choice"> = {
  primitive: "choice",
  state: STATE,
  questions: {
    queue: {
      instructions: "Which team should own this chat?",
      criteria: {
        nurse_line: "Needs a nurse to assess symptoms today",
        primary_care: "Book with the patient's own doctor",
        pharmacy: "Refill or medication question only",
        front_desk: null,
      },
    },
  },
};

/** The neutral request behind the recorded `acuity` score question. */
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

/** The neutral request behind the recorded image exchanges; the test adds the state and the image. */
const imageRequest: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: "The attached image is the only evidence.",
  questions: { red: { instructions: "Is the image mostly red?" } },
};

/** The neutral request behind the recorded `score-<count>-levels` exchanges. */
function levelsRequest(count: number): DecisionRequest<"score"> {
  const rest = Array.from({ length: count - 2 }, (_, index) => `Level ${index + 2}`);
  return {
    primitive: "score",
    state: STATE,
    questions: {
      acuity: {
        instructions: "How soon should someone respond? Level 0 is the least urgent.",
        criteria: ["Level 0", "Level 1", ...rest],
      },
    },
  };
}

/** A 2xx reply to `POST /v1/decisions`. */
function isDecisionReply(recorded: Recorded): boolean {
  return recorded.status < 300 && recorded.request.url.endsWith("/v1/decisions");
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

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
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

/** OpenAI's error envelope, as the fixtures record it. */
function envelope(
  type: string,
  message: string,
  fields: { code?: string | null; param?: string | null } = {},
) {
  return { error: { message, type, param: fields.param ?? null, code: fields.code ?? null } };
}

const liveSignal = () => new AbortController().signal;

/** The key is never a concern of `toWire`, so a plain validated request suffices. */
function valid(request: DecisionRequest): ValidDecisionRequest {
  const validation = validateDecisionRequest(request, openai.capabilities);
  if (!validation.ok) throw new Error(`The request is not valid: ${validation.error}`);
  return validation.value;
}

describe("toWire", () => {
  it("pins the model to the catalog's gpt-6-luna, which the fixtures were also recorded with", () => {
    const wire = toWire(noulRequest);
    expect(wire.model).toBe(PINNED_MODEL);
    expect(wire.model).toBe(openai.model);
    expect(recordedRequest("three-types").model).toBe(PINNED_MODEL);
  });

  it("turns a Yes/no question with criteria into a predicate with both meanings appended", () => {
    const wire = toWire({
      primitive: "noul",
      state: "s",
      questions: {
        escalate: { instructions: "Is it urgent?", criteria: { true: "A", false: "B" } },
      },
    });
    expect(wire.questions).toStrictEqual([
      {
        type: "predicate",
        name: "escalate",
        instructions: "Is it urgent?\n\nYes means: A\nNo means: B",
      },
    ]);
  });

  it.each([
    ["only a yes meaning", { true: "A" }, "Is it urgent?\n\nYes means: A"],
    ["only a no meaning", { false: "B" }, "Is it urgent?\n\nNo means: B"],
    ["an empty criteria object", {}, "Is it urgent?"],
    ["no criteria", undefined, "Is it urgent?"],
  ] as const)("appends %s as given", (_name, criteria, instructions) => {
    const wire = toWire({
      primitive: "noul",
      state: "s",
      questions: {
        q:
          criteria === undefined
            ? { instructions: "Is it urgent?" }
            : { instructions: "Is it urgent?", criteria },
      },
    });
    expect(wire.questions[0]).toStrictEqual({ type: "predicate", name: "q", instructions });
  });

  it.each([
    ["an empty yes meaning", { true: "", false: "B" }, "Is it urgent?\n\nNo means: B"],
    ["a whitespace no meaning", { true: "A", false: "  \n " }, "Is it urgent?\n\nYes means: A"],
    ["two blank meanings", { true: " ", false: "" }, "Is it urgent?"],
  ] as const)("skips %s, so no dangling meaning line is sent", (_name, criteria, instructions) => {
    const wire = toWire({
      primitive: "noul",
      state: "s",
      questions: { q: { instructions: "Is it urgent?", criteria } },
    });
    expect(wire.questions[0]).toStrictEqual({ type: "predicate", name: "q", instructions });
  });

  it("gives a Yes/no question the request default meanings unless it has its own", () => {
    const wire = toWire({
      primitive: "noul",
      state: "s",
      criteria: { true: "Default yes", false: "Default no" },
      questions: {
        inherits: { instructions: "One?" },
        own: { instructions: "Two?", criteria: { true: "Own yes" } },
      },
    });
    expect(wire.questions.map((question) => question.instructions)).toEqual([
      "One?\n\nYes means: Default yes\nNo means: Default no",
      "Two?\n\nYes means: Own yes",
    ]);
  });

  it("writes a structured state, instructions, or meaning as JSON text", () => {
    const wire = toWire({
      primitive: "noul",
      state: { review: "Go see it." },
      questions: {
        q: { instructions: ["Does", "it", "recommend?"], criteria: { true: { tone: "positive" } } },
      },
    });
    expect(wire.input).toBe('{"review":"Go see it."}');
    expect(wire.questions[0]?.instructions).toBe(
      '["Does","it","recommend?"]\n\nYes means: {"tone":"positive"}',
    );
  });

  it("turns a Choice question's criteria map into choices, leaving a null description out", () => {
    const wire = toWire({
      primitive: "choice",
      state: "s",
      criteria: { nurse_line: "Needs a nurse today", front_desk: null },
      questions: {
        queue: { instructions: "Which team?" },
        own: { instructions: "Which team now?", criteria: { a: ["list", "form"], b: null } },
      },
    });
    expect(wire.questions).toStrictEqual([
      {
        type: "choice",
        name: "queue",
        instructions: "Which team?",
        choices: [
          { value: "nurse_line", description: "Needs a nurse today" },
          { value: "front_desk" },
        ],
      },
      {
        type: "choice",
        name: "own",
        instructions: "Which team now?",
        choices: [{ value: "a", description: '["list","form"]' }, { value: "b" }],
      },
    ]);
  });

  it("labels a string level with itself and any other level by its index", () => {
    const wire = toWire({
      primitive: "score",
      state: "s",
      questions: {
        acuity: { instructions: "How soon?", criteria: ["Low", { tier: "mid" }, null] },
      },
    });
    expect(wire.questions).toStrictEqual([
      {
        type: "score",
        name: "acuity",
        instructions: "How soon?",
        levels: [
          { label: "Low" },
          { label: "Level 1", description: '{"tier":"mid"}' },
          { label: "Level 2" },
        ],
      },
    ]);
  });

  it("keeps every label unique and non-blank, so OpenAI sees one label per level", () => {
    const wire = toWire({
      primitive: "score",
      state: "s",
      questions: {
        acuity: {
          instructions: "How soon?",
          criteria: ["Level 1", { x: 1 }, "Low", "Low", "", "   ", "Low"],
        },
      },
    });
    const [question] = wire.questions;
    if (question?.type !== "score") throw new Error("Expected a score question.");
    expect(question.levels).toStrictEqual([
      { label: "Level 1" },
      // The index label collides with the string level before it, so the index is appended.
      { label: "Level 1 (1)", description: '{"x":1}' },
      { label: "Low" },
      { label: "Low (3)" },
      { label: "Level 4" },
      { label: "Level 5" },
      { label: "Low (6)" },
    ]);
    const labels = question.levels.map((level) => level.label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.every((label) => label.trim() !== "")).toBe(true);
  });

  it("gives a Score question the request default levels unless it has its own", () => {
    const wire = toWire({
      primitive: "score",
      state: "s",
      criteria: ["Cold", "Hot"],
      questions: {
        inherits: { instructions: "One?" },
        own: { instructions: "Two?", criteria: ["Slow", "Fast"] },
      },
    });
    expect(wire.questions.map((question) => "levels" in question && question.levels)).toEqual([
      [{ label: "Cold" }, { label: "Hot" }],
      [{ label: "Slow" }, { label: "Fast" }],
    ]);
  });

  it("rebuilds the three recorded questions and the recorded input", () => {
    const recorded = recordedRequest("three-types");
    expect(toWire(noulRequest).input).toBe(recorded.input);
    expect(toWire(noulRequest).questions).toStrictEqual([recorded.questions[0]]);
    expect(toWire(choiceRequest).questions).toStrictEqual([recorded.questions[1]]);
    expect(toWire(scoreRequest).questions).toStrictEqual([recorded.questions[2]]);
  });

  it("sends two images as one user message of a text part and two image parts", () => {
    const wire = toWire({
      ...noulRequest,
      images: [
        { mediaType: "image/png", base64: "AAAA" },
        { mediaType: "image/png", base64: "BBBB" },
      ],
    });
    expect(wire.input).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: STATE },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
          { type: "input_image", image_url: "data:image/png;base64,BBBB" },
        ],
      },
    ]);
    expect(wire.questions).toStrictEqual([recordedRequest("three-types").questions[0]]);
  });

  it.each([
    ["image-png-data-url", "image/png"],
    ["image-jpeg-data-url", "image/jpeg"],
  ])("rebuilds the recorded one-image request %s from its neutral form", (name, mediaType) => {
    const recorded = recordedRequest(name);
    const message = (
      recorded.input as { content: { type: string; text?: string; image_url?: string }[] }[]
    )[0];
    const [text, image] = message?.content ?? [];
    const prefix = `data:${mediaType};base64,`;
    const dataUrl = image?.image_url ?? "";
    expect(dataUrl.startsWith(prefix)).toBe(true);

    const wire = toWire({
      ...imageRequest,
      state: text?.text ?? "",
      images: [{ mediaType, base64: dataUrl.slice(prefix.length) }],
    });

    expect(wire).toStrictEqual(recorded);
  });

  it.each([2, 10])("rebuilds the recorded %i-level score request", (count) => {
    expect(toWire(levelsRequest(count))).toStrictEqual(recordedRequest(`score-${count}-levels`));
  });

  it("sends input as text when the images list is empty", () => {
    expect(toWire({ ...noulRequest, images: [] }).input).toBe(STATE);
  });

  it("sends only model, input, and questions", () => {
    expect(Object.keys(toWire(noulRequest)).sort()).toEqual(["input", "model", "questions"]);
  });
});

describe("fromWire", () => {
  it("turns the recorded predicate answer into a Noul answer and keeps two usage fields", () => {
    const decision = fromWire(noulRequest, replyWith("three-types", "escalate"));
    expect(decision).toStrictEqual({
      model: PINNED_MODEL,
      usage: { input_tokens: 436, output_tokens: 0 },
      answers: { escalate: { type: "noul", noul: 0.98 } },
    });
  });

  it("turns the recorded choice answer's probabilities list into a record keyed by value", () => {
    const decision = fromWire(choiceRequest, replyWith("three-types", "queue"));
    expect(decision.answers).toStrictEqual({
      queue: {
        type: "choice",
        choice: "nurse_line",
        confidence: 1,
        probabilities: { nurse_line: 1, primary_care: 0, pharmacy: 0, front_desk: 0 },
      },
    });
  });

  it("gives the recorded score answer a legend from the request's levels, keyed by index", () => {
    const decision = fromWire(scoreRequest, replyWith("three-types", "acuity"));
    expect(decision.answers).toStrictEqual({
      acuity: {
        type: "score",
        score: 1.9,
        confidence: 0.85,
        legend: { "0": "Within a week", "1": "Within a day", "2": "Within an hour" },
        probabilities: { "0": 0, "1": 0.1, "2": 0.9 },
      },
    });
  });

  it("keeps a structured or null level in the legend as the request gave it", () => {
    const request: DecisionRequest<"score"> = {
      ...scoreRequest,
      questions: {
        acuity: { instructions: "How soon?", criteria: ["Low", { tier: "mid" }, null] },
      },
    };
    const decision = fromWire(request, replyWith("three-types", "acuity"));
    expect(decision.answers.acuity).toMatchObject({
      legend: { "0": "Low", "1": { tier: "mid" }, "2": null },
    });
  });

  it("reads the recorded ten-level score answer", () => {
    const decision = fromWire(levelsRequest(10), fixture("score-10-levels").body);
    const answer = decision.answers.acuity;
    if (answer?.type !== "score") throw new Error("Expected a score answer.");
    expect(Object.keys(answer.probabilities)).toHaveLength(10);
    expect(answer.probabilities["1"]).toBe(0.63);
    expect(answer.legend["9"]).toBe("Level 9");
  });

  /**
   * A request of one known primitive. The generic `DecisionRequest` is wider
   * than the validated union, so the table names the three members instead.
   */
  type OnePrimitiveRequest =
    | DecisionRequest<"noul">
    | DecisionRequest<"choice">
    | DecisionRequest<"score">;

  /** Every recorded 2xx decision reply, with the neutral request that reads each of its answers. */
  const recordedReplies: [fixture: string, request: OnePrimitiveRequest, kept: string][] = [
    ["three-types", noulRequest, "escalate"],
    ["three-types", choiceRequest, "queue"],
    ["three-types", scoreRequest, "acuity"],
    ["three-types-after-models-list", noulRequest, "escalate"],
    ["three-types-after-models-list", choiceRequest, "queue"],
    ["three-types-after-models-list", scoreRequest, "acuity"],
    ["score-2-levels", levelsRequest(2), "acuity"],
    ["score-10-levels", levelsRequest(10), "acuity"],
    ["image-png-data-url", imageRequest, "red"],
    ["image-jpeg-data-url", imageRequest, "red"],
  ];

  it("has a request for every recorded 2xx decision reply", () => {
    const covered = new Set(recordedReplies.map(([name]) => name));
    const recorded = Object.keys(fixtures)
      .map((path) => path.slice("./fixtures/openai/".length, -5))
      .filter((name) => isDecisionReply(fixture(name)));
    expect(recorded.sort()).toEqual([...covered].sort());
  });

  it.each(recordedReplies)(
    "reads the recorded %s reply with a request for %o, answer %s",
    (name, request, kept) => {
      const decision = fromWire(request, replyWith(name, kept));
      expect(Object.keys(decision.answers)).toEqual([kept]);
      const answer = decision.answers[kept];
      expect(answer?.type).toBe(request.primitive);
      expect(decision.model).toBe(PINNED_MODEL);
      expect(decision.usage.output_tokens).toBe(0);
    },
  );

  it("returns the answers in the request's order, whatever order the reply used", () => {
    const request: DecisionRequest<"noul"> = {
      ...noulRequest,
      questions: {
        ...noulRequest.questions,
        urgent: { instructions: "Is it urgent?" },
        later: { instructions: "Can it wait?" },
      },
    };
    const body = {
      ...replyWith("three-types"),
      answers: [
        { type: "predicate", name: "later", probability: 0.1 },
        { type: "predicate", name: "escalate", probability: 0.98 },
        { type: "predicate", name: "urgent", probability: 0.5 },
      ],
    };
    expect(Object.keys(fromWire(request, body).answers)).toEqual(["escalate", "urgent", "later"]);
  });

  it.each([
    ["choice", choiceRequest, "queue"],
    ["score", scoreRequest, "acuity"],
  ] as const)("passes a synthetic refusal through for a %s question", (_name, request, id) => {
    const body = { ...replyWith("three-types"), answers: [{ type: "refusal", name: id }] };
    expect(fromWire(request, body).answers).toStrictEqual({ [id]: { type: "refusal" } });
  });

  it("passes a synthetic refusal through and leaves the other answers intact", () => {
    // No recorded fixture holds a refusal, so this one is written by hand from the guide's shape.
    const request: DecisionRequest<"noul"> = {
      ...noulRequest,
      questions: { ...noulRequest.questions, urgent: { instructions: "Is it urgent?" } },
    };
    const body = {
      ...replyWith("three-types", "escalate"),
      answers: [
        { type: "refusal", name: "urgent" },
        { type: "predicate", name: "escalate", probability: 0.98 },
      ],
    };
    expect(fromWire(request, body).answers).toStrictEqual({
      urgent: { type: "refusal" },
      escalate: { type: "noul", noul: 0.98 },
    });
  });

  it("strips fields the schema does not know", () => {
    const body = structuredClone(fixture("three-types").body) as {
      usage: Record<string, unknown>;
      answers: Record<string, unknown>[];
    };
    const [escalate] = body.answers;
    const decision = fromWire(noulRequest, {
      ...body,
      request_id: "abc",
      answers: [{ ...escalate, debug: "trace" }],
    });
    expect(decision).toStrictEqual({
      model: PINNED_MODEL,
      usage: { input_tokens: 436, output_tokens: 0 },
      answers: { escalate: { type: "noul", noul: 0.98 } },
    });
    // The recording carried more usage fields than the contract keeps.
    expect(Object.keys(body.usage).sort()).toEqual([
      "input_tokens",
      "input_tokens_details",
      "output_tokens",
      "output_tokens_details",
      "total_tokens",
    ]);
  });

  it("rejects an answer whose name is not in the request, naming the stray name", () => {
    const body = {
      ...replyWith("three-types"),
      answers: [{ type: "predicate", name: "stray", probability: 0.5 }],
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe('answers.0.name: no question named "stray"');
    expect(error.message).toBe("OpenAI Decisions answered in a shape this app cannot read.");
  });

  it("rejects a second answer for the same question", () => {
    const body = {
      ...replyWith("three-types"),
      answers: [
        { type: "predicate", name: "escalate", probability: 0.5 },
        { type: "predicate", name: "escalate", probability: 0.6 },
      ],
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe('answers.1.name: a second answer for question "escalate"');
  });

  it("rejects a reply that leaves a question unanswered", () => {
    const error = failure(() => fromWire(noulRequest, replyWith("three-types")));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe('answers: no answer for question "escalate"');
  });

  it("rejects an answer for a primitive the request did not ask", () => {
    const body = {
      ...replyWith("three-types", "queue"),
      answers: replyWith("three-types", "queue").answers.map((answer) => ({
        ...answer,
        name: "escalate",
      })),
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe(
      'answers.0.type: expected "predicate" or "refusal", received "choice"',
    );
  });

  it("rejects a choice answer without confidence, which the contract requires", () => {
    const body = replyWith("three-types", "queue");
    const [queue] = body.answers as { confidence?: number }[];
    delete queue?.confidence;
    const error = failure(() => fromWire(choiceRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("answers.0.confidence: expected number, received undefined");
  });

  it("rejects an unknown answer type as upstream, at the discriminator", () => {
    const body = {
      ...replyWith("three-types"),
      answers: [{ type: "mystery", name: "escalate", value: 1 }],
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toMatch(/^answers\.0\.type: /);
  });

  it("rejects an answer without a name at its path", () => {
    const body = {
      ...replyWith("three-types"),
      answers: [{ type: "predicate", name: null, probability: 0.5 }],
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.detail).toBe("answers.0.name: expected string, received null");
  });

  it("rejects a deliberately broken copy of the fixture at its dot path", () => {
    const broken = structuredClone(fixture("three-types").body) as {
      answers: { probabilities?: { probability: unknown }[] }[];
    };
    const acuity = broken.answers[2];
    if (acuity?.probabilities?.[1] === undefined) throw new Error("The fixture changed shape.");
    acuity.probabilities[1].probability = "0.1";
    const error = failure(() => fromWire(scoreRequest, broken));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe(
      "answers.2.probabilities.1.probability: expected number, received string",
    );
  });

  it("rejects a body that is not an object at the body itself", () => {
    expect(failure(() => fromWire(noulRequest, "not json")).detail).toBe(
      "body: expected object, received string",
    );
    expect(failure(() => fromWire(noulRequest, null)).detail).toBe(
      "body: expected object, received null",
    );
  });

  it("truncates a provider-supplied name in the detail to about 300 characters", () => {
    const body = {
      ...replyWith("three-types"),
      answers: [{ type: "predicate", name: "x".repeat(1000), probability: 0.5 }],
    };
    const error = failure(() => fromWire(noulRequest, body));
    expect(error.detail?.length).toBeLessThan(360);
    expect(error.detail).toMatch(/^answers\.0\.name: no question named "x{10}/);
    expect(error.detail).toMatch(/…"$/);
  });
});

describe("the schemas against every recorded fixture", () => {
  const names = Object.keys(fixtures).map((path) => path.slice("./fixtures/openai/".length, -5));

  /** Which schema a recorded exchange is checked with; exactly one must claim each file. */
  const selectors = {
    error: { matches: (recorded: Recorded) => recorded.status >= 300, schema: errorEnvelopeSchema },
    warm: {
      matches: (recorded: Recorded) =>
        recorded.status < 300 && recorded.request.url.includes("/v1/models"),
      schema: warmReplySchema,
    },
    decision: { matches: isDecisionReply, schema: decisionReplySchema },
  };

  it("has recorded exchanges, each claimed by exactly one selector", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const claimed = Object.values(selectors).filter((selector) =>
        selector.matches(fixture(name)),
      );
      expect(claimed, name).toHaveLength(1);
    }
  });

  it.each(names)("parses %s with the schema its selector picks", (name) => {
    const recorded = fixture(name);
    const selector = Object.values(selectors).find((candidate) => candidate.matches(recorded));
    if (selector === undefined) throw new Error(`No selector claims ${name}.`);
    expect(selector.schema.safeParse(recorded.body).success).toBe(true);
  });

  it("parses the catalog's warm path reply as a single model", () => {
    const { request, body } = fixture("models-retrieve");
    expect(request.url).toBe(`${openai.baseUrl}${openai.warmPath}`);
    expect(warmReplySchema.safeParse(body)).toMatchObject({
      success: true,
      data: { id: PINNED_MODEL, object: "model" },
    });
  });

  it("fails a broken copy of the error envelope at its path", () => {
    const broken = structuredClone(fixture("bad-key").body) as { error: { message?: string } };
    delete broken.error.message;
    const result = errorEnvelopeSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["error", "message"]);
  });
});

describe("decide", () => {
  it("posts the wire request to /v1/decisions with the injected fetch and the key in the header", async () => {
    const body = replyWith("three-types", "escalate");
    const { fetch, calls } = jsonFetch(200, body);
    const signal = liveSignal();
    const decision = await decide(noulRequest, API_KEY, signal, fetch);

    expect(decision).toStrictEqual(fromWire(noulRequest, body));
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe("https://api.openai.com/v1/decisions");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.signal).toBe(signal);
    // A redirect would carry the key header to another host, so none is followed.
    expect(call?.init.redirect).toBe("error");
    expect(call?.init.headers).toStrictEqual({
      accept: "application/json",
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(call?.init.body as string)).toStrictEqual(toWire(noulRequest));
  });

  it("maps the recorded 401 to auth by its status, because OpenAI sends code null", async () => {
    const recorded = fixture("bad-key");
    expect(recorded.body).toMatchObject({ error: { code: null, param: null } });
    const { fetch } = jsonFetch(recorded.status, recorded.body);
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("auth");
    expect(error.message).toBe("OpenAI Decisions rejected the API key.");
    expect(error.detail).toBe("401 invalid_request_error: A valid API key is required.");
    expectNoKey(error);
  });

  it("maps the recorded 400 to invalid_request, with the code and param in the detail", async () => {
    const recorded = fixture("score-11-levels");
    const { fetch } = jsonFetch(recorded.status, recorded.body);
    const error = await rejection(decide(scoreRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("invalid_request");
    expect(error.detail).toMatch(
      /^400 invalid_request_error array_above_max_length at questions\[0\]\.levels: Invalid 'questions\[0\]\.levels': array too long\./,
    );
  });

  it.each([
    [
      "code insufficient_quota",
      envelope("insufficient_quota", "Out of credit.", { code: "insufficient_quota" }),
    ],
    ["type insufficient_quota", envelope("insufficient_quota", "Out of credit.")],
    [
      "code credit_balance_exhausted",
      envelope("billing_error", "Your credit balance is exhausted.", {
        code: "credit_balance_exhausted",
      }),
    ],
  ])("maps a 429 with %s to no_credits", async (_name, body) => {
    const { fetch } = jsonFetch(429, body, { "retry-after": "7" });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("no_credits");
    expect(error.message).toBe(
      "OpenAI Decisions has no credit left on this account. Add credit, then try again.",
    );
    expect(error.detail).toMatch(/^429 /);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("keeps a 429 with code slow_down as rate_limited carrying Retry-After", async () => {
    const { fetch } = jsonFetch(
      429,
      envelope("rate_limit_error", "Slow down.", { code: "slow_down" }),
      { "retry-after": "7" },
    );
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.message).toBe(
      "OpenAI Decisions is rate limiting requests. Wait 7 seconds and try again.",
    );
    expect(error.detail).toBe("429 rate_limit_error slow_down: Slow down.");
  });

  it("maps a 402 to no_credits", async () => {
    const { fetch } = jsonFetch(402, envelope("billing_error", "Payment required."));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("no_credits");
    expect(error.detail).toBe("402 billing_error: Payment required.");
  });

  it("maps a 403 whose message names the region block to upstream, worded as such", async () => {
    // Synthetic: the error guide lists "Country, region, or territory not supported" under
    // 403 without a code, and no fixture holds one, so the message is matched, not a code.
    const { fetch } = jsonFetch(
      403,
      envelope("request_forbidden", "Country, region, or territory not supported"),
    );
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("upstream");
    expect(error.message).toBe(
      "OpenAI Decisions does not serve the country or region this server runs in, so it refused the request.",
    );
    expect(error.detail).toBe("403 request_forbidden: Country, region, or territory not supported");
  });

  it("keeps a 403 for a key missing a scope as auth with the default wording", async () => {
    const { fetch } = jsonFetch(
      403,
      envelope("invalid_request_error", "You have insufficient permissions for this operation.", {
        code: "insufficient_permissions",
      }),
    );
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("auth");
    expect(error.message).toBe("OpenAI Decisions rejected the API key.");
    expect(error.detail).toBe(
      "403 invalid_request_error insufficient_permissions: You have insufficient permissions for this operation.",
    );
  });

  it("keeps a 403 whose body is not the envelope as auth, described by its status", async () => {
    const { fetch } = stubFetch(403, "<html>Forbidden</html>", { "content-type": "text/html" });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("auth");
    expect(error.message).toBe("OpenAI Decisions rejected the API key.");
    expect(error.detail).toBe("403");
  });

  it.each([
    "organization_spend_limit_exceeded",
    "project_spend_limit_exceeded",
    "organization_usage_limit_exceeded",
  ])("maps a 429 with code %s to no_credits with spend-limit wording", async (code) => {
    const { fetch } = jsonFetch(429, envelope("insufficient_quota", "Limit reached.", { code }), {
      "retry-after": "7",
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("no_credits");
    expect(error.message).toBe(
      "OpenAI Decisions refused the request because this project or organisation reached its spend limit. Raise the limit, then try again.",
    );
    expect(error.detail).toBe(`429 insufficient_quota ${code}: Limit reached.`);
    expect(error.retryAfterSeconds).toBeUndefined();
  });

  it("keeps a 429 with code rate_limit_exceeded as rate_limited carrying Retry-After", async () => {
    const { fetch } = jsonFetch(
      429,
      envelope("rate_limit_error", "Rate limit reached for requests.", {
        code: "rate_limit_exceeded",
      }),
      { "retry-after": "12" },
    );
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.message).toContain("Wait 12 seconds");
  });

  it("truncates the envelope message in the detail to about 300 characters", async () => {
    const { fetch } = jsonFetch(500, envelope("server_error", "y".repeat(1000)));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.detail?.length).toBeLessThan(330);
    expect(error.detail).toMatch(/^500 server_error: y{10}/);
    expect(error.detail).toContain("…");
  });

  it("maps a 413 to invalid_request with wording about the images", async () => {
    const { fetch } = stubFetch(413, "<html>Request Entity Too Large</html>", {
      "content-type": "text/html",
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.kind).toBe("invalid_request");
    expect(error.message).toBe(
      "OpenAI Decisions refused the request as too large. Remove or shrink the images and try again.",
    );
    expect(error.detail).toBe("413");
  });

  it.each([
    [400, "invalid_request"],
    [404, "upstream"],
    [500, "upstream"],
    [503, "upstream"],
  ] as const)("maps a %i to %s", async (status, kind) => {
    const { fetch } = jsonFetch(status, envelope("some_error", "Something."));
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe(kind);
    expect(error.detail).toBe(`${status} some_error: Something.`);
    expect(error.message).toContain("OpenAI Decisions");
  });

  it("reports a failed status whose body is not the envelope by its status alone", async () => {
    const { fetch } = stubFetch(502, "<html>Bad gateway</html>", { "content-type": "text/html" });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("502");
  });

  it("redacts the key when the provider's error message quotes it", async () => {
    const { fetch } = jsonFetch(
      401,
      envelope("invalid_request_error", `Incorrect API key provided: ${API_KEY}.`),
    );
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));

    expect(error.detail).toBe("401 invalid_request_error: Incorrect API key provided: [redacted].");
    expectNoKey(error);
  });

  it("maps a success whose schema fails to upstream with the dot path", async () => {
    const { fetch } = jsonFetch(200, {
      model: PINNED_MODEL,
      answers: [],
      usage: { input_tokens: 1 },
    });
    const error = await rejection(decide(noulRequest, API_KEY, liveSignal(), fetch));
    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("usage.output_tokens: expected number, received undefined");
  });
});

describe("through POST /api/decide/openai", () => {
  const OPENAI_KEY = "sk-route-test-0123456789abcdef";
  const env: ProviderKeys = { OPENAI_API_KEY: OPENAI_KEY };

  function deps(fetch: Fetch): HandlerDeps {
    return { fetch, timeoutSignal: () => new AbortController().signal, log: vi.fn() };
  }

  function post(request: DecisionRequest): Request {
    return new Request("https://decisionmachines3000.example/api/decide/openai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  it("answers a configured OpenAI with a decision, not a 501", async () => {
    const { fetch, calls } = jsonFetch(200, replyWith("three-types", "escalate"));
    const response = await handle(post(noulRequest), env, deps(fetch));
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      primitive: "noul",
      provider: "openai",
      model: PINNED_MODEL,
      usage: { input_tokens: 436, output_tokens: 0 },
      answers: { escalate: { type: "noul", noul: 0.98 } },
      wire: {
        request: { model: PINNED_MODEL, questions: [{ type: "predicate", name: "escalate" }] },
      },
    });
    expect(calls).toHaveLength(1);
    expect(text).not.toContain(OPENAI_KEY);
  });

  it("answers 402 for a 429 with code credit_balance_exhausted", async () => {
    const { fetch } = jsonFetch(
      429,
      envelope("billing_error", "Your credit balance is exhausted.", {
        code: "credit_balance_exhausted",
      }),
    );
    const response = await handle(post(noulRequest), env, deps(fetch));
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("no credit left"),
    });
  });

  it("answers 402 for a 429 with code project_spend_limit_exceeded", async () => {
    const { fetch } = jsonFetch(
      429,
      envelope("insufficient_quota", "Limit reached.", { code: "project_spend_limit_exceeded" }),
    );
    const response = await handle(post(noulRequest), env, deps(fetch));
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("spend limit"),
    });
  });

  it("answers 429 with Retry-After for a 429 with code slow_down", async () => {
    const { fetch } = jsonFetch(
      429,
      envelope("rate_limit_error", "Slow down.", { code: "slow_down" }),
      { "retry-after": "7" },
    );
    const response = await handle(post(noulRequest), env, deps(fetch));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
  });
});

describe("the browser examples", () => {
  it.each([
    ["noul", noulExample, "predicate"],
    ["choice", choiceExample, "choice"],
    ["score", scoreExample, "score"],
  ] as const)(
    "translate the %s example to one wire question of type %s each",
    (_name, example, type) => {
      const wire: OpenAiRequest = toWire(valid(example));
      expect(wire.questions).toHaveLength(Object.keys(example.questions).length);
      expect(wire.questions.every((question) => question.type === type)).toBe(true);
      expect(typeof wire.input).toBe("string");
    },
  );

  it("appends the Noul example's one set of meanings to that question alone", () => {
    const wire = toWire(valid(noulExample));
    const withMeanings = wire.questions.filter((question) =>
      question.instructions.includes("\n\nYes means: "),
    );
    expect(withMeanings.map((question) => question.name)).toEqual(["saw_in_theater"]);
    expect(withMeanings[0]?.instructions).toMatch(/\nNo means: The review describes home viewing/);
  });

  it("sends the Score example's four levels, within OpenAI's maximum of ten", () => {
    const wire = toWire(valid(scoreExample));
    const [first] = wire.questions;
    if (first?.type !== "score") throw new Error("Expected a score question.");
    expect(first.levels).toHaveLength(4);
    expect(openai.capabilities.scoreLevels).toEqual({ min: 2, max: 10 });
  });
});

describe("the adapter object", () => {
  it("bundles the catalog descriptor with the three functions", () => {
    expect(openaiAdapter.descriptor).toBe(openai);
    expect(openaiAdapter.toWire).toBe(toWire);
    expect(openaiAdapter.fromWire).toBe(fromWire);
    expect(openaiAdapter.decide).toBe(decide);
  });

  it("ends with satisfies ProviderAdapter", () => {
    expect(openaiSource.trimEnd()).toMatch(/\bsatisfies ProviderAdapter;$/);
  });
});

/** The key must not appear in anything the error carries or prints. */
function expectNoKey(error: ProviderError) {
  expect(error.message).not.toContain(API_KEY);
  expect(error.detail ?? "").not.toContain(API_KEY);
  expect(JSON.stringify(error)).not.toContain(API_KEY);
}
