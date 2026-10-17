import type { DecisionSuccess, Primitive } from "../decision/contract.ts";
import { EXAMPLE_SETS, isExampleSetId } from "../decision/examples.ts";
import type { ExampleSet, ExampleSetId } from "../decision/examples.ts";
import { validateDecisionRequest } from "../decision/validate.ts";
import { DEFAULT_PROVIDER } from "../providers/catalog.ts";
import type { ProviderCapabilities } from "../providers/catalog.ts";
import type { ValidDecisionRequest } from "../decision/validate.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { createAttachments, toFormData } from "./attachments.ts";
import { browserRasterizer } from "./shrink-browser.ts";
import { createShrinkTransform } from "./shrink.ts";
import type { Attachments } from "./attachments.ts";
import { imagesCount } from "./image-sentences.ts";
import { askProvider, REQUEST_TIMEOUT_MS } from "./client.ts";
import type { AskResult, PostBody } from "./client.ts";
import { STATE_KEY, toRequest, toViewModel } from "./composer/model.ts";
import type { ComposerModel, DraftRequest } from "./composer/model.ts";
import { createComposer } from "./composer/tree.ts";
import type { Composer } from "./composer/tree.ts";
import { createConfirmDialog } from "./confirm-dialog.ts";
import type { Confirm, Confirmation } from "./confirm-dialog.ts";
import { create, required } from "./dom.ts";
import { describeJsonError } from "./json-error.ts";
import type { ProviderSelection } from "./provider-select.ts";
import {
  renderError,
  renderLoading,
  renderNonJson,
  renderResponse,
  renderUnreachable,
} from "./readout.ts";
import { fetchSampleImages } from "./sample-images.ts";
import { capitalise } from "./text.ts";
import { renderWire } from "./wire-view.ts";

type View = "tree" | "json";

const VIEWS = ["tree", "json"] as const satisfies readonly View[];

type Panel = {
  primitive: Primitive;
  /** The panel's name as its heading shows it: "Noul". */
  name: string;
  /** The limits this panel validates against. */
  capabilities: ProviderCapabilities;
  form: HTMLFormElement;
  field: HTMLTextAreaElement;
  error: HTMLElement;
  hintId: string;
  /** The sentence in the JSON view's hint that says how attached images travel. Empty without images. */
  imagesHint: HTMLElement;
  /** The panel's images, which follow the selected provider. */
  attachments: Attachments;
  button: HTMLButtonElement;
  label: HTMLElement;
  status: HTMLElement;
  /** The message a panel shows until it is edited or an example is loaded. */
  emptyMessage: HTMLElement;
  loadButtons: Record<ExampleSetId, HTMLButtonElement>;
  switches: Record<View, HTMLButtonElement>;
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
   * True from the start until the person edits the panel or loads an example.
   * Run is disabled meanwhile, and the empty-state message says why.
   */
  untouched: boolean;
  /** How many edits the person made since the panel was last loaded; a load asks before replacing any. */
  edits: number;
  /** The images the last loaded example attached. Any other attached image is the person's, and a load asks before removing it. */
  loadedImages: ReadonlySet<File>;
  /** True from a press of a load button until the example is in place; presses meanwhile are dropped. */
  loading: boolean;
  /** Tells the page that Run may now enable or disable. */
  onChange: () => void;
};

const VIEW_STORAGE_PREFIX = "decisionmachines3000:view:";

/** The view this viewer last used for a panel. A per-viewer convenience: any storage failure means "tree". */
function readStoredView(primitive: Primitive): View {
  try {
    return localStorage.getItem(`${VIEW_STORAGE_PREFIX}${primitive}`) === "json" ? "json" : "tree";
  } catch {
    return "tree";
  }
}

