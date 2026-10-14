import { DEFAULT_KEEP_ALIVE_SECONDS, WARM_ENDPOINT } from "../decision/contract.ts";
import type { KeepAliveSeconds, WarmRequest, WarmResponse } from "../decision/contract.ts";
import { isKeepAliveSeconds, isWarmResponse, postJson, REQUEST_TIMEOUT_MS } from "./client.ts";
import type { ApiResult } from "./client.ts";
import { required } from "./dom.ts";

/**
 * The warm connection control: asks the server to open a connection to TypeSafe
 * with a chosen keep-alive, then counts down how long that connection stays warm.
 *
 * The form is hidden in `index.html` for now: the old `/api/jev/warm` endpoint
 * went with the `/api/jev` middleware (#8), and a decision success no longer
 * reports its connection. Issue #9 adds a warm route per provider on the Node
 * dev host, shows the form again where connection metrics are available, and
 * brings back the restart of the count after each run.
 */

const numberFormat = new Intl.NumberFormat("en");

export const COLD_TEXT = "Connection is cold again.";

export function warmForText(seconds: number): string {
  return `Warm for ${seconds} s.`;
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

/** POSTs the keep-alive to the warm endpoint. Never rejects. */
export function warmConnection(
  keepAliveSeconds: KeepAliveSeconds,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ApiResult<WarmResponse>> {
  const body: WarmRequest = { keepAliveSeconds };
  return postJson(WARM_ENDPOINT, JSON.stringify(body), isWarmResponse, timeoutMs);
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

/** Wires the warm form: the keep-alive select, the Warm connection button, and the countdown output. */
export function setupWarm(root: Document, repeat: Repeat = repeatWithInterval): void {
  const form = required(root, "form.warm", HTMLFormElement);
  const select = required(form, "select.warm-keep-alive", HTMLSelectElement);
  const button = required(form, "button.warm-button", HTMLButtonElement);
  const label = required(form, ".warm-label", HTMLElement);
  const status = required(form, "output.warm-status", HTMLOutputElement);

  const countdown = createCountdown((text) => {
    status.value = text;
    delete status.dataset.tone;
  }, repeat);

  let warming = false;

  function setWarming(active: boolean): void {
    warming = active;
    button.disabled = active;
    label.textContent = active ? "Warming" : "Warm connection";
  }

  function selectedKeepAlive(): KeepAliveSeconds {
    const seconds = Number(select.value);
    return isKeepAliveSeconds(seconds) ? seconds : DEFAULT_KEEP_ALIVE_SECONDS;
  }

  async function warm(): Promise<void> {
    setWarming(true);
    try {
      const result = await warmConnection(selectedKeepAlive());
      if (result.kind === "response" && result.response.ok) {
        countdown.start(result.response.keepAliveSeconds, warmedText(result.response.latencyMs));
        return;
      }
      countdown.stop();
      status.value = `Could not warm the connection. ${warmFailureText(result) ?? ""}`.trim();
      status.dataset.tone = "alert";
    } finally {
      setWarming(false);
      // Disabling the focused button drops focus to the body; hand it back.
      if (root.activeElement === null || root.activeElement === root.body) {
        button.focus({ preventScroll: true });
      }
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (warming) return;
    void warm();
  });
}
