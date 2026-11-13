import type { DecisionSuccess, Primitive } from "../decision/contract.ts";
import { EXAMPLE_SETS, isExampleSetId } from "../decision/examples.ts";
import type { ExampleSet, ExampleSetId } from "../decision/examples.ts";
import { validateDecisionRequest } from "../decision/validate.ts";
import { DEFAULT_PROVIDER } from "../providers/catalog.ts";
import type { ProviderCapabilities } from "../providers/catalog.ts";
import type { ValidDecisionRequest, ValidationResult } from "../decision/validate.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { createAttachments, withImages } from "./attachments.ts";
import { browserRasterizer } from "./shrink-browser.ts";
import { createShrinkTransform } from "./shrink.ts";
import type { Attachments } from "./attachments.ts";
import { imagesCount, textOnlySentence } from "./image-sentences.ts";
import {
  imageProviders,
  providerNames,
  strictestCapabilities,
  textOnlyProviders,
} from "./provider-limits.ts";
import { askProvider, REQUEST_TIMEOUT_MS } from "./client.ts";
import type { AskResult } from "./client.ts";
import { findIssues, STATE_KEY, toRequest, toViewModel } from "./composer/model.ts";
import type { ComposerModel, DraftRequest, Issue } from "./composer/model.ts";
import { createComposer } from "./composer/tree.ts";
import type { Composer } from "./composer/tree.ts";
import { createConfirmDialog } from "./confirm-dialog.ts";
import type { Confirm, Confirmation } from "./confirm-dialog.ts";
import { appendWithInlineCode, create, required } from "./dom.ts";
import { createErrorSummary } from "./error-summary.ts";
import type { ErrorSummary, Problem } from "./error-summary.ts";
import { describeJsonError } from "./json-error.ts";
import type { ProviderSelection } from "./provider-select.ts";
import { renderError, renderNonJson, renderResponse, renderUnreachable } from "./readout.ts";
import { QUESTION_TYPE_NAMES } from "./question-types.ts";
import { answersSentence, comparedSentence, setupResults } from "./results.ts";
import type { Outcome, ProviderRun } from "./results.ts";
import { fetchSampleImages } from "./sample-images.ts";
import { capitalise } from "./text.ts";
import { questionTypeTerm } from "./vocabulary.ts";
import { renderWire } from "./wire-view.ts";

/**
 * The request form: one request, whose question type is a choice (issue #102).
 *
 * The page used to repeat the whole editor once per question type. Now one
 * form holds what the model reads, the images, and the questions, and a radio
 * group chooses the type. Each type keeps its own questions and criteria, so
 * switching to another type and back restores them; what the model reads and
 * the images belong to the request, not the type, so they stay as they are.
 */

type View = "tree" | "json";

const VIEWS = ["tree", "json"] as const satisfies readonly View[];

const PRIMITIVES = ["noul", "choice", "score"] as const satisfies readonly Primitive[];

type RequestForm = {
  /** The question type the form shows and Run sends. */
  primitive: Primitive;
  /**
   * The questions and criteria each type had when the form last left it, so
   * switching back restores them. The shown type's entry is stale while it is
   * shown; the composer holds its live model.
   */
  remembered: Record<Primitive, ComposerModel>;
  /** The ticked providers, which Run asks. */
  selected: readonly ProviderSummary[];
  /** The limits every ticked provider accepts, which the form validates against. */
  capabilities: ProviderCapabilities;
  form: HTMLFormElement;
  typeInputs: Record<Primitive, HTMLInputElement>;
  field: HTMLTextAreaElement;
  error: HTMLElement;
  hintId: string;
  /** The sentence in the JSON view's hint that says how attached images travel. Empty without images. */
  imagesHint: HTMLElement;
  /** The request's images, which follow the selected provider and every question type. */
  attachments: Attachments;
  /** The image control's file input, which the summary links to when the images stop a run. */
  imagesInput: HTMLInputElement;
  button: HTMLButtonElement;
  label: HTMLElement;
  /** The sentence Run's aria-describedby points at once the form is edited: what Run will send, or why it cannot. */
  runNote: HTMLElement;
  /** The box at the top of the form that lists why the last press of Run sent nothing. */
  summary: ErrorSummary;
  status: HTMLElement;
  /** The message the form shows until it is edited or an example is loaded. */
  emptyMessage: HTMLElement;
  loadButtons: Record<ExampleSetId, HTMLButtonElement>;
  switches: Record<View, HTMLInputElement>;
  bodies: Record<View, HTMLElement>;
  composer: Composer;
  view: View;
  /** What Run sends. The tree and the JSON textarea are two views of it. */
  request: DraftRequest;
  /**
   * The JSON last written into the textarea from `request`. While the textarea
   * still holds exactly this, switching back keeps the tree's model, including
   * fan-out questions and rows that are not valid yet.
   */
  serialised: string;
  /**
   * True from the start until the person edits the form or loads an example.
   * Run sends nothing meanwhile, and the empty-state message, which describes Run, says why.
   */
  untouched: boolean;
  /** How many edits the person made since an example was last loaded; a load asks before replacing any. */
  edits: number;
  /** The images the last loaded example attached. Any other attached image is the person's, and a load asks before removing it. */
  loadedImages: ReadonlySet<File>;
  /** True from a press of a load button until the example is in place; presses meanwhile are dropped. */
  loading: boolean;
  /** Tells the page that what Run would send, or why it cannot, may have changed. */
  onChange: () => void;
};

