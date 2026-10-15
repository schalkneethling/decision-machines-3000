// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { choiceExample, noulExample, scoreExample } from "../decision/examples.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupPanels } from "./panels.ts";
import type { ProviderSelection } from "./provider-select.ts";

const page = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
// The page's own module script is left out: the test calls setupPanels itself.
const body = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);

const typesafe = toProviderSummary(PROVIDERS.typesafe);
const subq = toProviderSummary(PROVIDERS.subq);

/** A provider selection the test drives by hand: `choose(undefined)` is "no provider". */
function selectionOf(initial: ProviderSummary | undefined) {
  let current: ProviderSummary | undefined = initial;
  const listeners: ((provider: ProviderSummary | undefined) => void)[] = [];
  const selection: ProviderSelection = {
    current: () => current,
    host: () => (current === undefined ? undefined : { connectionMetrics: false }),
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

function form(primitive: string): HTMLFormElement {
  return get<HTMLFormElement>(`form[data-primitive="${primitive}"]`);
}

function viewButton(primitive: string, view: "tree" | "json"): HTMLButtonElement {
  return get<HTMLButtonElement>(`form[data-primitive="${primitive}"] [data-view="${view}"]`);
}

function textarea(primitive: string): HTMLTextAreaElement {
  return get<HTMLTextAreaElement>(`#${primitive}-request`);
}

function status(primitive: string): HTMLElement {
  return get(`#${primitive}-status`);
}

function submit(primitive: string): void {
  form(primitive).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function mockFetch() {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify(noulResponse), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = body;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("view switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens every panel in the tree", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    for (const primitive of ["noul", "choice", "score"]) {
      expect(viewButton(primitive, "tree").getAttribute("aria-pressed")).toBe("true");
      expect(get(`form[data-primitive="${primitive}"] [data-view-body="json"]`).hidden).toBe(true);
    }
  });

  it("serialises the request into the JSON view", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("choice", "json").click();
    expect(textarea("choice").value).toBe(JSON.stringify(choiceExample, null, 2));
    expect(viewButton("choice", "json").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("decisionmachines3000:view:choice")).toBe("json");
  });

  it("ignores a view preference saved under the old key", () => {
    localStorage.setItem("jev-3000:view:score", "json");
    setupPanels(document, selectionOf(typesafe).selection);
    expect(viewButton("score", "json").getAttribute("aria-pressed")).toBe("false");
    expect(viewButton("score", "tree").getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers the JSON view per panel", () => {
    localStorage.setItem("decisionmachines3000:view:score", "json");
    setupPanels(document, selectionOf(typesafe).selection);
    expect(viewButton("score", "json").getAttribute("aria-pressed")).toBe("true");
    expect(viewButton("noul", "tree").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not write the stored preference while loading", () => {
    localStorage.setItem("decisionmachines3000:view:score", "json");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setupPanels(document, selectionOf(typesafe).selection);
    expect(setItem).not.toHaveBeenCalled();
    expect(viewButton("score", "json").getAttribute("aria-pressed")).toBe("true");
    expect(textarea("score").value).toBe(JSON.stringify(scoreExample, null, 2));
  });

  it("opens in the tree when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    expect(() => setupPanels(document, selectionOf(typesafe).selection)).not.toThrow();
    viewButton("noul", "json").click();
    expect(viewButton("noul", "json").getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses to switch to the tree while the JSON is invalid", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "json").getAttribute("aria-pressed")).toBe("true");
    expect(get("#noul-error").hidden).toBe(false);
    expect(textarea("noul").getAttribute("aria-invalid")).toBe("true");
    expect(status("noul").textContent).toBe("Fix the JSON to switch to the tree.");
  });

  it("refuses to switch to the tree when the JSON fails validation", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = JSON.stringify({ ...noulExample, state: "" });
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "json").getAttribute("aria-pressed")).toBe("true");
    expect(get("#noul-error").textContent).toMatch(/"state" is empty/);
  });

  it("clears a shown JSON error as soon as typing makes the text valid", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    expect(get("#noul-error").hidden).toBe(false);

    textarea("noul").value = JSON.stringify(noulExample);
    textarea("noul").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#noul-error").hidden).toBe(true);
    expect(get("#noul-error").textContent).toBe("");
    expect(textarea("noul").hasAttribute("aria-invalid")).toBe(false);
    expect(status("noul").textContent).toBe("");
  });

  it("keeps the JSON error while the text is still invalid", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    textarea("noul").value = `{"primitive": "noul"}`;
    textarea("noul").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#noul-error").hidden).toBe(false);
    expect(textarea("noul").getAttribute("aria-invalid")).toBe("true");
  });

  it("rebuilds the tree from edited JSON", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    const edited = { ...noulExample, questions: { only: { instructions: "Is it good?" } } };
    textarea("noul").value = JSON.stringify(edited);
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "tree").getAttribute("aria-pressed")).toBe("true");
    expect(
      [...form("noul").querySelectorAll<HTMLInputElement>('[data-control="id"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["only"]);
  });

  it("keeps tree edits through a round trip to JSON and back", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    const id = form("noul").querySelector<HTMLInputElement>('[data-control="id"]');
    if (id === null) throw new Error("No id field.");
    id.value = "would_recommend";
    id.dispatchEvent(new Event("input", { bubbles: true }));
    viewButton("noul", "json").click();
    expect(JSON.parse(textarea("noul").value).questions).toHaveProperty("would_recommend");
    viewButton("noul", "tree").click();
    expect(form("noul").querySelector<HTMLInputElement>('[data-control="id"]')?.value).toBe(
      "would_recommend",
    );
  });
});

