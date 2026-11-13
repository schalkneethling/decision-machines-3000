import type { DecisionResponse, DecisionSuccess } from "../decision/contract.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import { create } from "./dom.ts";

/**
 * The read-only wire view: what the Worker sent the provider, and what the Worker
 * answered the browser with. Both are plain text in `<pre><code>`, so nothing in
 * them can be edited or run.
 */

/**
 * A closed disclosure, so a list of results stays short until the person opens
 * the JSON of the one they want.
 */
function disclosure(title: string, value: unknown): HTMLDetailsElement {
  const code = create("code", { text: JSON.stringify(value, null, 2) });
  return create("details", { className: "raw" }, [
    create("summary", { className: "raw-summary", text: title }),
    create("pre", { className: "raw-code" }, [code]),
  ]);
}

/**
 * Two disclosures, both closed. "Sent to {provider}" is `wire.request`: the provider's
 * own request body. It never holds the API key, because the key travels in a header
 * and the wire record is the body only. "Received from {provider}" is `wire.response`:
 * the provider's reply body as the Worker read it, with the API key already redacted.
 */
export function renderWireView(response: DecisionSuccess): HTMLDetailsElement[] {
  const provider = PROVIDERS[response.provider].displayName;
  const { request, response: received } = response.wire;
  return [
    disclosure(`Sent to ${provider}`, request),
    disclosure(`Received from ${provider}`, received),
  ];
}

/**
 * The wire view for a finished run. It belongs to that run's result, which sits
 * outside the live region, so a screen reader does not speak the JSON. A success gets the sent and received
 * blocks; a failure gets its "Raw response" block.
 */
export function renderWire(response: DecisionResponse): HTMLElement {
  const blocks = response.ok ? renderWireView(response) : [disclosure("Raw response", response)];
  return create("div", { className: "wire-view" }, blocks);
}
