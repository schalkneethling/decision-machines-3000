import { createServer, request } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connect, Plugin } from "vite-plus";
import * as z from "zod/mini";
import { openai, typesafe } from "../src/providers/catalog.ts";
import { MAX_BODY_BYTES, tooLarge } from "../worker/body-limit.ts";
import type { ProviderKeys } from "../worker/env.ts";
import { MISSING_KEYS_MESSAGE } from "../worker/env.ts";
import { defaultDeps, handle } from "../worker/handler.ts";
import { apiMiddleware, providerKeysFromProcessEnv, viteHostPlugin } from "./vite-host.ts";

/*
 * Drives the dev host through a real Node HTTP server, so the conversion between
 * Node's request and response and the Fetch API's is exercised too.
 */

type Middleware = Connect.NextHandleFunction;

/** Captures the middleware a plugin registers, and whatever it logs as a warning. */
function configure(plugin: Plugin): { middleware: Middleware; warn: ReturnType<typeof vi.fn> } {
  const used: Middleware[] = [];
  const warn = vi.fn();
  const hook = plugin.configureServer as (server: unknown) => void;
  hook({
    config: { logger: { warn } },
    middlewares: { use: (fn: Middleware) => used.push(fn) },
    httpServer: null,
  });
  const [middleware] = used;
  if (middleware === undefined) throw new Error(`${plugin.name} registered no middleware.`);
  return { middleware, warn };
}

const servers: Server[] = [];

