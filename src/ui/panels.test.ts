// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { choiceExample, imageExamples, noulExample, scoreExample } from "../decision/examples.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { fileOf, pngBytes } from "./fixtures/images.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { setupPanels } from "./panels.ts";
import type { ProviderSelection } from "./provider-select.ts";
import { capitalise } from "./text.ts";

const page = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
// The page's own module script is left out: the test calls setupPanels itself.
const body = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);

const typesafe = toProviderSummary(PROVIDERS.typesafe);
const subq = toProviderSummary(PROVIDERS.subq);
const openai = toProviderSummary(PROVIDERS.openai);

const PRIMITIVES = ["noul", "choice", "score"] as const;

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

function loadButton(primitive: string, set: "film" | "images"): HTMLButtonElement {
  return get<HTMLButtonElement>(
    `form[data-primitive="${primitive}"] .load-example[data-example="${set}"]`,
  );
}

function textarea(primitive: string): HTMLTextAreaElement {
  return get<HTMLTextAreaElement>(`#${primitive}-request`);
}

function status(primitive: string): HTMLElement {
  return get(`#${primitive}-status`);
}

function runButton(primitive: string): HTMLButtonElement {
  return get<HTMLButtonElement>(`form[data-primitive="${primitive}"] .run`);
}

function emptyMessage(primitive: string): HTMLElement {
  return get(`form[data-primitive="${primitive}"] .panel-empty`);
}

/** The error summary at the top of a panel; empty while it lists nothing. */
function summary(primitive: string): HTMLElement {
  return get(`#${primitive}-summary`);
}

/** What the summary lists, each as its text and the href of its link, or null for a problem without one. */
function summaryItems(primitive: string): { text: string; href: string | null }[] {
  return [...summary(primitive).querySelectorAll("li")].map((item) => ({
    text: item.textContent ?? "",
    href: item.querySelector("a")?.getAttribute("href") ?? null,
  }));
}

/** Follows the summary link whose text is `text`. */
function followSummaryLink(primitive: string, text: string): void {
  const link = [...summary(primitive).querySelectorAll("a")].find(
    (candidate) => candidate.textContent === text,
  );
  if (link === undefined) throw new Error(`The ${primitive} summary has no link "${text}".`);
  link.click();
}

/** The sentence Run's aria-describedby points at. */
function runNote(primitive: string): string {
  const id = runButton(primitive).getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

/** Checks that an untouched panel's Run is described by the empty-state message, and its own note is hidden. */
function expectDescribedByEmptyMessage(primitive: string): void {
  expect(runButton(primitive).getAttribute("aria-describedby")).toBe(`${primitive}-empty`);
  expect(get(`#${primitive}-empty`)).toBe(emptyMessage(primitive));
  expect(get(`#${primitive}-run-note`).hidden).toBe(true);
}

const EMPTY_PANEL = "Load an example or write a question to run this panel.";
const NO_PROVIDER =
  "No provider is available yet. The Provider area at the top of the page says why.";

function stateField(primitive: string): HTMLTextAreaElement {
  return get<HTMLTextAreaElement>(
    `form[data-primitive="${primitive}"] [data-for="state"][data-control="state"]`,
  );
}

function submit(primitive: string): void {
  form(primitive).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

/** Presses "Load film example" in a panel and waits for the status line to say it loaded. */
async function loadFilm(primitive: string): Promise<void> {
  loadButton(primitive, "film").click();
  await vi.waitFor(() => expect(status(primitive).textContent).toBe("Film example loaded."));
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * A `fetch` that serves every sample picture at once except the first, which
 * waits until the returned function is called, so a test can act mid-load.
 */
function holdFirstSample(): () => void {
  let serve: () => void = () => {};
  const first = sampleBytes("picture-1.png");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((resolve) => {
          const image = imageExamples.images.find((candidate) => candidate.url === url);
          if (image === undefined) throw new Error(`Unexpected fetch of ${url}.`);
          if (image.name === "picture-1.png") {
            serve = () => resolve(new Response(first, { status: 200 }));
          } else {
            resolve(new Response(sampleBytes(image.name), { status: 200 }));
          }
        }),
    ),
  );
  return () => serve();
}

/** Lets every pending promise settle, so an in-flight load has run to its end. */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The committed sample picture `name`, as the browser would fetch it. */
function sampleBytes(name: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    readFileSync(resolve(import.meta.dirname, "../decision/examples/images", name)),
  );
}