const VIEW_STORAGE_KEY = "decisionmachines3000:view";
const TYPE_STORAGE_KEY = "decisionmachines3000:question-type";

/** A stored per-viewer convenience: any storage failure means "nothing stored". */
function readStored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is blocked or full; the form just opens on its defaults next time.
  }
}

function isPrimitive(value: string | undefined): value is Primitive {
  return value === "noul" || value === "choice" || value === "score";
}

/** What a request that failed validation says, with the path to the problem when there is one. */
function invalidMessage(invalid: { error: string; detail?: string }): string {
  const where = invalid.detail ? ` Path: ${invalid.detail}.` : "";
  return `${invalid.error}${where}`;
}

function setStatus(request: RequestForm, message: string, tone: "note" | "alert" = "note"): void {
  request.status.textContent = message;
  request.status.dataset.tone = tone;
}

/** The shown question type's plain name: "Yes or no". */
function typeName(request: RequestForm): string {
  return QUESTION_TYPE_NAMES[request.primitive];
}

/** What the JSON view's hint says about the images, or nothing when there are none. */
function imagesHintText(count: number): string {
  if (count === 0) return "";
  return `${imagesCount(count)} attached. Run adds ${count === 1 ? "it" : "them"} to this JSON as base64 in an "images" list, which this view does not show.`;
}

/**
 * What a type holds before anything is loaded: an empty state, no questions,
 * and no shared criteria. The JSON view shows the same,
 * `{ "primitive": …, "state": "", "questions": {} }`.
 */
function emptyModel(primitive: Primitive): ComposerModel {
  return { primitive, state: "", questions: [], nextKey: 0 };
}

type FormSetup = {
  /** The type the form opens on. */
  primitive: Primitive;
  /** The providers ticked while the form is built, for the image control's first, silent render. */
  selected: readonly ProviderSummary[];
  /** The providers the page received, so the image control and example can name the ones that take images. */
  providers: () => readonly ProviderSummary[];
  /** Called after any change to what Run would send or why it cannot: the images, or an edit. */
  onChange: () => void;
};

function setupForm(
  form: HTMLFormElement,
  { primitive, selected, providers, onChange }: FormSetup,
): RequestForm {
  const capabilities = limitsOf(selected);
  const status = required(form, ".request-status", HTMLElement);
  const treeBody = required(form, '[data-view-body="tree"]', HTMLElement);
  const hint = required(form, ".hint", HTMLElement);
  const imagesHint = create("span", { className: "hint-images" });
  hint.append(" ", imagesHint);

  // The composer's and the image control's callbacks need the finished form, which needs them.
  let request: RequestForm | undefined;
  const attachments = createAttachments(form, {
    prefix: "request-images",
    selected,
    providers,
    transform: createShrinkTransform(browserRasterizer()),
    onChange: () => {
      if (!request) return;
      request.imagesHint.textContent = imagesHintText(attachments.count());
      // An image added or removed decides whether a blank state is a problem.
      revalidate(request);
      onChange();
    },
  });
  const composer = createComposer({
    prefix: "request-tree",
    model: emptyModel(primitive),
    capabilities,
    announce: (message) => {
      if (request) setStatus(request, message);
    },
    onChange: () => {
      if (!request) return;
      request.request = toRequest(composer.model());
      if (request.status.dataset.tone === "alert") setStatus(request, "");
      markEdited(request);
    },
  });
  treeBody.append(composer.element);

  const typeInput = (candidate: Primitive): HTMLInputElement =>
    required(form, `input[name="question-type"][value="${candidate}"]`, HTMLInputElement);
  const typeInputs: Record<Primitive, HTMLInputElement> = {
    noul: typeInput("noul"),
    choice: typeInput("choice"),
    score: typeInput("score"),
  };
  for (const candidate of PRIMITIVES) {
    // Each option's last line, the API's word for its type.
    const term = required(form, `#${candidate}-type-term`, HTMLElement);
    term.replaceChildren("API term: ");
    appendWithInlineCode(term, `${questionTypeTerm(candidate)}.`);
  }

  request = {
    primitive,
    remembered: {
      noul: emptyModel("noul"),
      choice: emptyModel("choice"),
      score: emptyModel("score"),
    },
    selected,
    capabilities,
    form,
    typeInputs,
    field: required(form, "textarea.request-field", HTMLTextAreaElement),
    error: required(form, ".field-error", HTMLElement),
    hintId: hint.id,
    imagesHint,
    attachments,
    imagesInput: required(form, ".attachments-input", HTMLInputElement),
    button: required(form, ".run", HTMLButtonElement),
    label: required(form, ".run-label", HTMLElement),
    runNote: required(form, ".run-note", HTMLElement),
    summary: createErrorSummary(
      required(form, ".error-summary", HTMLElement),
      "The request cannot be sent yet",
    ),
    status,
    emptyMessage: required(form, ".request-empty", HTMLElement),
    loadButtons: {
      film: required(form, '.load-example[data-example="film"]', HTMLButtonElement),
      images: required(form, '.load-example[data-example="images"]', HTMLButtonElement),
    },
    switches: {
      tree: required(form, 'input[name="view"][value="tree"]', HTMLInputElement),
      json: required(form, 'input[name="view"][value="json"]', HTMLInputElement),
    },
    bodies: {
      tree: treeBody,
      json: required(form, '[data-view-body="json"]', HTMLElement),
    },
    composer,
    view: "tree",
    request: toRequest(composer.model()),
    serialised: "",
    untouched: true,
    edits: 0,
    loadedImages: new Set(),
    loading: false,
    onChange,
  };
  showType(request, primitive);
  return request;
}

