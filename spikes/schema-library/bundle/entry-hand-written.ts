/**
 * The baseline: today's hand-written validator (`src/decision/validate.ts`) and
 * the browser's type guard from `src/ui/client.ts`, built the same way as the two
 * library entries.
 */

import { isDecisionResponse } from "../../../src/ui/client.ts";
import { typesafe } from "../../../src/providers/catalog.ts";
import { validateDecisionRequest } from "../../../src/decision/validate.ts";

const read = (id: string): unknown =>
  JSON.parse(document.getElementById(id)?.textContent ?? "null");

console.log(
  validateDecisionRequest(read("request"), typesafe.capabilities),
  isDecisionResponse(read("response")),
);