/** A `fetch` that answers the decide route with the Noul fixture and serves the sample pictures. */
function mockFetch(options: { failing?: string } = {}) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    const sample = imageExamples.images.find((image) => image.url === url);
    if (sample !== undefined) {
      if (sample.name === options.failing) return new Response("", { status: 404 });
      return new Response(sampleBytes(sample.name), { status: 200 });
    }
    return new Response(JSON.stringify(noulResponse), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The decide calls `fetchMock` received, leaving out the sample pictures. */
function decideCalls(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.filter(([url]) => url.startsWith("/api/"));
}

function emptyJson(primitive: string): string {
  return JSON.stringify({ primitive, state: "", questions: {} }, null, 2);
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = body;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the empty start (issue #58)", () => {
  it("opens every panel empty, with the message shown, Run reachable and described, and nothing announced", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    for (const primitive of PRIMITIVES) {
      expect(emptyMessage(primitive).hidden).toBe(false);
      expect(emptyMessage(primitive).textContent).toContain("Load an example above");
      // Run stays in the tab order (issue #95), and its description says why it cannot run yet.
      expect(runButton(primitive).disabled).toBe(false);
      expect(runButton(primitive).hasAttribute("aria-disabled")).toBe(false);
      runButton(primitive).focus();
      expect(document.activeElement).toBe(runButton(primitive));
      // The empty-state message describes Run, so the hidden note does not repeat it.
      expectDescribedByEmptyMessage(primitive);
      expect(summary(primitive).childElementCount).toBe(0);
      expect(status(primitive).textContent).toBe("");
      expect(get(`form[data-primitive="${primitive}"] .attachments-status`).textContent).toBe("");
      expect(stateField(primitive).value).toBe("");
      expect(form(primitive).querySelectorAll('[data-control="id"]')).toHaveLength(0);
    }
  });

  it("shows the same empty request in the JSON view", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("choice", "json").click();
    expect(textarea("choice").value).toBe(emptyJson("choice"));
    expect(JSON.parse(textarea("choice").value)).toEqual({
      primitive: "choice",
      state: "",
      questions: {},
    });
  });

  it("posts nothing when Run is pressed on an untouched panel, and moves focus to a summary that says why", () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(undefined);
    setupPanels(document, selection);
    choose(subq);
    runButton("noul").focus();
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    // The GOV.UK error summary: a box with a heading and one link per problem. Focus moving
    // to it is what makes a screen reader read it, so it is not also an alert.
    expect(summary("noul").hasAttribute("role")).toBe(false);
    expect(summary("noul").getAttribute("tabindex")).toBe("-1");
    expect(summary("noul").querySelector("h3")?.textContent).toBe(
      "The Noul request cannot be sent yet",
    );
    expect(summaryItems("noul")).toEqual([{ text: EMPTY_PANEL, href: "#noul-load-film" }]);
    expect(document.activeElement).toBe(summary("noul"));
    // The summary says the problem, so the status line does not repeat it.
    expect(status("noul").textContent).toBe("");
    // Only the pressed panel shows a summary.
    expect(summary("choice").childElementCount).toBe(0);

    followSummaryLink("noul", EMPTY_PANEL);
    expect(document.activeElement).toBe(loadButton("noul", "film"));
  });

  it("hides the message on the first edit, and Run then lists the request's problems and focuses the summary", () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    type(stateField("noul"), "A review.");
    expect(emptyMessage("noul").hidden).toBe(true);
    // Once edited, Run is described by its own note, which is now shown.
    expect(runButton("noul").getAttribute("aria-describedby")).toBe("noul-run-note");
    expect(get("#noul-run-note").hidden).toBe(false);
    expect(runNote("noul")).toBe("Checks the Noul request and sends it to TypeSafe Jev.");
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems("noul")).toEqual([
      { text: "Add at least one question.", href: "#noul-tree-questions-issue" },
    ]);
    expect(status("noul").textContent).toBe("");
    expect(document.activeElement).toBe(summary("noul"));
    followSummaryLink("noul", "Add at least one question.");
    expect(document.activeElement?.textContent).toBe("Add question");
  });

  it("counts typing in the JSON view as an edit", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("score", "json").click();
    type(textarea("score"), `{"primitive": "score"`);
    expect(emptyMessage("score").hidden).toBe(true);
    expect(runNote("score")).toBe("Checks the Score request and sends it to TypeSafe Jev.");
  });

  it("drops the empty-panel problem from a shown summary once the panel is edited, without moving focus", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    submit("noul");
    expect(summaryItems("noul")).toHaveLength(1);
    stateField("noul").focus();
    type(stateField("noul"), "A review.");
    // Fixed problems leave quietly; the new ones wait for the next press of Run.
    expect(summary("noul").childElementCount).toBe(0);
    expect(document.activeElement).toBe(stateField("noul"));
  });

  it("lists every reason at once, and links to the provider select while it can take focus", () => {
    setupPanels(document, selectionOf(undefined).selection);
    submit("noul");
    expect(summaryItems("noul")).toEqual([
      { text: EMPTY_PANEL, href: "#noul-load-film" },
      // The page's select is disabled until providers load, so this problem has no link.
      { text: NO_PROVIDER, href: null },
    ]);

    get<HTMLSelectElement>("#provider-select").disabled = false;
    submit("noul");
    expect(summaryItems("noul")).toEqual([
      { text: EMPTY_PANEL, href: "#noul-load-film" },
      { text: "Choose a provider to run this panel.", href: "#provider-select" },
    ]);
    expect(document.activeElement).toBe(summary("noul"));
    followSummaryLink("noul", "Choose a provider to run this panel.");
    expect(document.activeElement).toBe(get("#provider-select"));
  });

  it("puts both load buttons in a labelled group before the view switch", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    for (const [primitive, name] of [
      ["noul", "Noul"],
      ["choice", "Choice"],
      ["score", "Score"],
    ] as const) {
      const group = get(`form[data-primitive="${primitive}"] .examples`);
      expect(group.getAttribute("role")).toBe("group");
      expect(group.getAttribute("aria-label")).toBe(`Examples for ${name}`);
      const buttons = [...group.querySelectorAll("button")];
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        "Load film example",
        "Load image example",
      ]);
      for (const button of buttons) {
        expect(button.getAttribute("type")).toBe("button");
        expect(button.disabled).toBe(false);
        // Styled as a bordered button, not as a link-like text button.
        expect(button.classList.contains("action-button")).toBe(true);
        expect(button.classList.contains("text-button")).toBe(false);
      }
      const order = group.compareDocumentPosition(viewButton(primitive, "tree"));
      expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });
});

describe("offering the image example only where it can load (issue #58)", () => {
  it("hides it on a text-only provider and when no provider is selected, and keeps the film example", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    for (const primitive of PRIMITIVES) {
      expect(loadButton(primitive, "images").hidden).toBe(true);
      expect(loadButton(primitive, "film").hidden).toBe(false);
    }
    choose(undefined);
    for (const primitive of PRIMITIVES) expect(loadButton(primitive, "images").hidden).toBe(true);
  });

  it("shows it on an image provider, and hides it again on a switch to a text-only one", () => {
    const { selection, choose } = selectionOf(subq);
    setupPanels(document, selection);
    for (const primitive of PRIMITIVES) expect(loadButton(primitive, "images").hidden).toBe(false);
    choose(typesafe);
    for (const primitive of PRIMITIVES) expect(loadButton(primitive, "images").hidden).toBe(true);
    choose(openai);
    for (const primitive of PRIMITIVES) expect(loadButton(primitive, "images").hidden).toBe(false);
  });
});

