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
import { setupRequestForm } from "./request-form.ts";
import type { ProviderSelection } from "./provider-select.ts";
import { QUESTION_TYPE_NAMES } from "./question-types.ts";

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

type Ticked = ProviderSummary | readonly ProviderSummary[] | undefined;

function isList(
  ticked: ProviderSummary | readonly ProviderSummary[],
): ticked is readonly ProviderSummary[] {
  return Array.isArray(ticked);
}

/** The providers `ticked` names: one, several, or none for `undefined`. */
function asList(ticked: Ticked): readonly ProviderSummary[] {
  return ticked === undefined ? [] : isList(ticked) ? ticked : [ticked];
}

/**
 * A provider selection the test drives by hand. `choose` ticks one provider,
 * several, or none with `undefined`, which is also how it stands while the
 * list loads.
 */
function selectionOf(initial: Ticked) {
  let ticked = asList(initial);
  const listeners: ((selected: readonly ProviderSummary[]) => void)[] = [];
  const selection: ProviderSelection = {
    selected: () => ticked,
    host: () => (ticked.length === 0 ? undefined : { connectionMetrics: false }),
    // The three providers the catalog lists, as a configured instance would send them.
    providers: () => (ticked.length === 0 ? [] : [typesafe, subq, openai]),
    subscribe: (listener) => listeners.push(listener),
  };
  return {
    selection,
    choose: (next: Ticked) => {
      ticked = asList(next);
      for (const listener of listeners) listener(ticked);
    },
  };
}

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}.`);
  return found;
}

/**
 * Chooses `primitive` in the question type radios, as a click would, unless it
 * is already chosen. The helpers below that take a question type call this
 * first, so a test reads as "in Yes or no, …".
 */
function useType(primitive: string): void {
  const input = get<HTMLInputElement>(`input[name="question-type"][value="${primitive}"]`);
  if (!input.checked) input.click();
}

function typeInput(primitive: string): HTMLInputElement {
  return get<HTMLInputElement>(`input[name="question-type"][value="${primitive}"]`);
}

/** The question type the radios show. */
function chosenType(): string | undefined {
  return document.querySelector<HTMLInputElement>('input[name="question-type"]:checked')?.value;
}

function form(primitive?: string): HTMLFormElement {
  if (primitive !== undefined) useType(primitive);
  return get<HTMLFormElement>("#request-form");
}

function viewButton(primitive: string, view: "tree" | "json"): HTMLInputElement {
  useType(primitive);
  return get<HTMLInputElement>(`input[name="view"][value="${view}"]`);
}

function loadButton(primitive: string, set: "film" | "images"): HTMLButtonElement {
  useType(primitive);
  return get<HTMLButtonElement>(`#request-form .load-example[data-example="${set}"]`);
}

function textarea(_primitive?: string): HTMLTextAreaElement {
  return get<HTMLTextAreaElement>("#request-json");
}

function status(_primitive?: string): HTMLElement {
  return get("#request-status");
}

function runButton(_primitive?: string): HTMLButtonElement {
  return get<HTMLButtonElement>("#request-form .run");
}

function emptyMessage(_primitive?: string): HTMLElement {
  return get("#request-empty");
}

/** The error summary at the top of the form; empty while it lists nothing. */
function summary(_primitive?: string): HTMLElement {
  return get("#request-summary");
}

/** What the summary lists, each as its text and the href of its link, or null for a problem without one. */
function summaryItems(_primitive?: string): { text: string; href: string | null }[] {
  return [...summary().querySelectorAll("li")].map((item) => ({
    text: item.textContent ?? "",
    href: item.querySelector("a")?.getAttribute("href") ?? null,
  }));
}

/** Follows the summary link whose text is `text`. */
function followSummaryLink(_primitive: string, text: string): void {
  const link = [...summary().querySelectorAll("a")].find(
    (candidate) => candidate.textContent === text,
  );
  if (link === undefined) throw new Error(`The summary has no link "${text}".`);
  link.click();
}

/** The sentence Run's aria-describedby points at. */
function runNote(_primitive?: string): string {
  const id = runButton().getAttribute("aria-describedby") ?? "";
  return document.getElementById(id)?.textContent ?? "";
}

/** Checks that an untouched form's Run is described by the empty-state message, and its own note is hidden. */
function expectDescribedByEmptyMessage(_primitive?: string): void {
  expect(runButton().getAttribute("aria-describedby")).toBe("request-empty");
  expect(get("#request-empty")).toBe(emptyMessage());
  expect(get("#request-run-note").hidden).toBe(true);
}

const EMPTY_REQUEST = "Load an example or write a question to run the request.";
const NO_PROVIDER = "No provider is available yet. The Providers to ask area beside Run says why.";

function stateField(primitive?: string): HTMLTextAreaElement {
  if (primitive !== undefined) useType(primitive);
  return get<HTMLTextAreaElement>('#request-form [data-for="state"][data-control="state"]');
}

/** The results in the list, newest first. */
function results(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#results-list > li > article")];
}

