// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { KEEP_ALIVE_SECONDS } from "../decision/contract.ts";
import type { DecisionSuccess, WarmSuccess } from "../decision/contract.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { HostSummary, ProviderSummary } from "../providers/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupProviderSelect } from "./provider-select.ts";
import type { ProviderSelection } from "./provider-select.ts";
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

const typesafe = toProviderSummary(PROVIDERS.typesafe);
const subq = toProviderSummary(PROVIDERS.subq);
/** A provider whose descriptor declares no warm path. */
const noWarmPath: ProviderSummary = { ...toProviderSummary(PROVIDERS.openai), canWarm: false };

const NODE_DEV_HOST: HostSummary = { connectionMetrics: true };
const WORKER_HOST: HostSummary = { connectionMetrics: false };

/** A provider selection the test drives by hand, listed by `host`. */
function selectionOf(initial: ProviderSummary | undefined, host: HostSummary = NODE_DEV_HOST) {
  let current = initial;
  const listeners: ((provider: ProviderSummary | undefined) => void)[] = [];
  const selection: ProviderSelection = {
    current: () => current,
    host: () => (current === undefined ? undefined : host),
    subscribe: (listener) => listeners.push(listener),
  };
  return {
    selection,
    choose: (provider: ProviderSummary | undefined) => {
      current = provider;
      for (const listener of listeners) listener(provider);
    },
  };
}

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}.`);
  return found;
}

function warmForm(): HTMLFormElement {
  return get<HTMLFormElement>("form.warm");
}

function output(): HTMLOutputElement {
  return get<HTMLOutputElement>("#warm-status");
}

function submitWarm(): void {
  warmForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

function warmed(overrides: Partial<WarmSuccess> = {}): WarmSuccess {
  return {
    ok: true,
    provider: "typesafe",
    latencyMs: 950,
    connection: "new",
    keepAliveSeconds: 30,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = body;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the keep-alive options", () => {
  it("come from KEEP_ALIVE_SECONDS, so index.html holds an empty select", () => {
    expect(page).toMatch(/<select\s[^>]*id="keep-alive"[^>]*>\s*<\/select>/);

    setupWarm(document, selectionOf(typesafe).selection, manualRepeat().repeat);

    const select = get<HTMLSelectElement>("#keep-alive");
    expect([...select.options].map((option) => Number(option.value))).toEqual([
      ...KEEP_ALIVE_SECONDS,
    ]);
    expect([...select.options].map((option) => option.text)).toEqual([
      "4 s, Node default",
      "30 s",
      "60 s",
    ]);
    expect(select.value).toBe("4");
  });

  it("are labelled, and the status is an output, so the countdown is announced politely", () => {
    setupWarm(document, selectionOf(typesafe).selection, manualRepeat().repeat);

    expect(output().tagName).toBe("OUTPUT");
    expect(get("label[for=keep-alive]").textContent).toBe("Keep warm for");
  });
});

describe("when the warm form shows", () => {
  it("is hidden in index.html, before anything is known", () => {
    expect(warmForm().hidden).toBe(true);
  });

  it("shows on the Node dev host for a provider with a warm path", () => {
    setupWarm(document, selectionOf(typesafe, NODE_DEV_HOST).selection, manualRepeat().repeat);

    expect(warmForm().hidden).toBe(false);
  });

  it("stays hidden on the Worker host, which reports no connection metrics", () => {
    setupWarm(document, selectionOf(typesafe, WORKER_HOST).selection, manualRepeat().repeat);

    expect(warmForm().hidden).toBe(true);
  });

  it("hides when a provider without a warm path is selected, and shows again for one with", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, manualRepeat().repeat);

    choose(noWarmPath);
    expect(warmForm().hidden).toBe(true);

    choose(subq);
    expect(warmForm().hidden).toBe(false);
  });

  it("stays hidden while no provider is selected", () => {
    setupWarm(document, selectionOf(undefined).selection, manualRepeat().repeat);

    expect(warmForm().hidden).toBe(true);
  });

  it("follows what GET /api/providers says about the host, through the provider select", async () => {
    for (const [host, hidden] of [
      [WORKER_HOST, true],
      [NODE_DEV_HOST, false],
    ] as const) {
      document.body.innerHTML = body;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ ok: true, providers: [typesafe], host, protection: { mode: "local" } }),
        ),
      );
      const selection = setupProviderSelect(document);
      setupWarm(document, selection, manualRepeat().repeat);

      await vi.waitFor(() => {
        expect(selection.current()?.id).toBe("typesafe");
      });
      expect(selection.host()).toEqual(host);
      expect(warmForm().hidden).toBe(hidden);
    }
  });
});

describe("the warm button", () => {
  it("names the selected provider, and the new one when the selection changes", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, manualRepeat().repeat);

    expect(get(".warm-label").textContent).toBe("Warm the TypeSafe Jev connection");

    choose(subq);
    expect(get(".warm-label").textContent).toBe("Warm the SubQ Snap connection");
    expect(get(".warm-button .run-sizer").textContent).toBe("Warming the SubQ Snap connection");
  });

  it("posts the chosen keep-alive to the selected provider's warm route, then counts down", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const clock = manualRepeat();
    setupWarm(document, selectionOf(typesafe).selection, clock.repeat);

    get<HTMLSelectElement>("#keep-alive").value = "30";
    submitWarm();

    const button = get<HTMLButtonElement>(".warm-button");
    expect(button.disabled).toBe(true);
    expect(get(".warm-label").textContent).toBe("Warming the TypeSafe Jev connection");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/warm/typesafe",
      expect.objectContaining({ method: "POST" }),
    );
    const sent = fetchMock.mock.calls[0]?.[1].body;
    expect(typeof sent === "string" ? JSON.parse(sent) : sent).toEqual({ keepAliveSeconds: 30 });

    resolveFetch(jsonResponse(warmed()));
    await vi.waitFor(() => {
      expect(output().value).toBe("Connection warmed in 950 ms. Warm for 30 s.");
    });
    expect(button.disabled).toBe(false);
    expect(get(".warm-label").textContent).toBe("Warm the TypeSafe Jev connection");

    clock.advance();
    expect(output().value).toBe("Warm for 29 s.");
  });

  it("warms the newly selected provider after the selection changes", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      jsonResponse(warmed({ provider: "subq" })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, manualRepeat().repeat);

    choose(subq);
    submitWarm();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/warm/subq");
  });

  it("clears the previous provider's countdown when the selection changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(warmed())),
    );
    const clock = manualRepeat();
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, clock.repeat);
    submitWarm();
    await vi.waitFor(() => expect(clock.running).toBe(true));

    choose(subq);

    expect(clock.running).toBe(false);
    expect(output().value).toBe("");
  });

  /** A fetch whose answers the test hands over one at a time, in the order the requests went out. */
  function heldFetch() {
    const pending: ((response: Response) => void)[] = [];
    const fetchMock = vi.fn(
      (_url: string, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      answerNext(response: Response) {
        pending.shift()?.(response);
      },
    };
  }

  it("shows B as ready, not warming, while A's warm is still in flight", () => {
    heldFetch();
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, manualRepeat().repeat);
    submitWarm();

    choose(subq);

    expect(get(".warm-label").textContent).toBe("Warm the SubQ Snap connection");
    expect(get<HTMLButtonElement>(".warm-button").disabled).toBe(false);
  });

  it("warms B while A's warm is still in flight", async () => {
    const { fetchMock } = heldFetch();
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, manualRepeat().repeat);
    submitWarm();

    choose(subq);
    submitWarm();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/warm/typesafe",
      "/api/warm/subq",
    ]);
    expect(get(".warm-label").textContent).toBe("Warming the SubQ Snap connection");
  });

  it("counts A's answer when the viewer is back on A by the time it arrives", async () => {
    // The answer describes the connection the form shows again, so it is shown, not dropped.
    const held = heldFetch();
    const clock = manualRepeat();
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, clock.repeat);
    submitWarm();

    choose(subq);
    choose(typesafe);
    expect(get(".warm-label").textContent).toBe("Warming the TypeSafe Jev connection");
    expect(get<HTMLButtonElement>(".warm-button").disabled).toBe(true);

    held.answerNext(jsonResponse(warmed()));

    await vi.waitFor(() => {
      expect(output().value).toBe("Connection warmed in 950 ms. Warm for 30 s.");
    });
    expect(get<HTMLButtonElement>(".warm-button").disabled).toBe(false);
  });

  it("drops an answer that arrives after the viewer chose another provider", async () => {
    let resolveFetch: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const clock = manualRepeat();
    const { selection, choose } = selectionOf(typesafe);
    setupWarm(document, selection, clock.repeat);
    submitWarm();

    choose(subq);
    resolveFetch(jsonResponse(warmed()));

    await vi.waitFor(() => expect(get<HTMLButtonElement>(".warm-button").disabled).toBe(false));
    expect(output().value).toBe("");
    expect(clock.running).toBe(false);
  });

  it("shows the server's error when warming fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ ok: false, error: "Could not reach TypeSafe Jev." }, 502)),
    );
    setupWarm(document, selectionOf(typesafe).selection, manualRepeat().repeat);
    submitWarm();

    await vi.waitFor(() => {
      expect(output().value).toBe("Could not warm the connection. Could not reach TypeSafe Jev.");
    });
    expect(output().dataset.tone).toBe("alert");
  });

  it("says when the warm endpoint answers with a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 })),
    );
    setupWarm(document, selectionOf(typesafe).selection, manualRepeat().repeat);
    submitWarm();

    await vi.waitFor(() => {
      expect(output().value).toBe(
        "Could not warm the connection. The warm endpoint answered with HTTP 502 and a body that is not JSON.",
      );
    });
  });
});

describe("noteAnswered", () => {
  const answeredOverWarmConnection: DecisionSuccess = {
    ...noulResponse,
    connection: "reused",
    keepAliveSeconds: 60,
  };

  it("restarts the count after a run on the warm form's provider", () => {
    const clock = manualRepeat();
    const warm = setupWarm(document, selectionOf(typesafe).selection, clock.repeat);

    warm.noteAnswered(answeredOverWarmConnection);

    expect(output().value).toBe("Warm for 60 s.");
    expect(clock.running).toBe(true);
  });

  it("ignores a run on another provider, and one from a host without connection fields", () => {
    const clock = manualRepeat();
    const warm = setupWarm(document, selectionOf(subq).selection, clock.repeat);

    warm.noteAnswered(answeredOverWarmConnection);
    warm.noteAnswered({ ...noulResponse, provider: "subq" });

    expect(output().value).toBe("");
    expect(clock.running).toBe(false);
  });
});
