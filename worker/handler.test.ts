// Adapter sources are read with `?raw` through `import.meta.glob`, a Vite feature
// that Vitest serves. Its types come from `vite/client`, which the root tsconfig
// does not apply to the worker folder, so this file names it itself.
/// <reference types="vite/client" />

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import * as z from "zod/mini";
import { decisionResponseSchema } from "../src/decision/contract.ts";
import type { DecisionRequest } from "../src/decision/contract.ts";
import { validateDecisionRequest } from "../src/decision/validate.ts";
import type { ValidDecisionRequest } from "../src/decision/validate.ts";
import { openai, subq, typesafe } from "../src/providers/catalog.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import {
  IMAGE_ALLOWANCE_BYTES,
  MAX_BODY_BYTES,
  TEXT_ALLOWANCE_BYTES,
  TOO_LARGE_MESSAGE,
} from "./body-limit.ts";
import { PROVIDER_TIMEOUT_MS, wireRecord } from "./decide.ts";
import type { ImageAttachment } from "./decide.ts";
import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";
import type { ProviderAdapter } from "./providers/adapter.ts";
import { useEnglishZodMessages } from "./zod-locale.ts";

const ORIGIN = "https://decisionmachines3000.example";

type StubDeps = HandlerDeps & {
  fetch: Mock<typeof fetch>;
  timeoutSignal: Mock<(ms: number) => AbortSignal>;
  log: Mock<(line: string) => void>;
};

/**
 * Doubles for every dependency. By default `fetch` fails the test if a route
 * calls it unexpectedly, and the timeout signal never fires.
 */
function stubDeps(fetch: typeof globalThis.fetch = unexpectedFetch): StubDeps {
  return {
    fetch: vi.fn(fetch),
    timeoutSignal: vi.fn((_ms: number) => new AbortController().signal),
    log: vi.fn((_line: string) => {}),
  };
}

function unexpectedFetch(): Promise<Response> {
  return Promise.reject(new Error("deps.fetch was called."));
}

function get(path: string, init?: RequestInit): Request {
  return new Request(`${ORIGIN}${path}`, init);
}

async function run(request: Request, env: ProviderKeys) {
  const response = await handle(request, env, stubDeps());
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as unknown };
}