/**
 * Records an edit the person made: the empty-state message goes, a load will
 * ask first, and the page hears of it, so Run's note and a shown error summary
 * follow the edit.
 */
function markEdited(request: RequestForm): void {
  request.edits += 1;
  if (request.untouched) {
    request.untouched = false;
    request.emptyMessage.hidden = true;
  }
  request.onChange();
}

function showView(request: RequestForm, view: View): void {
  request.view = view;
  for (const candidate of VIEWS) {
    request.switches[candidate].checked = candidate === view;
    request.bodies[candidate].hidden = candidate !== view;
  }
}

/** Checks the radio for `primitive`. The form's model is the caller's to change. */
function showType(request: RequestForm, primitive: Primitive): void {
  request.primitive = primitive;
  for (const candidate of PRIMITIVES) {
    request.typeInputs[candidate].checked = candidate === primitive;
  }
}

function writeJson(request: RequestForm): void {
  request.serialised = JSON.stringify(request.request, null, 2);
  request.field.value = request.serialised;
  clearFieldError(request);
}

/**
 * The limits the form checks a request against: those every ticked provider
 * accepts, or, with none ticked, the default provider's, so the tree still
 * reports what it can.
 */
function limitsOf(selected: readonly ProviderSummary[]): ProviderCapabilities {
  return selected.length === 0 ? DEFAULT_PROVIDER.capabilities : strictestCapabilities(selected);
}

/** How many of the request's images Run would send to the providers that take images: none when no ticked provider does. */
function sentImageCount(request: RequestForm): number {
  return request.capabilities.images === false ? 0 : request.attachments.count();
}

/**
 * Checks `value` as the request the form would send: against the limits every
 * ticked provider accepts, with the images the image providers get, then
 * against each ticked text-only provider, which gets no images. A blank state
 * passes with an image attached, but not for a provider that is sent no image.
 */
function validateForRequest(request: RequestForm, value: unknown): ValidationResult {
  const strictest = validateDecisionRequest(value, request.capabilities, sentImageCount(request));
  if (!strictest.ok || sentImageCount(request) === 0) return strictest;
  for (const provider of textOnlyProviders(request.selected)) {
    const own = validateDecisionRequest(value, provider.capabilities, 0);
    if (!own.ok) {
      return {
        ...own,
        error: `For ${provider.displayName}, which is sent no images: ${own.error}`,
      };
    }
  }
  return strictest;
}

/** The textarea read as a valid request, or why it is not one. Shows nothing. */
function checkJson(
  request: RequestForm,
): { ok: true; value: ValidDecisionRequest } | { ok: false; message: string } {
  const source = request.field.value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    return { ok: false, message: describeJsonError(source, error) };
  }

  const validation = validateForRequest(request, parsed);
  if (!validation.ok) return { ok: false, message: invalidMessage(validation) };
  return { ok: true, value: validation.value };
}

/**
 * Reads the textarea as a valid request, or shows why it is not one under the
 * textarea. Focus moves to the textarea then, unless `focus` is false.
 */
function readJson(request: RequestForm, focus = true): ValidDecisionRequest | undefined {
  const checked = checkJson(request);
  if (!checked.ok) {
    showFieldError(request, checked.message, focus);
    return undefined;
  }
  clearFieldError(request);
  return checked.value;
}

/**
 * Takes an edited textarea into the tree's model. The JSON names its own
 * `primitive`, so a person who changed it there has changed the question type,
 * and the radios follow. Returns false, after showing why under the textarea,
 * when the JSON is not a valid request.
 */
function adoptJson(request: RequestForm): boolean {
  if (request.field.value === request.serialised) return true;
  const read = readJson(request);
  if (read === undefined) return false;
  request.composer.setModel(toViewModel(read));
  request.request = toRequest(request.composer.model());
  if (read.primitive !== request.primitive) showType(request, read.primitive);
  request.serialised = request.field.value;
  markEdited(request);
  return true;
}

/**
 * Switches the form between the tree and the JSON textarea. Leaving the JSON view
 * needs valid JSON; otherwise the switch is refused and the error shows under
 * the textarea. Returns whether the form now shows `view`.
 */
function switchView(request: RequestForm, view: View): boolean {
  if (view === request.view) return true;

  if (view === "json") {
    writeJson(request);
    showView(request, "json");
    store(VIEW_STORAGE_KEY, "json");
    return true;
  }

  if (!adoptJson(request)) {
    setStatus(request, "Fix the JSON to switch to the tree.", "alert");
    showView(request, "json");
    return false;
  }
  clearFieldError(request);
  setStatus(request, "");
  showView(request, "tree");
  store(VIEW_STORAGE_KEY, "tree");
  return true;
}

