// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDERS } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { Protection } from "../providers/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupRequestForm } from "./request-form.ts";
import { DEPLOYMENT_GUIDE_URL } from "./protection-notice.ts";
import { setupProviderSelect } from "./provider-select.ts";

const page = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
// The page's own module script is left out: the tests call the setup functions themselves.
const body = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);

const typesafe = toProviderSummary(PROVIDERS.typesafe);
const subq = toProviderSummary(PROVIDERS.subq);
const openai = toProviderSummary(PROVIDERS.openai);

const STORAGE_KEY = "decisionmachines3000:providers";
const LEGACY_STORAGE_KEY = "decisionmachines3000:provider";

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}.`);
  return found;
}

function providerChoice(): HTMLFieldSetElement {
  return get<HTMLFieldSetElement>("#provider-choice");
}

function checkboxes(): HTMLInputElement[] {
  return [...providerChoice().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
}

function checkbox(id: string): HTMLInputElement {
  return get<HTMLInputElement>(`#provider-${id}`);
}

/** Each checkbox's label text, which is its accessible name. */
function optionTexts(): string[] {
  return checkboxes().map((input) => input.labels?.[0]?.textContent ?? "");
}

/** The ids of the ticked checkboxes, in order. */
function tickedIds(): string[] {
  return checkboxes()
    .filter((input) => input.checked)
    .map((input) => input.value);
}

function runButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("#request-form .run")];
}

/** The sentence a Run button's aria-describedby points at: what it will send, or why it cannot. */
function runNote(button: HTMLButtonElement): string {
  return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
}

const NO_PROVIDER = "No provider is available yet. The Providers to ask area beside Run says why.";

/** Chooses a question type in the request form. */
function useType(primitive: string): void {
  get<HTMLInputElement>(`input[name="question-type"][value="${primitive}"]`).click();
}

/** Loads the film example into the request, since an empty request's Run sends nothing (issues #58 and #95). */
async function loadFilmExample(): Promise<void> {
  get<HTMLButtonElement>("#load-film").click();
  await vi.waitFor(() => expect(get("#request-status").textContent).toBe("Film example loaded."));
}

/** Answers GET /api/providers with each queued answer in turn, and the last one after that. */
function answerProviders(...answers: Response[]) {
  const queue = [...answers];
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next === undefined) throw new Error("No answer queued.");
    return next.clone();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** A success for a local instance; `listedWith` sets another protection state. */
function listed(...providers: (typeof typesafe)[]): Response {
  return listedWith({ mode: "local" }, ...providers);
}

function listedWith(protection: Protection, ...providers: (typeof typesafe)[]): Response {
  return Response.json({ ok: true, providers, host: { connectionMetrics: false }, protection });
}

const missingKeys = () =>
  Response.json(
    { ok: false, error: "No provider key is set, and at least one is required." },
    { status: 503 },
  );

/** Loads the page's provider choice and waits until the list has been handled. */
async function load() {
  const selection = setupProviderSelect(document);
  await vi.waitFor(() => {
    expect(get(".provider-options").textContent).not.toBe("Loading providers…");
  });
  return selection;
}

/** Ticks or unticks a provider's checkbox, as a click does. */
function tick(id: string, checked = true): void {
  const input = checkbox(id);
  if (input.checked !== checked) input.click();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = body;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the list", () => {
  it("has a checkbox for exactly the providers the instance lists, in that order, with name and model", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(optionTexts()).toEqual(["TypeSafe Jev jev-1.13.0", "SubQ Snap subq-snap-preview"]);
    expect(checkboxes().map((input) => input.value)).toEqual(["typesafe", "subq"]);
    // A text space between name and model, so the name never reads "OpenAI Decisionsgpt-6-luna".
    expect(optionTexts()).not.toContain("TypeSafe Jevjev-1.13.0");
  });

  it("hands the listed providers to the request form, empty until the list loads", async () => {
    answerProviders(listed(typesafe, subq));
    const selection = setupProviderSelect(document);
    expect(selection.providers()).toEqual([]);
    await vi.waitFor(() => expect(selection.providers()).toHaveLength(2));
    expect(selection.providers().map((provider) => provider.id)).toEqual(["typesafe", "subq"]);
  });

  it("asks GET /api/providers once", async () => {
    const fetchMock = answerProviders(listed(typesafe));
    await load();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/providers");
  });

  it("starts as a disabled fieldset that says the list is loading", () => {
    answerProviders(listed(typesafe));
    setupProviderSelect(document);
    expect(providerChoice().disabled).toBe(true);
    expect(providerChoice().querySelector("legend")?.textContent).toBe("Providers to ask");
    expect(get(".provider-options").textContent).toBe("Loading providers…");
    expect(checkboxes()).toHaveLength(0);
  });

  it("enables the choice once the list has loaded, inside the Run bar before Run", async () => {
    answerProviders(listed(typesafe));
    await load();
    expect(providerChoice().disabled).toBe(false);
    expect(providerChoice().closest(".run-bar")).not.toBeNull();
    const run = get("#request-form .run");
    expect(
      providerChoice().compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("describes each checkbox by what the provider does with images, outside its name", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    const description = (id: string) =>
      get(`#${checkbox(id).getAttribute("aria-describedby") ?? ""}`).textContent;
    expect(description("typesafe")).toBe("Text only, no images.");
    expect(description("subq")).toBe(
      "Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB in total.",
    );
    expect(optionTexts()[0]).not.toContain("Text only");
  });
});