describe("loading the film example (issue #58)", () => {
  it("fills Choice with exactly choiceExample, agreeing in both views, and announces it", async () => {
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("choice");
    expect(emptyMessage("choice").hidden).toBe(true);
    expect(runNote("choice")).toBe("Checks the Choice request and sends it to TypeSafe Jev.");
    expect(status("choice").dataset.tone).toBe("note");
    expect(
      [...form("choice").querySelectorAll<HTMLInputElement>('[data-control="id"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["film"]);
    viewButton("choice", "json").click();
    expect(JSON.parse(textarea("choice").value)).toStrictEqual(choiceExample);
    // The other panels are untouched.
    expect(emptyMessage("noul").hidden).toBe(false);
    expectDescribedByEmptyMessage("noul");
  });

  it("puts focus on the State field of the loaded tree", async () => {
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("score");
    expect(document.activeElement).toBe(stateField("score"));
  });

  it("writes the example into the textarea and focuses it when the JSON view is open", async () => {
    localStorage.setItem("decisionmachines3000:view:noul", "json");
    setupPanels(document, selectionOf(typesafe).selection);
    expect(textarea("noul").value).toBe(emptyJson("noul"));
    await loadFilm("noul");
    expect(textarea("noul").value).toBe(JSON.stringify(noulExample, null, 2));
    expect(document.activeElement).toBe(textarea("noul"));
    expect(get("#noul-error").hidden).toBe(true);
  });

  it("loads without a provider, since the film set needs none, and Run waits for one", async () => {
    const { selection, choose } = selectionOf(undefined);
    setupPanels(document, selection);
    await loadFilm("noul");
    expect(runNote("noul")).toBe(NO_PROVIDER);
    choose(typesafe);
    expect(runNote("noul")).toBe("Checks the Noul request and sends it to TypeSafe Jev.");
  });
});

describe("loading the image example (issue #58)", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function attachments(primitive: string): HTMLElement[] {
    return [...form(primitive).querySelectorAll<HTMLElement>(".attachment")];
  }

  function attachmentNames(primitive: string): string[] {
    return attachments(primitive).map(
      (item) => item.querySelector(".attachment-name")?.textContent ?? "",
    );
  }

  it("loads the request and attaches the four sample pictures through the image control on SubQ", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    loadButton("noul", "images").click();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(attachmentNames("noul")).toEqual([
      "picture-1.png",
      "picture-2.png",
      "picture-3.png",
      "picture-4.png",
    ]);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      imageExamples.images.map((image) => image.url),
    );
    // One announcement: the panel's status line, not one sentence per picture from the image control.
    expect(get('form[data-primitive="noul"] .attachments-status').textContent).toBe("");
    expect(emptyMessage("noul").hidden).toBe(true);
    expect(runNote("noul")).toBe(
      "Checks the Noul request and sends it to SubQ Snap with 4 images.",
    );
    expect(document.activeElement).toBe(stateField("noul"));

    viewButton("noul", "json").click();
    expect(JSON.parse(textarea("noul").value)).toStrictEqual(imageExamples.requests.noul);
    expect(get("#noul-hint").textContent).toContain("4 images attached");
  });

  it("posts the loaded request and the pictures as one multipart form", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(openai).selection);
    loadButton("score", "images").click();
    await vi.waitFor(() => expect(attachments("score")).toHaveLength(4));
    submit("score");
    await vi.waitFor(() => expect(decideCalls(fetchMock)).toHaveLength(1));
    const [url, init] = decideCalls(fetchMock)[0] ?? [];
    expect(url).toBe("/api/decide/openai");
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("Expected a FormData body.");
    expect(JSON.parse(body.get("request") as string)).toStrictEqual(imageExamples.requests.score);
    expect(body.getAll("image").map((part) => (part instanceof File ? part.name : ""))).toEqual([
      "picture-1.png",
      "picture-2.png",
      "picture-3.png",
      "picture-4.png",
    ]);
    const first = body.getAll("image")[0];
    if (!(first instanceof File)) throw new Error("Expected a file part.");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(sampleBytes("picture-1.png"));
  });

  it("refuses on TypeSafe Jev if its hidden button is pressed anyway, and changes nothing", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("choice");
    viewButton("choice", "json").click();
    const before = textarea("choice").value;

    loadButton("choice", "images").click();
    await vi.waitFor(() =>
      expect(status("choice").textContent).toBe(
        "The image example needs a provider that takes images. TypeSafe Jev is text only. Choose another provider first.",
      ),
    );
    expect(status("choice").dataset.tone).toBe("alert");
    expect(textarea("choice").value).toBe(before);
    expect(attachments("choice")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(viewButton("choice", "json").getAttribute("aria-pressed")).toBe("true");
  });

  it("refuses with no provider if its hidden button is pressed anyway", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(undefined).selection);
    loadButton("noul", "images").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe(
        "The image example needs a provider that takes images. No provider is selected.",
      ),
    );
    expect(emptyMessage("noul").hidden).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Attaches one image of the person's own through the file input. */
  async function attachOwn(primitive: string, name: string): Promise<void> {
    const before = attachments(primitive).length;
    const input = get<HTMLInputElement>(`#${primitive}-images-input`);
    const transfer = new DataTransfer();
    transfer.items.add(fileOf(pngBytes({ size: 1024 }), name, "image/png"));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(attachments(primitive)).toHaveLength(before + 1));
  }

  it("asks before removing images the person attached, and keeps them when they cancel", async () => {
    const fetchMock = mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    await attachOwn("noul", "mine.png");

    loadButton("noul", "images").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the image example into the Noul panel?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachmentNames("noul")).toEqual(["mine.png"]);
    expect(emptyMessage("noul").hidden).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the person's images with the sample pictures when they agree", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => true);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    await attachOwn("noul", "mine.png");
    await attachOwn("noul", "also-mine.png");

    loadButton("noul", "images").click();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the image example into the Noul panel?",
      message: "This removes the 2 images you attached. You cannot undo this.",
    });
    expect(attachmentNames("noul")).toEqual([
      "picture-1.png",
      "picture-2.png",
      "picture-3.png",
      "picture-4.png",
    ]);
  });

  it("removes attached images when the film example loads, too", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => true);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    type(stateField("choice"), "My own question.");
    await attachOwn("choice", "mine.png");

    await loadFilm("choice");
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example into the Choice panel?",
      message:
        "This replaces your request and removes the image you attached. You cannot undo this.",
    });
    expect(attachments("choice")).toHaveLength(0);
    expect(get("#choice-hint").textContent).not.toContain("attached");
  });

  it("replaces the image example's own pictures without asking", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    loadButton("score", "images").click();
    await vi.waitFor(() => expect(status("score").textContent).toBe("Image example loaded."));

    await loadFilm("score");
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(attachments("score")).toHaveLength(0);
  });

  it("asks about the person's own image beside the sample pictures", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => false);
    // OpenAI takes up to 8 images, so a fifth fits beside the four samples.
    setupPanels(document, selectionOf(openai).selection, { confirmReplace });
    loadButton("score", "images").click();
    await vi.waitFor(() => expect(status("score").textContent).toBe("Image example loaded."));
    await attachOwn("score", "mine.png");

    loadButton("score", "film").click();
    await vi.waitFor(() =>
      expect(status("score").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example into the Score panel?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachments("score")).toHaveLength(5);
  });

  it("leaves the panel unchanged when a sample picture cannot be fetched", async () => {
    mockFetch({ failing: "picture-3.png" });
    setupPanels(document, selectionOf(openai).selection);
    loadButton("score", "images").click();
    await vi.waitFor(() =>
      expect(status("score").textContent).toBe(
        "The image example's sample pictures could not be loaded. Nothing was changed.",
      ),
    );
    expect(status("score").dataset.tone).toBe("alert");
    expect(emptyMessage("score").hidden).toBe(false);
    expectDescribedByEmptyMessage("score");
    expect(attachments("score")).toHaveLength(0);
    expect(stateField("score").value).toBe("");
  });

  it("refuses after the fetch when the provider became text only meanwhile, and changes nothing", async () => {
    const serve = holdFirstSample();
    const { selection, choose } = selectionOf(subq);
    setupPanels(document, selection);
    loadButton("noul", "images").click();
    await settled();
    choose(typesafe);
    serve();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe(
        "The image example needs a provider that takes images. TypeSafe Jev is text only. Choose another provider first.",
      ),
    );
    expect(emptyMessage("noul").hidden).toBe(false);
    expect(attachments("noul")).toHaveLength(0);
    expect(stateField("noul").value).toBe("");
  });

  it("drops a second press while the first load is still in flight", async () => {
    const serve = holdFirstSample();
    const fetchMock = vi.mocked(fetch);
    setupPanels(document, selectionOf(subq).selection);
    loadButton("noul", "images").click();
    await settled();
    loadButton("noul", "images").click();
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(status("noul").textContent).toBe("An example is still loading into the Noul panel.");
    serve();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(attachments("noul")).toHaveLength(4);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("says how many pictures were attached when the control refuses one", async () => {
    mockFetch();
    const busy = sampleBytes("picture-4.png").length;
    const tight: ProviderSummary = {
      ...subq,
      capabilities: {
        ...subq.capabilities,
        images: {
          maxCount: 4,
          maxBytesPerImage: busy - 1,
          maxBytesPerRequest: 64 * 1024,
          mediaTypes: ["image/png", "image/jpeg", "image/webp"],
        },
      },
    };
    setupPanels(document, selectionOf(tight).selection);
    loadButton("choice", "images").click();
    await vi.waitFor(() =>
      expect(status("choice").textContent).toMatch(
        /^Image example loaded, but only 3 of 4 sample pictures were attached\. picture-4\.png was not added: /,
      ),
    );
    expect(status("choice").dataset.tone).toBe("alert");
    expect(attachmentNames("choice")).toEqual(["picture-1.png", "picture-2.png", "picture-3.png"]);
    // The control stays quiet, so the refusal is said once, in the panel's status line.
    expect(get('form[data-primitive="choice"] .attachments-status').textContent).toBe("");
  });

  /**
   * Starts adding one image of the person's own through the file input, and
   * holds it while its first bytes are read, as a slow disk or a shrink would,
   * until `release` is called.
   */
  function attachOwnHeld(primitive: string, name: string): { release: () => void } {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const file = fileOf(pngBytes({ size: 1024 }), name, "image/png");
    const slice = file.slice.bind(file);
    file.slice = (...args: Parameters<Blob["slice"]>) => {
      const part = slice(...args);
      const read = part.arrayBuffer.bind(part);
      part.arrayBuffer = async () => {
        await gate;
        return read();
      };
      return part;
    };
    const input = get<HTMLInputElement>(`#${primitive}-images-input`);
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { release };
  }

  it("counts an image still being added as the person's, and asks before removing it", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    const adding = attachOwnHeld("noul", "slow.png");

    loadButton("noul", "film").click();
    await settled();
    expect(confirmReplace).not.toHaveBeenCalled();
    adding.release();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example into the Noul panel?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachmentNames("noul")).toEqual(["slow.png"]);
  });

  it("records only the sample pictures as loaded, so a later load still asks about the person's image", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => true);
    setupPanels(document, selectionOf(openai).selection, { confirmReplace });
    loadButton("noul", "images").click();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(confirmReplace).not.toHaveBeenCalled();
    await attachOwn("noul", "mine.png");

    await loadFilm("noul");
    expect(confirmReplace).toHaveBeenCalledOnce();
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example into the Noul panel?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachments("noul")).toHaveLength(0);
  });

  it("sends nothing while an image is being added, says so, and runs once the image is in", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    expect(runNote("noul")).toBe("Checks the Noul request and sends it to SubQ Snap.");

    const adding = attachOwnHeld("noul", "slow.png");
    await settled();
    const stillAdding = "Images are still being added. Run is available once they are.";
    expect(runNote("noul")).toBe(stillAdding);
    submit("noul");
    expect(decideCalls(fetchMock)).toHaveLength(0);
    expect(summaryItems("noul")).toEqual([{ text: stillAdding, href: "#noul-images-input" }]);
    expect(document.activeElement).toBe(summary("noul"));

    adding.release();
    await vi.waitFor(() => expect(attachmentNames("noul")).toEqual(["slow.png"]));
    await settled();
    // The problem went away, so the summary drops it.
    expect(summary("noul").childElementCount).toBe(0);
    expect(runNote("noul")).toBe("Checks the Noul request and sends it to SubQ Snap with 1 image.");
    submit("noul");
    await vi.waitFor(() => expect(decideCalls(fetchMock)).toHaveLength(1));
  });

  it("leaves focus alone when the person moved on while the pictures were fetched", async () => {
    const serve = holdFirstSample();
    setupPanels(document, selectionOf(subq).selection);
    loadButton("score", "images").click();
    await settled();
    const elsewhere = viewButton("score", "json");
    elsewhere.focus();
    serve();
    await vi.waitFor(() => expect(status("score").textContent).toBe("Image example loaded."));
    expect(document.activeElement).toBe(elsewhere);
  });

  it("replaces an untouched film example without asking", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    await loadFilm("noul");
    loadButton("noul", "images").click();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(stateField("noul").value).toBe(imageExamples.requests.noul.state);
  });
});