/**
 * Shows `next`'s questions and criteria with the current state. The type that
 * was shown keeps its own, so switching back restores them. In the JSON view
 * the textarea is read first, and an invalid one refuses the switch, because
 * its questions would otherwise be lost. Returns whether the form now shows `next`.
 */
function switchType(request: RequestForm, next: Primitive): boolean {
  if (next === request.primitive) return true;
  if (request.view === "json" && !adoptJson(request)) {
    setStatus(request, "Fix the JSON to change the question type.", "alert");
    showType(request, request.primitive);
    return false;
  }
  if (next === request.primitive) {
    // The JSON named this type itself; adopting it already switched.
    return true;
  }

  const current = request.composer.model();
  request.remembered[request.primitive] = current;
  request.composer.setModel({ ...request.remembered[next], state: current.state });
  request.request = toRequest(request.composer.model());
  showType(request, next);
  store(TYPE_STORAGE_KEY, next);
  if (request.view === "json") writeJson(request);
  if (request.status.dataset.tone === "alert") setStatus(request, "");
  request.onChange();
  return true;
}

/** Shows `message` under the textarea. Focus moves to the textarea unless `focus` is false. */
function showFieldError(request: RequestForm, message: string, focus = true): void {
  request.error.textContent = message;
  request.error.hidden = false;
  request.field.setAttribute("aria-invalid", "true");
  request.field.setAttribute("aria-describedby", `${request.error.id} ${request.hintId}`);
  if (focus) request.field.focus();
}

function clearFieldError(request: RequestForm): void {
  request.error.textContent = "";
  request.error.hidden = true;
  request.field.removeAttribute("aria-invalid");
  request.field.setAttribute("aria-describedby", request.hintId);
}

/** What the summary and Run's note say about a request that is still empty. */
const EMPTY_REQUEST = "Load an example or write a question to run the request.";

/** A summary link to `element`, which must have an id. */
function targetOf(element: HTMLElement): NonNullable<Problem["target"]> {
  return { href: `#${element.id}`, focus: () => element.focus() };
}

/**
 * Why no provider can take the request. The summary links to the first
 * provider checkbox while providers can be ticked. While the choice is
 * disabled, because the list is loading, failed, or is empty, the problem
 * beside it says why, so this is listed without a link.
 */
function providerProblem(choice: HTMLFieldSetElement | null): Problem {
  const first = choice?.disabled === false ? choice.querySelector<HTMLInputElement>("input") : null;
  if (first === null || first === undefined) {
    return {
      key: "provider",
      message: "No provider is available yet. The Providers to ask area beside Run says why.",
    };
  }
  return {
    key: "provider",
    message: "Tick at least one provider to run the request.",
    target: targetOf(first),
  };
}

/**
 * What stops the request from running before it is read: nothing to send
 * yet, no provider, or images that are over a provider's limits or still
 * being added. Each links to the control that fixes it.
 */
function runBlockers(request: RequestForm, choice: HTMLFieldSetElement | null): Problem[] {
  const problems: Problem[] = [];
  if (request.untouched) {
    problems.push({
      key: "empty",
      message: EMPTY_REQUEST,
      target: targetOf(request.loadButtons.film),
    });
  }
  if (request.selected.length === 0) problems.push(providerProblem(choice));
  const blocked = request.attachments.blocked();
  if (blocked !== undefined) {
    problems.push({ key: "images", message: blocked, target: targetOf(request.imagesInput) });
  }
  return problems;
}

/**
 * The tree's issues as summary problems. Each link moves focus the way Run
 * always has, through the composer, and names the row's issue slot, which
 * shows the same message beside the control.
 */
function issueProblems(request: RequestForm, issues: readonly Issue[]): Problem[] {
  const seen = new Map<string, number>();
  return issues.map((issue) => {
    // Two issues can concern the same control; the count keeps their keys apart.
    const base = `tree:${issue.key}:${issue.field}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slot = request.composer.element.querySelector<HTMLElement>(
      `[data-issue-for="${CSS.escape(issue.key)}"]`,
    );
    return {
      key: count === 0 ? base : `${base}:${count}`,
      message: issue.message,
      target: {
        // Every row the composer reports on has a slot; "#" only guards against markup drifting.
        href: slot === null ? "#" : `#${slot.id}`,
        focus: () => request.composer.focusIssue(issue),
      },
    };
  });
}

/** The JSON view's problem, which links to the textarea. */
function jsonProblem(request: RequestForm, message: string): Problem {
  return { key: "json", message, target: targetOf(request.field) };
}

/** A request the shared validator refuses as a whole, which no one control can fix, so it has no link. */
function invalidProblem(invalid: { error: string; detail?: string }): Problem {
  return { key: "request", message: invalidMessage(invalid) };
}

/** The problems in the request, found without revealing, showing, or focusing anything. */
function requestProblems(request: RequestForm): Problem[] {
  if (request.view === "json") {
    const checked = checkJson(request);
    return checked.ok ? [] : [jsonProblem(request, checked.message)];
  }
  const issues = findIssues(
    request.composer.model(),
    request.capabilities,
    sentImageCount(request),
  );
  if (issues.length > 0) return issueProblems(request, issues);
  const validation = validateForRequest(request, request.request);
  return validation.ok ? [] : [invalidProblem(validation)];
}

