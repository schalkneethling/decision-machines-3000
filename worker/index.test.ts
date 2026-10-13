import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { defaultDeps } from "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("defaultDeps", () => {
  it("calls the global fetch with globalThis as `this`, which workerd requires", async () => {
    const calls: { self: unknown; input: unknown }[] = [];
    vi.stubGlobal("fetch", function recordingFetch(this: unknown, input: unknown) {
      calls.push({ self: this, input });
      return Promise.resolve(new Response(null, { status: 204 }));
    });

    // Called as a method of the deps object, as the handler's routes will call it.
    const deps = defaultDeps();
    await deps.fetch("https://provider.example/v1/models");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.self).toBe(globalThis);
    expect(calls[0]?.input).toBe("https://provider.example/v1/models");
  });
});