describe("run", () => {
  it("posts the tree's request", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/decide/typesafe");
    const sent = fetchMock.mock.calls[0]?.[1].body;
    if (typeof sent !== "string") throw new Error("Expected a JSON string body.");
    expect(JSON.parse(sent)).toStrictEqual(noulExample);
  });

  it("names the provider that answered in the readout", async () => {
    mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    submit("noul");
    await vi.waitFor(() =>
      expect(document.querySelector(".reading-meta")?.textContent).toBe(
        "Answered by TypeSafe Jev (jev-1.13.0) in 474 ms using 452 input tokens.",
      ),
    );
  });

  it("tells onAnswered about a success, and only a success", async () => {
    const fetchMock = mockFetch();
    const onAnswered = vi.fn();
    setupPanels(document, selectionOf(typesafe).selection, { onAnswered });

    submit("noul");
    await vi.waitFor(() => expect(onAnswered).toHaveBeenCalledOnce());
    expect(onAnswered).toHaveBeenCalledWith(noulResponse);

    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ ok: false, error: "No." }), { status: 502 }),
    );
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(document.querySelector("#readout-body .readout-error")).not.toBeNull(),
    );
    expect(onAnswered).toHaveBeenCalledOnce();
  });

  it("keeps the JSON out of the live region after a success and after a failure", async () => {
    mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    submit("noul");
    await vi.waitFor(() => expect(document.querySelector(".reading-meta")).not.toBeNull());
    const live = get("[aria-live]");
    expect(live.querySelector("details, pre")).toBeNull();
    expect(get("#wire-body").querySelectorAll("details")).toHaveLength(2);
    expect(live.contains(get("#wire-body"))).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "Nope.", detail: "HTTP 401" }), {
            status: 502,
          }),
      ),
    );
    submit("noul");
    await vi.waitFor(() => expect(live.querySelector('[role="alert"]')).not.toBeNull());
    expect(live.querySelector("details, pre")).toBeNull();
    const raw = get("#wire-body details");
    expect(raw.querySelector("summary")?.textContent).toBe("Raw response");
  });

  it("says a 502 page that is not JSON is not JSON, rather than unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );
    setupPanels(document, selectionOf(typesafe).selection);
    submit("noul");
    await vi.waitFor(() =>
      expect(document.querySelector("#readout-body")?.textContent).toContain(
        "The decision endpoint answered with HTTP 502 and a body that is not JSON.",
      ),
    );
    expect(document.querySelector("#readout-body")?.textContent).not.toMatch(/could not reach/i);
  });

  it("reports the first tree problem in the status line instead of posting", () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    const instructions = form("noul").querySelectorAll<HTMLTextAreaElement>(
      '[data-control="instructions"]',
    )[1];
    if (instructions === undefined) throw new Error("No second question.");
    instructions.value = "";
    instructions.dispatchEvent(new Event("input", { bubbles: true }));
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(status("noul").textContent).toBe("Write the question you want answered.");
    expect(status("noul").dataset.tone).toBe("alert");
    expect(document.activeElement).toBe(instructions);
  });

  it("names no provider when the endpoint answers with a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { status: 200 })),
    );
    setupPanels(document, selectionOf(typesafe).selection);
    submit("noul");
    await vi.waitFor(() => expect(document.body.textContent).toContain("a body that is not JSON"));
    expect(document.body.textContent).not.toMatch(/Jev|TypeSafe/);
  });

  it("posts the JSON text unchanged from the JSON view", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    const text = JSON.stringify(noulExample);
    textarea("noul").value = text;
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(text);
  });
});