type Prepared =
  | { ok: true; sent: ValidDecisionRequest; body: string }
  | { ok: false; problems: Problem[] };

/**
 * What Run sends from the current view, or the problems that stop it. The
 * problems are also shown where they are: in the tree's issue slots, or under
 * the textarea. The JSON view sends its text unchanged, as it always has, and
 * the radios follow a `primitive` changed there. Nothing here moves focus; Run
 * decides where focus goes.
 */
function prepareRun(request: RequestForm): Prepared {
  if (request.view === "json") {
    const read = readJson(request, false);
    if (read === undefined) {
      return { ok: false, problems: [jsonProblem(request, request.error.textContent ?? "")] };
    }
    request.request = read;
    if (read.primitive !== request.primitive) {
      request.composer.setModel(toViewModel(read));
      showType(request, read.primitive);
    }
    return { ok: true, sent: read, body: request.field.value };
  }

  const issues = request.composer.revealIssues();
  if (issues.length > 0) return { ok: false, problems: issueProblems(request, issues) };

  // The tree found nothing wrong; the shared validator has the final word.
  const validation = validateForRequest(request, request.request);
  if (!validation.ok) return { ok: false, problems: [invalidProblem(validation)] };
  return { ok: true, sent: validation.value, body: JSON.stringify(validation.value) };
}

/**
 * Checks what the form shows against the limits of a newly selected provider,
 * or against a changed set of images, so a problem the old ones caused goes
 * away, and a new one is shown, without another press of Run. The tree's
 * issue slots and the error under the textarea follow here; the error summary
 * follows in the caller. Nothing here moves focus.
 */
function revalidate(request: RequestForm): void {
  request.composer.setCapabilities(request.capabilities);
  request.composer.setImageCount(sentImageCount(request));
  if (request.view !== "json") return;

  const parsed = tryParse(request.field.value);
  // A syntax error stays as it is shown; only validity depends on the provider and images.
  if (!parsed.ok) return;
  const validation = validateForRequest(request, parsed.value);
  if (validation.ok) {
    request.request = validation.value;
    if (!request.error.hidden) clearFieldError(request);
    if (request.status.dataset.tone === "alert") setStatus(request, "");
  } else if (!request.error.hidden) {
    showFieldError(request, invalidMessage(validation), false);
  }
}

/**
 * Puts `loaded` into the form, in whichever view is open, as if it had just
 * been loaded: no edits, no shown error, and the empty-state message gone.
 * Only the shown type's questions change; the other types keep theirs.
 */
function replaceRequest(request: RequestForm, loaded: ValidDecisionRequest): void {
  request.composer.setModel(toViewModel(loaded));
  request.request = toRequest(request.composer.model());
  clearFieldError(request);
  if (request.view === "json") writeJson(request);
  request.edits = 0;
  if (request.untouched) {
    request.untouched = false;
    request.emptyMessage.hidden = true;
  }
  // The summary was about the request this one replaces.
  request.summary.clear();
  request.onChange();
}

/**
 * Puts focus on the first field of what was loaded: the tree's "What the model reads" field, or
 * the textarea. Only when focus is still on `pressed`, the load button, or has
 * fallen to the body: a person who tabbed on while the pictures were fetched
 * keeps their place.
 */
function focusLoaded(request: RequestForm, pressed: Element | null): void {
  const active = request.form.ownerDocument.activeElement;
  if (active !== null && active !== pressed && active !== request.form.ownerDocument.body) return;
  if (request.view === "json") {
    request.field.focus();
    return;
  }
  const state = request.composer.element.querySelector<HTMLElement>(
    `[data-for="${STATE_KEY}"][data-control="state"]`,
  );
  state?.focus();
}

/**
 * Why the image example cannot load right now, or undefined when it can: no
 * ticked provider would be sent the pictures. Its button stays while only
 * text-only providers are ticked and presses into this sentence, which names
 * the listed providers that take images (issue #98). It also answers a
 * provider change made while the pictures were being fetched.
 */
function imageExampleProblem(
  set: ExampleSet,
  selected: readonly ProviderSummary[],
  providers: readonly ProviderSummary[],
): string | undefined {
  const needs = `The ${set.label} needs a provider that takes images.`;
  if (selected.length === 0) return `${needs} No provider is ticked.`;
  if (imageProviders(selected).length === 0) {
    return `${needs} ${textOnlySentence(selected, providers, "first")}`;
  }
  return undefined;
}

/** What a load would take from the person: their edits, and how many images they attached themselves. */
type Losses = { edits: number; images: number };

function lossesOf(request: RequestForm): Losses {
  const own = request.attachments.files().filter((file) => !request.loadedImages.has(file));
  return { edits: request.edits, images: own.length };
}