/** Serves `middlewares` in order, like Vite's connect stack, and answers 418 when none handles a request. */
async function serve(...middlewares: Middleware[]): Promise<string> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const run = (index: number) => {
      const middleware = middlewares[index];
      if (middleware === undefined) {
        res.statusCode = 418;
        res.end("passed on");
        return;
      }
      middleware(req, res, () => run(index + 1));
    };
    run(0);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterAll(() => {
  // Configuring the plugin turns on Zod's English messages, a per-realm setting; turn it off again.
  z.config({ localeError: undefined });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

const withOpenAI: ProviderKeys = { OPENAI_API_KEY: "dev-host-test-key" };

describe("the dev host middleware", () => {
  it("answers GET /api/providers with exactly what handle answers", async () => {
    const base = await serve(apiMiddleware(() => withOpenAI));

    const viaHost = await fetch(`${base}/api/providers`);
    const direct = await handle(
      new Request(`${base}/api/providers`),
      withOpenAI,
      defaultDeps("node-dev"),
    );

    expect(viaHost.status).toBe(direct.status);
    expect(viaHost.headers.get("cache-control")).toBe("no-store");
    expect(viaHost.headers.get("content-type")).toBe(direct.headers.get("content-type"));
    expect(await viaHost.json()).toEqual(await direct.json());
  });

  it("lists the provider whose key it reads, and never the key", async () => {
    const base = await serve(apiMiddleware(() => withOpenAI));

    const response = await fetch(`${base}/api/providers`);
    const text = await response.text();

    expect(JSON.parse(text)).toMatchObject({ ok: true, providers: [{ id: openai.id }] });
    expect(text).not.toContain("dev-host-test-key");
  });

  it("reads the keys on every request", async () => {
    const keys: ProviderKeys = {};
    const base = await serve(apiMiddleware(() => keys));

    expect((await fetch(`${base}/api/providers`)).status).toBe(503);
    keys.TYPESAFE_API_KEY = "now-set";
    expect((await fetch(`${base}/api/providers`)).status).toBe(200);
  });

  it("answers unknown /api paths and wrong methods as the Worker does", async () => {
    const base = await serve(apiMiddleware(() => withOpenAI));

    const unknown = await fetch(`${base}/api/unknown`);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({
      ok: false,
      error: "No API route matches this path.",
    });

    const posted = await fetch(`${base}/api/providers`, { method: "POST", body: "{}" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET, HEAD");
  });

  it.each(["/", "/index.html", "/apis", "/src/main.ts"])(
    "passes %s on to the next middleware",
    async (path) => {
      const base = await serve(apiMiddleware(() => withOpenAI));

      const response = await fetch(`${base}${path}`);

      expect(response.status).toBe(418);
    },
  );
});

type RawAnswer = { status: number; headers: Record<string, unknown>; body: Buffer };

/**
 * Sends a request with Node's own client, which, unlike `fetch`, allows a raw
 * path, any Host header, and methods such as TRACE.
 */
function raw(
  base: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: Buffer },
): Promise<RawAnswer> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname,
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("the dev host's request conversion", () => {
  it("passes the method, the content type, and the exact body bytes to the handler", async () => {
    let received: { method: string; contentType: string | null; body: Uint8Array } | undefined;
    const echo = async (request: Request) => {
      received = {
        method: request.method,
        contentType: request.headers.get("content-type"),
        body: new Uint8Array(await request.arrayBuffer()),
      };
      return new Response(null, { status: 204 });
    };
    const base = await serve(apiMiddleware(() => withOpenAI, echo));
    // Non-ASCII text, plus a byte that is not valid UTF-8, so no decoding step can hide.
    const body = Buffer.concat([
      Buffer.from('{"state":"Amélie — 日本 ✓"}', "utf8"),
      Buffer.from([0xff]),
    ]);

    const answer = await raw(base, {
      method: "POST",
      path: "/api/decide/noul",
      headers: { "content-type": "application/json; charset=utf-8" },
      body,
    });

    expect(answer.status).toBe(204);
    expect(received?.method).toBe("POST");
    expect(received?.contentType).toBe("application/json; charset=utf-8");
    expect(Buffer.from(received?.body ?? [])).toEqual(body);
  });

  describe("with a body over the limit the Worker's route applies", () => {
    function recordingHandler() {
      const received: number[] = [];
      const handler = async (request: Request) => {
        received.push((await request.arrayBuffer()).byteLength);
        return new Response(null, { status: 204 });
      };
      return { handler, received };
    }

    it.each([
      ["a declared length", { "content-type": "application/json" }],
      [
        "a chunked body with no length",
        { "content-type": "application/json", "transfer-encoding": "chunked" },
      ],
    ])(
      "answers %s one byte over with the Worker's JSON 413, without calling the handler",
      async (_kind, headers) => {
        const { handler, received } = recordingHandler();
        const base = await serve(apiMiddleware(() => withOpenAI, handler));

        const answer = await raw(base, {
          method: "POST",
          path: "/api/decide/typesafe",
          headers,
          body: Buffer.alloc(MAX_BODY_BYTES + 1, 0x20),
        });

        expect(answer.status).toBe(413);
        expect(answer.headers["cache-control"]).toBe("no-store");
        expect(answer.headers["x-content-type-options"]).toBe("nosniff");
        expect(JSON.parse(answer.body.toString())).toEqual(await tooLarge().json());
        expect(received).toEqual([]);

        // The socket was not left hanging: the server answers the next request.
        const next = await raw(base, { path: "/api/providers" });
        expect(next.status).toBe(204);
      },
    );

    it.each([
      ["a declared length", { "content-type": "application/json" }],
      [
        "a chunked body with no length",
        { "content-type": "application/json", "transfer-encoding": "chunked" },
      ],
    ])("passes %s of exactly the limit to the handler", async (_kind, headers) => {
      const { handler, received } = recordingHandler();
      const base = await serve(apiMiddleware(() => withOpenAI, handler));

      const answer = await raw(base, {
        method: "POST",
        path: "/api/decide/typesafe",
        headers,
        body: Buffer.alloc(MAX_BODY_BYTES, 0x20),
      });

      expect(answer.status).toBe(204);
      expect(received).toEqual([MAX_BODY_BYTES]);
    });
  });

  it("passes a request with no body to the handler with none", async () => {
    let bodyWasNull = false;
    const echo = async (request: Request) => {
      bodyWasNull = request.body === null;
      return new Response(null, { status: 204 });
    };
    const base = await serve(apiMiddleware(() => withOpenAI, echo));

    await raw(base, { path: "/api/providers" });

    expect(bodyWasNull).toBe(true);
  });

  it("does not read a path that starts with // as another host", async () => {
    const base = await serve(apiMiddleware(() => withOpenAI));

    const answer = await raw(base, { path: "//evil.example/api/providers" });

    // Passed on, as the Worker's assets layer would, rather than answered as /api/providers.
    expect(answer.status).toBe(418);
  });

  it.each(["bad host", "localhost/api/providers?", "user@localhost"])(
    "answers a malformed Host header %j with a JSON 400",
    async (host) => {
      const base = await serve(apiMiddleware(() => withOpenAI));

      const answer = await raw(base, { path: "/api/providers", headers: { host } });

      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body.toString())).toMatchObject({ ok: false });
    },
  );

  // CONNECT and TRACK never reach a request listener: Node's server handles
  // CONNECT separately, and its parser answers TRACK with a 400 itself.
  it.each(["TRACE"])(
    "answers %s, which the Fetch API cannot represent, with a JSON 405",
    async (method) => {
      const base = await serve(apiMiddleware(() => withOpenAI));

      const answer = await raw(base, { method, path: "/api/providers" });

      expect(answer.status).toBe(405);
      expect(answer.headers.allow).toBe("GET, HEAD");
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(answer.headers["x-content-type-options"]).toBe("nosniff");
      expect(JSON.parse(answer.body.toString())).toMatchObject({ ok: false });
    },
  );

  it("answers HEAD with the GET headers and no body", async () => {
    const base = await serve(apiMiddleware(() => withOpenAI));

    const head = await raw(base, { method: "HEAD", path: "/api/providers" });

    expect(head.status).toBe(200);
    expect(head.headers["content-type"]).toMatch(/^application\/json/);
    expect(head.body.length).toBe(0);
  });
});

describe("the dev host plugin", () => {
  it("warns at start-up with the variables to set when no key is set", () => {
    const { warn } = configure(viteHostPlugin(() => ({ OPENAI_API_KEY: "  unset " })));

    expect(warn).toHaveBeenCalledOnce();
    const [message] = warn.mock.calls[0] as [string];
    expect(message).toContain(MISSING_KEYS_MESSAGE);
    expect(message).toContain("TYPESAFE_API_KEY");
    expect(message).toContain("SUBQ_API_KEY");
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).toContain("at least one is required");
  });

  it("starts quietly when a key is set", () => {
    const { warn } = configure(viteHostPlugin(() => withOpenAI));

    expect(warn).not.toHaveBeenCalled();
  });

  it("reads the keys from process.env by default", () => {
    vi.stubEnv("TYPESAFE_API_KEY", "from-process-env");
    vi.stubEnv("SUBQ_API_KEY", "");
    try {
      expect(providerKeysFromProcessEnv()).toMatchObject({
        TYPESAFE_API_KEY: "from-process-env",
        SUBQ_API_KEY: "",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("POST /api/decide/{provider} on the dev host", () => {
  const withTypeSafe: ProviderKeys = { TYPESAFE_API_KEY: "dev-host-typesafe-key" };
  const noulRequest = {
    primitive: "noul",
    state: "Patient with asthma reports shortness of breath.",
    questions: { escalate: { instructions: "Should a nurse see this chat first?" } },
  };
  /** The success body of `worker/providers/fixtures/typesafe/noul.json`. */
  const recordedReply = {
    model: "jev-1.13.0",
    answers: { escalate: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 343, output_tokens: 22 },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("serves the route through handle, calling the provider with the Worker's dependencies", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const upstream = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json(recordedReply)),
    );
    // The test talks to its server with Node's own client, so only the provider call sees this.
    vi.stubGlobal("fetch", upstream);
    const base = await serve(configure(viteHostPlugin(() => withTypeSafe)).middleware);

    const answer = await raw(base, {
      method: "POST",
      path: "/api/decide/typesafe",
      headers: { "content-type": "application/json" },
      body: Buffer.from(JSON.stringify(noulRequest)),
    });

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body.toString())).toMatchObject({
      ok: true,
      provider: "typesafe",
      model: "jev-1.13.0",
      answers: { escalate: { type: "noul", noul: 0.92 } },
      wire: { request: { model: typesafe.model } },
    });
    expect(upstream).toHaveBeenCalledOnce();
    expect(upstream.mock.calls[0]?.[0]).toBe("https://api.typesafe.ai/v1/systemone");
    expect(upstream.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(answer.body.toString()).not.toContain("dev-host-typesafe-key");
  });

  it("answers the old /api/jev paths with a JSON 404, because nothing mounts them any more", async () => {
    const base = await serve(configure(viteHostPlugin(() => withTypeSafe)).middleware);

    for (const path of ["/api/jev", "/api/jev/warm"]) {
      const answer = await raw(base, {
        method: "POST",
        path,
        headers: { "content-type": "application/json" },
        body: Buffer.from("{}"),
      });
      expect(answer.status).toBe(404);
      expect(JSON.parse(answer.body.toString())).toEqual({
        ok: false,
        error: "No API route matches this path.",
      });
    }
  });

  it("turns on Zod's English messages when it configures the server", () => {
    configure(viteHostPlugin(() => withTypeSafe));

    const result = z.object({ tokens: z.number() }).safeParse({ tokens: "many" });

    expect(result.error?.issues[0]?.message).toBe(
      "Invalid input: expected number, received string",
    );
  });
});
