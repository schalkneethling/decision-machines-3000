import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Primitive } from "../src/decision/contract.ts";
import { examples } from "../src/decision/examples.ts";
import { jevApiPlugin, toContractAnswers } from "./jev-api.ts";

/*
 * Drives the real middleware, validation included, with the SDK call stubbed so
 * no network or API key is involved. Varlock is stubbed because the real module
 * reads the key from 1Password.
 */

vi.mock("varlock/env", () => ({ ENV: { TYPESAFE_API_KEY: "test-key" } }));

const stubAnswers: Record<Primitive, unknown> = {
  noul: { type: "noul", noul: 0.9 },
  choice: {
    type: "choice",
    choice: "a",
    confidence: 0.8,
    probabilities: { a: 0.8, b: 0.2 },
  },
  score: {
    type: "score",
    score: 1,
    confidence: 0.7,
    legend: { "0": "low", "1": "high" },
    probabilities: { "0": 0.3, "1": 0.7 },
  },
};

let currentPrimitive: Primitive = "noul";
/** What the stubbed SDK call received on its latest call. */
let received: { state: unknown; questions: Record<string, { type: string; criteria?: unknown }> };

vi.mock("@typesafe-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@typesafe-ai/sdk")>();
  class StubClient {
    baseURL = "https://api.typesafe.test";
    async systemOne(params: { state: unknown; questions: typeof received.questions }) {
      received = { state: params.state, questions: params.questions };
      const answers: Record<string, unknown> = {};
      for (const id of Object.keys(params.questions)) answers[id] = stubAnswers[currentPrimitive];
      return { model: "stub-1", usage: { input_tokens: 1, output_tokens: 1 }, answers };
    }
  }
  return { ...actual, TypeSafeClient: StubClient };
});

type Captured = { status: number; body: unknown };
type Middleware = (req: never, res: never, next: () => void) => void;

function post(body: unknown): Promise<Captured> {
  let middleware: Middleware | undefined;
  const configure = jevApiPlugin().configureServer as (server: unknown) => void;
  configure({
    middlewares: {
      use: (fn: Middleware) => {
        middleware = fn;
      },
    },
    httpServer: null,
  });

  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method: "POST",
    url: "/api/jev",
    headers: { "content-type": "application/json" },
  });
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      setHeader() {},
      end(payload: string) {
        resolve({ status: this.statusCode, body: JSON.parse(payload) });
      },
    };
    middleware?.(req as never, res as never, () => reject(new Error("Request was not handled.")));
  });
}

type ExampleRequest = {
  state: unknown;
  criteria?: unknown;
  questions: Record<string, { criteria?: unknown }>;
};

describe("POST /api/jev", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const primitive of ["noul", "choice", "score"] as const) {
    it(`answers the ${primitive} example in the contract shape`, async () => {
      currentPrimitive = primitive;
      vi.spyOn(console, "info").mockImplementation(() => {});
      const { status, body } = await post(examples[primitive]);
      expect(status).toBe(200);
      const sent: ExampleRequest = examples[primitive];
      expect(body).toEqual({
        ok: true,
        primitive,
        model: "stub-1",
        usage: { input_tokens: 1, output_tokens: 1 },
        latencyMs: expect.any(Number),
        connection: expect.any(String),
        keepAliveSeconds: expect.any(Number),
        answers: Object.fromEntries(
          Object.keys(sent.questions).map((id) => [id, stubAnswers[primitive]]),
        ),
      });

      // What reached the SDK must match what was posted.
      expect(Object.keys(received.questions)).toEqual(Object.keys(sent.questions));
      expect(received.state).toEqual(sent.state);
      for (const [id, question] of Object.entries(received.questions)) {
        expect(question.type).toBe(primitive);
        expect(question.criteria).toEqual(sent.questions[id]?.criteria ?? sent.criteria);
      }
    });
  }

  it("rejects an invalid request before calling the SDK", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { status, body } = await post({ ...examples.noul, primitive: "rank" });
    expect(status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: expect.stringContaining('Set "primitive" to'),
      detail: "primitive",
    });
  });
});

describe("toContractAnswers", () => {
  it("passes a refusal through", () => {
    expect(toContractAnswers({ q: { type: "refusal" } })).toEqual({ q: { type: "refusal" } });
  });

  it("fails loudly on an answer type it does not know", () => {
    const odd = JSON.parse('{"q": {"type": "mystery"}}');
    expect(() => toContractAnswers(odd)).toThrow(/unknown answer type for question "q"/);
  });
});
