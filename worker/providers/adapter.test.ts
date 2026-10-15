import { describe, expect, it, vi } from "vite-plus/test";
import { typesafe } from "../../src/providers/catalog.ts";
import { ProviderError, fetchJson } from "./adapter.ts";
import type { Fetch } from "./adapter.ts";

const API_KEY = "sk-test-0123456789abcdef-never-logged";
const URL_ = "https://api.typesafe.ai/v1/systemone";
const POST = { method: "POST", body: "{}" } as const;

const liveSignal = () => new AbortController().signal;

/** A `fetch` that answers every call with `response` and records each call's `init`. */
function answering(response: Response) {
  const calls: RequestInit[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return response;
  }) as unknown as Fetch;
  return { fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("Expected a ProviderError, but the call resolved.");
}

describe("fetchJson and redirects", () => {
  it('asks fetch not to follow redirects with "manual", the value workerd accepts', async () => {
    // workerd rejects "error" with a TypeError, so every provider call failed on
    // a deployed Worker (#48). "manual" returns the redirect without following it.
    const { fetch, calls } = answering(Response.json({ ok: true }));
    await fetchJson(fetch, liveSignal(), typesafe, API_KEY, URL_, POST);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.redirect).toBe("manual");
  });

  it.each([301, 302, 303, 307, 308])(
    "refuses a %i as an upstream failure without reading its body or naming its target",
    async (status) => {
      const body = new ReadableStream({
        pull() {
          throw new Error("The body of a redirect must not be read.");
        },
      });
      const location = "https://elsewhere.example/steal";
      const { fetch } = answering(new Response(body, { status, headers: { location } }));

      const error = await rejection(fetchJson(fetch, liveSignal(), typesafe, API_KEY, URL_, POST));

      expect(error.kind).toBe("upstream");
      expect(error.message).toBe(
        "TypeSafe Jev answered with a redirect, which this app does not follow.",
      );
      expect(error.detail).toBe(`${status} redirect`);
      expect(JSON.stringify(error)).not.toContain("elsewhere");
    },
  );
});