/** What the route answers for a descriptor: the public fields and nothing else. */
function summaryOf(descriptor: ProviderDescriptor) {
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    model: descriptor.model,
    capabilities: descriptor.capabilities,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/providers", () => {
  // The body equals the catalog summary exactly, so it holds no other field: no
  // key, key length, or key prefix. A substring search for "x" itself cannot work,
  // because the capabilities contain "max".
  it("lists a configured provider with exactly the catalog's summary", async () => {
    const { response, body } = await run(get("/api/providers"), { OPENAI_API_KEY: "x" });

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, providers: [summaryOf(openai)] });
  });

  it("never puts the key or its prefix in the body or the headers", async () => {
    const key = "sk-live-0123456789abcdef";
    const { response, text } = await run(get("/api/providers"), { OPENAI_API_KEY: key });

    expect(response.status).toBe(200);
    expect(text).not.toContain(key);
    expect(text).not.toContain("sk-");
    const headers = [...response.headers].flat().join("\n");
    expect(headers).not.toContain(key);
    expect(headers).not.toContain("sk-");
  });

  it("lists configured providers in catalog order", async () => {
    const { body } = await run(get("/api/providers"), {
      OPENAI_API_KEY: "o",
      TYPESAFE_API_KEY: "t",
    });

    expect(body).toEqual({ ok: true, providers: [summaryOf(typesafe), summaryOf(openai)] });
  });

  it("treats a key that only contains the placeholder as a real key", async () => {
    const { body } = await run(get("/api/providers"), { SUBQ_API_KEY: "unset-but-real" });

    expect(body).toEqual({ ok: true, providers: [summaryOf(subq)] });
  });

  it.each([
    ["an empty key", ""],
    ["a blank key", "   "],
    ["the placeholder", "unset"],
    ["the placeholder in capitals, padded", " UNSET "],
    ["the placeholder in mixed case", "Unset"],
  ])("treats %s as absent", async (_name, value) => {
    const absent = await run(get("/api/providers"), { OPENAI_API_KEY: value });
    const none = await run(get("/api/providers"), {});

    expect(absent.response.status).toBe(503);
    expect(absent.body).toEqual(none.body);
  });

  it("answers 503 with an error naming every key when none is set", async () => {
    const { response, body } = await run(get("/api/providers"), {});

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({ ok: false, error: expect.any(String) });
    const { error } = body as { error: string };
    expect(error).toContain("TYPESAFE_API_KEY");
    expect(error).toContain("SUBQ_API_KEY");
    expect(error).toContain("OPENAI_API_KEY");
    expect(error).toContain("at least one is required");
  });

  it("leaves the placeholder out of the 503, so Varlock's leak scan cannot block it", async () => {
    // A key set to the placeholder is a sensitive value as far as Varlock knows, and
    // Varlock replaces any response that contains a sensitive value with a 500.
    const { response, text } = await run(get("/api/providers"), { TYPESAFE_API_KEY: "unset" });

    expect(response.status).toBe(503);
    expect(text.toLowerCase()).not.toContain("unset");
  });

  it("answers from its own arguments only, keeping nothing between requests", async () => {
    const withKey = await run(get("/api/providers"), { TYPESAFE_API_KEY: "t" });
    const withoutKey = await run(get("/api/providers"), {});
    const withKeyAgain = await run(get("/api/providers"), { TYPESAFE_API_KEY: "t" });

    expect(withKey.response.status).toBe(200);
    expect(withoutKey.response.status).toBe(503);
    expect(withKeyAgain.body).toEqual(withKey.body);
  });

  it("calls neither deps.fetch nor the global fetch, because it makes no provider call", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const deps = stubDeps();

    await handle(get("/api/providers"), { OPENAI_API_KEY: "o" }, deps);

    expect(deps.fetch).not.toHaveBeenCalled();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("routing", () => {
  it.each(["/api/unknown", "/api/", "/api", "/api/providers/extra"])(
    "answers %s with a JSON 404",
    async (path) => {
      const { response, body } = await run(get(path), { OPENAI_API_KEY: "o" });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/json/);
      expect(body).toEqual({ ok: false, error: "No API route matches this path." });
    },
  );

  // Under Varlock in vp dev, a key set to the placeholder is a sensitive value, and a
  // response that contains it is replaced with a 500, so no answer quotes the path.
  it.each([
    ["GET", "/api/unset", 404],
    ["GET", "/api/decide/unset", 405],
    ["DELETE", "/api/providers/unset", 404],
  ])("does not quote the path of %s %s", async (method, path, status) => {
    const { response, text } = await run(get(path, { method }), { TYPESAFE_API_KEY: "unset" });

    expect(response.status).toBe(status);
    expect(text.toLowerCase()).not.toContain("unset");
  });

  it("does not match a path or a method by an inherited object key", async () => {
    const path = await run(get("/constructor"), {});
    const method = await run(get("/api/providers", { method: "toString" }), {});

    expect(path.response.status).toBe(404);
    expect(method.response.status).toBe(405);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])(
    "answers %s /api/providers with 405, allowing GET and HEAD",
    async (method) => {
      const response = await handle(
        get("/api/providers", { method }),
        { OPENAI_API_KEY: "o" },
        stubDeps(),
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        ok: false,
        error: `This route answers only GET and HEAD, not ${method}.`,
      });
    },
  );

  it("names a method only when it is a standard one", async () => {
    // A method is any token, so one could be the placeholder key itself.
    const { response, body, text } = await run(get("/api/providers", { method: "UNSET" }), {
      TYPESAFE_API_KEY: "UNSET",
    });

    expect(response.status).toBe(405);
    expect(body).toEqual({
      ok: false,
      error: "This route answers only GET and HEAD, not this method.",
    });
    expect(text).not.toContain("UNSET");
  });

  it.each([
    ["a listed provider", { OPENAI_API_KEY: "o" }],
    ["no key", {}],
  ])("answers HEAD like GET, with the same headers and no body, for %s", async (_name, env) => {
    const getResponse = await handle(get("/api/providers"), env, stubDeps());
    const headResponse = await handle(get("/api/providers", { method: "HEAD" }), env, stubDeps());

    expect(headResponse.status).toBe(getResponse.status);
    expect([...headResponse.headers]).toEqual([...getResponse.headers]);
    expect(headResponse.body).toBeNull();
  });

  it("gives a cross-origin preflight no CORS headers", async () => {
    const response = await handle(
      get("/api/providers", {
        method: "OPTIONS",
        headers: {
          origin: "https://elsewhere.example",
          "access-control-request-method": "GET",
        },
      }),
      { OPENAI_API_KEY: "o" },
      stubDeps(),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
  });

  it.each([
    ["a listed provider", "/api/providers", { OPENAI_API_KEY: "o" }],
    ["no key", "/api/providers", {}],
    ["an unknown path", "/api/unknown", {}],
  ])("sends Cache-Control: no-store for %s", async (_name, path, env: ProviderKeys) => {
    const { response } = await run(get(path), env);

    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([
    ["a listed provider", get("/api/providers"), { OPENAI_API_KEY: "o" }],
    ["no key", get("/api/providers"), {}],
    ["an unknown path", get("/api/unknown"), {}],
    ["a wrong method", get("/api/providers", { method: "POST" }), {}],
    ["a HEAD request", get("/api/providers", { method: "HEAD" }), { OPENAI_API_KEY: "o" }],
  ])("sends X-Content-Type-Options: nosniff for %s", async (_name, request, env: ProviderKeys) => {
    const response = await handle(request, env, stubDeps());

    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("key values that are not strings", () => {
  it.each([
    ["a number", 42],
    ["a boolean", true],
    ["an object", { value: "k" }],
    ["null", null],
  ])("treats %s as absent instead of throwing", async (_name, value) => {
    // A Worker `vars` entry in wrangler.jsonc can hold JSON that is not a string.
    const env = { OPENAI_API_KEY: value } as unknown as ProviderKeys;

    const { response } = await run(get("/api/providers"), env);

    expect(response.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// POST /api/decide/{provider}
// ---------------------------------------------------------------------------

/** A key whose shape mirrors a real one without being one. It must never reach a response or a log. */
const TYPESAFE_KEY = "sk-handler-test-0123456789abcdef";
const withTypeSafe: ProviderKeys = { TYPESAFE_API_KEY: TYPESAFE_KEY };

const yesNo: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: "Patient with asthma reports a sore throat and shortness of breath.",
  questions: {
    escalate: {
      instructions: "Should a nurse see this chat before the patient books anything?",
      criteria: { true: "Breathing trouble", false: "Stable symptoms" },
    },
  },
};

/** The success body of `providers/fixtures/typesafe/noul.json`, the recorded Jev reply. */
const recordedNoulReply = {
  model: "jev-1.13.0",
  answers: { escalate: { type: "noul", noul: 0.92 } },
  usage: { input_tokens: 343, output_tokens: 22 },
};

/** TypeSafe's error envelope, as `providers/fixtures/typesafe/bad-key.json` records it. */
function envelope(errorType: string, message: string) {
  return { detail: { error_type: errorType, message } };
}

/** A provider that answers every call with one JSON reply. */
function upstreamReply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      }),
    );
}

function post(path: string, body: BodyInit | null, contentType?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: contentType === undefined ? {} : { "content-type": contentType },
    body,
  });
}

function postJson(path: string, value: unknown): Request {
  return post(path, JSON.stringify(value), "application/json");
}

async function decideWith(request: Request, env: ProviderKeys, deps: StubDeps) {
  const response = await handle(request, env, deps);
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** The body without its measured latency, so two runs can be compared. */
function withoutLatency(body: Record<string, unknown>): Record<string, unknown> {
  const { latencyMs: _latency, ...rest } = body;
  return rest;
}

describe("POST /api/decide/typesafe", () => {
  it("answers a Yes/no request with a DecisionSuccess, its wire record, and the pinned model", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    const { response, body, text } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(200);
    expect(decisionResponseSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      ok: true,
      primitive: "noul",
      provider: "typesafe",
      model: "jev-1.13.0",
      usage: { input_tokens: 343, output_tokens: 22 },
      answers: { escalate: { type: "noul", noul: 0.92 } },
      wire: { request: { model: "jev-1.13.0", questions: { escalate: { type: "noul" } } } },
    });
    expect(body.latencyMs).toEqual(expect.any(Number));
    expect(body).not.toHaveProperty("connection");
    expect(body).not.toHaveProperty("keepAliveSeconds");
    expect(deps.fetch).toHaveBeenCalledOnce();
    expect(text).not.toContain(TYPESAFE_KEY);
  });

  it("sends the provider exactly what wire.request records, model pinned by the catalog", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    const { body } = await decideWith(postJson("/api/decide/typesafe", yesNo), withTypeSafe, deps);

    const [url, init] = deps.fetch.mock.calls[0] ?? [];
    expect(url).toBe(`${typesafe.baseUrl}/v1/systemone`);
    const sentText = init?.body;
    if (typeof sentText !== "string")
      throw new Error("Expected the provider call to send JSON text.");
    const sent = JSON.parse(sentText) as unknown;
    expect(sent).toEqual((body.wire as { request: unknown }).request);
    expect(sent).toMatchObject({ model: typesafe.model });
  });

  it("asks for one 25-second signal and hands it to the provider call", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    await decideWith(postJson("/api/decide/typesafe", yesNo), withTypeSafe, deps);

    expect(PROVIDER_TIMEOUT_MS).toBe(25_000);
    expect(deps.timeoutSignal).toHaveBeenCalledExactlyOnceWith(25_000);
    const signal = deps.timeoutSignal.mock.results[0]?.value as AbortSignal;
    expect(deps.fetch.mock.calls[0]?.[1]?.signal).toBe(signal);
  });

  it("logs one line per provider call, naming the provider, status, and latency", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    await decideWith(postJson("/api/decide/typesafe", yesNo), withTypeSafe, deps);

    expect(deps.log).toHaveBeenCalledOnce();
    const [line] = deps.log.mock.calls[0] ?? [""];
    expect(line).toMatch(
      /^\[api\] decide provider="typesafe" primitive="noul" questions=1 status=200 latencyMs=\d+$/,
    );
  });
});

