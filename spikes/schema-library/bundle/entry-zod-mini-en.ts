/**
 * The Zod Mini entry plus its English locale. Zod Mini ships without one, so its
 * default messages read "Invalid input" until `z.config(z.locales.en())` runs
 * (https://zod.dev/packages/mini). Schema 1 carries its own wording and does not
 * need the locale; this entry measures what readable defaults for the other
 * schemas would cost in the browser.
 */

import * as z from "zod/mini";
import { typesafe } from "../../../src/providers/catalog.ts";
import { validateDecisionRequest } from "../zod-mini/request.ts";
import { isDecisionResponse } from "../zod-mini/response.ts";

z.config(z.locales.en());

const read = (id: string): unknown =>
  JSON.parse(document.getElementById(id)?.textContent ?? "null");

console.log(
  validateDecisionRequest(read("request"), typesafe.capabilities),
  isDecisionResponse(read("response")),
);
