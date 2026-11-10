// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDERS } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { Protection } from "../providers/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupPanels } from "./panels.ts";
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

const STORAGE_KEY = "decisionmachines3000:provider";

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}.`);
  return found;
}

function providerSelect(): HTMLSelectElement {
  return get<HTMLSelectElement>("#provider-select");
}

function optionTexts(): string[] {
  return [...providerSelect().options].map((option) => option.textContent ?? "");
}

function runButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("form[data-primitive] .run")];
}

/** The sentence a Run button's aria-describedby points at: what it will send, or why it cannot. */
function runNote(button: HTMLButtonElement): string {
  return document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
}

const NO_PROVIDER =
  "No provider is available yet. The Provider area at the top of the page says why.";

/** Loads the film example into every panel, since an empty panel's Run sends nothing (issues #58 and #95). */
async function loadFilmExamples(): Promise<void> {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    'form[data-primitive] .load-example[data-example="film"]',
  )) {
    button.click();
  }
  await vi.waitFor(() => {
    for (const line of document.querySelectorAll("form[data-primitive] .panel-status")) {
      expect(line.textContent).toBe("Film example loaded.");
    }
  });
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

/** Loads the page's select and waits until the list has been handled. */
async function load() {
  const selection = setupProviderSelect(document);
  await vi.waitFor(() => {
    expect(providerSelect().options[0]?.textContent).not.toBe("Loading providers…");
  });
  return selection;
}

function change(id: string): void {
  providerSelect().value = id;
  providerSelect().dispatchEvent(new Event("change", { bubbles: true }));
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
  it("has exactly the providers the instance lists, in that order, with name and model", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(optionTexts()).toEqual(["TypeSafe Jev jev-1.13.0", "SubQ Snap subq-snap-preview"]);
    expect([...providerSelect().options].map((option) => option.value)).toEqual([
      "typesafe",
      "subq",
    ]);
  });

  it("hands the listed providers to the panels, empty until the list loads", async () => {
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

  it("starts disabled with a loading option until the list arrives", () => {
    answerProviders(listed(typesafe));
    setupProviderSelect(document);
    expect(providerSelect().disabled).toBe(true);
    expect(optionTexts()).toEqual(["Loading providers…"]);
  });

  it("enables the select once the list has loaded", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(providerSelect().disabled).toBe(false);
  });
});

describe("the native select structure that browsers without appearance: base-select show", () => {
  // happy-dom has no styled picker, so it renders the structure such a browser shows.
  it("is a labelled <select> whose option text has a space between name and model", async () => {
    answerProviders(listed(typesafe, subq, openai));
    await load();
    const select = providerSelect();
    expect(select).toBeInstanceOf(HTMLSelectElement);
    const label = document.querySelector<HTMLLabelElement>('label[for="provider-select"]');
    expect(label?.textContent).toBe("Provider");
    const texts = [...select.options].map((option) => option.text);
    expect(texts).toContain("OpenAI Decisions gpt-6-luna");
    expect(texts).not.toContain("OpenAI Decisionsgpt-6-luna");
  });

  it("keeps the button and selectedcontent first in the select, ahead of the options", async () => {
    answerProviders(listed(typesafe));
    await load();
    const [first] = providerSelect().children;
    expect(first?.tagName).toBe("BUTTON");
    expect(first?.firstElementChild?.tagName).toBe("SELECTEDCONTENT");
    expect(providerSelect().options).toHaveLength(1);
  });
});

describe("the stored choice", () => {
  it("selects a stored provider that is configured", async () => {
    localStorage.setItem(STORAGE_KEY, "subq");
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(providerSelect().value).toBe("subq");
    expect(selection.current()?.id).toBe("subq");
  });

  it("selects the first provider and updates the store when the stored one is not configured", async () => {
    localStorage.setItem(STORAGE_KEY, "openai");
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(providerSelect().value).toBe("typesafe");
    expect(selection.current()?.id).toBe("typesafe");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("typesafe");
  });

  it("selects the first provider and writes nothing when nothing is stored", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(providerSelect().value).toBe("typesafe");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["an empty string", ""],
    ["the key name __proto__", "__proto__"],
    ["a name that only looks like an id", "toString"],
  ])("selects the first provider and replaces a stored value that is %s", async (_name, stored) => {
    localStorage.setItem(STORAGE_KEY, stored);
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(providerSelect().value).toBe("typesafe");
    expect(selection.current()?.id).toBe("typesafe");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("typesafe");
  });

  it("stores a user's choice", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    change("subq");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("subq");
  });

  it("still works when every storage read and write throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    answerProviders(listed(typesafe, subq));
    const selection = await load();
    expect(providerSelect().value).toBe("typesafe");
    expect(() => change("subq")).not.toThrow();
    expect(selection.current()?.id).toBe("subq");
  });
});

describe("the capability line (issue #98)", () => {
  const capability = () => get("#provider-capability");

  it("is in the page empty, and is plain text, not a live region", () => {
    expect(capability().textContent).toBe("");
    expect(capability().hasAttribute("role")).toBe(false);
    expect(capability().hasAttribute("aria-live")).toBe(false);
  });

  it("states a text-only provider's capability on the first load, with nothing announced", async () => {
    answerProviders(listed(typesafe, subq));
    await load();
    expect(capability().textContent).toBe("TypeSafe Jev: Text only, no images.");
    expect(get("#provider-status").textContent).toBe("");
  });

  it("states a stored image provider's capability on the first load", async () => {
    localStorage.setItem(STORAGE_KEY, "subq");
    answerProviders(listed(typesafe, subq));
    await load();
    expect(capability().textContent).toBe(
      "SubQ Snap: Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB each and 64 KB in total.",
    );
    expect(get("#provider-status").textContent).toBe("");
  });

  it("follows every change, and the status line announces the same capability sentence", async () => {
    answerProviders(listed(typesafe, subq, openai));
    await load();
    change("openai");
    expect(capability().textContent).toBe(
      "OpenAI Decisions: Image input available: up to 8 PNG, JPEG, or WebP images, 64 KB each and 64 KB in total.",
    );
    expect(get("#provider-status").textContent).toBe(
      "Provider set to OpenAI Decisions. Image input available: up to 8 PNG, JPEG, or WebP images, 64 KB each and 64 KB in total.",
    );
    change("typesafe");
    expect(capability().textContent).toBe("TypeSafe Jev: Text only, no images.");
    expect(get("#provider-status").textContent).toBe(
      "Provider set to TypeSafe Jev. Text only, no images.",
    );
  });

  it("is the line sighted viewers read, because the status line is visually hidden", () => {
    expect(get("#provider-status").classList.contains("visually-hidden")).toBe(true);
    expect(capability().classList.contains("visually-hidden")).toBe(false);
  });

  it("is filled after a Retry, and cleared when no provider is available", async () => {
    answerProviders(Response.json({ ok: false, error: "No." }, { status: 500 }), listed(typesafe));
    await load();
    expect(capability().textContent).toBe("");
    get(".provider-retry").click();
    await vi.waitFor(() => expect(providerSelect().disabled).toBe(false));
    expect(capability().textContent).toBe("TypeSafe Jev: Text only, no images.");
  });

  it("stays empty when the instance has no provider key", async () => {
    answerProviders(missingKeys());
    await load();
    expect(capability().textContent).toBe("");
  });
});

describe("the status line", () => {
  it("is empty after the page loads without user action", async () => {
    localStorage.setItem(STORAGE_KEY, "subq");
    answerProviders(listed(typesafe, subq));
    await load();
    expect(get("#provider-status").textContent).toBe("");
    expect(get("#provider-status").getAttribute("role")).toBe("status");
  });

  it("announces a change with the image capability sentence", async () => {
    answerProviders(listed(typesafe, subq, openai));
    await load();
    change("subq");
    expect(get("#provider-status").textContent).toBe(
      "Provider set to SubQ Snap. Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB each and 64 KB in total.",
    );
    change("typesafe");
    expect(get("#provider-status").textContent).toBe(
      "Provider set to TypeSafe Jev. Text only, no images.",
    );
    change("openai");
    expect(get("#provider-status").textContent).toBe(
      "Provider set to OpenAI Decisions. Image input available: up to 8 PNG, JPEG, or WebP images, 64 KB each and 64 KB in total.",
    );
  });
});

describe("the vocabulary legend", () => {
  it("stays hidden until a provider is selected", () => {
    answerProviders(listed(typesafe));
    setupProviderSelect(document);
    expect(get("#provider-vocabulary").hidden).toBe(true);
  });

  it("lists the selected provider's words and follows a change", async () => {
    answerProviders(listed(typesafe, openai));
    await load();
    const legend = get("#provider-vocabulary");
    expect(legend.hidden).toBe(false);
    expect(legend.querySelector("summary")?.textContent).toBe("Words TypeSafe Jev uses");
    expect(legend.textContent).not.toContain("predicate");

    change("openai");
    expect(legend.querySelector("summary")?.textContent).toBe("Words OpenAI Decisions uses");
    const codes = [...legend.querySelectorAll("code")].map((code) => code.textContent);
    expect(codes).toContain("predicate");
    expect(codes).toContain("input");
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
    expect(providerSelect().getAttribute("aria-describedby")).toBe("provider-problem");
  });

  it("disables the select, and every Run button says no provider is available and sends nothing", async () => {
    const fetchMock = answerProviders(missingKeys());
    const selection = setupProviderSelect(document);
    setupPanels(document, selection);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).not.toBe(""));
    await loadFilmExamples();
    expect(providerSelect().disabled).toBe(true);
    expect(selection.current()).toBeUndefined();
    expect(runButtons()).toHaveLength(3);
    // Run stays reachable by keyboard and says why it cannot run (issue #95).
    for (const button of runButtons()) {
      expect(button.disabled).toBe(false);
      expect(runNote(button)).toBe(NO_PROVIDER);
    }
    get("form[data-primitive='noul']").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    // The select cannot take focus, so the summary names the problem without a link.
    expect(get("#noul-summary").textContent).toContain(NO_PROVIDER);
    expect(get("#noul-summary").querySelector("a")).toBeNull();
    // Only the list was requested: no decide call could have been made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("a list that could not be loaded", () => {
  it("says so and offers Retry, with the select disabled and Run saying why it cannot run", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const selection = setupProviderSelect(document);
    setupPanels(document, selection);
    await vi.waitFor(() => expect(get("#provider-problem").textContent).toContain("Retry"));
    expect(get("#provider-problem").textContent).toContain(
      "The list of providers could not be loaded.",
    );
    expect(providerSelect().disabled).toBe(true);
    // Loaded, so the missing provider is the first reason each Run gives.
    await loadFilmExamples();
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

  it("refetches on Retry and fills the select when the list loads", async () => {
    const fetchMock = answerProviders(
      Response.json({ ok: false, error: "Something went wrong." }, { status: 500 }),
      listed(typesafe, subq),
    );
    const selection = setupProviderSelect(document);
    setupPanels(document, selection);
    await vi.waitFor(() => expect(get(".provider-retry")).toBeTruthy());
    // The panels start empty, which also stops Run; an example makes them runnable.
    await loadFilmExamples();

    get(".provider-retry").click();
    await vi.waitFor(() => expect(providerSelect().disabled).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(optionTexts()).toEqual(["TypeSafe Jev jev-1.13.0", "SubQ Snap subq-snap-preview"]);
    expect(get("#provider-problem").textContent).toBe("");
    for (const button of runButtons()) {
      expect(runNote(button)).toMatch(/^Checks the .+ request and sends it to TypeSafe Jev\.$/);
    }
    expect(document.activeElement).toBe(providerSelect());
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
    await vi.waitFor(() => expect(providerSelect().disabled).toBe(false));
    expect(get("#provider-status").textContent).toBe("");
    expect(document.activeElement).toBe(providerSelect());
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

describe("Run follows the select", () => {
  it('posts the "Score on a scale" panel to the selected provider\'s decide route', async () => {
    const fetchMock = answerProviders(listed(typesafe, subq));
    const selection = setupProviderSelect(document);
    setupPanels(document, selection);
    await vi.waitFor(() => expect(providerSelect().disabled).toBe(false));
    change("subq");
    await loadFilmExamples();

    fetchMock.mockImplementation(async () => Response.json(noulResponse));
    get("form[data-primitive='score']").dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/decide/subq");
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
    // The select still works: the gate refuses runs, it does not hide them.
    expect(providerSelect().disabled).toBe(false);
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
