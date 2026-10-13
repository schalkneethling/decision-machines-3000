import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { Connect, Plugin } from "vite-plus";
import { openai } from "../src/providers/catalog.ts";
import type { ProviderKeys } from "../worker/env.ts";
import { MISSING_KEYS_MESSAGE } from "../worker/env.ts";
import { handle } from "../worker/handler.ts";
import { jevApiPlugin } from "./jev-api.ts";
import { apiMiddleware, providerKeysFromProcessEnv, viteHostPlugin } from "./vite-host.ts";

/*
 * Drives the dev host through a real Node HTTP server, so the conversion between
 * Node's request and response and the Fetch API's is exercised too. Varlock is
 * stubbed because the legacy `/api/jev` module imports it, and the real module
 * reads the key from 1Password.
 */

vi.mock("varlock/env", () => ({ ENV: {} }));

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
    const direct = await handle(new Request(`${base}/api/providers`), withOpenAI, { fetch });

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
      error: "No API route matches /api/unknown.",
    });

    const posted = await fetch(`${base}/api/providers`, { method: "POST", body: "{}" });
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
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

describe("the dev host beside the legacy /api/jev middleware", () => {
  it("leaves /api/jev to the legacy middleware and answers /api/providers itself", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    // The order vite.config.ts registers them in.
    const legacy = configure(jevApiPlugin()).middleware;
    const host = configure(viteHostPlugin(() => withOpenAI)).middleware;
    const base = await serve(legacy, host);

    const jev = await fetch(`${base}/api/jev`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const jevBody = (await jev.json()) as { ok: boolean; detail?: string };
    // The legacy middleware's own validation error, not the dev host's JSON 404.
    expect(jev.status).toBe(400);
    expect(jevBody).toMatchObject({ ok: false, detail: "primitive" });

    const providers = await fetch(`${base}/api/providers`);
    expect(providers.status).toBe(200);
    expect(await providers.json()).toMatchObject({ ok: true, providers: [{ id: openai.id }] });
  });
});
