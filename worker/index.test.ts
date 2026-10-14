import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as z from "zod/mini";
import { defaultDeps } from "./handler.ts";
// Loading the Worker's module is what turns on Zod's English messages.
import "./index.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  // The setting is per realm, so it is turned off again for any file that shares this one's.
  z.config({ localeError: undefined });
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

  it("builds the timeout signal with AbortSignal.timeout", () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");

    const signal = defaultDeps().timeoutSignal(25_000);

    expect(timeout).toHaveBeenCalledExactlyOnceWith(25_000);
    expect(signal.aborted).toBe(false);
    timeout.mockRestore();
  });
});

describe("the Worker module", () => {
  it("turns on Zod's English messages when it loads", () => {
    const result = z.object({ tokens: z.number() }).safeParse({ tokens: "many" });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "Invalid input: expected number, received string",
    );
  });
});