describe("provider selection", () => {
  /** A copy of `provider` whose Score levels stop at `max`, or have no upper limit. */
  function withLevelLimit(provider: ProviderSummary, max?: number): ProviderSummary {
    return {
      ...provider,
      capabilities: {
        ...provider.capabilities,
        scoreLevels: max === undefined ? { min: 2 } : { min: 2, max },
      },
    };
  }

  function withoutLevelLimit(provider: ProviderSummary): ProviderSummary {
    return withLevelLimit(provider);
  }

  function runButton(primitive: string): HTMLButtonElement {
    return get<HTMLButtonElement>(`form[data-primitive="${primitive}"] .run`);
  }

  it("sends Run to the selected provider and names it while waiting", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    choose(subq);
    submit("score");
    expect(get("#readout-body").textContent).toBe("Asking SubQ Snap…");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/decide/subq");
  });

  it("disables every Run button while there is no provider, and enables them when one arrives", () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(undefined);
    setupPanels(document, selection);
    for (const primitive of ["noul", "choice", "score"]) {
      expect(runButton(primitive).disabled).toBe(true);
    }
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();

    choose(typesafe);
    for (const primitive of ["noul", "choice", "score"]) {
      expect(runButton(primitive).disabled).toBe(false);
    }

    choose(undefined);
    expect(runButton("noul").disabled).toBe(true);
  });

  /** Eleven levels, which the catalog's providers refuse and a provider with no maximum accepts. */
  function elevenLevels(): string {
    const criteria = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
    return JSON.stringify({ ...scoreExample, criteria });
  }

  it("clears a panel's alert when the new provider accepts the request", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(unlimited);
    setupPanels(document, selection);
    // With no limit, 11 levels are fine, and the tree shows them.
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();
    expect(viewButton("score", "tree").getAttribute("aria-pressed")).toBe("true");

    // A provider whose maximum is 10 refuses them when Run is pressed.
    choose(typesafe);
    submit("score");
    expect(status("score").dataset.tone).toBe("alert");
    expect(status("score").textContent).not.toBe("");

    choose(unlimited);
    expect(status("score").textContent).toBe("");
    expect(runButton("score").disabled).toBe(false);
  });

  it("clears the JSON view's error when the new provider accepts the request", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();
    expect(get("#score-error").hidden).toBe(false);
    expect(status("score").dataset.tone).toBe("alert");
    // The refused switch left focus in the textarea; the viewer then moves on to another Run button.
    const elsewhere = runButton("noul");
    elsewhere.focus();

    choose(unlimited);
    expect(get("#score-error").hidden).toBe(true);
    expect(status("score").textContent).toBe("");
    expect(runButton("score").disabled).toBe(false);
    expect(document.activeElement).toBe(elsewhere);
  });

  it("updates a shown JSON error to the new provider's limit without moving focus", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();
    expect(get("#score-error").textContent).toContain("at most 10");
    const elsewhere = runButton("noul");
    elsewhere.focus();

    choose(withLevelLimit(subq, 6));
    expect(get("#score-error").hidden).toBe(false);
    expect(get("#score-error").textContent).toContain("at most 6");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("shows nothing in the JSON view when a provider change makes valid JSON invalid, and Run then reports it", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(unlimited);
    setupPanels(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    // Run finds nothing wrong yet, because this provider takes 11 levels.
    textarea("score").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#score-error").hidden).toBe(true);

    choose(typesafe);
    // Nothing was shown, so nothing is shown now; Run reports it.
    expect(get("#score-error").hidden).toBe(true);
    submit("score");
    expect(get("#score-error").hidden).toBe(false);
  });

  it("replaces an alert with the new provider's own limit in the tree view", () => {
    const { selection, choose } = selectionOf(withoutLevelLimit(subq));
    setupPanels(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();

    choose(typesafe);
    submit("score");
    expect(status("score").dataset.tone).toBe("alert");
    expect(status("score").textContent).toContain("at most 10");

    choose(withLevelLimit(subq, 6));
    expect(status("score").dataset.tone).toBe("alert");
    expect(status("score").textContent).toContain("at most 6");
    expect(status("score").textContent).not.toContain("at most 10");
  });
});