function submit(_primitive?: string): void {
  form().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

/** Chooses a question type, presses "Load film example", and waits for the status line to say it loaded. */
async function loadFilm(primitive: string): Promise<void> {
  loadButton(primitive, "film").click();
  await vi.waitFor(() => expect(status(primitive).textContent).toBe("Film example loaded."));
}

function type(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The JSON a decide call posted, with its `images` list split off. */
function sentRequest(init: RequestInit | undefined): {
  request: Record<string, unknown>;
  images: { name: string; base64: string }[];
} {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON text body.");
  const { images = [], ...request } = JSON.parse(init.body) as Record<string, unknown> & {
    images?: { name: string; base64: string }[];
  };
  return { request, images };
}

/** The bytes a base64 string decodes to. */
function decoded(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
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

describe("plain names (issue #103)", () => {
  const apiTerms = {
    noul: "API term: noul in TypeSafe Jev and SubQ Snap, predicate in OpenAI Decisions.",
    choice: "API term: choice in every provider.",
    score: "API term: score in every provider.",
  } as const;

  it("names each question type option by its plain name only, and describes it with what it answers and the API term", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    for (const primitive of PRIMITIVES) {
      const input = typeInput(primitive);
      const name = get(`#${input.getAttribute("aria-labelledby") ?? ""}`);
      // The radio is named by the plain name alone, so the API term adds no noise to it.
      expect(name.textContent).toBe(QUESTION_TYPE_NAMES[primitive]);
      const [description, term] = (input.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .map((id) => get(`#${id}`));
      expect(description?.textContent).not.toBe("");
      expect(term?.textContent).toBe(apiTerms[primitive]);
      expect(term?.querySelector("code")?.textContent).toBe(primitive);
    }
  });

  it("keeps the API's own keys in the JSON view and its hint", async () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    for (const primitive of PRIMITIVES) {
      // The same for every question type.
      useType(primitive);
      const hint = get("#request-json-hint");
      expect([...hint.querySelectorAll("code")].map((code) => code.textContent)).toEqual([
        "criteria",
        "criteria",
      ]);
    }
    await loadFilm("noul");
    viewButton("noul", "json").click();
    expect(Object.keys(JSON.parse(textarea("noul").value) as object)).toEqual([
      "primitive",
      "state",
      "questions",
    ]);
  });
});

describe("the question type (issue #102)", () => {
  function questionIds(): string[] {
    return [...form().querySelectorAll<HTMLInputElement>('[data-control="id"]')].map(
      (input) => input.value,
    );
  }

  it("is one group of native radios that opens on Yes or no", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    const group = typeInput("noul").closest("fieldset");
    expect(group?.querySelector("legend")?.textContent).toBe("Question type");
    expect(group?.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(chosenType()).toBe("noul");
    expect(textarea().value).toBe("");
  });

  it("opens on the type this viewer chose last, and stores a new choice", () => {
    localStorage.setItem("decisionmachines3000:question-type", "score");
    setupRequestForm(document, selectionOf(typesafe).selection);
    expect(chosenType()).toBe("score");
    typeInput("choice").click();
    expect(localStorage.getItem("decisionmachines3000:question-type")).toBe("choice");
  });

  it("keeps what the model reads and the images, and remembers each type's questions", async () => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/preview");
    mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("choice");
    const state = stateField().value;
    expect(questionIds()).toEqual(["film"]);

    typeInput("noul").click();
    expect(chosenType()).toBe("noul");
    expect(stateField().value).toBe(state);
    expect(questionIds()).toEqual([]);
    // Switching is not an edit, and says nothing: the radio itself is announced.
    expect(status().textContent).toBe("Film example loaded.");
    expect(runNote()).toBe("Checks the Yes or no request and sends it to SubQ Snap.");

    typeInput("choice").click();
    expect(questionIds()).toEqual(["film"]);
    expect(stateField().value).toBe(state);
    vi.restoreAllMocks();
  });

  it("carries an edit to what the model reads into the other types", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    type(stateField("score"), "A shared review.");
    typeInput("noul").click();
    expect(stateField().value).toBe("A shared review.");
  });

  it("rewrites the JSON view for the new type", async () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    viewButton("noul", "json").click();
    typeInput("score").click();
    expect(JSON.parse(textarea().value)).toStrictEqual({
      primitive: "score",
      state: noulExample.state,
      questions: {},
    });
  });

  it("refuses to change the type while the JSON is invalid, and says why", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    type(textarea(), "{ not json");
    typeInput("choice").click();
    expect(chosenType()).toBe("noul");
    expect(status().textContent).toBe("Fix the JSON to change the question type.");
    expect(status().dataset.tone).toBe("alert");
    expect(get("#request-json-error").hidden).toBe(false);
    expect(textarea().value).toBe("{ not json");
  });

  it("follows a primitive changed in the JSON view", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    type(textarea(), JSON.stringify(scoreExample));
    viewButton("noul", "tree").click();
    expect(chosenType()).toBe("score");
    // The tree folds film_0 to film_3 back into the one question asked for each film.
    expect(questionIds()).toEqual(["film"]);
  });

  it("labels the result with the type the JSON sent", async () => {
    mockFetch();
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    type(textarea(), JSON.stringify(choiceExample));
    submit();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(chosenType()).toBe("choice");
    expect(results()[0]?.querySelector(".result-title")?.textContent).toMatch(
      /^Pick one option: TypeSafe Jev at /,
    );
  });
});

describe("the empty start (issue #58)", () => {
  it("opens the form empty for every question type, with the message shown, Run reachable and described, and nothing announced", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
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
      expect(get(`#request-form .attachments-status`).textContent).toBe("");
      expect(stateField(primitive).value).toBe("");
      expect(form(primitive).querySelectorAll('[data-control="id"]')).toHaveLength(0);
    }
  });

  it("shows the same empty request in the JSON view", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("choice", "json").click();
    expect(textarea("choice").value).toBe(emptyJson("choice"));
    expect(JSON.parse(textarea("choice").value)).toEqual({
      primitive: "choice",
      state: "",
      questions: {},
    });
  });

  it("posts nothing when Run is pressed on an untouched form, and moves focus to a summary that says why", () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(undefined);
    setupRequestForm(document, selection);
    choose(subq);
    runButton("noul").focus();
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    // The GOV.UK error summary: a box with a heading and one link per problem. Focus moving
    // to it is what makes a screen reader read it, so it is not also an alert.
    expect(summary("noul").hasAttribute("role")).toBe(false);
    expect(summary("noul").getAttribute("tabindex")).toBe("-1");
    expect(summary("noul").querySelector("h3")?.textContent).toBe("The request cannot be sent yet");
    expect(summaryItems("noul")).toEqual([{ text: EMPTY_REQUEST, href: "#load-film" }]);
    expect(document.activeElement).toBe(summary("noul"));
    // The summary says the problem, so the status line does not repeat it.
    expect(status("noul").textContent).toBe("");

    followSummaryLink("noul", EMPTY_REQUEST);
    expect(document.activeElement).toBe(loadButton("noul", "film"));
  });

  it("hides the message on the first edit, and Run then lists the request's problems and focuses the summary", () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(typesafe).selection);
    type(stateField("noul"), "A review.");
    expect(emptyMessage("noul").hidden).toBe(true);
    // Once edited, Run is described by its own note, which is now shown.
    expect(runButton("noul").getAttribute("aria-describedby")).toBe("request-run-note");
    expect(get("#request-run-note").hidden).toBe(false);
    expect(runNote("noul")).toBe("Checks the Yes or no request and sends it to TypeSafe Jev.");
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems("noul")).toEqual([
      { text: "Add at least one question.", href: "#request-tree-questions-issue" },
    ]);
    expect(status("noul").textContent).toBe("");
    expect(document.activeElement).toBe(summary("noul"));
    followSummaryLink("noul", "Add at least one question.");
    expect(document.activeElement?.textContent).toBe("Add question");
  });

  it("counts typing in the JSON view as an edit", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("score", "json").click();
    type(textarea("score"), `{"primitive": "score"`);
    expect(emptyMessage("score").hidden).toBe(true);
    expect(runNote("score")).toBe(
      "Checks the Score on a scale request and sends it to TypeSafe Jev.",
    );
  });

  it("drops the empty-request problem from a shown summary once the request is edited, without moving focus", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    submit("noul");
    expect(summaryItems("noul")).toHaveLength(1);
    stateField("noul").focus();
    type(stateField("noul"), "A review.");
    // Fixed problems leave quietly; the new ones wait for the next press of Run.
    expect(summary("noul").childElementCount).toBe(0);
    expect(document.activeElement).toBe(stateField("noul"));
  });

  it("lists every reason at once, and links to the provider select while it can take focus", () => {
    setupRequestForm(document, selectionOf(undefined).selection);
    submit("noul");
    expect(summaryItems("noul")).toEqual([
      { text: EMPTY_REQUEST, href: "#load-film" },
      // The provider choice is disabled until providers load, so this problem has no link.
      { text: NO_PROVIDER, href: null },
    ]);

    // The list loaded, but nothing is ticked: the problem links to the first checkbox.
    const choice = get<HTMLFieldSetElement>("#provider-choice");
    choice.disabled = false;
    get(".provider-options").innerHTML =
      '<input type="checkbox" id="provider-typesafe" name="provider" value="typesafe" />';
    submit("noul");
    expect(summaryItems("noul")).toEqual([
      { text: EMPTY_REQUEST, href: "#load-film" },
      { text: "Tick at least one provider to run the request.", href: "#provider-typesafe" },
    ]);
    expect(document.activeElement).toBe(summary("noul"));
    followSummaryLink("noul", "Tick at least one provider to run the request.");
    expect(document.activeElement).toBe(get("#provider-typesafe"));
  });

  it("puts both load buttons in a labelled group before the view switch", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    const group = get("#request-form .examples");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("Examples");
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
    const order = group.compareDocumentPosition(viewButton("noul", "tree"));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("the image example on a text-only provider (issues #58 and #98)", () => {
  it("keeps it visible, unavailable, and focusable on a text-only provider, and hides it only with no provider", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupRequestForm(document, selection);
    for (const primitive of PRIMITIVES) {
      const button = loadButton(primitive, "images");
      expect(button.hidden).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.hasAttribute("data-unavailable")).toBe(true);
      // Not `disabled`, so it stays in the tab order and can be pressed.
      expect(button.disabled).toBe(false);
      button.focus();
      expect(document.activeElement).toBe(button);
      expect(loadButton(primitive, "film").hidden).toBe(false);
    }
    choose(undefined);
    for (const primitive of PRIMITIVES) expect(loadButton(primitive, "images").hidden).toBe(true);
  });

  it("shows it as available on an image provider, and marks it unavailable again on a switch to a text-only one", () => {
    const { selection, choose } = selectionOf(subq);
    setupRequestForm(document, selection);
    for (const primitive of PRIMITIVES) {
      const button = loadButton(primitive, "images");
      expect(button.hidden).toBe(false);
      expect(button.hasAttribute("aria-disabled")).toBe(false);
      expect(button.hasAttribute("data-unavailable")).toBe(false);
    }
    choose(typesafe);
    for (const primitive of PRIMITIVES) {
      const button = loadButton(primitive, "images");
      expect(button.hidden).toBe(false);
      expect(button.getAttribute("aria-disabled")).toBe("true");
    }
    choose(openai);
    for (const primitive of PRIMITIVES) {
      const button = loadButton(primitive, "images");
      expect(button.hidden).toBe(false);
      expect(button.hasAttribute("aria-disabled")).toBe(false);
      expect(button.hasAttribute("data-unavailable")).toBe(false);
    }
  });

  it("shows the image control as unavailable for every question type, naming the providers that take images", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    for (const primitive of PRIMITIVES) {
      // The same for every question type.
      useType(primitive);
      const zone = get<HTMLFieldSetElement>(`#request-form .attachments-zone`);
      expect(zone.hidden).toBe(false);
      expect(zone.hasAttribute("data-unavailable")).toBe(true);
      expect(get("#request-images-limits").textContent).toBe(
        "TypeSafe Jev is text only. Choose SubQ Snap or OpenAI Decisions to attach images.",
      );
      expect(get<HTMLInputElement>("#request-images-input").disabled).toBe(true);
    }
  });

  it("shows the image control as before on SubQ Snap for every question type", () => {
    setupRequestForm(document, selectionOf(subq).selection);
    for (const primitive of PRIMITIVES) {
      // The same for every question type.
      useType(primitive);
      const zone = get<HTMLFieldSetElement>(`#request-form .attachments-zone`);
      expect(zone.hidden).toBe(false);
      expect(zone.hasAttribute("data-unavailable")).toBe(false);
      expect(get<HTMLInputElement>("#request-images-input").disabled).toBe(false);
    }
  });
});

