import {
  DEFAULT_KEEP_ALIVE_SECONDS,
  KEEP_ALIVE_SECONDS,
  warmEndpoint,
} from "../decision/contract.ts";
import type {
  DecisionSuccess,
  KeepAliveSeconds,
  WarmRequest,
  WarmResponse,
} from "../decision/contract.ts";
import type { ProviderId } from "../providers/catalog.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { isKeepAliveSeconds, isWarmResponse, postJson, REQUEST_TIMEOUT_MS } from "./client.ts";
import type { ApiResult } from "./client.ts";
import { create, required } from "./dom.ts";
import type { ProviderSelection } from "./provider-select.ts";

/**
 * The warm connection control: asks the server to open a connection to the
 * selected provider with a chosen keep-alive, then counts down how long that
 * connection stays warm. Each run on that provider restarts the count.
 *
 * The form is hidden in `index.html` and stays hidden unless the host reports
 * connection metrics, which only the Node dev host does (ADR-0002), and the
 * selected provider declares a warm path.
 */

const numberFormat = new Intl.NumberFormat("en");

export const COLD_TEXT = "Connection is cold again.";

export function warmForText(seconds: number): string {
  return `Warm for ${seconds} s.`;
}

/** The keep-alive option's text: "4 s, Node default" for Node's own, otherwise "30 s". */
export function keepAliveText(seconds: KeepAliveSeconds): string {
  return seconds === DEFAULT_KEEP_ALIVE_SECONDS ? `${seconds} s, Node default` : `${seconds} s`;
}

/** The button's text, naming the provider it warms. */
export function warmLabel(providerName: string, active: boolean): string {
  return `${active ? "Warming" : "Warm"} the ${providerName} connection`;
}

export function warmedText(latencyMs: number): string {
  return `Connection warmed in ${numberFormat.format(Math.round(latencyMs))} ms.`;
}

/** Calls `callback` every `ms` milliseconds until the returned function is called. */
export type Repeat = (callback: () => void, ms: number) => () => void;

const repeatWithInterval: Repeat = (callback, ms) => {
  const handle = setInterval(callback, ms);
  return () => {
    clearInterval(handle);
  };
};

export type Countdown = {
  /**
   * Show `lead` (if any) and "Warm for {seconds} s.", then count down once a
   * second to "Connection is cold again." Restarting cancels the running count.
   */
  start(seconds: number, lead?: string): void;
  /** Cancel the running count, leaving the text as it is. */
  stop(): void;
  /** Seconds left, or 0 once the connection is cold. */
  readonly remaining: number;
};

/** The countdown as a small state machine; `repeat` is injectable so tests control time. */
export function createCountdown(
  render: (text: string) => void,
  repeat: Repeat = repeatWithInterval,
): Countdown {
  let remaining = 0;
  let cancel: (() => void) | undefined;

  function stop(): void {
    cancel?.();
    cancel = undefined;
  }

  function tick(): void {
    remaining -= 1;
    if (remaining > 0) {
      render(warmForText(remaining));
      return;
    }
    remaining = 0;
    stop();
    render(COLD_TEXT);
  }

  return {
    start(seconds, lead) {
      stop();
      remaining = seconds;
      render(lead === undefined ? warmForText(seconds) : `${lead} ${warmForText(seconds)}`);
      cancel = repeat(tick, 1000);
    },
    stop,
    get remaining() {
      return remaining;
    },
  };
}

