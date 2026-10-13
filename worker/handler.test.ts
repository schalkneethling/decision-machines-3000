import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openai, subq, typesafe } from "../src/providers/catalog.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";

const ORIGIN = "https://decisionmachines3000.example";

/** A stub `fetch` that fails the test if a route calls it unexpectedly. */
function stubDeps(): HandlerDeps & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(() => Promise.reject(new Error("deps.fetch was called."))) };
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
      expect(body).toEqual({ ok: false, error: `No API route matches ${path}.` });
    },
  );

  it("does not match a path or a method by an inherited object key", async () => {
    const path = await run(get("/constructor"), {});
    const method = await run(get("/api/providers", { method: "toString" }), {});

    expect(path.response.status).toBe(404);
    expect(method.response.status).toBe(405);
  });

  it.each(["POST", "PUT", "DELETE", "HEAD"])(
    "answers %s /api/providers with 405",
    async (method) => {
      const response = await handle(
        get("/api/providers", { method }),
        { OPENAI_API_KEY: "o" },
        stubDeps(),
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET");
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );

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
});
