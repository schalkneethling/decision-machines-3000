import { PROVIDER_ORDER, PROVIDERS } from "../providers/catalog.ts";
import type { HostSummary, Protection, ProviderSummary } from "../providers/contract.ts";
import { getProviders } from "./client.ts";
import { appendWithInlineCode, create, required } from "./dom.ts";
import { imageInputSentence } from "./image-sentences.ts";
import { DEPLOYMENT_GUIDE_URL, renderProtectionNotice } from "./protection-notice.ts";
import { VOCABULARY } from "./vocabulary.ts";

/**
 * The provider choice: one checkbox per provider `GET /api/providers` lists, in
 * a fieldset in the Run bar (issue #101). One press of Run asks every ticked
 * provider. Each checkbox is named by the provider and its model, and described
 * by what it does with images, so the choice and its effect are read together.
 *
 * The request form and the warm form learn the choice through
 * `ProviderSelection`, so they do not depend on this module's markup.
 */

/** What the request form and the warm form read: the providers Run asks, and a way to hear when they change. */
export type ProviderSelection = {
  /** The ticked providers, in list order; empty while the list loads, when it could not be loaded, and when none is ticked. */
  selected(): readonly ProviderSummary[];
  /**
   * What the host that listed the providers can report, from the same answer.
   * Undefined until the list loads, and set before listeners hear of a provider.
   */
  host(): HostSummary | undefined;
  /** The providers the host listed, in list order; empty while the list loads and when it could not be loaded. */
  providers(): readonly ProviderSummary[];
  /** Calls `listener` with the new `selected()` each time it changes. */
  subscribe(listener: (selected: readonly ProviderSummary[]) => void): void;
};

const PROVIDERS_STORAGE_KEY = "decisionmachines3000:providers";
/** Where a single choice was kept before the page could ask several providers. Read once, as a starting point. */
const LEGACY_PROVIDER_STORAGE_KEY = "decisionmachines3000:provider";

/** The providers this viewer last ticked. A per-viewer convenience: any storage failure means "none stored". */
function readStoredProviders(): string[] | undefined {
  try {
    const stored = localStorage.getItem(PROVIDERS_STORAGE_KEY);
    if (stored !== null) {
      const parsed: unknown = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === "string");
      }
      return undefined;
    }
    const legacy = localStorage.getItem(LEGACY_PROVIDER_STORAGE_KEY);
    return legacy === null ? undefined : [legacy];
  } catch {
    return undefined;
  }
}

/** Stores `ids` unless they are already what is stored, so a load that changes nothing writes nothing. */
function storeProviders(ids: readonly string[]): void {
  const value = JSON.stringify(ids);
  try {
    if (localStorage.getItem(PROVIDERS_STORAGE_KEY) !== value) {
      localStorage.setItem(PROVIDERS_STORAGE_KEY, value);
    }
  } catch {
    // Storage is blocked or full; the choice just opens on the first provider next time.
  }
}