describe("POST /api/decide/{provider} before any provider call", () => {
  it("answers an unknown provider with a 404 that names the id", async () => {
    const deps = stubDeps();

    const { response, body } = await decideWith(
      postJson("/api/decide/nope", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(404);
    expect(body).toEqual({
      ok: false,
      error: 'No provider is named "nope". Use typesafe, subq, or openai.',
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each(["unset", "UNSET"])(
    "does not echo the id %s, which Varlock would treat as the placeholder key",
    async (id) => {
      // Under Varlock in vp dev, a key set to the placeholder is a sensitive value, and a
      // response that contains it is replaced with a 500.
      const { response, text } = await decideWith(
        postJson(`/api/decide/${id}`, yesNo),
        { TYPESAFE_API_KEY: "unset" },
        stubDeps(),
      );

      expect(response.status).toBe(404);
      expect(text.toLowerCase()).not.toContain("unset");
    },
  );

  it("does not echo an id that is not short and plain", async () => {
    const { response, body } = await decideWith(
      postJson(`/api/decide/${"x".repeat(41)}`, yesNo),
      withTypeSafe,
      stubDeps(),
    );

    expect(response.status).toBe(404);
    expect(body.error).toBe("No provider has that id. Use typesafe, subq, or openai.");
  });

  it("does not match a provider by an inherited object key", async () => {
    const { response } = await decideWith(
      postJson("/api/decide/constructor", yesNo),
      withTypeSafe,
      stubDeps(),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ["no key", {}],
    ["a blank key", { OPENAI_API_KEY: "  " }],
    ["the placeholder", { OPENAI_API_KEY: "unset" }],
  ])("answers a known provider with %s with a 409 naming its variable", async (_name, env) => {
    const deps = stubDeps();

    const { response, body, text } = await decideWith(
      postJson("/api/decide/openai", yesNo),
      env,
      deps,
    );

    expect(response.status).toBe(409);
    expect(body).toEqual({
      ok: false,
      error: "OpenAI Decisions is not set up on this instance. Set OPENAI_API_KEY to use it.",
    });
    expect(text.toLowerCase()).not.toContain("unset");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("answers a configured provider this version has no adapter for with a 501", async () => {
    const deps = stubDeps();

    const { response, body } = await decideWith(
      postJson("/api/decide/openai", yesNo),
      { OPENAI_API_KEY: "sk-openai" },
      deps,
    );

    expect(response.status).toBe(501);
    expect(body.error).toBe("OpenAI Decisions is not available in this version yet.");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain", "text/plain"],
    ["form-urlencoded", "application/x-www-form-urlencoded"],
    ["no content type", undefined],
  ])("answers %s with a 415 naming the two accepted types", async (_name, contentType) => {
    const deps = stubDeps();

    const { response, body } = await decideWith(
      post("/api/decide/typesafe", JSON.stringify(yesNo), contentType),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(415);
    expect(body.error).toContain("application/json");
    expect(body.error).toContain("multipart/form-data");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts a JSON content type with parameters and in any case", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    const { response } = await decideWith(
      post("/api/decide/typesafe", JSON.stringify(yesNo), "Application/JSON; charset=utf-8"),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(200);
  });

  it("limits a body to 2 MiB of images plus 256 KiB of text, and says so in plain words", () => {
    expect(IMAGE_ALLOWANCE_BYTES).toBe(2 * 1024 * 1024);
    expect(TEXT_ALLOWANCE_BYTES).toBe(256 * 1024);
    expect(MAX_BODY_BYTES).toBe(IMAGE_ALLOWANCE_BYTES + TEXT_ALLOWANCE_BYTES);
    expect(TOO_LARGE_MESSAGE).toBe(
      'The request is too large. It may hold up to 256 KB of text and 2 MB of images, 2.25 MB in all. Trim "state" or ask fewer questions.',
    );
  });

  it("answers a declared length over the limit with a 413 without reading the body", async () => {
    const deps = stubDeps();
    const request = new Request(`${ORIGIN}/api/decide/typesafe`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": `${MAX_BODY_BYTES + 1}` },
      body: JSON.stringify(yesNo),
    });

    const { response, body } = await decideWith(request, withTypeSafe, deps);

    expect(response.status).toBe(413);
    expect(body).toEqual({ ok: false, error: TOO_LARGE_MESSAGE });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  /** A valid Yes/no request whose JSON text is exactly `size` bytes, padded in `state`. */
  function requestOfSize(size: number): string {
    const bare = JSON.stringify({ ...yesNo, state: "" });
    const text = JSON.stringify({ ...yesNo, state: "a".repeat(size - bare.length) });
    if (text.length !== size) throw new Error(`Built ${text.length} bytes, not ${size}.`);
    return text;
  }

  /** `text` as a stream of 64 KiB chunks, so the request declares no length. */
  function streamed(text: string): Request {
    const bytes = new TextEncoder().encode(text);
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
        offset += 64 * 1024;
      },
    });
    // Node's Request needs `duplex` for a stream body; the Fetch types used here do not declare it.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    };
    return new Request(`${ORIGIN}/api/decide/typesafe`, init);
  }

  function declared(text: string): Request {
    return new Request(`${ORIGIN}/api/decide/typesafe`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": `${text.length}` },
      body: text,
    });
  }

  it.each([
    ["a declared length", "one byte under the limit", 200, -1, declared],
    ["a declared length", "exactly the limit", 200, 0, declared],
    ["a declared length", "one byte over the limit", 413, 1, declared],
    ["a streamed body", "one byte under the limit", 200, -1, streamed],
    ["a streamed body", "exactly the limit", 200, 0, streamed],
    ["a streamed body", "one byte over the limit", 413, 1, streamed],
  ])("answers %s of %s with %i", async (_kind, _size, status, offset, build) => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    const { response } = await decideWith(
      build(requestOfSize(MAX_BODY_BYTES + offset)),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(status);
    expect(deps.fetch).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it.each([
    ["shorter", 10],
    ["longer", -10],
  ])("reads a body %s than it declared in full", async (_name, difference) => {
    const text = requestOfSize(64 * 1024 * 3 + 5);
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));
    // A hand-built Request keeps whatever Content-Length it is given, so the two can disagree.
    const request = new Request(`${ORIGIN}/api/decide/typesafe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": `${text.length + difference}`,
      },
      body: text,
    });
    expect(request.headers.get("content-length")).toBe(`${text.length + difference}`);

    const { response } = await decideWith(request, withTypeSafe, deps);

    expect(response.status).toBe(200);
    const sent = deps.fetch.mock.calls[0]?.[1]?.body;
    if (typeof sent !== "string") throw new Error("Expected the provider call to send JSON text.");
    expect((JSON.parse(sent) as { state: unknown }).state).toBe(
      (JSON.parse(text) as { state: unknown }).state,
    );
  });

  it("answers a body that is not valid UTF-8 with a 400 rather than guessing at it", async () => {
    const encoder = new TextEncoder();
    const [before, after] = JSON.stringify({ ...yesNo, state: "a|b" }).split("|");
    const bytes = new Uint8Array([...encoder.encode(before), 0xff, ...encoder.encode(after)]);
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));

    const { response, body } = await decideWith(
      post("/api/decide/typesafe", bytes, "application/json"),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({
      ok: false,
      error: "The request body is not valid UTF-8. Send the panel's JSON as UTF-8 text.",
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body once it passes the limit, then answers 413", async () => {
    const chunk = new Uint8Array(64 * 1024);
    const limitInChunks = MAX_BODY_BYTES / chunk.byteLength;
    let pulled = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // Twice the limit is on offer, so a reader that never stopped would take it all.
        if (pulled > limitInChunks * 2) controller.close();
        else controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    // Node's Request needs `duplex` for a stream body; the Fetch types used here do not declare it.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    };
    const deps = stubDeps();

    const { response } = await decideWith(
      new Request(`${ORIGIN}/api/decide/typesafe`, init),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    // The limit, one chunk over it, and the stream's own read-ahead; nowhere near twice the limit.
    expect(pulled).toBeLessThanOrEqual(limitInChunks + 3);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", "", "The request body is empty. Send the panel's JSON as the body."],
    [
      "text that is not JSON",
      "{ not json",
      "The request body is not valid JSON. Check for missing quotes, commas, or brackets.",
    ],
  ])("answers %s with a 400 that does not echo it", async (_name, text, error) => {
    const { response, body } = await decideWith(
      post("/api/decide/typesafe", text, "application/json"),
      withTypeSafe,
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body).toEqual({ ok: false, error });
  });

  it.each([
    ["no primitive", { state: "x", questions: { q: { instructions: "?" } } }],
    ["no questions", { primitive: "noul", state: "x", questions: {} }],
    ["an unknown field", { ...yesNo, extra: true }],
    [
      "too many score levels",
      {
        primitive: "score",
        state: "x",
        questions: { q: { instructions: "?", criteria: Array.from({ length: 11 }, () => null) } },
      },
    ],
  ])(
    "answers a request with %s with the validator's own message and path",
    async (_name, value) => {
      const deps = stubDeps();
      const expected = validateDecisionRequest(value, typesafe.capabilities);
      if (expected.ok) throw new Error("The test request was expected to fail validation.");

      const { response, body } = await decideWith(
        postJson("/api/decide/typesafe", value),
        withTypeSafe,
        deps,
      );

      expect(response.status).toBe(400);
      expect(body).toEqual(
        expected.detail === undefined
          ? { ok: false, error: expected.error }
          : { ok: false, error: expected.error, detail: expected.detail },
      );
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("POST /api/decide/{provider} as multipart/form-data", () => {
  function multipart(parts: [string, string | Blob][]): Request {
    const form = new FormData();
    for (const [name, value] of parts) form.append(name, value);
    // The Request sets the content type, boundary included, from the FormData body.
    return new Request(`${ORIGIN}/api/decide/typesafe`, { method: "POST", body: form });
  }

  it("answers a request part with no image parts exactly as the same JSON", async () => {
    const asJson = stubDeps(upstreamReply(200, recordedNoulReply));
    const asMultipart = stubDeps(upstreamReply(200, recordedNoulReply));

    const viaJson = await decideWith(postJson("/api/decide/typesafe", yesNo), withTypeSafe, asJson);
    const viaMultipart = await decideWith(
      multipart([["request", JSON.stringify(yesNo)]]),
      withTypeSafe,
      asMultipart,
    );

    expect(viaMultipart.response.status).toBe(200);
    expect(withoutLatency(viaMultipart.body)).toEqual(withoutLatency(viaJson.body));
    expect(asMultipart.fetch.mock.calls[0]?.[1]?.body).toBe(asJson.fetch.mock.calls[0]?.[1]?.body);
  });

  it("answers an invalid request part exactly as the same JSON", async () => {
    const invalid = { ...yesNo, primitive: "maybe" };

    const viaJson = await decideWith(
      postJson("/api/decide/typesafe", invalid),
      withTypeSafe,
      stubDeps(),
    );
    const viaMultipart = await decideWith(
      multipart([["request", JSON.stringify(invalid)]]),
      withTypeSafe,
      stubDeps(),
    );

    expect(viaMultipart.response.status).toBe(400);
    expect(viaMultipart.body).toEqual(viaJson.body);
  });

  it("refuses images for a provider that accepts none", async () => {
    const deps = stubDeps();

    const { response, body } = await decideWith(
      multipart([
        ["request", JSON.stringify(yesNo)],
        ["image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" })],
      ]),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe("TypeSafe Jev does not accept images. Remove them and run again.");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it.each<[string, [string, string | Blob][]]>([
    ["no request part", [["image", "x"]]],
    [
      "two request parts",
      [
        ["request", "{}"],
        ["request", "{}"],
      ],
    ],
    ["a request part that is a file", [["request", new Blob(["{}"])]]],
    [
      "a part with another name",
      [
        ["request", "{}"],
        ["notes", "hello"],
      ],
    ],
  ])("refuses %s with a 400", async (_name, parts) => {
    const deps = stubDeps();

    const { response, body } = await decideWith(multipart(parts), withTypeSafe, deps);

    expect(response.status).toBe(400);
    expect(body).toMatchObject({ ok: false, error: expect.any(String) });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses a multipart body that cannot be parsed", async () => {
    const { response, body } = await decideWith(
      post("/api/decide/typesafe", "not multipart", "multipart/form-data; boundary=xyz"),
      withTypeSafe,
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe("The multipart body could not be read. Check its boundary and parts.");
  });
});

describe("POST /api/decide/{provider} when the provider fails", () => {
  it("answers a key the provider rejects with a 502 that keeps the key out", async () => {
    const deps = stubDeps(
      upstreamReply(
        401,
        envelope("authentication_error", `Cannot authenticate. Key ${TYPESAFE_KEY} is not valid.`),
      ),
    );

    const { response, body, text } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(502);
    expect(body.error).toBe("TypeSafe Jev rejected the API key.");
    expect(body.detail).toContain("401");
    expect(text).not.toContain(TYPESAFE_KEY);
    expect(deps.log.mock.calls.flat().join("\n")).not.toContain(TYPESAFE_KEY);
  });

  it("answers a rate limit with a 429 that forwards Retry-After", async () => {
    const deps = stubDeps(
      upstreamReply(429, envelope("rate_limit_error", "Slow down."), { "retry-after": "7" }),
    );

    const { response, body } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(429);
    expect(body.error).toBe(
      "TypeSafe Jev is rate limiting requests. Wait 7 seconds and try again.",
    );
    expect(response.headers.get("retry-after")).toBe("7");
  });

  it("sends no Retry-After when the provider gave none", async () => {
    const { response } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      stubDeps(upstreamReply(429, envelope("rate_limit_error", "Slow down."))),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  // One row per ProviderError kind, through the real TypeSafe adapter.
  it.each<[string, number, typeof fetch]>([
    ["invalid_request (400)", 422, upstreamReply(400, envelope("invalid_request_error", "No."))],
    ["invalid_request (422)", 422, upstreamReply(422, envelope("invalid_request_error", "No."))],
    ["no_credits (402)", 402, upstreamReply(402, envelope("payment_required", "None."))],
    ["auth (403)", 502, upstreamReply(403, envelope("permission_error", "No."))],
    ["upstream (500)", 502, upstreamReply(500, envelope("server_error", "Oops."))],
    ["upstream (529)", 502, upstreamReply(529, envelope("overloaded_error", "Busy."))],
    [
      "upstream (a reply the schema rejects)",
      502,
      upstreamReply(200, { ...recordedNoulReply, usage: { input_tokens: 1 } }),
    ],
    ["unreachable", 502, () => Promise.reject(new TypeError("fetch failed"))],
  ])("answers the kind %s with %i, calling the provider once", async (_name, status, fetch) => {
    const deps = stubDeps(fetch);

    const { response, body } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(status);
    expect(body).toMatchObject({ ok: false, error: expect.stringContaining("TypeSafe Jev") });
    expect(deps.fetch).toHaveBeenCalledOnce();
  });

  it("answers a failure that is not a ProviderError with a 500 that hides its message", async () => {
    // A reply whose headers throw when read: `fetchJson` reads them after its own
    // transport handling, so the error reaches the route as it is.
    const brokenReply = {
      status: 200,
      text: () => Promise.resolve(JSON.stringify(recordedNoulReply)),
      get headers(): Headers {
        throw new Error(`internal detail ${TYPESAFE_KEY}`);
      },
    } as unknown as Response;
    const deps = stubDeps(() => Promise.resolve(brokenReply));

    const { response, body, text } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(500);
    expect(body.error).toBe(
      "Something went wrong on the server while asking TypeSafe Jev. Check the server log.",
    );
    expect(text).not.toContain("internal detail");
    const [line] = deps.log.mock.calls[0] ?? [""];
    expect(line).toContain('unexpected="Error"');
    expect(line).not.toContain("internal detail");
  });

  describe("with one 25-second budget on a fake clock", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    /**
     * A timeout signal built on `setTimeout`, which Vitest's fake timers control.
     * `AbortSignal.timeout` does not advance under Vitest 4.1's fake timers.
     */
    function fakeClockSignal(ms: number): AbortSignal {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
      }, ms);
      return controller.signal;
    }

    /** A provider that never answers. Like a real `fetch`, it rejects once its signal aborts. */
    const silentProvider: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });

    it("answers 504 once 25 seconds pass, having called the provider exactly once", async () => {
      vi.useFakeTimers();
      const deps = stubDeps(silentProvider);
      deps.timeoutSignal.mockImplementation(fakeClockSignal);

      let settled = false;
      const pending = handle(postJson("/api/decide/typesafe", yesNo), withTypeSafe, deps).then(
        (response) => {
          settled = true;
          return response;
        },
      );

      await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(deps.fetch).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: expect.stringContaining("TypeSafe Jev took too long to answer"),
      });

      // No retry follows, however long the clock runs on.
      await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS * 4);
      expect(deps.fetch).toHaveBeenCalledOnce();
    });
  });
});

describe("POST /api/decide/{provider} with Zod's English messages on", () => {
  beforeAll(() => {
    useEnglishZodMessages();
  });

  afterAll(() => {
    // The setting is per realm, so it is turned off again for any file that shares this one's.
    z.config({ localeError: undefined });
  });

  it("logs a reply the schema rejects in English and keeps the dot path in detail", async () => {
    const deps = stubDeps(
      upstreamReply(200, {
        ...recordedNoulReply,
        usage: { input_tokens: 343, output_tokens: "twenty-two" },
      }),
    );

    const { response, body } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(502);
    expect(body).toEqual({
      ok: false,
      error: "TypeSafe Jev answered in a shape this app cannot read.",
      detail: "usage.output_tokens: expected number, received string",
    });
    const [line] = deps.log.mock.calls[0] ?? [""];
    expect(line).toContain("status=502");
    expect(line).toContain('kind="upstream"');
    expect(line).toContain('detail="usage.output_tokens: expected number, received string"');
    expect(line).toContain('schema="Invalid input: expected number, received string"');
  });

  it("returns the validator's own message, not the locale's", async () => {
    const invalid = { ...yesNo, questions: { escalate: { instructions: 42 } } };

    const { response, body } = await decideWith(
      postJson("/api/decide/typesafe", invalid),
      withTypeSafe,
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(String(body.error)).not.toMatch(/^Invalid input/);
    expect(body.detail).toBe("questions.escalate.instructions");
  });
});

describe("other paths under /api/decide", () => {
  it.each(["/api/decide", "/api/decide/", "/api/decide/typesafe/extra"])(
    "answers POST %s with a JSON 404",
    async (path) => {
      const { response, body } = await decideWith(postJson(path, yesNo), withTypeSafe, stubDeps());

      expect(response.status).toBe(404);
      expect(body).toEqual({ ok: false, error: "No API route matches this path." });
    },
  );

  it("answers GET /api/decide/typesafe with a 405 that allows POST only", async () => {
    const response = await handle(get("/api/decide/typesafe"), withTypeSafe, stubDeps());

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({
      ok: false,
      error: "This route answers only POST, not GET.",
    });
  });

  it("sends a successful decision as uncacheable, sniff-proof JSON with no CORS headers", async () => {
    const response = await handle(
      new Request(`${ORIGIN}/api/decide/typesafe`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
        body: JSON.stringify(yesNo),
      }),
      withTypeSafe,
      stubDeps(upstreamReply(200, recordedNoulReply)),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      [...response.headers.keys()].filter((name) => name.startsWith("access-control-")),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Errors that are not answers of a route
// ---------------------------------------------------------------------------

describe("an error a route does not answer itself", () => {
  const UNEXPECTED = {
    ok: false,
    error: "Something went wrong on the server. Check the server log.",
  };

  it("answers a body stream that fails mid-read, as when the client goes away, with a JSON 500", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError(`The client went away holding ${TYPESAFE_KEY}`));
      },
    });
    // Node's Request needs `duplex` for a stream body; the Fetch types used here do not declare it.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    };
    const deps = stubDeps();

    const response = await handle(
      new Request(`${ORIGIN}/api/decide/typesafe`, init),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(UNEXPECTED);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith('[api] status=500 unexpected="TypeError"');
  });

  it("answers a dependency that throws before the provider call with a JSON 500", async () => {
    const deps = stubDeps(upstreamReply(200, recordedNoulReply));
    deps.timeoutSignal.mockImplementation(() => {
      throw new RangeError(`internal detail ${TYPESAFE_KEY}`);
    });

    const { response, body, text } = await decideWith(
      postJson("/api/decide/typesafe", yesNo),
      withTypeSafe,
      deps,
    );

    expect(response.status).toBe(500);
    expect(body).toEqual(UNEXPECTED);
    expect(text).not.toContain("internal detail");
    expect(deps.log).toHaveBeenCalledExactlyOnceWith('[api] status=500 unexpected="RangeError"');
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The wire record
// ---------------------------------------------------------------------------

describe("the wire record", () => {
  type WithImages = ValidDecisionRequest & { images?: ImageAttachment[] };

  /** An adapter that places images the way a multimodal provider would: in a field of its own. */
  function imageAdapter() {
    const toWire = vi.fn((request: WithImages) => ({
      model: "fake-model",
      state: request.state,
      attachments: (request.images ?? []).map((image) => ({
        type: image.mediaType,
        data: image.base64,
      })),
    }));
    const adapter: ProviderAdapter = {
      descriptor: typesafe,
      toWire,
      fromWire: () => {
        throw new Error("Not used.");
      },
      decide: () => Promise.reject(new Error("Not used.")),
    };
    return { adapter, toWire };
  }

  const realData = "iVBORw0KGgo".repeat(30_000);
  const withImage: WithImages = {
    primitive: "noul",
    state: "A photo of a rash.",
    questions: { urgent: { instructions: "Does this need a doctor today?" } },
    images: [{ mediaType: "image/png", base64: realData, byteLength: 230 * 1024 }],
  };

  it("puts a placeholder where the data was, by calling the adapter's toWire on a copy", () => {
    const { adapter, toWire } = imageAdapter();

    const record = wireRecord(adapter, withImage);

    expect(record.request).toEqual({
      model: "fake-model",
      state: "A photo of a rash.",
      attachments: [{ type: "image/png", data: "<image 1: image/png, 230 KB>" }],
    });
    expect(toWire).toHaveBeenCalledOnce();
    expect(toWire.mock.calls[0]?.[0]).not.toBe(withImage);
    // The request that goes to the provider keeps its real data.
    expect(withImage.images?.[0]?.base64).toBe(realData);
    expect(JSON.stringify(record)).not.toContain("iVBORw0KGgo");
  });

  it("numbers the placeholders and gives each image's size", () => {
    const { adapter } = imageAdapter();
    const request: WithImages = {
      ...withImage,
      images: [
        { mediaType: "image/png", base64: "a", byteLength: 512 },
        { mediaType: "image/jpeg", base64: "b", byteLength: 1536 * 1024 },
      ],
    };

    const record = wireRecord(adapter, request).request as { attachments: { data: string }[] };

    expect(record.attachments.map((attachment) => attachment.data)).toEqual([
      "<image 1: image/png, 512 bytes>",
      "<image 2: image/jpeg, 1.5 MB>",
    ]);
  });

  it("passes a request without images to toWire unchanged", () => {
    const { adapter, toWire } = imageAdapter();
    const { images: _images, ...textOnly } = withImage;

    wireRecord(adapter, textOnly);

    expect(toWire.mock.calls[0]?.[0]).toBe(textOnly);
  });

  it("needs no redaction code in any adapter", () => {
    const sources = import.meta.glob<string>(["./providers/*.ts", "!./providers/*.test.ts"], {
      query: "?raw",
      import: "default",
      eager: true,
    });

    expect(Object.keys(sources)).toContain("./providers/typesafe.ts");
    for (const [path, source] of Object.entries(sources)) {
      expect(source, path).not.toMatch(/<image|placeholder|withImagePlaceholders/i);
    }
  });
});