/** The question a load asks before it replaces `losses`, which says plainly that there is no undo. */
function replaceQuestion(request: RequestForm, set: ExampleSet, losses: Losses): Confirmation {
  const costs: string[] = [];
  if (losses.edits > 0) costs.push("replaces your request");
  if (losses.images > 0) {
    costs.push(
      `removes ${losses.images === 1 ? "the image" : `the ${losses.images} images`} you attached`,
    );
  }
  return {
    title: `Load the ${set.label} for ${typeName(request)}?`,
    message: `This ${costs.join(" and ")}. You cannot undo this.`,
  };
}

/**
 * What one provider made of a run, for its part of the result. `omittedImages`
 * is how many attached images it was sent without, because it is text only.
 */
function outcomeOf(sent: unknown, result: AskResult, omittedImages: number): Outcome {
  switch (result.kind) {
    case "response":
      return result.response.ok
        ? { kind: "answered", response: result.response, omittedImages }
        : { kind: "failed", reading: renderResponse(sent, result.response) };
    case "unreachable":
      return { kind: "failed", reading: renderUnreachable(result.detail) };
    case "non_json":
      return { kind: "failed", reading: renderNonJson(result.status) };
    case "timeout":
      return {
        kind: "failed",
        reading: renderError(
          `No answer arrived within ${REQUEST_TIMEOUT_MS / 1000} seconds. Run the request again.`,
        ),
      };
    case "unrecognised":
      return {
        kind: "failed",
        reading: renderError(
          "The decision endpoint answered in a shape this page does not recognise.",
          `HTTP ${result.status}. Check the server log for details.`,
        ),
      };
  }
}

function tryParse(source: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return { ok: false };
  }
}

export type RequestFormOptions = {
  /** Called after every run the provider answered successfully; the warm form restarts its count. */
  onAnswered?: (response: DecisionSuccess) => void;
  /**
   * Asks whether a load may replace what the person made, and resolves the
   * answer. The page asks through its `#replace-dialog`; tests answer directly.
   */
  confirmReplace?: Confirm;
};

/**
 * Wires the request form, which starts empty, to its question type radios,
 * its two example buttons, its Tree and JSON views, and Run, which posts to
 * every provider `selection` holds, at the same time, and adds what came back
 * to the result list as one result. Run
 * stays in the tab order whatever the form holds: its note says what it will
 * send or why it cannot, and a press that cannot send lists every reason in
 * the form's error summary.
 */
