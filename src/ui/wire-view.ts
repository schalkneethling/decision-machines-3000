import type { DecisionSuccess } from "../decision/contract.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import { create } from "./dom.ts";

/**
 * The read-only wire view: what the Worker sent the provider, and what the Worker
 * answered the browser with. Both are plain text in `<pre><code>`, so nothing in
 * them can be edited or run.
 */

function disclosure(title: string, value: unknown): HTMLDetailsElement {
  const code = create("code", { text: JSON.stringify(value, null, 2) });
  const details = create("details", { className: "raw" }, [
    create("summary", { className: "raw-summary", text: title }),
    create("pre", { className: "raw-code" }, [code]),
  ]);
  details.open = true;
  return details;
}

/**
 * Two disclosures, both open. "Sent to {provider}" is `wire.request`: the provider's
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
