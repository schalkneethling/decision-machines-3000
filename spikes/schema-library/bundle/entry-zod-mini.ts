/**
 * Minimal browser entry for the bundle measurement. It imports schema 1 and
 * schema 3 and exercises both, so nothing can be tree-shaken away. The four
 * entries in this folder differ only in the two import paths.
 */

import { typesafe } from "../../../src/providers/catalog.ts";
import { validateDecisionRequest } from "../zod-mini/request.ts";
import { isDecisionResponse } from "../zod-mini/response.ts";

const read = (id: string): unknown =>
  JSON.parse(document.getElementById(id)?.textContent ?? "null");

console.log(
  validateDecisionRequest(read("request"), typesafe.capabilities),
  isDecisionResponse(read("response")),
);