/** The notice for an instance with no provider key: which keys fix it, and where to read how. */
function setupNotice(): HTMLElement {
  const names = PROVIDER_ORDER.map((id) => PROVIDERS[id].keyName);
  const keys: (Node | string)[] = [];
  names.forEach((name, index) => {
    if (index > 0) keys.push(index === names.length - 1 ? ", or " : ", ");
    keys.push(create("code", { text: name }));
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

/** The id of a provider's checkbox. */
function providerInputId(provider: ProviderSummary): string {
  return `provider-${provider.id}`;
}

/**
 * One provider's checkbox: named by the provider and its model, described by
 * its image capability. The model is separated by a text space, so the name
 * reads "OpenAI Decisions gpt-6-luna" and not "OpenAI Decisionsgpt-6-luna".
 */
function optionFor(provider: ProviderSummary, checked: boolean): HTMLElement {
  const inputId = providerInputId(provider);
  const abilityId = `${inputId}-ability`;
  const input = create("input", {
    className: "provider-input",
    attributes: {
      type: "checkbox",
      id: inputId,
      name: "provider",
      value: provider.id,
      "aria-describedby": abilityId,
    },
  });
  input.checked = checked;
  const label = create(
    "label",
    { className: "provider-option-label", attributes: { for: inputId } },
    [
      create("span", { className: "provider-name", text: provider.displayName }),
      " ",
      create("span", { className: "provider-model", text: provider.model }),
    ],
  );
  return create("div", { className: "provider-option" }, [
    input,
    label,
    create("p", {
      className: "provider-ability",
      text: imageInputSentence(provider.capabilities.images),
      attributes: { id: abilityId },
    }),
  ]);
}

/**
 * Fills the "About these providers" legend with a table: one row per part of a
 * request, named as the page names it, and one column per listed provider with
 * the word its API uses.
 */
function renderLegend(legend: HTMLDetailsElement, providers: readonly ProviderSummary[]): void {
  const table = required(legend, "table", HTMLTableElement);
  legend.hidden = providers.length === 0;
  if (providers.length === 0) {
    table.replaceChildren();
    return;
  }
  const head = create("thead", {}, [
    create("tr", {}, [
      create("th", { text: "On this page", attributes: { scope: "col" } }),
      ...providers.map((provider) =>
        create("th", { text: provider.displayName, attributes: { scope: "col" } }),
      ),
    ]),
  ]);
  const body = create(
    "tbody",
    {},
    VOCABULARY.map((row) =>
      create("tr", {}, [
        create("th", { text: row.shared, attributes: { scope: "row" } }),
        ...providers.map((provider) => {
          const cell = create("td");
          appendWithInlineCode(cell, row.byProvider[provider.id]);
          return cell;
        }),
      ]),
    ),
  );
  table.replaceChildren(
    create("caption", { className: "visually-hidden", text: "Words each provider uses" }),
    head,
    body,
  );
}

/** Wires the provider choice in `root`, loads the list, and returns what the request form reads. */
export function setupProviderSelect(root: Document): ProviderSelection {
  const fieldset = required(root, "#provider-choice", HTMLFieldSetElement);
  const options = required(fieldset, ".provider-options", HTMLElement);
  const problem = required(root, "#provider-problem", HTMLElement);
  const status = required(root, "#provider-status", HTMLElement);
  const protectionNotice = required(root, "#protection-notice", HTMLElement);
  const legend = required(root, "#provider-vocabulary", HTMLDetailsElement);

  let providers: ProviderSummary[] = [];
  let selected: readonly ProviderSummary[] = [];
  let host: HostSummary | undefined;
  const listeners: ((selected: readonly ProviderSummary[]) => void)[] = [];

  function choose(next: readonly ProviderSummary[]): void {
    selected = next;
    for (const listener of listeners) listener(next);
  }

  /** The ticked checkboxes' providers, in list order. */
  function ticked(): ProviderSummary[] {
    return providers.filter(
      (provider) =>
        root.querySelector<HTMLInputElement>(`#${providerInputId(provider)}`)?.checked === true,
    );
  }

  /** The choice, the notice, the legend, and the request form for a state in which no provider can be ticked. */
  function showUnavailable(placeholder: string, notice: Node[]): void {
    providers = [];
    host = undefined;
    fieldset.disabled = true;
    options.replaceChildren(create("p", { className: "provider-placeholder", text: placeholder }));
    status.textContent = "";
    problem.replaceChildren(...notice);
    renderProtectionNotice(protectionNotice, undefined);
    renderLegend(legend, []);
    choose([]);
  }

  function showFailed(): void {
    const retry = create("button", {
      className: "provider-retry",
      text: "Retry",
      attributes: { type: "button" },
    });
    retry.addEventListener("click", () => {
      // A Retry that is waiting for its answer ignores further presses.
      if (retry.getAttribute("aria-disabled") === "true") return;
      load(retry).catch(showFailed);
    });
    showUnavailable("Providers unavailable", [
      create("p", {
        className: "provider-problem-message",
        text: "The list of providers could not be loaded.",
      }),
      retry,
    ]);
  }

  function showReady(list: ProviderSummary[], listedBy: HostSummary, protection: Protection): void {
    const [first] = list;
    if (first === undefined) {
      showFailed();
      return;
    }
    const stored = readStoredProviders();
    // Stored providers that are no longer configured are dropped; with none left, the first is ticked.
    const kept =
      stored === undefined ? [] : list.filter((provider) => stored.includes(provider.id));
    const chosen =
      stored !== undefined && stored.length === 0 ? [] : kept.length > 0 ? kept : [first];
    const ids = chosen.map((provider) => provider.id);
    storeProviders(ids);

    providers = list;
    host = listedBy;
    problem.replaceChildren();
    renderProtectionNotice(protectionNotice, protection);
    options.replaceChildren(
      ...list.map((provider) => optionFor(provider, chosen.includes(provider))),
    );
    fieldset.disabled = false;
    renderLegend(legend, list);
    choose(chosen);
  }

  /**
   * Puts focus on the first thing the viewer can use after a retry: the first
   * checkbox when the list loaded, otherwise the new Retry, otherwise the setup
   * notice. The pressed Retry was removed, so focus would otherwise fall to the body.
   */
  function focusOutcome(): void {
    const first = fieldset.disabled ? null : fieldset.querySelector<HTMLInputElement>("input");
    if (first !== null) {
      first.focus();
      return;
    }
    (root.querySelector<HTMLElement>(".provider-retry") ?? problem).focus();
  }

  /**
   * Fetches the list. `retry` is the Retry button that asked for a reload, if
   * one did. It stays in place and focused, marked `aria-disabled`, and the
   * status line says the list is loading, until the answer decides what
   * replaces it and where focus goes. A first load has no Retry and does not
   * move focus.
   */
  async function load(retry?: HTMLElement): Promise<void> {
    if (retry === undefined) {
      showUnavailable("Loading providers…", []);
    } else {
      retry.setAttribute("aria-disabled", "true");
      status.textContent = "Loading providers…";
    }
    const result = await getProviders();
    status.textContent = "";

    if (result.kind === "response" && result.response.ok) {
      showReady(result.response.providers, result.response.host, result.response.protection);
    } else if (result.kind === "response" && result.status === 503) {
      // The route answers 503 only when no provider key is set; any other failure may pass.
      showUnavailable("No provider key is set", [setupNotice()]);
    } else {
      showFailed();
    }
    if (retry !== undefined) focusOutcome();
  }

  // A checkbox announces its own state, and each image control says what the change does to the images.
  fieldset.addEventListener("change", () => {
    const next = ticked();
    storeProviders(next.map((provider) => provider.id));
    choose(next);
  });

  load().catch(showFailed);

  return {
    selected: () => selected,
    host: () => host,
    providers: () => providers,
    subscribe(listener) {
      listeners.push(listener);
    },
  };
}
