// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { choiceExample, noulExample, scoreExample } from "../decision/examples.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupPanels } from "./panels.ts";

const page = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
// The page's own module script is left out: the test calls setupPanels itself.
const body = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);

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
    setupPanels(document);
    for (const primitive of ["noul", "choice", "score"]) {
      expect(viewButton(primitive, "tree").getAttribute("aria-pressed")).toBe("true");
      expect(get(`form[data-primitive="${primitive}"] [data-view-body="json"]`).hidden).toBe(true);
    }
  });

  it("serialises the request into the JSON view", () => {
    setupPanels(document);
    viewButton("choice", "json").click();
    expect(textarea("choice").value).toBe(JSON.stringify(choiceExample, null, 2));
    expect(viewButton("choice", "json").getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("decisionmachines3000:view:choice")).toBe("json");
  });

  it("ignores a view preference saved under the old key", () => {
    localStorage.setItem("jev-3000:view:score", "json");
    setupPanels(document);
    expect(viewButton("score", "json").getAttribute("aria-pressed")).toBe("false");
    expect(viewButton("score", "tree").getAttribute("aria-pressed")).toBe("true");
  });

  it("remembers the JSON view per panel", () => {
    localStorage.setItem("decisionmachines3000:view:score", "json");
    setupPanels(document);
    expect(viewButton("score", "json").getAttribute("aria-pressed")).toBe("true");
    expect(viewButton("noul", "tree").getAttribute("aria-pressed")).toBe("true");
  });

  it("does not write the stored preference while loading", () => {
    localStorage.setItem("decisionmachines3000:view:score", "json");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setupPanels(document);
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
    expect(() => setupPanels(document)).not.toThrow();
    viewButton("noul", "json").click();
    expect(viewButton("noul", "json").getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses to switch to the tree while the JSON is invalid", () => {
    setupPanels(document);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "json").getAttribute("aria-pressed")).toBe("true");
    expect(get("#noul-error").hidden).toBe(false);
    expect(textarea("noul").getAttribute("aria-invalid")).toBe("true");
    expect(status("noul").textContent).toBe("Fix the JSON to switch to the tree.");
  });

  it("refuses to switch to the tree when the JSON fails validation", () => {
    setupPanels(document);
    viewButton("noul", "json").click();
    textarea("noul").value = JSON.stringify({ ...noulExample, state: "" });
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "json").getAttribute("aria-pressed")).toBe("true");
    expect(get("#noul-error").textContent).toMatch(/"state" is empty/);
  });

  it("clears a shown JSON error as soon as typing makes the text valid", () => {
    setupPanels(document);
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
    setupPanels(document);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    textarea("noul").value = `{"primitive": "noul"}`;
    textarea("noul").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#noul-error").hidden).toBe(false);
    expect(textarea("noul").getAttribute("aria-invalid")).toBe("true");
  });

  it("rebuilds the tree from edited JSON", () => {
    setupPanels(document);
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
    setupPanels(document);
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
    setupPanels(document);
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const sent = fetchMock.mock.calls[0]?.[1].body;
    if (typeof sent !== "string") throw new Error("Expected a JSON string body.");
    expect(JSON.parse(sent)).toStrictEqual(noulExample);
  });

  it("reports the first tree problem in the status line instead of posting", () => {
    const fetchMock = mockFetch();
    setupPanels(document);
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
    setupPanels(document);
    submit("noul");
    await vi.waitFor(() => expect(document.body.textContent).toContain("was not JSON"));
    expect(document.body.textContent).not.toMatch(/Jev|TypeSafe/);
  });

  it("posts the JSON text unchanged from the JSON view", async () => {
    const fetchMock = mockFetch();
    setupPanels(document);
    viewButton("noul", "json").click();
    const text = JSON.stringify(noulExample);
    textarea("noul").value = text;
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1].body).toBe(text);
  });
});