describe("protecting edits (issue #58)", () => {
  it("asks before replacing edits, and keeps them when the person cancels", async () => {
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(typesafe).selection, { confirmReplace });
    type(stateField("noul"), "My own review.");
    loadButton("noul", "film").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example into the Noul panel?",
      message: "This replaces your request. You cannot undo this.",
    });
    expect(stateField("noul").value).toBe("My own review.");
    expect(status("noul").dataset.tone).toBe("note");
  });

  it("replaces the edits when the person agrees", async () => {
    const confirmReplace = vi.fn(async () => true);
    setupPanels(document, selectionOf(typesafe).selection, { confirmReplace });
    type(stateField("noul"), "My own review.");
    await loadFilm("noul");
    expect(confirmReplace).toHaveBeenCalledOnce();
    // The film state is an object, which the field shows as JSON.
    expect(JSON.parse(stateField("noul").value)).toEqual(noulExample.state);
  });

  it("asks again once the loaded example has been edited", async () => {
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(typesafe).selection, { confirmReplace });
    await loadFilm("choice");
    loadButton("choice", "film").click();
    await settled();
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(status("choice").textContent).toBe("Film example loaded.");

    type(stateField("choice"), "Changed.");
    loadButton("choice", "film").click();
    await vi.waitFor(() =>
      expect(status("choice").textContent).toBe(
        "Nothing loaded. Your request and images are kept.",
      ),
    );
    expect(confirmReplace).toHaveBeenCalledOnce();
  });

  it("asks about edits typed while the pictures were being fetched", async () => {
    const serve = holdFirstSample();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/preview");
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(subq).selection, { confirmReplace });
    loadButton("noul", "images").click();
    await settled();
    expect(confirmReplace).not.toHaveBeenCalled();

    type(stateField("noul"), "Typed while loading.");
    serve();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledOnce();
    expect(stateField("noul").value).toBe("Typed while loading.");
    expect(form("noul").querySelectorAll(".attachment")).toHaveLength(0);
    vi.restoreAllMocks();
  });

  describe("the page's dialog, when no confirmReplace is given", () => {
    function dialog(): HTMLDialogElement {
      return get<HTMLDialogElement>("#replace-dialog");
    }

    function dialogButton(value: "cancel" | "confirm"): HTMLButtonElement {
      return get<HTMLButtonElement>(`#replace-dialog button[value="${value}"]`);
    }

    /**
     * Closes the dialog the way Escape does in a browser: `cancel`, then
     * `close`, with `returnValue` left as it was. happy-dom's `close()` would
     * reset it, which would hide a stale answer from an earlier question.
     */
    function pressEscape(): void {
      dialog().dispatchEvent(new Event("cancel", { cancelable: true }));
      dialog().removeAttribute("open");
      dialog().dispatchEvent(new Event("close"));
    }

    /** Types into Noul's state, presses "Load film example", and waits for the dialog to open. */
    async function askToReplace(): Promise<void> {
      setupPanels(document, selectionOf(typesafe).selection);
      type(stateField("noul"), "My own review.");
      loadButton("noul", "film").click();
      await vi.waitFor(() => expect(dialog().open).toBe(true));
    }

    it("opens as a modal, names the question and the cost, and says there is no undo", async () => {
      const showModal = vi.spyOn(dialog(), "showModal");
      await askToReplace();
      expect(showModal).toHaveBeenCalledOnce();
      expect(dialog().getAttribute("aria-labelledby")).toBe("replace-dialog-title");
      expect(dialog().getAttribute("aria-describedby")).toBe("replace-dialog-message");
      expect(get("#replace-dialog-title").textContent).toBe(
        "Load the film example into the Noul panel?",
      );
      expect(get("#replace-dialog-message").textContent).toBe(
        "This replaces your request. You cannot undo this.",
      );
      expect(dialogButton("cancel").hasAttribute("autofocus")).toBe(true);
    });

    it("loads the example when the person confirms", async () => {
      await askToReplace();
      dialogButton("confirm").click();
      await vi.waitFor(() => expect(status("noul").textContent).toBe("Film example loaded."));
      expect(dialog().open).toBe(false);
      expect(JSON.parse(stateField("noul").value)).toEqual(noulExample.state);
    });

    it("keeps the request when the person presses the cancel button", async () => {
      await askToReplace();
      dialogButton("cancel").click();
      await vi.waitFor(() =>
        expect(status("noul").textContent).toBe(
          "Nothing loaded. Your request and images are kept.",
        ),
      );
      expect(stateField("noul").value).toBe("My own review.");
    });

    it("keeps the request when the person presses Escape", async () => {
      await askToReplace();
      pressEscape();
      await vi.waitFor(() =>
        expect(status("noul").textContent).toBe(
          "Nothing loaded. Your request and images are kept.",
        ),
      );
      expect(stateField("noul").value).toBe("My own review.");
    });

    it("does not carry a confirmation over to the next question", async () => {
      await askToReplace();
      dialogButton("confirm").click();
      await vi.waitFor(() => expect(status("noul").textContent).toBe("Film example loaded."));
      type(stateField("noul"), "Edited again.");
      loadButton("noul", "film").click();
      await vi.waitFor(() => expect(dialog().open).toBe(true));
      pressEscape();
      await vi.waitFor(() =>
        expect(status("noul").textContent).toBe(
          "Nothing loaded. Your request and images are kept.",
        ),
      );
    });
  });

  it("counts a JSON edit brought back into the tree as an edit", async () => {
    const confirmReplace = vi.fn(async () => false);
    setupPanels(document, selectionOf(typesafe).selection, { confirmReplace });
    viewButton("noul", "json").click();
    textarea("noul").value = JSON.stringify(noulExample);
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "tree").getAttribute("aria-pressed")).toBe("true");
    expect(runNote("noul")).toBe("Checks the Noul request and sends it to TypeSafe Jev.");
    loadButton("noul", "film").click();
    await vi.waitFor(() => expect(confirmReplace).toHaveBeenCalledOnce());
  });
});