export function setupRequestForm(
  root: Document,
  selection: ProviderSelection,
  { onAnswered, confirmReplace }: RequestFormOptions = {},
): void {
  const results = setupResults(root);
  const confirm =
    confirmReplace ?? createConfirmDialog(required(root, "#replace-dialog", HTMLDialogElement));
  // Owned by the provider choice; read here only to link to it, and to know whether it can take focus.
  const providerChoice = root.querySelector<HTMLFieldSetElement>("#provider-choice");
  const storedType = readStored(TYPE_STORAGE_KEY);
  const request = setupForm(required(root, "#request-form", HTMLFormElement), {
    primitive: isPrimitive(storedType) ? storedType : "noul",
    selected: selection.selected(),
    providers: () => selection.providers(),
    onChange: changed,
  });
  /** Whether a run is in flight. */
  let running = false;

  /** What Run's note says once the form is edited: what a press will send, or the first reason it will send nothing. */
  function runNoteText(): string {
    if (running) {
      return request.selected.length > 1
        ? "Waiting for the answers to this request."
        : "Waiting for the answer to this request.";
    }
    const [blocker] = runBlockers(request, providerChoice);
    if (blocker !== undefined) return blocker.message;
    const count = request.attachments.count();
    const sends = `Checks the ${typeName(request)} request and sends it to`;
    const withImages = imageProviders(request.selected);
    const without = textOnlyProviders(request.selected);
    if (count === 0) return `${sends} ${providerNames(request.selected)}.`;
    if (withImages.length === 0) {
      return `${sends} ${providerNames(without)} without your ${imagesCount(count)}.`;
    }
    if (without.length === 0) {
      return `${sends} ${providerNames(withImages)} with ${imagesCount(count)}.`;
    }
    return `${sends} ${providerNames(withImages)} with ${imagesCount(count)}, and to ${providerNames(without)} without them.`;
  }

  /**
   * Run is marked aria-disabled while a run is in flight, and a press then
   * does nothing. It is never `disabled`, so it keeps focus and its place in
   * the tab order, and its note says why. While the form is untouched, its
   * note is hidden and Run is described by the empty-state message instead,
   * so the page does not say the same thing twice. "Load image example" is
   * hidden only while no provider is ticked. While only text-only providers
   * are ticked it stays, marked `aria-disabled` and `data-unavailable` but
   * still focusable and pressable, so a visitor finds that images exist and its
   * press says why nothing loads (issue #98).
   */
  function updateButtons(): void {
    const unavailable = request.selected.length === 0;
    const textOnly = !unavailable && imageProviders(request.selected).length === 0;
    const exampleButton = request.loadButtons.images;
    exampleButton.hidden = unavailable;
    // `aria-disabled`, not `disabled`: the button stays in the tab order and its press explains.
    if (textOnly) exampleButton.setAttribute("aria-disabled", "true");
    else exampleButton.removeAttribute("aria-disabled");
    exampleButton.toggleAttribute("data-unavailable", textOnly);
    if (running) request.button.setAttribute("aria-disabled", "true");
    else request.button.removeAttribute("aria-disabled");
    request.label.textContent = running ? "Running" : "Run";
    request.button.toggleAttribute("data-running", running);
    request.runNote.textContent = request.untouched ? "" : runNoteText();
    request.runNote.hidden = request.untouched;
    request.button.setAttribute(
      "aria-describedby",
      request.untouched ? request.emptyMessage.id : request.runNote.id,
    );
  }

  /** Drops what a shown error summary lists once it is fixed, and updates what changed. */
  function refreshSummary(): void {
    if (!request.summary.shown()) return;
    const blockers = runBlockers(request, providerChoice);
    request.summary.update(
      request.untouched ? blockers : [...blockers, ...requestProblems(request)],
    );
  }

  /** Follows a change to the request or its images. */
  function changed(): void {
    updateButtons();
    refreshSummary();
  }

  function setRunning(active: boolean): void {
    running = active;
    updateButtons();
  }

  selection.subscribe((next) => {
    request.selected = next;
    request.capabilities = limitsOf(next);
    revalidate(request);
    // The image control re-marks its images for the ticked providers and tells the page through onChange.
    request.attachments.setSelected(next);
    changed();
  });
  updateButtons();

  /**
   * Loads an example set for the shown question type, replacing what the model
   * reads, that type's questions, and every attached image. The other types
   * keep their questions. The image set needs an image provider, and its
   * pictures are fetched before anything is replaced, so a failed fetch leaves
   * the form as it was. Edits and images the person attached are never
   * replaced without asking, including an image still being added when the
   * button was pressed and any made while the pictures were being fetched, and
   * the image check runs again after the fetch, because the provider may have
   * changed meanwhile. The status line says what happened either way, in one
   * sentence once loaded, and focus lands on the first field of what was
   * loaded. Pressed while only text-only providers are ticked, the image set
   * loads nothing and the status line names the providers that take images. It
   * does not tick a provider: that choice also changes the stored preference
   * and who receives the person's data, so it stays theirs.
   */
  async function loadExample(set: ExampleSet): Promise<void> {
    if (request.loading) {
      setStatus(request, "An example is still loading.");
      return;
    }
    const pressed = root.activeElement;
    /** Whether the image set may go into the form right now; announces the problem when not. */
    const imagesAllowed = (): boolean => {
      if (set.images.length === 0) return true;
      const problem = imageExampleProblem(set, request.selected, selection.providers());
      if (problem === undefined) return true;
      setStatus(request, problem, "alert");
      return false;
    };
    if (!imagesAllowed()) return;

    /**
     * What the person agreed may go, or undefined when they kept their work.
     * It asks whenever there is more to lose than `agreed`, and an image still
     * being added counts, so it waits for every add first, and again after each
     * answer, until nothing new has appeared. It returns with the queue still,
     * so the caller's `replace` runs before any later add.
     */
    const agreesToReplace = async (agreed: Losses): Promise<Losses | undefined> => {
      for (;;) {
        await request.attachments.settled();
        const losses = lossesOf(request);
        if (losses.edits <= agreed.edits && losses.images <= agreed.images) return losses;
        if (!(await confirm(replaceQuestion(request, set, losses)))) return undefined;
        agreed = losses;
      }
    };
    const kept = "Nothing loaded. Your request and images are kept.";

    request.loading = true;
    try {
      const agreed = await agreesToReplace({ edits: 0, images: 0 });
      if (agreed === undefined) {
        setStatus(request, kept);
        return;
      }

      let files: File[];
      try {
        files = await fetchSampleImages(set.images);
      } catch {
        setStatus(
          request,
          `The ${set.label}'s sample pictures could not be loaded. Nothing was changed.`,
          "alert",
        );
        return;
      }
      if (!imagesAllowed()) return;
      if ((await agreesToReplace(agreed)) === undefined) {
        setStatus(request, kept);
        return;
      }

      replaceRequest(request, set.requests[request.primitive]);
      // The load says what arrived in one sentence, so the control stays quiet.
      const { added, refused } = await request.attachments.replace(files);
      request.loadedImages = new Set(added);
      setStatus(
        request,
        refused.length === 0
          ? `${capitalise(set.label)} loaded.`
          : [
              `${capitalise(set.label)} loaded, but only ${added.length} of ${files.length} sample pictures were attached.`,
              ...refused,
            ].join(" "),
        refused.length === 0 ? "note" : "alert",
      );
      focusLoaded(request, pressed);
    } finally {
      request.loading = false;
    }
  }

  /**
   * Asks one provider and makes its part of the result. `bodies` holds the
   * request text alone, for a text-only provider, and the text with the images
   * as base64, encoded once for every provider that takes them.
   */
  async function ask(
    sent: ValidDecisionRequest,
    provider: ProviderSummary,
    bodies: { text: string; withImages: string },
  ): Promise<{ run: ProviderRun; answered: DecisionSuccess | undefined }> {
    const count = request.attachments.count();
    const textOnly = provider.capabilities.images === false;
    const omittedImages = textOnly ? count : 0;
    try {
      const result = await askProvider(provider.id, textOnly ? bodies.text : bodies.withImages);
      const outcome = outcomeOf(sent, result, omittedImages);
      const wire = result.kind === "response" ? renderWire(result.response) : undefined;
      return {
        run: { provider: provider.displayName, outcome, wire },
        answered: outcome.kind === "answered" ? outcome.response : undefined,
      };
    } catch (error) {
      const reading = renderError(
        "Something went wrong while showing the answer.",
        error instanceof Error ? error.message : undefined,
      );
      return {
        run: {
          provider: provider.displayName,
          outcome: { kind: "failed", reading },
          wire: undefined,
        },
        answered: undefined,
      };
    }
  }

  /**
   * Lists every reason a press of Run sent nothing in the error summary and
   * moves focus to it, which makes a screen reader read it. The status line is
   * cleared, so the problem is said once. Problems in the request also stay in
   * their inline issue slots or under the textarea, where the summary's links lead.
   */
  function showProblems(problems: readonly Problem[]): void {
    setStatus(request, "");
    request.summary.show(problems);
    request.summary.focus();
  }

  async function run(): Promise<void> {
    const blockers = runBlockers(request, providerChoice);
    // An untouched request is empty, so checking it would only repeat that it is empty.
    const prepared = request.untouched ? undefined : prepareRun(request);
    if (prepared === undefined || !prepared.ok || blockers.length > 0) {
      const found = prepared?.ok === false ? prepared.problems : [];
      showProblems([...blockers, ...found]);
      return;
    }
    request.summary.clear();
    setStatus(request, "");
    setRunning(true);
    // The result is labelled with what ran and when it started, and never marked out of
    // date: the request or the providers may change later, and the label still says what this was.
    const at = new Date();
    const asked = [...request.selected];
    const questionType = QUESTION_TYPE_NAMES[prepared.sent.primitive];
    results.waiting(asked.map((provider) => provider.displayName));
    try {
      // Encoding the images happens while the form already shows that it is running, and once for all.
      const files = request.attachments.files();
      const withImagesBody =
        files.length > 0 && imageProviders(asked).length > 0
          ? await withImages(prepared.body, files)
          : prepared.body;
      const bodies = { text: prepared.body, withImages: withImagesBody };
      // At the same time (owner's decision, 2026-11-13): one slow provider does not hold up the others.
      const outcomes = await Promise.all(
        asked.map((provider) => ask(prepared.sent, provider, bodies)),
      );
      const runs = outcomes.map((outcome) => outcome.run);
      const answered = outcomes.flatMap((outcome) =>
        outcome.answered === undefined ? [] : [outcome.answered],
      );
      const [only] = answered;
      // A failure's alert speaks for itself, so the live region then names only who answered.
      const announcement =
        asked.length === 1
          ? only === undefined
            ? ""
            : answersSentence(
                questionType,
                runs[0]?.provider ?? "",
                Object.keys(only.answers).length,
              )
          : comparedSentence(
              questionType,
              runs.filter((run) => run.outcome.kind === "answered").map((run) => run.provider),
              asked.length,
            );
      results.add({ questionType, at, sent: prepared.sent, runs }, announcement);
      for (const response of answered) onAnswered?.(response);
    } finally {
      setRunning(false);
    }
  }

  if (readStored(VIEW_STORAGE_KEY) === "json") {
    // Restoring the preference must not write it back, so this skips switchView.
    writeJson(request);
    showView(request, "json");
  } else {
    showView(request, "tree");
  }

  for (const view of VIEWS) {
    request.switches[view].addEventListener("change", () => {
      // A refused switch puts the radios back; focus stays on the radio that was pressed.
      if (switchView(request, view)) {
        // A problem the summary named in the other view is no longer where its link points.
        refreshSummary();
      }
    });
  }

  for (const primitive of PRIMITIVES) {
    request.typeInputs[primitive].addEventListener("change", () => {
      if (switchType(request, primitive)) refreshSummary();
    });
  }

  for (const button of Object.values(request.loadButtons)) {
    button.addEventListener("click", () => {
      const id = button.dataset.example;
      if (!isExampleSetId(id)) return;
      loadExample(EXAMPLE_SETS[id]).catch((error: unknown) => {
        setStatus(
          request,
          `Something went wrong while loading the example${error instanceof Error ? `: ${error.message}` : "."}`,
          "alert",
        );
      });
    });
  }

  // Keep the request current while the JSON parses and validates, and drop a
  // shown error as soon as the text is fixed. Run and the switch back to the
  // tree report any remaining problem.
  request.field.addEventListener("input", () => {
    markEdited(request);
    const parsed = tryParse(request.field.value);
    const validation = parsed.ok ? validateForRequest(request, parsed.value) : undefined;
    if (validation?.ok) {
      request.request = validation.value;
      if (!request.error.hidden) clearFieldError(request);
      if (request.status.dataset.tone === "alert") setStatus(request, "");
    }
  });

  request.form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Run is aria-disabled meanwhile, so a press, or Enter in a field, does nothing.
    if (running) return;
    // run adds its own failures to the result list; what reaches here failed before anything was sent.
    run().catch((error: unknown) => {
      setStatus(
        request,
        `Something went wrong while running the request${error instanceof Error ? `: ${error.message}` : "."}`,
        "alert",
      );
    });
  });
}