describe("loading the film example (issue #58)", () => {
  it("fills Choice with exactly choiceExample, agreeing in both views, and announces it", async () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("choice");
    expect(emptyMessage("choice").hidden).toBe(true);
    expect(runNote("choice")).toBe(
      "Checks the Pick one option request and sends it to TypeSafe Jev.",
    );
    expect(status("choice").dataset.tone).toBe("note");
    expect(
      [...form("choice").querySelectorAll<HTMLInputElement>('[data-control="id"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["film"]);
    viewButton("choice", "json").click();
    expect(JSON.parse(textarea("choice").value)).toStrictEqual(choiceExample);
    // The other types keep their own questions, which are still none; what the model reads is shared.
    useType("noul");
    expect(JSON.parse(textarea().value)).toStrictEqual({
      primitive: "noul",
      state: choiceExample.state,
      questions: {},
    });
  });

  it('puts focus on the "What the model reads" field of the loaded tree', async () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("score");
    expect(document.activeElement).toBe(stateField("score"));
  });

  it("writes the example into the textarea and focuses it when the JSON view is open", async () => {
    localStorage.setItem("decisionmachines3000:view", "json");
    setupRequestForm(document, selectionOf(typesafe).selection);
    expect(textarea("noul").value).toBe(emptyJson("noul"));
    await loadFilm("noul");
    expect(textarea("noul").value).toBe(JSON.stringify(noulExample, null, 2));
    expect(document.activeElement).toBe(textarea("noul"));
    expect(get("#request-json-error").hidden).toBe(true);
  });

  it("loads without a provider, since the film set needs none, and Run waits for one", async () => {
    const { selection, choose } = selectionOf(undefined);
    setupRequestForm(document, selection);
    await loadFilm("noul");
    expect(runNote("noul")).toBe(NO_PROVIDER);
    choose(typesafe);
    expect(runNote("noul")).toBe("Checks the Yes or no request and sends it to TypeSafe Jev.");
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
    setupRequestForm(document, selectionOf(subq).selection);
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
    // One announcement: the form's status line, not one sentence per picture from the image control.
    expect(get("#request-form .attachments-status").textContent).toBe("");
    expect(emptyMessage("noul").hidden).toBe(true);
    expect(runNote("noul")).toBe(
      "Checks the Yes or no request and sends it to SubQ Snap with 4 images.",
    );
    expect(document.activeElement).toBe(stateField("noul"));

    viewButton("noul", "json").click();
    expect(JSON.parse(textarea("noul").value)).toStrictEqual(imageExamples.requests.noul);
    expect(get("#request-json-hint").textContent).toContain("4 images attached");
  });

  it("posts the loaded request with the pictures as base64 in its images list", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(openai).selection);
    loadButton("score", "images").click();
    await vi.waitFor(() => expect(attachments("score")).toHaveLength(4));
    submit("score");
    await vi.waitFor(() => expect(decideCalls(fetchMock)).toHaveLength(1));
    const [url, init] = decideCalls(fetchMock)[0] ?? [];
    expect(url).toBe("/api/decide/openai");
    const { request, images } = sentRequest(init);
    expect(request).toStrictEqual(imageExamples.requests.score);
    expect(images.map((image) => image.name)).toEqual([
      "picture-1.png",
      "picture-2.png",
      "picture-3.png",
      "picture-4.png",
    ]);
    expect(decoded(images[0]!.base64)).toEqual(sampleBytes("picture-1.png"));
  });

  it("refuses on TypeSafe Jev when its unavailable button is pressed, names the providers that take images, and changes nothing", async () => {
    const fetchMock = mockFetch();
    const { selection } = selectionOf(typesafe);
    setupRequestForm(document, selection);
    await loadFilm("choice");
    viewButton("choice", "json").click();
    const before = textarea("choice").value;

    loadButton("choice", "images").click();
    await vi.waitFor(() =>
      expect(status("choice").textContent).toBe(
        "The image example needs a provider that takes images. TypeSafe Jev is text only. Choose SubQ Snap or OpenAI Decisions first.",
      ),
    );
    expect(status("choice").dataset.tone).toBe("alert");
    expect(textarea("choice").value).toBe(before);
    expect(attachments("choice")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(viewButton("choice", "json").checked).toBe(true);
    // The page does not switch the provider for the person.
    expect(selection.selected()).toEqual([typesafe]);
  });

  it("asks nothing before it refuses, even when the person has typed into the request", async () => {
    const confirmReplace = vi.fn(async () => true);
    mockFetch();
    setupRequestForm(document, selectionOf(typesafe).selection, { confirmReplace });
    type(stateField("noul"), "my own state");
    loadButton("noul", "images").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toContain("TypeSafe Jev is text only."),
    );
    expect(confirmReplace).not.toHaveBeenCalled();
    expect(stateField("noul").value).toBe("my own state");
  });

  it("says when no provider on the instance takes images", async () => {
    const fetchMock = mockFetch();
    const { selection } = selectionOf(typesafe);
    setupRequestForm(document, {
      ...selection,
      providers: () => [typesafe],
    });
    loadButton("noul", "images").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe(
        "The image example needs a provider that takes images. TypeSafe Jev is text only, and no provider on this instance takes images.",
      ),
    );
    expect(get("#request-images-limits").textContent).toBe(
      "TypeSafe Jev is text only, and no provider on this instance takes images.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses with no provider if its hidden button is pressed anyway", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(undefined).selection);
    loadButton("noul", "images").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe(
        "The image example needs a provider that takes images. No provider is ticked.",
      ),
    );
    expect(emptyMessage("noul").hidden).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /** Attaches one image of the person's own through the file input. */
  async function attachOwn(primitive: string, name: string): Promise<void> {
    const before = attachments(primitive).length;
    const input = get<HTMLInputElement>("#request-images-input");
    const transfer = new DataTransfer();
    transfer.items.add(fileOf(pngBytes({ size: 1024 }), name, "image/png"));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(attachments(primitive)).toHaveLength(before + 1));
  }

  it("asks before removing images the person attached, and keeps them when they cancel", async () => {
    const fetchMock = mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
    await attachOwn("noul", "mine.png");

    loadButton("noul", "images").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the image example for Yes or no?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachmentNames("noul")).toEqual(["mine.png"]);
    expect(emptyMessage("noul").hidden).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("replaces the person's images with the sample pictures when they agree", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => true);
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
    await attachOwn("noul", "mine.png");
    await attachOwn("noul", "also-mine.png");

    loadButton("noul", "images").click();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the image example for Yes or no?",
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
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
    type(stateField("choice"), "My own question.");
    await attachOwn("choice", "mine.png");

    await loadFilm("choice");
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example for Pick one option?",
      message:
        "This replaces your request and removes the image you attached. You cannot undo this.",
    });
    expect(attachments("choice")).toHaveLength(0);
    expect(get("#request-json-hint").textContent).not.toContain("attached");
  });

  it("replaces the image example's own pictures without asking", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
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
    setupRequestForm(document, selectionOf(openai).selection, { confirmReplace });
    loadButton("score", "images").click();
    await vi.waitFor(() => expect(status("score").textContent).toBe("Image example loaded."));
    await attachOwn("score", "mine.png");

    loadButton("score", "film").click();
    await vi.waitFor(() =>
      expect(status("score").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example for Score on a scale?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachments("score")).toHaveLength(5);
  });

  it("leaves the request unchanged when a sample picture cannot be fetched", async () => {
    mockFetch({ failing: "picture-3.png" });
    setupRequestForm(document, selectionOf(openai).selection);
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
    setupRequestForm(document, selection);
    loadButton("noul", "images").click();
    await settled();
    choose(typesafe);
    serve();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe(
        "The image example needs a provider that takes images. TypeSafe Jev is text only. Choose SubQ Snap or OpenAI Decisions first.",
      ),
    );
    expect(emptyMessage("noul").hidden).toBe(false);
    expect(attachments("noul")).toHaveLength(0);
    expect(stateField("noul").value).toBe("");
  });

  it("drops a second press while the first load is still in flight", async () => {
    const serve = holdFirstSample();
    const fetchMock = vi.mocked(fetch);
    setupRequestForm(document, selectionOf(subq).selection);
    loadButton("noul", "images").click();
    await settled();
    loadButton("noul", "images").click();
    await settled();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(status("noul").textContent).toBe("An example is still loading.");
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
    setupRequestForm(document, selectionOf(tight).selection);
    loadButton("choice", "images").click();
    await vi.waitFor(() =>
      expect(status("choice").textContent).toMatch(
        /^Image example loaded, but only 3 of 4 sample pictures were attached\. picture-4\.png was not added: /,
      ),
    );
    expect(status("choice").dataset.tone).toBe("alert");
    expect(attachmentNames("choice")).toEqual(["picture-1.png", "picture-2.png", "picture-3.png"]);
    // The control stays quiet, so the refusal is said once, in the form's status line.
    expect(get("#request-form .attachments-status").textContent).toBe("");
  });

  /**
   * Starts adding one image of the person's own through the file input, and
   * holds it while its first bytes are read, as a slow disk or a shrink would,
   * until `release` is called.
   */
  function attachOwnHeld(_primitive: string, name: string): { release: () => void } {
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
    const input = get<HTMLInputElement>("#request-images-input");
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { release };
  }

  it("counts an image still being added as the person's, and asks before removing it", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => false);
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
    const adding = attachOwnHeld("noul", "slow.png");

    loadButton("noul", "film").click();
    await settled();
    expect(confirmReplace).not.toHaveBeenCalled();
    adding.release();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example for Yes or no?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachmentNames("noul")).toEqual(["slow.png"]);
  });

  it("records only the sample pictures as loaded, so a later load still asks about the person's image", async () => {
    mockFetch();
    const confirmReplace = vi.fn(async () => true);
    setupRequestForm(document, selectionOf(openai).selection, { confirmReplace });
    loadButton("noul", "images").click();
    await vi.waitFor(() => expect(status("noul").textContent).toBe("Image example loaded."));
    expect(confirmReplace).not.toHaveBeenCalled();
    await attachOwn("noul", "mine.png");

    await loadFilm("noul");
    expect(confirmReplace).toHaveBeenCalledOnce();
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example for Yes or no?",
      message: "This removes the image you attached. You cannot undo this.",
    });
    expect(attachments("noul")).toHaveLength(0);
  });

  it("sends nothing while an image is being added, says so, and runs once the image is in", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    expect(runNote("noul")).toBe("Checks the Yes or no request and sends it to SubQ Snap.");

    const adding = attachOwnHeld("noul", "slow.png");
    await settled();
    const stillAdding = "Images are still being added. Run is available once they are.";
    expect(runNote("noul")).toBe(stillAdding);
    submit("noul");
    expect(decideCalls(fetchMock)).toHaveLength(0);
    expect(summaryItems("noul")).toEqual([{ text: stillAdding, href: "#request-images-input" }]);
    expect(document.activeElement).toBe(summary("noul"));

    adding.release();
    await vi.waitFor(() => expect(attachmentNames("noul")).toEqual(["slow.png"]));
    await settled();
    // The problem went away, so the summary drops it.
    expect(summary("noul").childElementCount).toBe(0);
    expect(runNote("noul")).toBe(
      "Checks the Yes or no request and sends it to SubQ Snap with 1 image.",
    );
    submit("noul");
    await vi.waitFor(() => expect(decideCalls(fetchMock)).toHaveLength(1));
  });

  it("leaves focus alone when the person moved on while the pictures were fetched", async () => {
    const serve = holdFirstSample();
    setupRequestForm(document, selectionOf(subq).selection);
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
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
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
    setupRequestForm(document, selectionOf(typesafe).selection, { confirmReplace });
    type(stateField("noul"), "My own review.");
    loadButton("noul", "film").click();
    await vi.waitFor(() =>
      expect(status("noul").textContent).toBe("Nothing loaded. Your request and images are kept."),
    );
    expect(confirmReplace).toHaveBeenCalledWith({
      title: "Load the film example for Yes or no?",
      message: "This replaces your request. You cannot undo this.",
    });
    expect(stateField("noul").value).toBe("My own review.");
    expect(status("noul").dataset.tone).toBe("note");
  });

  it("replaces the edits when the person agrees", async () => {
    const confirmReplace = vi.fn(async () => true);
    setupRequestForm(document, selectionOf(typesafe).selection, { confirmReplace });
    type(stateField("noul"), "My own review.");
    await loadFilm("noul");
    expect(confirmReplace).toHaveBeenCalledOnce();
    // The film state is an object, which the field shows as JSON.
    expect(JSON.parse(stateField("noul").value)).toEqual(noulExample.state);
  });

  it("asks again once the loaded example has been edited", async () => {
    const confirmReplace = vi.fn(async () => false);
    setupRequestForm(document, selectionOf(typesafe).selection, { confirmReplace });
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
    setupRequestForm(document, selectionOf(subq).selection, { confirmReplace });
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
      setupRequestForm(document, selectionOf(typesafe).selection);
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
      expect(get("#replace-dialog-title").textContent).toBe("Load the film example for Yes or no?");
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
    setupRequestForm(document, selectionOf(typesafe).selection, { confirmReplace });
    viewButton("noul", "json").click();
    textarea("noul").value = JSON.stringify(noulExample);
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "tree").checked).toBe(true);
    expect(runNote("noul")).toBe("Checks the Yes or no request and sends it to TypeSafe Jev.");
    loadButton("noul", "film").click();
    await vi.waitFor(() => expect(confirmReplace).toHaveBeenCalledOnce());
  });
});