describe("view switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens every panel in the tree", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    for (const primitive of PRIMITIVES) {
      expect(viewButton(primitive, "tree").getAttribute("aria-pressed")).toBe("true");
      expect(get(`form[data-primitive="${primitive}"] [data-view-body="json"]`).hidden).toBe(true);
    }
  });

  it("serialises the request into the JSON view", async () => {
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("choice");
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
    expect(textarea("score").value).toBe(emptyJson("score"));
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

  it("keeps tree edits through a round trip to JSON and back", async () => {
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    const id = form("noul").querySelector<HTMLInputElement>('[data-control="id"]');
    if (id === null) throw new Error("No id field.");
    type(id, "would_recommend");
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
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/decide/typesafe");
    const sent = fetchMock.mock.calls[0]?.[1]?.body;
    if (typeof sent !== "string") throw new Error("Expected a JSON string body.");
    expect(JSON.parse(sent)).toStrictEqual(noulExample);
    expect(summary("noul").childElementCount).toBe(0);
  });

  it("clears a summary from an earlier press once a press posts", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    viewButton("noul", "json").click();
    type(textarea("noul"), "{");
    submit("noul");
    expect(summaryItems("noul")).toHaveLength(1);
    textarea("noul").value = JSON.stringify(noulExample);
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(summary("noul").childElementCount).toBe(0);
  });

  it("names the provider that answered in the readout", async () => {
    mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
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
    await loadFilm("noul");

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
    await loadFilm("noul");
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
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() =>
      expect(document.querySelector("#readout-body")?.textContent).toContain(
        "The decision endpoint answered with HTTP 502 and a body that is not JSON.",
      ),
    );
    expect(document.querySelector("#readout-body")?.textContent).not.toMatch(/could not reach/i);
  });

  it("lists the tree's problems in the summary instead of posting, and focuses the summary", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    const [first, second] = form("noul").querySelectorAll<HTMLTextAreaElement>(
      '[data-control="instructions"]',
    );
    if (first === undefined || second === undefined) throw new Error("No second question.");
    type(second, "");
    type(first, "");
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    const message = "Write the question you want answered.";
    expect(summaryItems("noul").map((item) => item.text)).toEqual([message, message]);
    // The summary says them, so the status line stays quiet.
    expect(status("noul").textContent).toBe("");
    expect(document.activeElement).toBe(summary("noul"));
    // The inline issue slots still show each problem beside its control, and the links name them.
    const slots = [...form("noul").querySelectorAll<HTMLElement>(".tree-issue:not([hidden])")];
    expect(slots.map((slot) => slot.textContent)).toEqual([message, message]);
    expect(summaryItems("noul").map((item) => item.href)).toEqual(
      slots.map((slot) => `#${slot.id}`),
    );

    // Each link moves focus to its own control.
    summary("noul").querySelectorAll("a")[0]?.click();
    expect(document.activeElement).toBe(first);
    summary("noul").querySelectorAll("a")[1]?.click();
    expect(document.activeElement).toBe(second);

    // Fixing one drops it from the summary and leaves the other.
    type(first, "Is it good?");
    expect(summaryItems("noul").map((item) => item.text)).toEqual([message]);
  });

  it("lists the JSON error in the summary, which takes focus and links to the textarea", () => {
    setupPanels(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    type(textarea("noul"), "{");
    submit("noul");
    const [item] = summaryItems("noul");
    expect(item?.href).toBe("#noul-request");
    // The error under the textarea still shows, as before.
    expect(get("#noul-error").hidden).toBe(false);
    expect(item?.text).toBe(get("#noul-error").textContent);
    expect(document.activeElement).toBe(summary("noul"));
    followSummaryLink("noul", item?.text ?? "");
    expect(document.activeElement).toBe(textarea("noul"));

    // A switch to the tree, where that problem no longer is, drops it.
    textarea("noul").value = JSON.stringify(noulExample);
    viewButton("noul", "tree").click();
    expect(summary("noul").childElementCount).toBe(0);
  });

  it("names no provider when the endpoint answers with a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { status: 200 })),
    );
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    const readout = get("#readout-body");
    await vi.waitFor(() => expect(readout.textContent).toContain("a body that is not JSON"));
    // Only the readout; Run's note names the selected provider on purpose.
    expect(readout.textContent).not.toMatch(/Jev|TypeSafe/);
  });

  it("posts the JSON text unchanged from the JSON view", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    viewButton("noul", "json").click();
    const text = JSON.stringify(noulExample);
    textarea("noul").value = text;
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(text);
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

  it("sends Run to the selected provider and names it while waiting", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    await loadFilm("score");
    choose(subq);
    submit("score");
    expect(get("#readout-body").textContent).toBe("Asking SubQ Snap…");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/decide/subq");
  });

  it("sends nothing while there is no provider, says why, and drops the reason when one arrives", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(undefined);
    setupPanels(document, selection);
    for (const primitive of PRIMITIVES) await loadFilm(primitive);
    for (const primitive of PRIMITIVES) {
      expect(runButton(primitive).disabled).toBe(false);
      expect(runNote(primitive)).toBe(NO_PROVIDER);
    }
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems("noul")).toEqual([{ text: NO_PROVIDER, href: null }]);
    expect(document.activeElement).toBe(summary("noul"));

    choose(typesafe);
    expect(summary("noul").childElementCount).toBe(0);
    for (const primitive of PRIMITIVES) {
      expect(runNote(primitive)).toBe(
        `Checks the ${capitalise(primitive)} request and sends it to TypeSafe Jev.`,
      );
    }

    choose(undefined);
    expect(runNote("noul")).toBe(NO_PROVIDER);
  });

  /** Eleven levels, which the catalog's providers refuse and a provider with no maximum accepts. */
  function elevenLevels(): string {
    const criteria = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
    return JSON.stringify({ ...scoreExample, criteria });
  }

  it("clears a panel's summary when the new provider accepts the request", () => {
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
    expect(summaryItems("score")).toHaveLength(1);

    choose(unlimited);
    expect(summary("score").childElementCount).toBe(0);
    expect(runNote("score")).toBe("Checks the Score request and sends it to SubQ Snap.");
  });

  it("clears the JSON view's error when the new provider accepts the request", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    viewButton("score", "json").click();
    type(textarea("score"), elevenLevels());
    viewButton("score", "tree").click();
    expect(get("#score-error").hidden).toBe(false);
    expect(status("score").dataset.tone).toBe("alert");
    // The refused switch left focus in the textarea; the viewer then moves on to another panel's button.
    const elsewhere = loadButton("noul", "film");
    elsewhere.focus();

    choose(unlimited);
    expect(get("#score-error").hidden).toBe(true);
    expect(status("score").textContent).toBe("");
    expect(runNote("score")).toBe("Checks the Score request and sends it to SubQ Snap.");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("updates a shown JSON error to the new provider's limit without moving focus", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();
    expect(get("#score-error").textContent).toContain("at most 10");
    const elsewhere = loadButton("noul", "film");
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

  it("replaces a summary's problem with the new provider's own limit in the tree view", () => {
    const { selection, choose } = selectionOf(withoutLevelLimit(subq));
    setupPanels(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();

    choose(typesafe);
    submit("score");
    expect(summaryItems("score")).toHaveLength(1);
    expect(summaryItems("score")[0]?.text).toContain("at most 10");
    const elsewhere = loadButton("noul", "film");
    elsewhere.focus();

    choose(withLevelLimit(subq, 6));
    expect(summaryItems("score")).toHaveLength(1);
    expect(summaryItems("score")[0]?.text).toContain("at most 6");
    expect(summaryItems("score")[0]?.text).not.toContain("at most 10");
    expect(status("score").textContent).toBe("");
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe("images", () => {
  const KIB = 1024;

  function png(name: string, size = 4 * KIB): File {
    return fileOf(pngBytes({ size }), name, "image/png");
  }

  /** Chooses `files` through the panel's file input. */
  function attach(primitive: string, ...files: File[]): void {
    const input = get<HTMLInputElement>(`#${primitive}-images-input`);
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function attachments(primitive: string): HTMLElement[] {
    return [...form(primitive).querySelectorAll<HTMLElement>(".attachment")];
  }

  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds an image control in every panel that follows the selected provider", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupPanels(document, selection);
    for (const primitive of PRIMITIVES) {
      expect(get(`form[data-primitive="${primitive}"] .attachments-zone`).hidden).toBe(true);
    }
    choose(subq);
    for (const primitive of PRIMITIVES) {
      const zone = get<HTMLFieldSetElement>(
        `form[data-primitive="${primitive}"] .attachments-zone`,
      );
      expect(zone.hidden).toBe(false);
      expect(zone.querySelector("legend")?.textContent).toBe("Images");
      expect(get(`#${primitive}-images-input`).getAttribute("accept")).toBe(
        "image/png,image/jpeg,image/webp",
      );
    }
  });

  it("posts a multipart form with the JSON text as the request part and each file as an image part", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    viewButton("noul", "json").click();
    const text = JSON.stringify(noulExample);
    textarea("noul").value = text;
    attach("noul", png("a.png"), png("b.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(2));
    expect(get("#noul-hint").textContent).toContain(
      "2 images attached. They are sent as image parts beside this JSON, not inside it.",
    );

    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1];
    const body = init?.body;
    if (!(body instanceof FormData)) throw new Error("Expected a FormData body.");
    expect(init?.headers).toBeUndefined();
    expect(body.get("request")).toBe(text);
    const parts = body.getAll("image");
    expect(parts).toHaveLength(2);
    expect(parts.map((part) => (part instanceof File ? part.name : typeof part))).toEqual([
      "a.png",
      "b.png",
    ]);
    const first = parts[0];
    if (!(first instanceof File)) throw new Error("Expected a file part.");
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(pngBytes({ size: 4 * KIB }));
    for (const part of [body.get("request"), ...parts]) {
      if (typeof part === "string") expect(part).not.toMatch(/^data:|[A-Za-z0-9+/]{200,}/);
    }
    // The textarea is untouched.
    expect(textarea("noul").value).toBe(text);
  });

  it("posts the tree's request as the request part when the tree view is open", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("score");
    attach("score", png("a.png"));
    await vi.waitFor(() => expect(attachments("score")).toHaveLength(1));
    submit("score");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = fetchMock.mock.calls[0]?.[1]?.body;
    if (!(body instanceof FormData)) throw new Error("Expected a FormData body.");
    expect(JSON.parse(body.get("request") as string)).toStrictEqual(scoreExample);
    expect(body.getAll("image")).toHaveLength(1);
  });

  it("posts JSON as before when no image is attached", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(typeof init?.body).toBe("string");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(get("#noul-hint").textContent).not.toContain("attached");
  });

  it("keeps the images on a text-only provider, sends JSON without them, and says so in the result", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(subq);
    setupPanels(document, selection);
    await loadFilm("noul");
    attach("noul", png("a.png"), png("b.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(2));

    choose(typesafe);
    expect(get('form[data-primitive="noul"] .attachments-zone').hidden).toBe(true);
    expect(get('form[data-primitive="noul"] .attachments-notice').textContent).toBe(
      "TypeSafe Jev is text only. Your 2 images are kept and will not be sent.",
    );
    expect(get('form[data-primitive="noul"] .attachments-status').textContent).toBe(
      "TypeSafe Jev is text only; your 2 images are kept and will not be sent",
    );
    // The other panels hold no images, so they say nothing.
    expect(get('form[data-primitive="choice"] .attachments-status').textContent).toBe("");
    expect(runNote("noul")).toBe(
      "Checks the Noul request and sends it to TypeSafe Jev without your 2 images.",
    );

    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(typeof init?.body).toBe("string");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    await vi.waitFor(() =>
      expect(document.querySelector(".reading-meta")?.textContent).toBe(
        "Answered by TypeSafe Jev (jev-1.13.0) in 474 ms using 452 input tokens. Sent without the 2 attached images.",
      ),
    );

    choose(subq);
    expect(get('form[data-primitive="noul"] .attachments-zone').hidden).toBe(false);
    expect(attachments("noul")).toHaveLength(2);
  });

  it("sends nothing while a lower limit leaves images marked, lists why, and runs once they are removed", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(openai);
    setupPanels(document, selection);
    await loadFilm("noul");
    await loadFilm("choice");
    attach("noul", ...Array.from({ length: 8 }, (_, index) => png(`${index + 1}.png`)));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(8));
    expect(runNote("noul")).toBe(
      "Checks the Noul request and sends it to OpenAI Decisions with 8 images.",
    );

    choose(subq);
    const overLimit = get('form[data-primitive="noul"] .attachments-notice').textContent ?? "";
    expect(overLimit).toContain("Remove the 4 marked images to run.");
    expect(runNote("noul")).toBe(overLimit);
    // Another panel's blocked images never stop this one's Run.
    expect(runNote("choice")).toBe("Checks the Choice request and sends it to SubQ Snap.");
    expect(attachments("noul").filter((item) => item.hasAttribute("data-over-limit"))).toHaveLength(
      4,
    );
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems("noul")).toEqual([{ text: overLimit, href: "#noul-images-input" }]);
    expect(document.activeElement).toBe(summary("noul"));
    // The summary says it, so the status line does not.
    expect(status("noul").textContent).toBe("");
    followSummaryLink("noul", overLimit);
    expect(document.activeElement).toBe(get("#noul-images-input"));

    for (let index = 0; index < 4; index += 1) {
      attachments("noul").at(-1)?.querySelector<HTMLButtonElement>(".attachment-remove")?.click();
    }
    expect(attachments("noul")).toHaveLength(4);
    expect(summary("noul").childElementCount).toBe(0);
    expect(runNote("noul")).toBe(
      "Checks the Noul request and sends it to SubQ Snap with 4 images.",
    );
    expect(get('form[data-primitive="noul"] .attachments-notice').textContent).toBe("");
  });

  function labels(): string[] {
    // The panels' labels only; the warm form has a `.run-label` of its own.
    return [...document.querySelectorAll("form[data-primitive] .run-label")].map(
      (label) => label.textContent ?? "",
    );
  }

  it("leaves every Run label reading Run after an image is added or removed", async () => {
    setupPanels(document, selectionOf(subq).selection);
    attach("noul", png("a.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(1));
    expect(labels()).toEqual(["Run", "Run", "Run"]);
    form("noul").querySelector<HTMLButtonElement>(".attachment-remove")?.click();
    expect(labels()).toEqual(["Run", "Run", "Run"]);
    // The panel's own status line is untouched by image events; the image control has its own.
    expect(status("noul").textContent).toBe("");
    expect(get('form[data-primitive="noul"] .attachments-status').textContent).toContain(
      "Image removed",
    );
  });

  it("keeps the running panel labelled Running while another panel gains an image", async () => {
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            answer = resolve;
          }),
      ),
    );
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    await loadFilm("choice");
    runButton("noul").focus();
    submit("noul");
    expect(labels()).toEqual(["Running", "Run", "Run"]);
    expect(runButton("noul").hasAttribute("data-running")).toBe(true);
    expect(runButton("choice").hasAttribute("data-running")).toBe(false);
    attach("choice", png("a.png"));
    await vi.waitFor(() => expect(attachments("choice")).toHaveLength(1));
    expect(labels()).toEqual(["Running", "Run", "Run"]);
    // Marked aria-disabled, not disabled, so the pressed Run keeps focus and each says why it waits.
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      "form[data-primitive] .run",
    )) {
      expect(button.disabled).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    expect(document.activeElement).toBe(runButton("noul"));
    expect(runNote("noul")).toBe("Waiting for the answer to this request.");
    expect(runNote("choice")).toBe(
      "The Noul panel is running. Run is available again once its answer arrives.",
    );
    // A press meanwhile does nothing: no second request, and no summary.
    submit("choice");
    expect(summary("choice").childElementCount).toBe(0);
    expect(labels()).toEqual(["Running", "Run", "Run"]);

    answer(new Response(JSON.stringify(noulResponse), { status: 200 }));
    await vi.waitFor(() => expect(labels()).toEqual(["Run", "Run", "Run"]));
    expect(runButton("noul").hasAttribute("data-running")).toBe(false);
    expect(runButton("noul").hasAttribute("aria-disabled")).toBe(false);
    expect(document.activeElement).toBe(runButton("noul"));
    expect(runNote("choice")).toBe(
      "Checks the Choice request and sends it to SubQ Snap with 1 image.",
    );
  });
});

