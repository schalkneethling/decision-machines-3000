import type { Primitive } from "../decision/contract.ts";
import { examples } from "../decision/examples.ts";
import { validateDecisionRequest } from "../decision/validate.ts";
import { DEFAULT_PROVIDER } from "../providers/catalog.ts";
import type { ProviderCapabilities } from "../providers/catalog.ts";
import type { ValidDecisionRequest } from "../decision/validate.ts";
import { askProvider, REQUEST_TIMEOUT_MS } from "./client.ts";
import type { AskResult } from "./client.ts";
import { toRequest, toViewModel } from "./composer/model.ts";
import type { DraftRequest } from "./composer/model.ts";
import { createComposer } from "./composer/tree.ts";
import type { Composer } from "./composer/tree.ts";
import { required } from "./dom.ts";
import { describeJsonError } from "./json-error.ts";
import {
  renderError,
  renderLoading,
  renderNonJson,
  renderResponse,
  renderUnreachable,
} from "./readout.ts";

type View = "tree" | "json";

const VIEWS = ["tree", "json"] as const satisfies readonly View[];

type Panel = {
  primitive: Primitive;
  /** The limits this panel validates against. */
  capabilities: ProviderCapabilities;
  form: HTMLFormElement;
  field: HTMLTextAreaElement;
  error: HTMLElement;
  hintId: string;
  button: HTMLButtonElement;
  label: HTMLElement;
  status: HTMLElement;
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

function setStatus(panel: Panel, message: string, tone: "note" | "alert" = "note"): void {
  panel.status.textContent = message;
  panel.status.dataset.tone = tone;
}

function setupPanel(form: HTMLFormElement, capabilities: ProviderCapabilities): Panel {
  const primitive = form.dataset.primitive;
  if (!isPrimitive(primitive)) {
    throw new Error(`Unknown primitive "${primitive ?? ""}" on a panel form.`);
  }

  const example = examples[primitive];
  const status = required(form, ".panel-status", HTMLElement);
  const treeBody = required(form, '[data-view-body="tree"]', HTMLElement);

  // The composer's callbacks need the finished panel, which needs the composer.
  let panel: Panel | undefined;
  const composer = createComposer({
    prefix: `${primitive}-tree`,
    model: toViewModel(example),
    capabilities,
    announce: (message) => {
      if (panel) setStatus(panel, message);
    },
    onChange: () => {
      if (!panel) return;
      panel.request = toRequest(composer.model());
      if (panel.status.dataset.tone === "alert") setStatus(panel, "");
    },
  });
  treeBody.append(composer.element);

  panel = {
    primitive,
    capabilities,
    form,
    field: required(form, "textarea.request-field", HTMLTextAreaElement),
    error: required(form, ".field-error", HTMLElement),
    hintId: required(form, ".hint", HTMLElement).id,
    button: required(form, ".run", HTMLButtonElement),
    label: required(form, ".run-label", HTMLElement),
    status,
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
  };
  return panel;
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
    const where = validation.detail ? ` Path: ${validation.detail}.` : "";
    showFieldError(panel, `${validation.error}${where}`);
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
  }
  clearFieldError(panel);
  setStatus(panel, "");
  showView(panel, "tree");
  storeView(panel.primitive, "tree");
  return true;
}

function showFieldError(panel: Panel, message: string): void {
  panel.error.textContent = message;
  panel.error.hidden = false;
  panel.field.setAttribute("aria-invalid", "true");
  panel.field.setAttribute("aria-describedby", `${panel.error.id} ${panel.hintId}`);
  panel.field.focus();
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
    const where = validation.detail ? ` Path: ${validation.detail}.` : "";
    setStatus(panel, `${validation.error}${where}`, "alert");
    return undefined;
  }
  return { sent: validation.value, body: JSON.stringify(validation.value) };
}

function renderResult(sent: unknown, result: AskResult): HTMLElement {
  switch (result.kind) {
    case "response":
      return renderResponse(sent, result.response);
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

/** Fills each panel with its example, wires the Tree and JSON views, and wires Run to the shared readout. */
export function setupPanels(root: Document): void {
  const readout = required(root, "#readout-body", HTMLElement);
  // The one place the panels learn which provider's limits apply.
  const capabilities = DEFAULT_PROVIDER.capabilities;
  const panels = [...root.querySelectorAll<HTMLFormElement>("form[data-primitive]")].map((form) =>
    setupPanel(form, capabilities),
  );
  let running = false;

  function setRunning(active: Panel | undefined): void {
    running = active !== undefined;
    readout.setAttribute("aria-busy", String(running));
    for (const panel of panels) {
      panel.button.disabled = running;
      panel.label.textContent = panel === active ? "Running" : "Run";
    }
  }

  async function run(panel: Panel): Promise<void> {
    const prepared = prepareRun(panel);
    if (prepared === undefined) {
      return;
    }

    setStatus(panel, "");
    setRunning(panel);
    readout.replaceChildren(renderLoading());
    try {
      // Hard-wired to the default provider until the provider select lands (#12).
      const result = await askProvider(DEFAULT_PROVIDER.id, prepared.body);
      readout.replaceChildren(renderResult(prepared.sent, result));
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

    // Keep the request current while the JSON parses and validates, and drop a
    // shown error as soon as the text is fixed. Run and the switch back to the
    // tree report any remaining problem.
    panel.field.addEventListener("input", () => {
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
      if (running) {
        return;
      }
      run(panel).catch((error: unknown) => {
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