describe("the stored choice", () => {
  it("ticks the stored providers that are configured", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["subq", "openai"]));
    answerProviders(listed(typesafe, subq, openai));
    const selection = await load();
    expect(tickedIds()).toEqual(["subq", "openai"]);
    expect(selection.selected().map((provider) => provider.id)).toEqual(["subq", "openai"]);
  });

  it("drops a stored provider that is not configured, and ticks the first when none is left", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(["openai"]));
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(tickedIds()).toEqual(["typesafe"]);
    expect(selection.selected().map((provider) => provider.id)).toEqual(["typesafe"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["typesafe"]));
  });

  it("ticks the first provider when nothing is stored, and stores that", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(tickedIds()).toEqual(["typesafe"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["typesafe"]));
  });

  it("keeps a stored choice of none, so a viewer who unticked every provider finds it so", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([]));
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(tickedIds()).toEqual([]);
    expect(selection.selected()).toEqual([]);
  });

  it("starts from the single provider stored before several could be ticked", async () => {
    localStorage.setItem(LEGACY_STORAGE_KEY, "subq");
    answerProviders(listed(typesafe, subq));
    await load();
    expect(tickedIds()).toEqual(["subq"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["subq"]));
  });

  it("stores each change, and tells listeners the ticked providers in list order", async () => {
    answerProviders(listed(typesafe, subq, openai));
    const selection = await load();
    const heard: string[][] = [];
    selection.subscribe((ticked) => heard.push(ticked.map((provider) => provider.id)));
    tick("openai");
    tick("subq");
    tick("typesafe", false);
    expect(heard).toEqual([
      ["typesafe", "openai"],
      ["typesafe", "subq", "openai"],
      ["subq", "openai"],
    ]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(["subq", "openai"]));
  });

  it("still works when every storage read and write throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(tickedIds()).toEqual(["typesafe"]);
    expect(() => tick("subq")).not.toThrow();
    expect(selection.selected().map((provider) => provider.id)).toEqual(["typesafe", "subq"]);
  });
});

describe("the status line", () => {
  it("is empty after the page loads and after a change, because each checkbox announces itself", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(get("#provider-status").textContent).toBe("");
    expect(get("#provider-status").getAttribute("role")).toBe("status");
    tick("subq");
    expect(get("#provider-status").textContent).toBe("");
  });
});