function storeView(primitive: Primitive, view: View): void {
  try {
    localStorage.setItem(`${VIEW_STORAGE_PREFIX}${primitive}`, view);
  } catch {
    // Storage is blocked or full; the panel just opens in the tree next time.
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

function setStatus(panel: Panel, message: string, tone: "note" | "alert" = "note"): void {
  panel.status.textContent = message;
  panel.status.dataset.tone = tone;
}

/** What the JSON view's hint says about the images, or nothing when there are none. */
function imagesHintText(count: number): string {
  if (count === 0) return "";
  return `${imagesCount(count)} attached. ${count === 1 ? "It is" : "They are"} sent as image parts beside this JSON, not inside it.`;
}

/**
 * What a panel holds at the start, before anything is loaded: an empty state,
 * no questions, and no shared criteria. The JSON view shows the same,
 * `{ "primitive": …, "state": "", "questions": {} }`.
 */
function emptyModel(primitive: Primitive): ComposerModel {
  return { primitive, state: "", questions: [], nextKey: 0 };
}

type PanelSetup = {
  /** The limits this panel validates against until a provider is selected. */
  capabilities: ProviderCapabilities;
  /** The provider selected while the panel is built, for the image control's first, silent render. */
  provider: ProviderSummary | undefined;
  /** Called after any change that may enable or disable Run: the panel's images, or its first edit. */
  onChange: () => void;
};

function setupPanel(
  form: HTMLFormElement,
  { capabilities, provider, onChange }: PanelSetup,
): Panel {
  const primitive = form.dataset.primitive;
  if (!isPrimitive(primitive)) {
    throw new Error(`Unknown primitive "${primitive ?? ""}" on a panel form.`);
  }

  const status = required(form, ".panel-status", HTMLElement);
  const treeBody = required(form, '[data-view-body="tree"]', HTMLElement);
  const hint = required(form, ".hint", HTMLElement);
  const imagesHint = create("span", { className: "hint-images" });
  hint.append(" ", imagesHint);

  // The composer's and the image control's callbacks need the finished panel, which needs them.
  let panel: Panel | undefined;
  const attachments = createAttachments(form, {
    prefix: `${primitive}-images`,
    provider,
    transform: createShrinkTransform(browserRasterizer()),
    onChange: () => {
      if (!panel) return;
      panel.imagesHint.textContent = imagesHintText(attachments.count());
      onChange();
    },
  });
  const composer = createComposer({
    prefix: `${primitive}-tree`,
    model: emptyModel(primitive),
    capabilities,
    announce: (message) => {
      if (panel) setStatus(panel, message);
    },
    onChange: () => {
      if (!panel) return;
      panel.request = toRequest(composer.model());
      if (panel.status.dataset.tone === "alert") setStatus(panel, "");
      markEdited(panel);
    },
  });
  treeBody.append(composer.element);

  panel = {
    primitive,
    name: capitalise(primitive),
    capabilities,
    form,
    field: required(form, "textarea.request-field", HTMLTextAreaElement),
    error: required(form, ".field-error", HTMLElement),
    hintId: hint.id,
    imagesHint,
    attachments,
    button: required(form, ".run", HTMLButtonElement),
    label: required(form, ".run-label", HTMLElement),
    status,
    emptyMessage: required(form, ".panel-empty", HTMLElement),
    loadButtons: {
      film: required(form, '.load-example[data-example="film"]', HTMLButtonElement),
      images: required(form, '.load-example[data-example="images"]', HTMLButtonElement),
    },
    switches: {
      tree: required(form, '.view-option[data-view="tree"]', HTMLButtonElement),
      json: required(form, '.view-option[data-view="json"]', HTMLButtonElement),
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
  return panel;
}

/** Records an edit the person made: the empty-state message goes, Run may enable, and a load will ask first. */
function markEdited(panel: Panel): void {
  panel.edits += 1;
  if (!panel.untouched) return;
  panel.untouched = false;
  panel.emptyMessage.hidden = true;
  panel.onChange();
}

function showView(panel: Panel, view: View): void {
  panel.view = view;
  for (const candidate of VIEWS) {
    panel.switches[candidate].setAttribute("aria-pressed", String(candidate === view));
    panel.bodies[candidate].hidden = candidate !== view;
  }
}

function writeJson(panel: Panel): void {
  panel.serialised = JSON.stringify(panel.request, null, 2);
  panel.field.value = panel.serialised;
  clearFieldError(panel);
}

/** Reads the textarea as a valid request, or shows why it is not one. */
function readJson(panel: Panel): ValidDecisionRequest | undefined {
  const source = panel.field.value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    showFieldError(panel, describeJsonError(source, error));
    return undefined;
  }

  const validation = validateDecisionRequest(parsed, panel.capabilities);
  if (!validation.ok) {
    showFieldError(panel, invalidMessage(validation));
    return undefined;
  }

  clearFieldError(panel);
  return validation.value;
}

/**
 * Switches a panel between the tree and the JSON textarea. Leaving the JSON view
 * needs valid JSON; otherwise the switch is refused and the error shows under
 * the textarea. Returns whether the panel now shows `view`.
 */
function switchView(panel: Panel, view: View): boolean {
  if (view === panel.view) return true;

  if (view === "json") {
    writeJson(panel);
    showView(panel, "json");
    storeView(panel.primitive, "json");
    return true;
  }

  if (panel.field.value !== panel.serialised) {
    const request = readJson(panel);
    if (request === undefined) {
      setStatus(panel, "Fix the JSON to switch to the tree.", "alert");
      return false;
    }
    panel.composer.setModel(toViewModel(request));
    panel.request = toRequest(panel.composer.model());
    markEdited(panel);
  }
  clearFieldError(panel);
  setStatus(panel, "");
  showView(panel, "tree");
  storeView(panel.primitive, "tree");
  return true;
}

/** Shows `message` under the textarea. Focus moves to the textarea unless `focus` is false. */
function showFieldError(panel: Panel, message: string, focus = true): void {
  panel.error.textContent = message;
  panel.error.hidden = false;
  panel.field.setAttribute("aria-invalid", "true");
  panel.field.setAttribute("aria-describedby", `${panel.error.id} ${panel.hintId}`);
  if (focus) panel.field.focus();
}

function clearFieldError(panel: Panel): void {
  panel.error.textContent = "";
  panel.error.hidden = true;
  panel.field.removeAttribute("aria-invalid");
  panel.field.setAttribute("aria-describedby", panel.hintId);
}

/**
 * What Run sends from the current view, or undefined after showing why it cannot.
 * The JSON view sends its text unchanged, as it always has.
 */
function prepareRun(panel: Panel): { sent: ValidDecisionRequest; body: string } | undefined {
  if (panel.view === "json") {
    const request = readJson(panel);
    if (request === undefined) return undefined;
    panel.request = request;
    return { sent: request, body: panel.field.value };
  }

  const [issue] = panel.composer.revealIssues();
  if (issue !== undefined) {
    setStatus(panel, issue.message, "alert");
    panel.composer.focusIssue(issue);
    return undefined;
  }

  // The tree found nothing wrong; the shared validator has the final word.
  const validation = validateDecisionRequest(panel.request, panel.capabilities);
  if (!validation.ok) {
    setStatus(panel, invalidMessage(validation), "alert");
    return undefined;
  }
  return { sent: validation.value, body: JSON.stringify(validation.value) };
}

/**
 * Checks what a panel shows against the limits of a newly selected provider, so
 * a problem the old limits caused goes away, and a new one is shown, without
 * another press of Run. Nothing here moves focus.
 */
function revalidate(panel: Panel): void {
  panel.composer.setCapabilities(panel.capabilities);

  if (panel.view === "json") {
    const parsed = tryParse(panel.field.value);
    // A syntax error stays as it is shown; only validity depends on the provider.
    if (!parsed.ok) return;
    const validation = validateDecisionRequest(parsed.value, panel.capabilities);
    if (validation.ok) {
      panel.request = validation.value;
      if (!panel.error.hidden) clearFieldError(panel);
      if (panel.status.dataset.tone === "alert") setStatus(panel, "");
    } else if (!panel.error.hidden) {
      showFieldError(panel, invalidMessage(validation), false);
    }
    return;
  }

  // In the tree, an alert means Run found a problem; look again with the new limits.
  if (panel.status.dataset.tone !== "alert") return;
  const [issue] = panel.composer.revealIssues();
  if (issue !== undefined) {
    setStatus(panel, issue.message, "alert");
    return;
  }
  const validation = validateDecisionRequest(panel.request, panel.capabilities);
  if (validation.ok) {
    setStatus(panel, "");
  } else {
    setStatus(panel, invalidMessage(validation), "alert");
  }
}

/**
 * Puts `request` into the panel, in whichever view is open, as if it had just
 * been loaded: no edits, no shown error, and the empty-state message gone.
 */
function replaceRequest(panel: Panel, request: ValidDecisionRequest): void {
  panel.composer.setModel(toViewModel(request));
  panel.request = toRequest(panel.composer.model());
  clearFieldError(panel);
  if (panel.view === "json") writeJson(panel);
  panel.edits = 0;
  if (panel.untouched) {
    panel.untouched = false;
    panel.emptyMessage.hidden = true;
  }
  panel.onChange();
}

/**
 * Puts focus on the first field of what was loaded: the tree's State field, or
 * the textarea. Only when focus is still on `pressed`, the load button, or has
 * fallen to the body: a person who tabbed on while the pictures were fetched
 * keeps their place.
 */
function focusLoaded(panel: Panel, pressed: Element | null): void {
  const active = panel.form.ownerDocument.activeElement;
  if (active !== null && active !== pressed && active !== panel.form.ownerDocument.body) return;
  if (panel.view === "json") {
    panel.field.focus();
    return;
  }
  const state = panel.composer.element.querySelector<HTMLElement>(
    `[data-for="${STATE_KEY}"][data-control="state"]`,
  );
  state?.focus();
}

/**
 * Why the image example cannot load right now, or undefined when it can: the
 * pictures would not be sent to a text-only provider, or to no provider. Its
 * button is hidden then, so this mostly answers a provider change made while
 * the pictures were being fetched.
 */
function imageExampleProblem(
  set: ExampleSet,
  chosen: ProviderSummary | undefined,
): string | undefined {
  const needs = `The ${set.label} needs a provider that takes images.`;
  if (chosen === undefined) return `${needs} No provider is selected.`;
  if (chosen.capabilities.images === false) {
    return `${needs} ${chosen.displayName} is text only. Choose another provider first.`;
  }
  return undefined;
}

/** What a load would take from the person: their edits, and how many images they attached themselves. */
type Losses = { edits: number; images: number };

function lossesOf(panel: Panel): Losses {
  const own = panel.attachments.files().filter((file) => !panel.loadedImages.has(file));
  return { edits: panel.edits, images: own.length };
}

/** The question a load asks before it replaces `losses`, which says plainly that there is no undo. */
function replaceQuestion(panel: Panel, set: ExampleSet, losses: Losses): Confirmation {
  const costs: string[] = [];
  if (losses.edits > 0) costs.push("replaces your request");
  if (losses.images > 0) {
    costs.push(
      `removes ${losses.images === 1 ? "the image" : `the ${losses.images} images`} you attached`,
    );
  }
  return {
    title: `Load the ${set.label} into the ${panel.name} panel?`,
    message: `This ${costs.join(" and ")}. You cannot undo this.`,
  };
}

/** `omittedImages` is how many attached images the run left out because the provider is text only. */
function renderResult(sent: unknown, result: AskResult, omittedImages: number): HTMLElement {
  switch (result.kind) {
    case "response":
      return renderResponse(sent, result.response, omittedImages);
    case "unreachable":
      return renderUnreachable(result.detail);
    case "non_json":
      return renderNonJson(result.status);
    case "timeout":
      return renderError(
        `No answer arrived within ${REQUEST_TIMEOUT_MS / 1000} seconds. Run the panel again.`,
      );
    case "unrecognised":
      return renderError(
        "The decision endpoint answered in a shape this page does not recognise.",
        `HTTP ${result.status}. Check the server log for details.`,
      );
  }
}

function tryParse(source: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(source) };
  } catch {
    return { ok: false };
  }
}

export type PanelOptions = {
  /** Called after every run the provider answered successfully; the warm form restarts its count. */
  onAnswered?: (response: DecisionSuccess) => void;
  /**
   * Asks whether a load may replace what the person made in a panel, and
   * resolves the answer. The page asks through its `#replace-dialog`; tests
   * answer directly.
   */
  confirmReplace?: Confirm;
};

/**
 * Wires each panel, which starts empty, to its two example buttons, its Tree
 * and JSON views, and Run, which posts to the shared readout on the provider
 * `selection` holds. Run stays disabled while the selection has no provider
 * and while a panel is still empty.
 */
export function setupPanels(
  root: Document,
  selection: ProviderSelection,
  { onAnswered, confirmReplace }: PanelOptions = {},
): void {
  const readout = required(root, "#readout-body", HTMLElement);
  // Outside the live region, so the JSON is never announced.
  const wire = required(root, "#wire-body", HTMLElement);
  const confirm =
    confirmReplace ?? createConfirmDialog(required(root, "#replace-dialog", HTMLDialogElement));
  // Until a provider is selected, requests are checked against the default provider's limits.
  const provider = selection.current();
  const capabilities = provider?.capabilities ?? DEFAULT_PROVIDER.capabilities;
  const panels = [...root.querySelectorAll<HTMLFormElement>("form[data-primitive]")].map((form) =>
    setupPanel(form, { capabilities, provider, onChange: updateButtons }),
  );
  /** The panel whose run is in flight, or undefined between runs. */
  let running: Panel | undefined;

  /**
   * Run is disabled while a run is in flight, while there is no provider, on a
   * panel that is still empty, and on a panel whose images the selected
   * provider cannot take, until the excess is removed. The running panel reads
   * "Running". "Load image example" is hidden unless the selected provider
   * takes images, because it could only refuse. The state is read here rather
   * than passed in, so a provider or image change during a run cannot relabel
   * the buttons.
   */
  function updateButtons(): void {
    const chosen = selection.current();
    const unavailable = chosen === undefined;
    const imagesTaken = chosen !== undefined && chosen.capabilities.images !== false;
    for (const panel of panels) {
      panel.loadButtons.images.hidden = !imagesTaken;
      panel.button.disabled =
        running !== undefined ||
        unavailable ||
        panel.untouched ||
        panel.attachments.blocked() !== undefined;
      panel.label.textContent = panel === running ? "Running" : "Run";
      panel.button.toggleAttribute("data-running", panel === running);
    }
  }

  function setRunning(active: Panel | undefined): void {
    running = active;
    readout.setAttribute("aria-busy", String(running !== undefined));
    updateButtons();
  }

  selection.subscribe((next) => {
    if (next !== undefined) {
      for (const panel of panels) {
        panel.capabilities = next.capabilities;
        revalidate(panel);
      }
    }
    // Each control re-marks its images for the new provider and tells updateButtons through onChange.
    for (const panel of panels) panel.attachments.setProvider(next);
    updateButtons();
  });
  updateButtons();

  /**
   * Loads an example set into a panel, replacing its request and every attached
   * image. The image set needs an image provider, and its pictures are fetched
   * before anything is replaced, so a failed fetch leaves the panel as it was.
   * Edits and images the person attached are never replaced without asking,
   * including an image still being added when the button was pressed and any
   * made while the pictures were being fetched, and the image check runs again
   * after the fetch, because the provider may have changed meanwhile. The
   * status line says what happened either way, in one sentence once loaded,
   * and focus lands on the first field of what was loaded.
   */
  async function loadExample(panel: Panel, set: ExampleSet): Promise<void> {
    if (panel.loading) {
      setStatus(panel, `An example is still loading into the ${panel.name} panel.`);
      return;
    }
    const pressed = root.activeElement;
    /** Whether the image set may go into this panel right now; announces the problem when not. */
    const imagesAllowed = (): boolean => {
      if (set.images.length === 0) return true;
      const problem = imageExampleProblem(set, selection.current());
      if (problem === undefined) return true;
      setStatus(panel, problem, "alert");
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
        await panel.attachments.settled();
        const losses = lossesOf(panel);
        if (losses.edits <= agreed.edits && losses.images <= agreed.images) return losses;
        if (!(await confirm(replaceQuestion(panel, set, losses)))) return undefined;
        agreed = losses;
      }
    };
    const kept = "Nothing loaded. Your request and images are kept.";

    panel.loading = true;
    try {
      const agreed = await agreesToReplace({ edits: 0, images: 0 });
      if (agreed === undefined) {
        setStatus(panel, kept);
        return;
      }

      let files: File[];
      try {
        files = await fetchSampleImages(set.images);
      } catch {
        setStatus(
          panel,
          `The ${set.label}'s sample pictures could not be loaded. Nothing was changed.`,
          "alert",
        );
        return;
      }
      if (!imagesAllowed()) return;
      if ((await agreesToReplace(agreed)) === undefined) {
        setStatus(panel, kept);
        return;
      }

      replaceRequest(panel, set.requests[panel.primitive]);
      // The load says what arrived in one sentence, so the control stays quiet.
      const { added, refused } = await panel.attachments.replace(files);
      panel.loadedImages = new Set(added);
      setStatus(
        panel,
        refused.length === 0
          ? `${capitalise(set.label)} loaded.`
          : [
              `${capitalise(set.label)} loaded, but only ${added.length} of ${files.length} sample pictures were attached.`,
              ...refused,
            ].join(" "),
        refused.length === 0 ? "note" : "alert",
      );
      focusLoaded(panel, pressed);
    } finally {
      panel.loading = false;
    }
  }

  /**
   * What Run posts: the request text alone as JSON, or, when the panel holds
   * images the provider takes, a multipart form of that text and the files.
   * Returns the body and how many images were left out because the provider is text only.
   */
  function bodyFor(
    panel: Panel,
    text: string,
    chosen: ProviderSummary,
  ): { body: PostBody; omittedImages: number } {
    const files = panel.attachments.files();
    if (files.length === 0) return { body: text, omittedImages: 0 };
    if (chosen.capabilities.images === false) return { body: text, omittedImages: files.length };
    return { body: toFormData(text, files), omittedImages: 0 };
  }

  async function run(panel: Panel): Promise<void> {
    const chosen = selection.current();
    // An untouched panel has nothing to send, and its empty-state message says so.
    if (chosen === undefined || panel.untouched) {
      return;
    }
    const blocked = panel.attachments.blocked();
    if (blocked !== undefined) {
      setStatus(panel, blocked, "alert");
      return;
    }
    const prepared = prepareRun(panel);
    if (prepared === undefined) {
      return;
    }
    const { body, omittedImages } = bodyFor(panel, prepared.body, chosen);

    setStatus(panel, "");
    setRunning(panel);
    readout.replaceChildren(renderLoading(chosen.displayName));
    wire.replaceChildren();
    try {
      const result = await askProvider(chosen.id, body);
      readout.replaceChildren(renderResult(prepared.sent, result, omittedImages));
      if (result.kind === "response") wire.replaceChildren(renderWire(result.response));
      if (result.kind === "response" && result.response.ok) onAnswered?.(result.response);
    } finally {
      setRunning(undefined);
      // Disabling the focused Run button drops focus to the body; hand it back.
      if (root.activeElement === null || root.activeElement === root.body) {
        panel.button.focus({ preventScroll: true });
      }
    }
  }

  for (const panel of panels) {
    const stored = readStoredView(panel.primitive);
    showView(panel, "tree");
    if (stored === "json") {
      // Restoring the preference must not write it back, so this skips switchView.
      writeJson(panel);
      showView(panel, "json");
    }

    for (const view of VIEWS) {
      panel.switches[view].addEventListener("click", () => {
        if (switchView(panel, view)) {
          panel.switches[view].focus();
        }
      });
    }

    for (const button of Object.values(panel.loadButtons)) {
      button.addEventListener("click", () => {
        const id = button.dataset.example;
        if (!isExampleSetId(id)) return;
        loadExample(panel, EXAMPLE_SETS[id]).catch((error: unknown) => {
          setStatus(
            panel,
            `Something went wrong while loading the example${error instanceof Error ? `: ${error.message}` : "."}`,
            "alert",
          );
        });
      });
    }

    // Keep the request current while the JSON parses and validates, and drop a
    // shown error as soon as the text is fixed. Run and the switch back to the
    // tree report any remaining problem.
    panel.field.addEventListener("input", () => {
      markEdited(panel);
      const parsed = tryParse(panel.field.value);
      const validation = parsed.ok
        ? validateDecisionRequest(parsed.value, panel.capabilities)
        : undefined;
      if (validation?.ok) {
        panel.request = validation.value;
        if (!panel.error.hidden) clearFieldError(panel);
        if (panel.status.dataset.tone === "alert") setStatus(panel, "");
      }
    });

    panel.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (running !== undefined) {
        return;
      }
      run(panel).catch((error: unknown) => {
        wire.replaceChildren();
        readout.replaceChildren(
          renderError(
            "Something went wrong while showing the answer.",
            error instanceof Error ? error.message : undefined,
          ),
        );
      });
    });
  }
}
