// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { WarmSuccess } from "../decision/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupPanels } from "./panels.ts";
import { COLD_TEXT, createCountdown, setupWarm } from "./warm.ts";
import type { Repeat } from "./warm.ts";

/** A hand-cranked clock: `advance` fires the repeating callback, `running` says whether one is set. */
function manualRepeat() {
  let callback: (() => void) | undefined;
  let cancelled = 0;
  const repeat: Repeat = (next, ms) => {
    expect(ms).toBe(1000);
    callback = next;
    return () => {
      cancelled += 1;
      if (callback === next) callback = undefined;
    };
  };
  return {
    repeat,
    advance(seconds = 1) {
      for (let i = 0; i < seconds; i += 1) callback?.();
    },
    get running() {
      return callback !== undefined;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

describe("createCountdown", () => {
  it("starts with the lead and the keep-alive, then counts down each second", () => {
    const clock = manualRepeat();
    const texts: string[] = [];
    const countdown = createCountdown((text) => texts.push(text), clock.repeat);

    countdown.start(4, "Connection warmed in 950 ms.");
    expect(texts).toEqual(["Connection warmed in 950 ms. Warm for 4 s."]);

    clock.advance();
    expect(texts.at(-1)).toBe("Warm for 3 s.");
    expect(countdown.remaining).toBe(3);
  });

  it("ends cold and stops ticking", () => {
    const clock = manualRepeat();
    const texts: string[] = [];
    const countdown = createCountdown((text) => texts.push(text), clock.repeat);

    countdown.start(4);
    clock.advance(4);
    expect(texts).toEqual([
      "Warm for 4 s.",
      "Warm for 3 s.",
      "Warm for 2 s.",
      "Warm for 1 s.",
      COLD_TEXT,
    ]);
    expect(texts.at(-1)).toBe("Connection is cold again.");
    expect(countdown.remaining).toBe(0);
    expect(clock.running).toBe(false);
  });

  it("restarts from the full keep-alive, cancelling the running count", () => {
    const clock = manualRepeat();
    const texts: string[] = [];
    const countdown = createCountdown((text) => texts.push(text), clock.repeat);

    countdown.start(30);
    clock.advance(10);
    expect(texts.at(-1)).toBe("Warm for 20 s.");

    countdown.start(30);
    expect(clock.cancelled).toBe(1);
    expect(texts.at(-1)).toBe("Warm for 30 s.");
    clock.advance();
    expect(texts.at(-1)).toBe("Warm for 29 s.");
  });

  it("stops without changing the text", () => {
    const clock = manualRepeat();
    const texts: string[] = [];
    const countdown = createCountdown((text) => texts.push(text), clock.repeat);

    countdown.start(4);
    countdown.stop();
    clock.advance();
    expect(texts).toEqual(["Warm for 4 s."]);
    expect(clock.running).toBe(false);
  });
});

const page = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
const body = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}.`);
  return found;
}

function output(): HTMLOutputElement {
  return get<HTMLOutputElement>("#warm-status");
}

function submitWarm(): void {
  get<HTMLFormElement>("form.warm").dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = body;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("setupWarm", () => {
  it("is an output, so the countdown is announced politely", () => {
    expect(output().tagName).toBe("OUTPUT");
    expect(get("label[for=keep-alive]").textContent).toBe("Keep warm for");
    expect([...get<HTMLSelectElement>("#keep-alive").options].map((o) => o.text)).toEqual([
      "4 s, Node default",
      "30 s",
      "60 s",
    ]);
  });

  it("posts the chosen keep-alive, shows Warming, then starts the countdown", async () => {
    const warmed: WarmSuccess = {
      ok: true,
      latencyMs: 950,
      connection: "new",
      keepAliveSeconds: 30,
    };
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const clock = manualRepeat();
    setupWarm(document, clock.repeat);

    get<HTMLSelectElement>("#keep-alive").value = "30";
    submitWarm();

    const button = get<HTMLButtonElement>(".warm-button");
    expect(button.disabled).toBe(true);
    expect(get(".warm-label").textContent).toBe("Warming");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jev/warm",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = fetchMock.mock.calls[0]?.[1].body;
    expect(typeof sent === "string" ? JSON.parse(sent) : sent).toEqual({ keepAliveSeconds: 30 });

    resolveFetch(jsonResponse(warmed));
    await vi.waitFor(() => {
      expect(output().value).toBe("Connection warmed in 950 ms. Warm for 30 s.");
    });
    expect(button.disabled).toBe(false);
    expect(get(".warm-label").textContent).toBe("Warm connection");

    clock.advance();
    expect(output().value).toBe("Warm for 29 s.");
  });

  it("shows the server's error when warming fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "Could not reach TypeSafe." }, 502)),
    );
    setupWarm(document, manualRepeat().repeat);
    submitWarm();

    await vi.waitFor(() => {
      expect(output().value).toBe("Could not warm the connection. Could not reach TypeSafe.");
    });
    expect(output().dataset.tone).toBe("alert");
  });

  it("restarts the countdown when a run is answered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ...noulResponse, keepAliveSeconds: 4 })),
    );
    const clock = manualRepeat();
    const warm = setupWarm(document, clock.repeat);
    setupPanels(document, { onAnswered: warm.noteAnswered });

    get<HTMLFormElement>('form[data-primitive="noul"]').dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => {
      expect(output().value).toBe("Warm for 4 s.");
    });
    clock.advance(2);
    expect(output().value).toBe("Warm for 2 s.");

    warm.noteAnswered(noulResponse);
    expect(output().value).toBe("Warm for 4 s.");
    clock.advance(4);
    expect(output().value).toBe(COLD_TEXT);
  });
});