describe("the vocabulary legend", () => {
  it("stays hidden until the list loads", () => {
    answerProviders(listed(typesafe));
    setupProviderSelect(document);
    expect(get("#provider-vocabulary").hidden).toBe(true);
  });

  it("is a table after the results, with a column for each listed provider's words", async () => {
    answerProviders(listed(typesafe, openai));
    await load();
    const legend = get<HTMLDetailsElement>("#provider-vocabulary");
    expect(legend.hidden).toBe(false);
    expect(
      get("#results-title").compareDocumentPosition(legend) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const headers = [...legend.querySelectorAll("thead th")].map((cell) => cell.textContent);
    expect(headers).toEqual(["On this page", "TypeSafe Jev", "OpenAI Decisions"]);
    const codes = [...legend.querySelectorAll("tbody code")].map((code) => code.textContent);
    expect(codes).toContain("predicate");
    expect(codes).toContain("input");
    expect(legend.querySelector("tbody th")?.getAttribute("scope")).toBe("row");
  });
});

describe("an instance with no provider key", () => {
  it("shows a setup notice that names the three keys and links the deployment guide", async () => {
    answerProviders(missingKeys());
    setupProviderSelect(document);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).not.toBe(""));
    const notice = get("#provider-problem");
    expect([...notice.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
      "TYPESAFE_API_KEY",
      "SUBQ_API_KEY",
      "OPENAI_API_KEY",
    ]);
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(DEPLOYMENT_GUIDE_URL);
    expect(notice.querySelector("a")?.textContent).toBe("deployment guide");
    // The region is an alert, so assistive technology announces the notice.
    expect(notice.getAttribute("role")).toBe("alert");
    expect(providerChoice().getAttribute("aria-describedby")).toBe("provider-problem");
  });

  it("disables the choice, and Run says no provider is available and sends nothing", async () => {
    const fetchMock = answerProviders(missingKeys());
    const selection = setupProviderSelect(document);
    setupRequestForm(document, selection);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).not.toBe(""));
    await loadFilmExample();
    expect(providerChoice().disabled).toBe(true);
    expect(selection.selected()).toEqual([]);
    expect(runButtons()).toHaveLength(1);
    // Run stays reachable by keyboard and says why it cannot run (issue #95).
    for (const button of runButtons()) {
      expect(button.disabled).toBe(false);
      expect(runNote(button)).toBe(NO_PROVIDER);
    }
    get("#request-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    // No checkbox can take focus, so the summary names the problem without a link.
    expect(get("#request-summary").textContent).toContain(NO_PROVIDER);
    expect(get("#request-summary").querySelector("a")).toBeNull();
    // Only the list was requested: no decide call could have been made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a list that could not be loaded", () => {
  it("says so and offers Retry, with the choice disabled and Run saying why it cannot run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const selection = setupProviderSelect(document);
    setupRequestForm(document, selection);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).toContain("Retry"));
    expect(get("#provider-problem").textContent).toContain(
      "The list of providers could not be loaded.",
    );
    expect(providerChoice().disabled).toBe(true);
    // Loaded, so the missing provider is the first reason each Run gives.
    await loadFilmExample();
    for (const button of runButtons()) {
      expect(button.disabled).toBe(false);
      expect(runNote(button)).toBe(NO_PROVIDER);
    }
  });

  it("treats a failure that is not the missing-key 503 as a failed load", async () => {
    answerProviders(Response.json({ ok: false, error: "Something went wrong." }, { status: 500 }));
    setupProviderSelect(document);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).toContain("Retry"));
    expect(get("#provider-problem").textContent).not.toContain("TYPESAFE_API_KEY");
  });

  it("refetches on Retry and fills the choice when the list loads", async () => {
    const fetchMock = answerProviders(
      Response.json({ ok: false, error: "Something went wrong." }, { status: 500 }),
      listed(typesafe, subq),
    );
    const selection = setupProviderSelect(document);
    setupRequestForm(document, selection);
    await vi.waitFor(() => expect(get(".provider-retry")).toBeTruthy());
    // The request starts empty, which also stops Run; an example makes it runnable.
    await loadFilmExample();

    get(".provider-retry").click();
    await vi.waitFor(() => expect(providerChoice().disabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(optionTexts()).toEqual(["TypeSafe Jev jev-1.13.0", "SubQ Snap subq-snap-preview"]);
    expect(get("#provider-problem").textContent).toBe("");
    for (const button of runButtons()) {
      expect(runNote(button)).toMatch(/^Checks the .+ request and sends it to TypeSafe Jev\.$/);
    }
    expect(document.activeElement).toBe(checkbox("typesafe"));
    // A retry that succeeds is not a user's choice, so it announces nothing.
    expect(get("#provider-status").textContent).toBe("");
  });

  it("moves focus to the setup notice when a retry ends in the missing-key 503", async () => {
    answerProviders(Response.json({ ok: false, error: "No." }, { status: 500 }), missingKeys());
    setupProviderSelect(document);
    await vi.waitFor(() => expect(get(".provider-retry")).toBeTruthy());

    get(".provider-retry").focus();
    get(".provider-retry").click();
    await vi.waitFor(() => expect(get("#provider-problem").textContent).toContain("deployment"));
    expect(document.activeElement).toBe(get("#provider-problem"));
    expect(get("#provider-problem").getAttribute("tabindex")).toBe("-1");
  });

  it("does not move focus to the setup notice when the page loads into it", async () => {
    answerProviders(missingKeys());
    setupProviderSelect(document);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).toContain("deployment"));
    expect(document.activeElement).not.toBe(get("#provider-problem"));
  });

  it("keeps a disabled Retry in place and announces the reload while it is in flight", async () => {
    let answer: (response: Response) => void = () => {};
    const fetchMock = vi
      .fn(async (_url: string, _init?: RequestInit) =>
        Response.json({ ok: false, error: "No." }, { status: 500 }),
      )
      .mockImplementationOnce(async () =>
        Response.json({ ok: false, error: "No." }, { status: 500 }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);
    setupProviderSelect(document);
    await vi.waitFor(() => expect(get(".provider-retry")).toBeTruthy());

    const retry = get(".provider-retry");
    retry.focus();
    retry.click();
    expect(get(".provider-retry")).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(retry);
    expect(get("#provider-status").textContent).toBe("Loading providers…");

    // Pressing a disabled Retry again must not start a second request.
    retry.click();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    answer(listed(typesafe));
    await vi.waitFor(() => expect(providerChoice().disabled).toBe(false));
    expect(get("#provider-status").textContent).toBe("");
    expect(document.activeElement).toBe(checkbox("typesafe"));
  });

  it("keeps the note and returns focus to Retry when the retry fails too", async () => {
    const failing = () => Response.json({ ok: false, error: "No." }, { status: 500 });
    const fetchMock = answerProviders(failing());
    setupProviderSelect(document);
    await vi.waitFor(() => expect(get(".provider-retry")).toBeTruthy());

    get(".provider-retry").focus();
    get(".provider-retry").click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(document.activeElement).toBe(get(".provider-retry")));
    expect(get("#provider-problem").textContent).toContain(
      "The list of providers could not be loaded.",
    );
  });
});

