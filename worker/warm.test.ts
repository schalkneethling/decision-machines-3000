import { describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import { decisionResponseSchema, warmResponseSchema } from "../src/decision/contract.ts";
import type { ConnectionKind, KeepAliveSeconds } from "../src/decision/contract.ts";
import { openai, subq, typesafe } from "../src/providers/catalog.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { ConnectionMetrics, HandlerDeps } from "./handler.ts";
import { MAX_WARM_BODY_BYTES, WARM_TIMEOUT_MS, WARM_UNAVAILABLE_MESSAGE, warmUrl } from "./warm.ts";

/*
 * The warm route and the connection fields, through `handle`, with a double
 * for the dev host's connection pool. The real pool is tested against a local
 * server in `server/connection.test.ts`, and the dev host's wiring of it in
 * `server/vite-host.test.ts`.
 */

const ORIGIN = "https://decisionmachines3000.example";

/** Keys whose shape mirrors a real one without being one. None may reach a response or a log. */
const KEYS: ProviderKeys = {
  TYPESAFE_API_KEY: "sk-warm-test-typesafe-0123456789",
  SUBQ_API_KEY: "sk-warm-test-subq-0123456789",
  OPENAI_API_KEY: "sk-warm-test-openai-0123456789",
};

type StubDeps = HandlerDeps & {
  fetch: Mock<typeof fetch>;
  timeoutSignal: Mock<(ms: number) => AbortSignal>;
  log: Mock<(line: string) => void>;
};

/** A connection pool double: it records each keep-alive change and tracked origin, and reports `kind`. */
function fakeConnections(kind: ConnectionKind = "new") {
  const tracked: string[] = [];
  const keepAlives: KeepAliveSeconds[] = [];
  let current: KeepAliveSeconds = 4;
  const connections: ConnectionMetrics = {
    get keepAliveSeconds() {
      return current;
    },
    setKeepAlive(seconds) {
      current = seconds;
      keepAlives.push(seconds);
    },
    track(origin) {
      tracked.push(origin);
      return { finish: () => kind };
    },
  };
  return { connections, tracked, keepAlives };
}

/** A provider that answers every call with one JSON reply. */
function upstreamReply(status: number, body: unknown): typeof fetch {
  return () => Promise.resolve(Response.json(body, { status }));
}

function stubDeps(
  fetch: typeof globalThis.fetch,
  connections: ConnectionMetrics | undefined,
): StubDeps {
  return {
    fetch: vi.fn(fetch),
    timeoutSignal: vi.fn((_ms: number) => new AbortController().signal),
    log: vi.fn((_line: string) => {}),
    ...(connections === undefined ? {} : { connections }),
  };
}

function post(path: string, body: string, contentType = "application/json"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

async function answer(request: Request, deps: StubDeps, env: ProviderKeys = KEYS) {
  const response = await handle(request, env, deps);
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

function keysIn(text: string): string[] {
  return Object.values(KEYS).filter((key) => key !== undefined && text.includes(key));
}

const warmBody = JSON.stringify({ keepAliveSeconds: 30 });

describe("GET /api/providers and the host's connection metrics", () => {
  it("says the Worker host reports no connection metrics", async () => {
    const { body } = await answer(
      new Request(`${ORIGIN}/api/providers`),
      stubDeps(upstreamReply(200, {}), undefined),
    );

    expect(body.host).toEqual({ connectionMetrics: false });
  });

  it("says a host with a connection pool reports connection metrics", async () => {
    const { body } = await answer(
      new Request(`${ORIGIN}/api/providers`),
      stubDeps(upstreamReply(200, {}), fakeConnections().connections),
    );

    expect(body.host).toEqual({ connectionMetrics: true });
  });

  it("says which providers can warm, without sending the warm path itself", async () => {
    const { body, text } = await answer(
      new Request(`${ORIGIN}/api/providers`),
      stubDeps(upstreamReply(200, {}), undefined),
    );

    expect(body.providers).toMatchObject([
      { id: "typesafe", canWarm: true },
      { id: "subq", canWarm: true },
      { id: "openai", canWarm: true },
    ]);
    expect(text).not.toContain("/v1/models");
  });
});

describe("POST /api/decide/{provider} and the connection it used", () => {
  const yesNo = {
    primitive: "noul",
    state: "Patient with asthma reports shortness of breath.",
    questions: { escalate: { instructions: "Should a nurse see this chat first?" } },
  };
  const recordedNoulReply = {
    model: "jev-1.13.0",
    answers: { escalate: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 343, output_tokens: 22 },
  };

  it("adds the connection and the keep-alive on a host with a connection pool", async () => {
    const pool = fakeConnections("reused");
    const deps = stubDeps(upstreamReply(200, recordedNoulReply), pool.connections);

    const { response, body } = await answer(
      post("/api/decide/typesafe", JSON.stringify(yesNo)),
      deps,
    );

    expect(response.status).toBe(200);
    expect(decisionResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ ok: true, connection: "reused", keepAliveSeconds: 4 });
    expect(pool.tracked).toEqual([typesafe.baseUrl]);
    expect(deps.log.mock.calls.flat().join("\n")).toContain('connection="reused"');
  });

  it("leaves both fields out on the Worker host", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply), undefined);

    const { body } = await answer(post("/api/decide/typesafe", JSON.stringify(yesNo)), deps);

    expect(body.ok).toBe(true);
    expect(body).not.toHaveProperty("connection");
    expect(body).not.toHaveProperty("keepAliveSeconds");
  });

  it("leaves both fields out of a failure, and still finishes tracking the call", async () => {
    const pool = fakeConnections("new");
    const deps = stubDeps(upstreamReply(500, { detail: "Oops." }), pool.connections);

    const { response, body } = await answer(
      post("/api/decide/typesafe", JSON.stringify(yesNo)),
      deps,
    );

    expect(response.status).toBe(502);
    expect(body).not.toHaveProperty("connection");
    expect(pool.tracked).toEqual([typesafe.baseUrl]);
  });
});