describe("view switch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens in the tree", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    for (const primitive of PRIMITIVES) {
      expect(viewButton(primitive, "tree").checked).toBe(true);
      expect(get(`#request-form [data-view-body="json"]`).hidden).toBe(true);
    }
  });

  it("serialises the request into the JSON view", async () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("choice");
    viewButton("choice", "json").click();
    expect(textarea("choice").value).toBe(JSON.stringify(choiceExample, null, 2));
    expect(viewButton("choice", "json").checked).toBe(true);
    expect(localStorage.getItem("decisionmachines3000:view")).toBe("json");
  });

  it("ignores a view preference saved under the old key", () => {
    localStorage.setItem("jev-3000:view:score", "json");
    setupRequestForm(document, selectionOf(typesafe).selection);
    expect(viewButton("score", "json").checked).toBe(false);
    expect(viewButton("score", "tree").checked).toBe(true);
  });

  it("keeps the stored view whichever question type is chosen", () => {
    localStorage.setItem("decisionmachines3000:view", "json");
    setupRequestForm(document, selectionOf(typesafe).selection);
    expect(viewButton("score", "json").checked).toBe(true);
    expect(viewButton("noul", "json").checked).toBe(true);
    expect(textarea().value).toBe(emptyJson("noul"));
  });

  it("does not write the stored preference while loading", () => {
    localStorage.setItem("decisionmachines3000:view", "json");
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    setupRequestForm(document, selectionOf(typesafe).selection);
    expect(setItem).not.toHaveBeenCalled();
    expect(viewButton("score", "json").checked).toBe(true);
    expect(textarea("score").value).toBe(emptyJson("score"));
  });

  it("opens in the tree when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Blocked");
    });
    expect(() => setupRequestForm(document, selectionOf(typesafe).selection)).not.toThrow();
    viewButton("noul", "json").click();
    expect(viewButton("noul", "json").checked).toBe(true);
  });

  it("refuses to switch to the tree while the JSON is invalid", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "json").checked).toBe(true);
    expect(get("#request-json-error").hidden).toBe(false);
    expect(textarea("noul").getAttribute("aria-invalid")).toBe("true");
    expect(status("noul").textContent).toBe("Fix the JSON to switch to the tree.");
  });

  it("refuses to switch to the tree when the JSON fails validation", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = JSON.stringify({ ...noulExample, state: "" });
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "json").checked).toBe(true);
    expect(get("#request-json-error").textContent).toMatch(/"state" is empty/);
  });

  it("clears a shown JSON error as soon as typing makes the text valid", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    expect(get("#request-json-error").hidden).toBe(false);

    textarea("noul").value = JSON.stringify(noulExample);
    textarea("noul").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#request-json-error").hidden).toBe(true);
    expect(get("#request-json-error").textContent).toBe("");
    expect(textarea("noul").hasAttribute("aria-invalid")).toBe(false);
    expect(status("noul").textContent).toBe("");
  });

  it("keeps the JSON error while the text is still invalid", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    textarea("noul").value = `{"primitive": "noul",`;
    viewButton("noul", "tree").click();
    textarea("noul").value = `{"primitive": "noul"}`;
    textarea("noul").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#request-json-error").hidden).toBe(false);
    expect(textarea("noul").getAttribute("aria-invalid")).toBe("true");
  });

  it("rebuilds the tree from edited JSON", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    const edited = { ...noulExample, questions: { only: { instructions: "Is it good?" } } };
    textarea("noul").value = JSON.stringify(edited);
    viewButton("noul", "tree").click();
    expect(viewButton("noul", "tree").checked).toBe(true);
    expect(
      [...form("noul").querySelectorAll<HTMLInputElement>('[data-control="id"]')].map(
        (input) => input.value,
      ),
    ).toEqual(["only"]);
  });

  it("keeps tree edits through a round trip to JSON and back", async () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
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
    setupRequestForm(document, selectionOf(typesafe).selection);
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
    setupRequestForm(document, selectionOf(typesafe).selection);
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
    setupRequestForm(document, selectionOf(typesafe).selection);
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
    setupRequestForm(document, selectionOf(typesafe).selection, { onAnswered });
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
      expect(document.querySelector("#results-list .readout-error")).not.toBeNull(),
    );
    expect(onAnswered).toHaveBeenCalledOnce();
  });

  it("keeps the JSON in its own result, outside the live region, after a success and after a failure", async () => {
    mockFetch();
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(document.querySelector(".reading-meta")).not.toBeNull());
    const live = get('[role="status"]#results-status');
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(0);
    expect(live.querySelector("details, pre")).toBeNull();
    expect(results()[0]?.querySelectorAll("details")).toHaveLength(2);
    expect(live.contains(get("#results-list"))).toBe(false);

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
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    const failed = results()[0];
    expect(failed?.querySelector('[role="alert"]')).not.toBeNull();
    // The alert announces the failure; the live region adds nothing.
    expect(live.textContent).toBe("");
    expect(failed?.querySelector("details summary")?.textContent).toBe("Raw response");
  });

  it("says a 502 page that is not JSON is not JSON, rather than unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })),
    );
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() =>
      expect(document.querySelector("#results-list")?.textContent).toContain(
        "The decision endpoint answered with HTTP 502 and a body that is not JSON.",
      ),
    );
    expect(document.querySelector("#results-list")?.textContent).not.toMatch(/could not reach/i);
  });

  it("lists the tree's problems in the summary instead of posting, and focuses the summary", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(typesafe).selection);
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
    setupRequestForm(document, selectionOf(typesafe).selection);
    viewButton("noul", "json").click();
    type(textarea("noul"), "{");
    submit("noul");
    const [item] = summaryItems("noul");
    expect(item?.href).toBe("#request-json");
    // The error under the textarea still shows, as before.
    expect(get("#request-json-error").hidden).toBe(false);
    expect(item?.text).toBe(get("#request-json-error").textContent);
    expect(document.activeElement).toBe(summary("noul"));
    followSummaryLink("noul", item?.text ?? "");
    expect(document.activeElement).toBe(textarea("noul"));

    // A switch to the tree, where that problem no longer is, drops it.
    textarea("noul").value = JSON.stringify(noulExample);
    viewButton("noul", "tree").click();
    expect(summary("noul").childElementCount).toBe(0);
  });

  it("names the provider only as where the request went when the endpoint answers with a body that is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { status: 200 })),
    );
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(document.body.textContent).toContain("a body that is not JSON"));
    const [result] = results();
    expect(result?.querySelector("h3")?.textContent).toMatch(/^Yes or no: TypeSafe Jev at /);
    result?.querySelector("h3")?.remove();
    // Only the result list; Run's note and the image control name the selected provider on purpose.
    expect(get("#results-list").textContent).not.toMatch(/Jev|TypeSafe/);
  });

  it("posts the JSON text unchanged from the JSON view", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    viewButton("noul", "json").click();
    const text = JSON.stringify(noulExample);
    textarea("noul").value = text;
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(text);
  });
});