describe("Run follows the choice", () => {
  it('posts a "Score on a scale" request to the ticked provider\'s decide route', async () => {
    const fetchMock = answerProviders(listed(typesafe, subq));
    const selection = setupProviderSelect(document);
    setupRequestForm(document, selection);
    await vi.waitFor(() => expect(providerChoice().disabled).toBe(false));
    tick("subq");
    tick("typesafe", false);
    useType("score");
    await loadFilmExample();

    fetchMock.mockImplementation(async () => Response.json(noulResponse));
    get("#request-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/decide/subq");
  });

  it("posts to every ticked provider with one press (issue #101)", async () => {
    const fetchMock = answerProviders(listed(typesafe, subq, openai));
    const selection = setupProviderSelect(document);
    setupRequestForm(document, selection);
    await vi.waitFor(() => expect(providerChoice().disabled).toBe(false));
    tick("openai");
    await loadFilmExample();
    expect(runNote(runButtons()[0]!)).toBe(
      "Checks the Yes or no request and sends it to TypeSafe Jev and OpenAI Decisions.",
    );

    fetchMock.mockImplementation(async () => Response.json(noulResponse));
    get("#request-form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls.slice(1).map(([url]) => url)).toEqual([
      "/api/decide/typesafe",
      "/api/decide/openai",
    ]);
  });
});

describe("the protection notice on a deployed instance", () => {
  it("fills #protection-notice from the list's protection state and links the guide", async () => {
    answerProviders(
      listedWith(
        { mode: "unconfigured", detail: "Neither Cloudflare Access nor the opt-out is set." },
        typesafe,
      ),
    );
    await load();
    const notice = get("#protection-notice");
    expect(notice.hidden).toBe(false);
    expect(notice.hasAttribute("hidden")).toBe(false);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("provider calls are refused");
    expect(notice.textContent).toContain("Neither Cloudflare Access nor the opt-out is set.");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(DEPLOYMENT_GUIDE_URL);
    // The choice still works: the gate refuses runs, it does not hide them.
    expect(providerChoice().disabled).toBe(false);
    expect(runButtons().every((button) => !button.disabled)).toBe(true);
  });

  it("says an opted-out instance runs for anyone", async () => {
    answerProviders(listedWith({ mode: "opted_out" }, typesafe));
    await load();
    expect(get("#protection-notice").textContent).toContain("run up the provider bill");
  });

  it("stays empty, and in the accessibility tree, for a local instance and for a validated Access request", async () => {
    answerProviders(listed(typesafe));
    await load();
    expect(get("#protection-notice").textContent).toBe("");
    expect(get("#protection-notice").hidden).toBe(false);

    document.body.innerHTML = body;
    answerProviders(listedWith({ mode: "access", validated: true }, typesafe));
    await load();
    expect(get("#protection-notice").textContent).toBe("");
    expect(get("#protection-notice").hidden).toBe(false);
  });

  it("is in the page, empty and not hidden, from the first paint, so filling it is announced", () => {
    answerProviders(listed(typesafe));
    setupProviderSelect(document);
    const notice = get("#protection-notice");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.hasAttribute("hidden")).toBe(false);
    expect(notice.textContent).toBe("");
  });

  it("is cleared when a reload ends without a list", async () => {
    const fetchMock = answerProviders(
      listedWith({ mode: "opted_out" }, typesafe),
      Response.json({ ok: false, error: "No." }, { status: 500 }),
    );
    await load();
    expect(get("#protection-notice").textContent).not.toBe("");

    // The second load fails, so the notice no longer describes a list that is not there.
    document.body.innerHTML = body;
    await load();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(get("#protection-notice").textContent).toBe("");
    expect(get("#protection-notice").hidden).toBe(false);
  });
});
