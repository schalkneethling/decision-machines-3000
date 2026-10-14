import type { ProviderCapabilities } from "../providers/catalog.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { getProviders } from "./client.ts";
import { appendWithInlineCode, create, required } from "./dom.ts";
import { VOCABULARY } from "./vocabulary.ts";

/**
 * The provider select: a real `<select>` filled from `GET /api/providers`.
 *
 * Browsers that support customizable select (`appearance: base-select`) style
 * the control and its picker with CSS alone. Every other browser shows the
 * native select with each option's text, so this module never tests for
 * support. Each option's name and model are separated by a text space, so the
 * native fallback reads "OpenAI Decisions gpt-6-luna" and not "OpenAI Decisionsgpt-6-luna".
 *
 * The panels learn the choice through `ProviderSelection`, so they do not
 * depend on this module's markup.
 */

/** What the panels read: the provider Run asks, and a way to hear when it changes. */
export type ProviderSelection = {
  /** The selected provider, or undefined while the list loads and when it could not be loaded. */
  current(): ProviderSummary | undefined;
  /** Calls `listener` with the new `current()` each time it changes. */
  subscribe(listener: (provider: ProviderSummary | undefined) => void): void;
};

const PROVIDER_STORAGE_KEY = "decisionmachines3000:provider";

/** The secrets that enable a provider, named in the setup notice. They match `worker/env.ts`. */
export const PROVIDER_KEYS = ["TYPESAFE_API_KEY", "SUBQ_API_KEY", "OPENAI_API_KEY"] as const;

/**
 * Where the setup notice sends the owner. The deployment guide is not written
 * yet (issue #17), so this is the README until it is.
 */
export const DEPLOYMENT_GUIDE_URL = "https://github.com/schalkneethling/jev-3000#readme";

/** The provider this viewer last chose. A per-viewer convenience: any storage failure means "none". */
function readStoredProvider(): string | undefined {
  try {
    return localStorage.getItem(PROVIDER_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function storeProvider(id: string): void {
  try {
    localStorage.setItem(PROVIDER_STORAGE_KEY, id);
  } catch {
    // Storage is blocked or full; the select just opens on the first provider next time.
  }
}

/** The part of the announcement about images, from the provider's capabilities. */
function imageSentence(capabilities: ProviderCapabilities): string {
  const { images } = capabilities;
  return images === false ? "Text only, no images." : `Images allowed, up to ${images.maxCount}.`;
}

function optionFor(provider: ProviderSummary): HTMLOptionElement {
  return create("option", { attributes: { value: provider.id } }, [
    create("span", { className: "provider-name", text: provider.displayName }),
    " ",
    create("span", { className: "provider-model", text: provider.model }),
  ]);
}

/** An option that stands in for a list that is not there. It cannot be chosen. */
function placeholderOption(text: string): HTMLOptionElement {
  const option = create("option", { text, attributes: { value: "", disabled: "" } });
  option.selected = true;
  return option;
}

/** The notice for an instance with no provider key: which keys fix it, and where to read how. */
function setupNotice(): HTMLElement {
  const keys: (Node | string)[] = [];
  PROVIDER_KEYS.forEach((key, index) => {
    if (index > 0) keys.push(index === PROVIDER_KEYS.length - 1 ? ", or " : ", ");
    keys.push(create("code", { text: key }));
  });
  return create("p", { className: "provider-problem-message" }, [
    "This instance has no provider key. Set at least one of ",
    ...keys,
    ", then reload. The ",
    create("a", {
      text: "deployment guide",
      attributes: { href: DEPLOYMENT_GUIDE_URL, rel: "noreferrer" },
    }),
    " explains how.",
  ]);
}

/** Wires the provider select in `root`, loads the list, and returns what the panels read. */
export function setupProviderSelect(root: Document): ProviderSelection {
  const select = required(root, "#provider-select", HTMLSelectElement);
  const problem = required(root, "#provider-problem", HTMLElement);
  const status = required(root, "#provider-status", HTMLElement);
  const legend = required(root, "#provider-vocabulary", HTMLDetailsElement);
  const legendSummary = required(legend, "summary", HTMLElement);
  const legendList = required(legend, "dl", HTMLElement);

  let providers: ProviderSummary[] = [];
  let selected: ProviderSummary | undefined;
  const listeners: ((provider: ProviderSummary | undefined) => void)[] = [];

  function choose(provider: ProviderSummary | undefined): void {
    selected = provider;
    for (const listener of listeners) listener(provider);
  }

  function setOptions(options: HTMLOptionElement[]): void {
    for (const option of select.querySelectorAll("option")) option.remove();
    select.append(...options);
  }

  function renderLegend(provider: ProviderSummary | undefined): void {
    legend.hidden = provider === undefined;
    legendList.replaceChildren();
    if (provider === undefined) return;
    legendSummary.textContent = `Words ${provider.displayName} uses`;
    for (const row of VOCABULARY) {
      const term = create("dd", { className: "provider-vocabulary-term" });
      appendWithInlineCode(term, row.byProvider[provider.id]);
      legendList.append(create("dt", { text: row.shared }), term);
    }
  }

  /** The select, the notice, the legend, and the panels for a state in which no provider is chosen. */
  function showUnavailable(placeholder: string, notice: Node[]): void {
    providers = [];
    select.disabled = true;
    setOptions([placeholderOption(placeholder)]);
    status.textContent = "";
    problem.replaceChildren(...notice);
    renderLegend(undefined);
    choose(undefined);
  }

  function showFailed(): void {
    const retry = create("button", {
      className: "provider-retry",
      text: "Retry",
      attributes: { type: "button" },
    });
    retry.addEventListener("click", () => {
      load(true).catch(showFailed);
    });
    showUnavailable("Providers unavailable", [
      create("p", {
        className: "provider-problem-message",
        text: "The list of providers could not be loaded.",
      }),
      retry,
    ]);
  }

  function showReady(list: ProviderSummary[]): void {
    const stored = readStoredProvider();
    const chosen = list.find((provider) => provider.id === stored) ?? list.at(0);
    if (chosen === undefined) {
      showFailed();
      return;
    }
    // A stored provider that is no longer configured is replaced, so the next load agrees.
    if (stored !== undefined && stored !== chosen.id) storeProvider(chosen.id);

    providers = list;
    problem.replaceChildren();
    const options = list.map(optionFor);
    setOptions(options);
    select.disabled = false;
    for (const option of options) option.selected = option.value === chosen.id;
    renderLegend(chosen);
    choose(chosen);
  }

  /** Fetches the list. `refocus` hands focus back to the select or the new Retry after the old Retry went away. */
  async function load(refocus: boolean): Promise<void> {
    showUnavailable("Loading providers…", []);
    const result = await getProviders();
    if (result.kind === "response" && result.response.ok) {
      showReady(result.response.providers);
      if (refocus) select.focus();
      return;
    }
    // The route answers 503 only when no provider key is set; any other failure may pass.
    if (result.kind === "response" && result.status === 503) {
      showUnavailable("No provider key is set", [setupNotice()]);
      return;
    }
    showFailed();
    if (refocus) root.querySelector<HTMLElement>(".provider-retry")?.focus();
  }

  select.addEventListener("change", () => {
    const next = providers.find((provider) => provider.id === select.value);
    if (next === undefined) return;
    storeProvider(next.id);
    status.textContent = `Provider set to ${next.displayName}. ${imageSentence(next.capabilities)}`;
    renderLegend(next);
    choose(next);
  });

  load(false).catch(showFailed);

  return {
    current: () => selected,
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}