describe("POST /api/warm/{provider}", () => {
  it("answers 501 on the Worker host without calling any provider", async () => {
    const deps = stubDeps(upstreamReply(200, {}), undefined);

    const { response, body } = await answer(post("/api/warm/typesafe", warmBody), deps);

    expect(response.status).toBe(501);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ ok: false, error: WARM_UNAVAILABLE_MESSAGE });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each<[string, string, ProviderKeys]>([
    ["an unknown provider", "/api/warm/nobody", KEYS],
    ["a provider whose key is not set", "/api/warm/subq", { TYPESAFE_API_KEY: "t" }],
  ])(
    "answers 501 on the Worker host for %s, before looking the provider up",
    async (_name, path, env) => {
      const deps = stubDeps(upstreamReply(200, {}), undefined);

      const { response, body } = await answer(post(path, warmBody), deps, env);

      expect(response.status).toBe(501);
      expect(body).toEqual({ ok: false, error: WARM_UNAVAILABLE_MESSAGE });
    },
  );

  it("reports the keep-alive this request asked for, even if another request changed the pool's", async () => {
    const pool = fakeConnections();
    // A racing warm sets 60 while this one's call to the provider is in flight.
    const racedTo: KeepAliveSeconds = 60;
    const deps = stubDeps(() => {
      pool.connections.setKeepAlive(racedTo);
      return Promise.resolve(Response.json({}));
    }, pool.connections);

    const { body } = await answer(post("/api/warm/typesafe", warmBody), deps);

    expect(pool.keepAlives).toEqual([30, 60]);
    expect(body.keepAliveSeconds).toBe(30);
  });

  // The warm paths spike #2 confirmed: no tokens spent, and never OpenAI's full model list.
  it.each<[ProviderDescriptor, string]>([
    [typesafe, "https://api.typesafe.ai/v1/models"],
    [subq, "https://api.subq.ai/v1/models"],
    [openai, "https://api.openai.com/v1/models/gpt-6-luna"],
  ])("warms %s with one GET to %s through the host's fetch", async (provider, url) => {
    const pool = fakeConnections("new");
    const deps = stubDeps(upstreamReply(200, { object: "list", data: [] }), pool.connections);

    const { response, body, text } = await answer(post(`/api/warm/${provider.id}`, warmBody), deps);

    expect(response.status).toBe(200);
    expect(warmResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      ok: true,
      provider: provider.id,
      latencyMs: expect.any(Number),
      connection: "new",
      keepAliveSeconds: 30,
    });
    expect(pool.keepAlives).toEqual([30]);
    expect(pool.tracked).toEqual([provider.baseUrl]);
    expect(deps.fetch).toHaveBeenCalledOnce();
    const [input, init] = deps.fetch.mock.calls[0] ?? [];
    expect(input).toBe(url);
    expect(init).toMatchObject({ method: "GET", redirect: "error" });
    expect(deps.timeoutSignal).toHaveBeenCalledWith(WARM_TIMEOUT_MS);
    expect(keysIn(text)).toEqual([]);
    const log = deps.log.mock.calls.flat().join("\n");
    expect(log).toContain(`[api] warm provider="${provider.id}" status=200`);
    expect(log).toContain('connection="new"');
    expect(keysIn(log)).toEqual([]);
  });

  it("reports a reused connection when the pool reused one", async () => {
    const deps = stubDeps(upstreamReply(200, {}), fakeConnections("reused").connections);

    const { body } = await answer(post("/api/warm/typesafe", warmBody), deps);

    expect(body.connection).toBe("reused");
  });

  it("answers 404 for an unknown provider, before reading the body", async () => {
    const deps = stubDeps(upstreamReply(200, {}), fakeConnections().connections);

    const { response, body } = await answer(post("/api/warm/nobody", "not json"), deps);

    expect(response.status).toBe(404);
    expect(body.error).toBe('No provider is named "nobody". Use typesafe, subq, or openai.');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("answers 409, naming the variable, for a provider whose key is not set", async () => {
    const deps = stubDeps(upstreamReply(200, {}), fakeConnections().connections);

    const { response, body } = await answer(post("/api/warm/subq", warmBody), deps, {
      TYPESAFE_API_KEY: "t",
    });

    expect(response.status).toBe(409);
    expect(body.error).toBe(
      "SubQ Snap is not set up on this instance. Set SUBQ_API_KEY to use it.",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each<[string, Request, number]>([
    ["a body that is not JSON text", post("/api/warm/typesafe", warmBody, "text/plain"), 415],
    ["a body over the limit", post("/api/warm/typesafe", " ".repeat(MAX_WARM_BODY_BYTES + 1)), 413],
    ["a body that is not JSON", post("/api/warm/typesafe", "{"), 400],
    ["an empty body", post("/api/warm/typesafe", ""), 400],
    [
      "a keep-alive that is not offered",
      post("/api/warm/typesafe", JSON.stringify({ keepAliveSeconds: 5 })),
      400,
    ],
  ])("refuses %s with %i, leaving the keep-alive alone", async (_name, request, status) => {
    const pool = fakeConnections();
    const deps = stubDeps(upstreamReply(200, {}), pool.connections);

    const { response, body } = await answer(request, deps);

    expect(response.status).toBe(status);
    expect(body.ok).toBe(false);
    expect(pool.keepAlives).toEqual([]);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("answers a key the provider rejects with a 502 that keeps the key out", async () => {
    const pool = fakeConnections();
    const deps = stubDeps(
      upstreamReply(401, { error: { message: `Bad key ${KEYS.OPENAI_API_KEY ?? ""}` } }),
      pool.connections,
    );

    const { response, body, text } = await answer(post("/api/warm/openai", warmBody), deps);

    expect(response.status).toBe(502);
    expect(body).toEqual({
      ok: false,
      error: "OpenAI Decisions rejected the API key.",
      detail: "401",
    });
    expect(keysIn(text)).toEqual([]);
    const log = deps.log.mock.calls.flat().join("\n");
    expect(log).toContain('[api] warm provider="openai"');
    expect(log).toContain('kind="auth"');
    expect(keysIn(log)).toEqual([]);
    expect(pool.tracked).toEqual([openai.baseUrl]);
  });

  it("answers 502 when the provider cannot be reached", async () => {
    const deps = stubDeps(
      () => Promise.reject(new TypeError("fetch failed")),
      fakeConnections().connections,
    );

    const { response, body } = await answer(post("/api/warm/typesafe", warmBody), deps);

    expect(response.status).toBe(502);
    expect(body.error).toBe("Could not reach TypeSafe Jev. Check the connection and try again.");
  });

  it("answers 504, in words about warming, once its signal aborts", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const deps = stubDeps(
      (_input, init) => Promise.reject(init?.signal?.reason),
      fakeConnections().connections,
    );
    deps.timeoutSignal.mockReturnValue(controller.signal);

    const { response, body } = await answer(post("/api/warm/subq", warmBody), deps);

    expect(response.status).toBe(504);
    expect(body.error).toBe(
      "SubQ Snap did not answer the warming call within 10 seconds. Try again.",
    );
  });

  it("answers 405 for GET, naming POST", async () => {
    const deps = stubDeps(upstreamReply(200, {}), fakeConnections().connections);

    const response = await handle(new Request(`${ORIGIN}/api/warm/typesafe`), KEYS, deps);

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it.each(["/api/warm/", "/api/warm", "/api/warm/typesafe/extra"])(
    "answers %s with the JSON 404",
    async (path) => {
      const deps = stubDeps(upstreamReply(200, {}), fakeConnections().connections);

      const { response, body } = await answer(post(path, warmBody), deps);

      expect(response.status).toBe(404);
      expect(body).toEqual({ ok: false, error: "No API route matches this path." });
    },
  );
});

describe("warmUrl", () => {
  it("joins the base URL and the warm path", () => {
    expect(warmUrl(openai)).toBe("https://api.openai.com/v1/models/gpt-6-luna");
  });

  it("leads the route to answer 404, without calling the provider, when the descriptor declares no warm path", async () => {
    // Every catalog provider has a warm path today, so one is taken away for this test only.
    const saved = subq.warmPath;
    delete subq.warmPath;
    try {
      const deps = stubDeps(upstreamReply(200, {}), fakeConnections().connections);

      const { response, body } = await answer(post("/api/warm/subq", warmBody), deps);

      expect(response.status).toBe(404);
      expect(body.error).toBe("SubQ Snap has no call to warm a connection with.");
      expect(deps.fetch).not.toHaveBeenCalled();
    } finally {
      subq.warmPath = saved;
    }
  });

  it("is undefined for a descriptor that declares no warm path", () => {
    const { warmPath: _warmPath, ...withoutWarmPath } = typesafe;

    expect(warmUrl(withoutWarmPath)).toBeUndefined();
  });
});