describe("Enter in a request field does not run the request (issue #93)", () => {
  /** Presses Enter in `field` and returns whether the browser's default action was cancelled. */
  function pressEnter(field: HTMLElement, isComposing = false): boolean {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing,
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  }

  // Browsers submit a form from Enter in a text input as that key's default action, and
  // cancelling the keydown cancels it. happy-dom does not implement implicit submission,
  // so these tests check that the default is cancelled and that no request is posted.
  it("cancels Enter in a question's Id field and posts nothing", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    const idField = get<HTMLInputElement>('form[data-primitive="noul"] input[data-control="id"]');
    const answerBefore = get("#readout-body").innerHTML;
    expect(pressEnter(idField)).toBe(true);
    await settled();
    expect(decideCalls(fetchMock)).toHaveLength(0);
    expect(get("#readout-body").innerHTML).toBe(answerBefore);
  });

  it("cancels Enter in an option's name field in the Choice panel and posts nothing", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("choice");
    const optionName = get<HTMLInputElement>(
      'form[data-primitive="choice"] input[data-control="name"]',
    );
    expect(pressEnter(optionName)).toBe(true);
    await settled();
    expect(decideCalls(fetchMock)).toHaveLength(0);
  });

  it("leaves Enter alone in a textarea, so it still inserts a new line", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    expect(pressEnter(stateField("noul"))).toBe(false);
    await settled();
    expect(decideCalls(fetchMock)).toHaveLength(0);
  });

  it("leaves Enter that confirms an input-method composition alone", async () => {
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    const idField = get<HTMLInputElement>('form[data-primitive="noul"] input[data-control="id"]');
    expect(pressEnter(idField, true)).toBe(false);
  });

  it("still posts when Run is activated", async () => {
    const fetchMock = mockFetch();
    setupPanels(document, selectionOf(subq).selection);
    await loadFilm("noul");
    runButton("noul").click();
    await vi.waitFor(() => expect(decideCalls(fetchMock)).toHaveLength(1));
  });
});
