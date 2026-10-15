/**
 * `GET /api/providers`: which providers this instance has a key for.
 *
 * The Worker answers with the public part of each configured provider's
 * catalog descriptor: its id, its display name, its model id, and its
 * capabilities. The base URL and the warm path are left out of the answer, and
 * no key, key length, or key prefix is ever part of it.
 *
 * The shape is a Zod Mini schema, following `src/decision/contract.ts`
 * (ADR-0004), so the browser checks the body with the same schema the type is
 * inferred from. Zod Mini APIs used, read from node_modules/zod/v4/mini/schemas.d.ts:
 * `object`, `literal` (with an array of values), `int`, `string`, `boolean`,
 * `array`, `readonly`, `exactOptional`, `union`, and `discriminatedUnion`; `minLength`
 * from node_modules/zod/v4/mini/checks.d.ts. `z.object` drops unknown keys
 * rather than rejecting them, so a field the server adds later does not break
 * an older browser.
 */

import * as z from "zod/mini";
import { failureSchema } from "../decision/contract.ts";
import { PROVIDER_ORDER } from "./catalog.ts";
import type { ProviderDescriptor } from "./catalog.ts";

export const PROVIDERS_ENDPOINT = "/api/providers";

// Every count and byte limit in the catalog is a whole number.
const countRangeSchema = z.readonly(z.object({ min: z.int(), max: z.exactOptional(z.int()) }));

const imageCapabilitiesSchema = z.object({
  maxCount: z.int(),
  maxBytesPerImage: z.int(),
  maxBytesPerRequest: z.int(),
  mediaTypes: z.readonly(z.array(z.string())),
});

const capabilitiesSchema = z.object({
  choiceOptions: countRangeSchema,
  scoreLevels: countRangeSchema,
  questionNameMaxLength: z.exactOptional(z.int()),
  images: z.union([imageCapabilitiesSchema, z.literal(false)]),
});

const providerSummarySchema = z.object({
  id: z.literal(PROVIDER_ORDER),
  displayName: z.string(),
  /** The model id requests are pinned to, which the provider select shows beside the name. */
  model: z.string(),
  capabilities: capabilitiesSchema,
});

/**
 * How the instance protects the owner's provider credit (issue #14, ADR-0003):
 * - `local`: the Node dev host inside `vp dev`, which only the developer can reach.
 * - `access`: Cloudflare Access is configured; `validated` says whether this
 *   very request carried a valid Access token, and `problem` says why not.
 * - `opted_out`: the owner set the opt-out variable and accepts an open instance.
 * - `unconfigured`: a deployed instance with neither, so every decision is
 *   refused; `detail` names the variables that are not set, never their values.
 */
export const protectionSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("local") }),
  z.object({
    mode: z.literal("access"),
    validated: z.boolean(),
    problem: z.exactOptional(z.string()),
  }),
  z.object({ mode: z.literal("opted_out") }),
  z.object({ mode: z.literal("unconfigured"), detail: z.string() }),
]);

const providersSuccessSchema = z.object({
  ok: z.literal(true),
  /**
   * The configured providers, in catalog order. Never empty, because an
   * instance with no provider key answers a 503 failure instead.
   */
  providers: z.array(providerSummarySchema).check(z.minLength(1)),
  protection: protectionSchema,
});

/**
 * What `GET /api/providers` answers. An instance with no provider key answers
 * a failure, because it is misconfigured rather than empty.
 */
export const providersResponseSchema = z.discriminatedUnion("ok", [
  providersSuccessSchema,
  failureSchema,
]);

/** The public part of a provider's descriptor. */
export type ProviderSummary = z.output<typeof providerSummarySchema>;

/** The instance's protection state, as `GET /api/providers` reports it. */
export type Protection = z.output<typeof protectionSchema>;

export type ProvidersSuccess = z.output<typeof providersSuccessSchema>;

export type ProvidersResponse = z.output<typeof providersResponseSchema>;

type CountRange = ProviderSummary["capabilities"]["choiceOptions"];

function copyRange(range: CountRange): CountRange {
  return range.max === undefined ? { min: range.min } : { min: range.min, max: range.max };
}

/**
 * Copies only the public fields of a descriptor, field by field down to the
 * capabilities' own fields, so a server-only field added to the catalog later
 * never reaches the browser by being passed along by reference.
 */
export function toProviderSummary(descriptor: ProviderDescriptor): ProviderSummary {
  const { capabilities } = descriptor;
  const images = capabilities.images;
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    model: descriptor.model,
    capabilities: {
      choiceOptions: copyRange(capabilities.choiceOptions),
      scoreLevels: copyRange(capabilities.scoreLevels),
      ...(capabilities.questionNameMaxLength === undefined
        ? {}
        : { questionNameMaxLength: capabilities.questionNameMaxLength }),
      images:
        images === false
          ? false
          : {
              maxCount: images.maxCount,
              maxBytesPerImage: images.maxBytesPerImage,
              maxBytesPerRequest: images.maxBytesPerRequest,
              mediaTypes: [...images.mediaTypes],
            },
    },
  };
}