describe("the result list (issue #100)", () => {
  /** Answers each decide call with the Noul fixture, as the provider in its URL. */
  function answerAsEachProvider() {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const provider = url.split("/").at(-1);
      return new Response(JSON.stringify({ ...noulResponse, provider }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function heading(result: HTMLElement | undefined): string {
    return result?.querySelector("h3")?.textContent ?? "";
  }

  it("starts empty and says so, with no Clear results button", () => {
    setupRequestForm(document, selectionOf(typesafe).selection);
    expect(results()).toHaveLength(0);
    expect(get("#results-empty").hidden).toBe(false);
    expect(get("#results-empty").textContent).toContain("There are no results.");
    expect(get("#results-clear").hidden).toBe(true);
    expect(get("#results-status").textContent).toBe("");
  });

  it("names the question type, TypeSafe Jev, and the time in the heading of the first result", async () => {
    answerAsEachProvider();
    const before = Date.now();
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    const [result] = results();
    expect(heading(result)).toMatch(/^Yes or no: TypeSafe Jev at \d{2}:\d{2}:\d{2}$/);
    const time = result?.querySelector("h3 time");
    const at = Date.parse(time?.getAttribute("datetime") ?? "");
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now());
    expect(result?.querySelectorAll("h4")).toHaveLength(4);
    expect(get("#results-empty").hidden).toBe(true);
    expect(get("#results-clear").hidden).toBe(false);
  });

  it("keeps the first result when a run on another provider adds a second, newest first", async () => {
    answerAsEachProvider();
    const { selection, choose } = selectionOf(typesafe);
    setupRequestForm(document, selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    choose(subq);
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    expect(results().map(heading)).toEqual([
      expect.stringMatching(/^Yes or no: SubQ Snap at /),
      expect.stringMatching(/^Yes or no: TypeSafe Jev at /),
    ]);
    expect(results().map((result) => result.querySelector(".reading-meta")?.textContent)).toEqual([
      expect.stringMatching(/^Answered by SubQ Snap /),
      expect.stringMatching(/^Answered by TypeSafe Jev /),
    ]);
    for (const result of results()) {
      expect(result.querySelectorAll(".bar-value")).toHaveLength(4);
    }
  });

  it("announces one sentence naming the question type, the provider, and the number of answers", async () => {
    answerAsEachProvider();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(get("#results-status").textContent).toBe("Yes or no: SubQ Snap gave 4 answers.");
  });

  it("keeps each result's wire view closed until the person opens it", async () => {
    answerAsEachProvider();
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    const blocks = [...(results()[0]?.querySelectorAll("details") ?? [])];
    expect(blocks).toHaveLength(2);
    expect(blocks.map((details) => details.open)).toEqual([false, false]);
  });

  it("empties the list on Clear results, says so, and moves focus to the Results heading", async () => {
    answerAsEachProvider();
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(2));
    get<HTMLButtonElement>("#results-clear").click();
    expect(results()).toHaveLength(0);
    expect(get("#results-empty").hidden).toBe(false);
    expect(get("#results-status").textContent).toBe("Results cleared.");
    expect(get("#results-clear").hidden).toBe(true);
    expect(document.activeElement).toBe(get("#results-title"));
  });

  it("keeps a run's result after the request is edited", async () => {
    answerAsEachProvider();
    setupRequestForm(document, selectionOf(typesafe).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    type(stateField("noul"), "A different review.");
    expect(results()).toHaveLength(1);
    expect(results()[0]?.querySelectorAll(".bar-value")).toHaveLength(4);
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
    setupRequestForm(document, selection);
    await loadFilm("score");
    choose(subq);
    submit("score");
    expect(get("#results-status").textContent).toBe("Asking SubQ Snap…");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/decide/subq");
  });

  it("sends nothing while there is no provider, says why, and drops the reason when one arrives", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(undefined);
    setupRequestForm(document, selection);
    await loadFilm("noul");
    expect(runButton().disabled).toBe(false);
    expect(runNote()).toBe(NO_PROVIDER);
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems()).toEqual([{ text: NO_PROVIDER, href: null }]);
    expect(document.activeElement).toBe(summary());

    choose(typesafe);
    expect(summary().childElementCount).toBe(0);
    expect(runNote()).toBe("Checks the Yes or no request and sends it to TypeSafe Jev.");

    choose(undefined);
    expect(runNote("noul")).toBe(NO_PROVIDER);
  });

  /** Eleven levels, which the catalog's providers refuse and a provider with no maximum accepts. */
  function elevenLevels(): string {
    const criteria = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
    return JSON.stringify({ ...scoreExample, criteria });
  }

  it("clears the summary when the new provider accepts the request", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(unlimited);
    setupRequestForm(document, selection);
    // With no limit, 11 levels are fine, and the tree shows them.
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();
    expect(viewButton("score", "tree").checked).toBe(true);

    // A provider whose maximum is 10 refuses them when Run is pressed.
    choose(typesafe);
    submit("score");
    expect(summaryItems("score")).toHaveLength(1);

    choose(unlimited);
    expect(summary("score").childElementCount).toBe(0);
    expect(runNote("score")).toBe("Checks the Score on a scale request and sends it to SubQ Snap.");
  });

  it("clears the JSON view's error when the new provider accepts the request", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(typesafe);
    setupRequestForm(document, selection);
    viewButton("score", "json").click();
    type(textarea("score"), elevenLevels());
    viewButton("score", "tree").click();
    expect(get("#request-json-error").hidden).toBe(false);
    expect(status("score").dataset.tone).toBe("alert");
    // The refused switch left focus in the textarea; the viewer then moves on to another button.
    const elsewhere = get<HTMLButtonElement>("#load-film");
    elsewhere.focus();

    choose(unlimited);
    expect(get("#request-json-error").hidden).toBe(true);
    expect(status("score").textContent).toBe("");
    expect(runNote("score")).toBe("Checks the Score on a scale request and sends it to SubQ Snap.");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("updates a shown JSON error to the new provider's limit without moving focus", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupRequestForm(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();
    expect(get("#request-json-error").textContent).toContain("at most 10");
    const elsewhere = get<HTMLButtonElement>("#load-film");
    elsewhere.focus();

    choose(withLevelLimit(subq, 6));
    expect(get("#request-json-error").hidden).toBe(false);
    expect(get("#request-json-error").textContent).toContain("at most 6");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("shows nothing in the JSON view when a provider change makes valid JSON invalid, and Run then reports it", () => {
    const unlimited = withoutLevelLimit(subq);
    const { selection, choose } = selectionOf(unlimited);
    setupRequestForm(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    // Run finds nothing wrong yet, because this provider takes 11 levels.
    textarea("score").dispatchEvent(new Event("input", { bubbles: true }));
    expect(get("#request-json-error").hidden).toBe(true);

    choose(typesafe);
    // Nothing was shown, so nothing is shown now; Run reports it.
    expect(get("#request-json-error").hidden).toBe(true);
    submit("score");
    expect(get("#request-json-error").hidden).toBe(false);
  });

  it("replaces a summary's problem with the new provider's own limit in the tree view", () => {
    const { selection, choose } = selectionOf(withoutLevelLimit(subq));
    setupRequestForm(document, selection);
    viewButton("score", "json").click();
    textarea("score").value = elevenLevels();
    viewButton("score", "tree").click();

    choose(typesafe);
    submit("score");
    expect(summaryItems("score")).toHaveLength(1);
    expect(summaryItems("score")[0]?.text).toContain("at most 10");
    const elsewhere = get<HTMLButtonElement>("#load-film");
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

  /** Chooses `files` through the form's file input. */
  function attach(_primitive: string, ...files: File[]): void {
    const input = get<HTMLInputElement>("#request-images-input");
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

  it("builds one image control that follows the selected provider", () => {
    const { selection, choose } = selectionOf(typesafe);
    setupRequestForm(document, selection);
    for (const primitive of PRIMITIVES) {
      // The same for every question type.
      useType(primitive);
      expect(get(`#request-form .attachments-zone`).hasAttribute("data-unavailable")).toBe(true);
    }
    choose(subq);
    for (const primitive of PRIMITIVES) {
      // The same for every question type.
      useType(primitive);
      const zone = get<HTMLFieldSetElement>(`#request-form .attachments-zone`);
      expect(zone.hidden).toBe(false);
      expect(zone.querySelector("legend")?.textContent).toBe("Images");
      expect(get("#request-images-input").getAttribute("accept")).toBe(
        "image/png,image/jpeg,image/webp",
      );
    }
  });

  it("posts the JSON view's request with each file as base64 in its images list, and leaves the textarea alone", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    viewButton("noul", "json").click();
    const text = JSON.stringify(noulExample);
    textarea("noul").value = text;
    attach("noul", png("a.png"), png("b.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(2));
    expect(get("#request-json-hint").textContent).toContain(
      '2 images attached. Run adds them to this JSON as base64 in an "images" list, which this view does not show.',
    );

    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    const { request, images } = sentRequest(init);
    expect(request).toStrictEqual(noulExample);
    expect(images.map((image) => image.name)).toEqual(["a.png", "b.png"]);
    expect(decoded(images[0]!.base64)).toEqual(pngBytes({ size: 4 * KIB }));
    // The textarea is untouched.
    expect(textarea("noul").value).toBe(text);
  });

  it("posts the tree's request with the images when the tree view is open", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("score");
    attach("score", png("a.png"));
    await vi.waitFor(() => expect(attachments("score")).toHaveLength(1));
    submit("score");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { request, images } = sentRequest(fetchMock.mock.calls[0]?.[1]);
    expect(request).toStrictEqual(scoreExample);
    expect(images).toHaveLength(1);
  });

  it("posts JSON as before when no image is attached", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1];
    expect(typeof init?.body).toBe("string");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(get("#request-json-hint").textContent).not.toContain("attached");
  });

  it("runs with a blank state once an image is attached, and clears the empty-state problem", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    type(stateField("noul"), "");
    submit("noul");
    expect(summaryItems("noul").map((item) => item.text)).toEqual([
      "What the model reads is empty. Add the text, object, or list your questions are about, or attach an image.",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();

    attach("noul", png("a.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(1));
    expect(summaryItems("noul")).toEqual([]);
    expect(stateField("noul").getAttribute("aria-invalid")).toBeNull();

    submit("noul");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { request, images } = sentRequest(fetchMock.mock.calls[0]?.[1]);
    expect(request.state).toBe("");
    expect(images).toHaveLength(1);
  });

  it("keeps the images on a text-only provider, sends JSON without them, and says so in the result", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(subq);
    setupRequestForm(document, selection);
    await loadFilm("noul");
    attach("noul", png("a.png"), png("b.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(2));

    choose(typesafe);
    expect(get("#request-form .attachments-zone").hasAttribute("data-unavailable")).toBe(true);
    expect(get("#request-form .attachments-notice").textContent).toBe(
      "TypeSafe Jev is text only. Your 2 images are kept and will not be sent.",
    );
    expect(get("#request-form .attachments-status").textContent).toBe(
      "TypeSafe Jev is text only; your 2 images are kept and will not be sent",
    );
    expect(runNote("noul")).toBe(
      "Checks the Yes or no request and sends it to TypeSafe Jev without your 2 images.",
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
    expect(get("#request-form .attachments-zone").hidden).toBe(false);
    expect(attachments("noul")).toHaveLength(2);
  });

  it("sends nothing while a lower limit leaves images marked, lists why, and runs once they are removed", async () => {
    const fetchMock = mockFetch();
    const { selection, choose } = selectionOf(openai);
    setupRequestForm(document, selection);
    await loadFilm("noul");
    attach("noul", ...Array.from({ length: 8 }, (_, index) => png(`${index + 1}.png`)));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(8));
    expect(runNote("noul")).toBe(
      "Checks the Yes or no request and sends it to OpenAI Decisions with 8 images.",
    );

    choose(subq);
    const overLimit = get("#request-form .attachments-notice").textContent ?? "";
    expect(overLimit).toContain("Remove the 4 marked images to run.");
    expect(runNote("noul")).toBe(overLimit);
    expect(attachments("noul").filter((item) => item.hasAttribute("data-over-limit"))).toHaveLength(
      4,
    );
    submit("noul");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems("noul")).toEqual([{ text: overLimit, href: "#request-images-input" }]);
    expect(document.activeElement).toBe(summary("noul"));
    // The summary says it, so the status line does not.
    expect(status("noul").textContent).toBe("");
    followSummaryLink("noul", overLimit);
    expect(document.activeElement).toBe(get("#request-images-input"));

    for (let index = 0; index < 4; index += 1) {
      attachments("noul").at(-1)?.querySelector<HTMLButtonElement>(".attachment-remove")?.click();
    }
    expect(attachments("noul")).toHaveLength(4);
    expect(summary("noul").childElementCount).toBe(0);
    expect(runNote("noul")).toBe(
      "Checks the Yes or no request and sends it to SubQ Snap with 4 images.",
    );
    expect(get("#request-form .attachments-notice").textContent).toBe("");
  });

  function label(): string {
    // The request form's label only; the warm form has a `.run-label` of its own.
    return get("#request-form .run-label").textContent ?? "";
  }

  it("leaves the Run label reading Run after an image is added or removed", async () => {
    setupRequestForm(document, selectionOf(subq).selection);
    attach("noul", png("a.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(1));
    expect(label()).toBe("Run");
    form().querySelector<HTMLButtonElement>(".attachment-remove")?.click();
    expect(label()).toBe("Run");
    // The form's own status line is untouched by image events; the image control has its own.
    expect(status().textContent).toBe("");
    expect(get("#request-form .attachments-status").textContent).toContain("Image removed");
  });

  it("keeps Run labelled Running while an image is added and the question type changes during a run", async () => {
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
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    runButton().focus();
    submit();
    expect(label()).toBe("Running");
    expect(runButton().hasAttribute("data-running")).toBe(true);
    attach("noul", png("a.png"));
    await vi.waitFor(() => expect(attachments("noul")).toHaveLength(1));
    typeInput("choice").click();
    expect(label()).toBe("Running");
    // Marked aria-disabled, not disabled, so Run keeps focus and its note says why it waits.
    expect(runButton().disabled).toBe(false);
    expect(runButton().getAttribute("aria-disabled")).toBe("true");
    expect(runNote()).toBe("Waiting for the answer to this request.");
    // A press meanwhile does nothing: no second request, and no summary.
    submit();
    expect(summary().childElementCount).toBe(0);
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();

    answer(new Response(JSON.stringify(noulResponse), { status: 200 }));
    await vi.waitFor(() => expect(label()).toBe("Run"));
    expect(runButton().hasAttribute("data-running")).toBe(false);
    expect(runButton().hasAttribute("aria-disabled")).toBe(false);
    // The result is labelled with the type that ran, not the one chosen since.
    expect(results()[0]?.querySelector(".result-title")?.textContent).toMatch(
      /^Yes or no: SubQ Snap at /,
    );
    expect(runNote()).toBe(
      "Checks the Pick one option request and sends it to SubQ Snap with 1 image.",
    );
  });
});

describe("several providers (issue #101)", () => {
  const KIB = 1024;

  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:test/preview");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function attachPng(name: string): void {
    const input = get<HTMLInputElement>("#request-images-input");
    const transfer = new DataTransfer();
    transfer.items.add(fileOf(pngBytes({ size: 4 * KIB }), name, "image/png"));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  /** A decide route that answers each provider with the Noul fixture, as that provider, or fails one of them. */
  function mockDecide(failing?: string) {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      const provider = url.split("/").at(-1) ?? "";
      if (provider === failing) {
        return new Response(JSON.stringify({ ok: false, error: "Rate limited." }), { status: 429 });
      }
      return new Response(JSON.stringify({ ...noulResponse, provider }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("asks every ticked provider with one press, and shows one result with a column each", async () => {
    const fetchMock = mockDecide();
    setupRequestForm(document, selectionOf([typesafe, subq]).selection);
    await loadFilm("noul");
    expect(runNote()).toBe(
      "Checks the Yes or no request and sends it to TypeSafe Jev and SubQ Snap.",
    );
    submit();
    expect(runNote()).toBe("Waiting for the answers to this request.");
    expect(get("#results-status").textContent).toBe("Asking TypeSafe Jev and SubQ Snap…");
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/decide/typesafe",
      "/api/decide/subq",
    ]);
    const [result] = results();
    expect(result?.querySelector(".result-title")?.textContent).toMatch(
      /^Yes or no: TypeSafe Jev and SubQ Snap at /,
    );
    expect(
      [...(result?.querySelectorAll("thead th") ?? [])].map((cell) => cell.textContent),
    ).toEqual(["Question", "TypeSafe Jev", "SubQ Snap"]);
    expect(result?.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(get("#results-status").textContent).toBe(
      "Yes or no: 2 of 2 providers answered, TypeSafe Jev and SubQ Snap.",
    );
  });

  it("shows the answers that arrived beside a provider that failed", async () => {
    mockDecide("subq");
    setupRequestForm(document, selectionOf([typesafe, subq]).selection);
    await loadFilm("noul");
    submit();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    const [result] = results();
    const cells = [...(result?.querySelectorAll('[data-provider="SubQ Snap"]') ?? [])];
    expect(cells.map((cell) => cell.textContent)).toEqual(Array(4).fill("No answer"));
    expect(result?.querySelectorAll('[data-provider="TypeSafe Jev"] .bar-value')).toHaveLength(4);
    expect(result?.querySelector('.result-provider [role="alert"]')?.textContent).toContain(
      "Rate limited.",
    );
    expect(get("#results-status").textContent).toBe(
      "Yes or no: 1 of 2 providers answered, TypeSafe Jev.",
    );
  });

  it("sends the images to the providers that take them, and says the text-only one was sent none", async () => {
    const fetchMock = mockDecide();
    setupRequestForm(document, selectionOf([typesafe, subq]).selection);
    await loadFilm("noul");
    attachPng("a.png");
    attachPng("b.png");
    await vi.waitFor(() => expect(form().querySelectorAll(".attachment")).toHaveLength(2));
    expect(runNote()).toBe(
      "Checks the Yes or no request and sends it to SubQ Snap with 2 images, and to TypeSafe Jev without them.",
    );
    submit();
    await vi.waitFor(() => expect(results()).toHaveLength(1));
    const bodyFor = (provider: string) =>
      sentRequest(fetchMock.mock.calls.find(([url]) => url.endsWith(provider))?.[1]);
    expect(bodyFor("typesafe").images).toHaveLength(0);
    expect(bodyFor("subq").images.map((image) => image.name)).toEqual(["a.png", "b.png"]);
    const sections = [...(results()[0]?.querySelectorAll(".result-provider") ?? [])];
    expect(sections[0]?.querySelector(".reading-meta")?.textContent).toContain(
      "Sent without the 2 attached images.",
    );
    expect(sections[1]?.querySelector(".reading-meta")?.textContent).not.toContain("Sent without");
  });

  it("refuses a blank state with an image when a ticked provider is sent no images", async () => {
    const fetchMock = mockDecide();
    setupRequestForm(document, selectionOf([typesafe, subq]).selection);
    await loadFilm("noul");
    type(stateField(), "");
    attachPng("a.png");
    await vi.waitFor(() => expect(form().querySelectorAll(".attachment")).toHaveLength(1));
    submit();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summaryItems()[0]?.text).toMatch(/^For TypeSafe Jev, which is sent no images: /);
  });

  it("checks the request against the strictest limits of the ticked providers", () => {
    const { selection, choose } = selectionOf(withoutLevelLimitOf(subq));
    setupRequestForm(document, selection);
    viewButton("score", "json").click();
    type(textarea(), JSON.stringify({ ...scoreExample, criteria: elevenLevelCriteria() }));
    viewButton("score", "tree").click();
    expect(get("#request-json-error").hidden).toBe(true);
    // TypeSafe Jev allows at most 10 levels, so ticking it beside the unlimited provider refuses 11.
    choose([withoutLevelLimitOf(subq), typesafe]);
    submit();
    expect(
      summaryItems()
        .map((item) => item.text)
        .join(" "),
    ).toContain("at most 10");
  });
});

/** `provider` with no maximum number of levels. */
function withoutLevelLimitOf(provider: ProviderSummary): ProviderSummary {
  return {
    ...provider,
    capabilities: {
      ...provider.capabilities,
      scoreLevels: { min: provider.capabilities.scoreLevels.min },
    },
  };
}

function elevenLevelCriteria(): string[] {
  return Array.from({ length: 11 }, (_, index) => `Level ${index}`);
}

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
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    const idField = get<HTMLInputElement>('#request-form input[data-control="id"]');
    const answerBefore = get("#results-list").innerHTML;
    expect(pressEnter(idField)).toBe(true);
    await settled();
    expect(decideCalls(fetchMock)).toHaveLength(0);
    expect(get("#results-list").innerHTML).toBe(answerBefore);
  });

  it('cancels Enter in an option\'s name field in "Pick one option" and posts nothing', async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("choice");
    const optionName = get<HTMLInputElement>('#request-form input[data-control="name"]');
    expect(pressEnter(optionName)).toBe(true);
    await settled();
    expect(decideCalls(fetchMock)).toHaveLength(0);
  });

  it("leaves Enter alone in a textarea, so it still inserts a new line", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    expect(pressEnter(stateField("noul"))).toBe(false);
    await settled();
    expect(decideCalls(fetchMock)).toHaveLength(0);
  });

  it("leaves Enter that confirms an input-method composition alone", async () => {
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    const idField = get<HTMLInputElement>('#request-form input[data-control="id"]');
    expect(pressEnter(idField, true)).toBe(false);
  });

  it("still posts when Run is activated", async () => {
    const fetchMock = mockFetch();
    setupRequestForm(document, selectionOf(subq).selection);
    await loadFilm("noul");
    runButton("noul").click();
    await vi.waitFor(() => expect(decideCalls(fetchMock)).toHaveLength(1));
  });
});