/** POSTs the keep-alive to the warm endpoint of `providerId`. Never rejects. */
export function warmConnection(
  providerId: ProviderId,
  keepAliveSeconds: KeepAliveSeconds,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ApiResult<WarmResponse>> {
  const body: WarmRequest = { keepAliveSeconds };
  return postJson(warmEndpoint(providerId), JSON.stringify(body), isWarmResponse, timeoutMs);
}

/** What went wrong, as one sentence for the status line. */
export function warmFailureText(result: ApiResult<WarmResponse>): string | undefined {
  switch (result.kind) {
    case "response":
      return result.response.ok ? undefined : result.response.error;
    case "unreachable":
      return "Could not reach the warm endpoint. Is the dev server running?";
    case "non_json":
      return `The warm endpoint answered with HTTP ${result.status} and a body that is not JSON.`;
    case "timeout":
      return `The connection did not warm within ${REQUEST_TIMEOUT_MS / 1000} seconds. Try again.`;
    case "unrecognised":
      return `The warm endpoint answered in a shape this page does not recognise (HTTP ${result.status}).`;
  }
}

/** What the panels tell the warm form. */
export type WarmControl = {
  /** A run succeeded: restart the count when it used the connection the form shows. */
  noteAnswered: (response: DecisionSuccess) => void;
};

/**
 * Wires the warm form: the keep-alive select, built from `KEEP_ALIVE_SECONDS`,
 * the button that warms the provider `selection` holds, and the countdown output.
 */
export function setupWarm(
  root: Document,
  selection: ProviderSelection,
  repeat: Repeat = repeatWithInterval,
): WarmControl {
  const form = required(root, "form.warm", HTMLFormElement);
  const select = required(form, "select.warm-keep-alive", HTMLSelectElement);
  const button = required(form, "button.warm-button", HTMLButtonElement);
  const label = required(form, ".warm-label", HTMLElement);
  const sizer = required(form, ".run-sizer", HTMLElement);
  const status = required(form, "output.warm-status", HTMLOutputElement);

  select.replaceChildren(
    ...KEEP_ALIVE_SECONDS.map((seconds) => {
      const option = create("option", {
        text: keepAliveText(seconds),
        attributes: { value: String(seconds) },
      });
      option.selected = seconds === DEFAULT_KEEP_ALIVE_SECONDS;
      return option;
    }),
  );

  const countdown = createCountdown((text) => {
    status.value = text;
    delete status.dataset.tone;
  }, repeat);

  /** The provider the form warms, or undefined while the form is hidden. */
  let provider: ProviderSummary | undefined;
  /** The provider a warm in flight was sent to, while one is in flight. */
  let warmingFor: ProviderId | undefined;

  function renderLabel(): void {
    const name = provider?.displayName ?? "";
    label.textContent = warmLabel(name, warmingFor !== undefined);
    // The sizer holds the longer text, so the button keeps its width while it warms.
    sizer.textContent = warmLabel(name, true);
  }

  function follow(next: ProviderSummary | undefined): void {
    const warmable =
      next !== undefined && next.canWarm && selection.host()?.connectionMetrics === true
        ? next
        : undefined;
    if (warmable?.id !== provider?.id) {
      // The count and any message were about the previous provider's connection.
      countdown.stop();
      status.value = "";
      delete status.dataset.tone;
    }
    provider = warmable;
    form.hidden = warmable === undefined;
    renderLabel();
  }

  function selectedKeepAlive(): KeepAliveSeconds {
    const seconds = Number(select.value);
    return isKeepAliveSeconds(seconds) ? seconds : DEFAULT_KEEP_ALIVE_SECONDS;
  }

  async function warm(target: ProviderSummary): Promise<void> {
    warmingFor = target.id;
    button.disabled = true;
    renderLabel();
    try {
      const result = await warmConnection(target.id, selectedKeepAlive());
      // The viewer chose another provider meanwhile, so the answer is about a connection the form no longer shows.
      if (provider?.id !== target.id) return;
      if (result.kind === "response" && result.response.ok) {
        countdown.start(result.response.keepAliveSeconds, warmedText(result.response.latencyMs));
        return;
      }
      countdown.stop();
      status.value = `Could not warm the connection. ${warmFailureText(result) ?? ""}`.trim();
      status.dataset.tone = "alert";
    } finally {
      warmingFor = undefined;
      button.disabled = false;
      renderLabel();
      // Disabling the focused button drops focus to the body; hand it back.
      if (!form.hidden && (root.activeElement === null || root.activeElement === root.body)) {
        button.focus({ preventScroll: true });
      }
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (warmingFor !== undefined || provider === undefined) return;
    void warm(provider);
  });

  selection.subscribe(follow);
  follow(selection.current());

  return {
    noteAnswered: (response) => {
      if (response.keepAliveSeconds === undefined || response.provider !== provider?.id) return;
      countdown.start(response.keepAliveSeconds);
    },
  };
}
