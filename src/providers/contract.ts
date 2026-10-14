/**
 * `GET /api/providers`: which providers this instance has a key for.
 *
 * The Worker answers with the public part of each configured provider's
 * catalog descriptor: its id, its display name, its model id, and its
 * capabilities. The base URL and the warm path stay on the server, and no key, key length, or
 * key prefix is ever part of the answer.
 *
 * The shape is a Zod Mini schema, following `src/decision/contract.ts`
 * (ADR-0004), so the browser checks the body with the same schema the type is
 * inferred from. Zod Mini APIs used, read from node_modules/zod/v4/mini/schemas.d.ts:
 * `object`, `literal` (with an array of values), `int`, `string`, `array`,
 * `readonly`, `exactOptional`, `union`, and `discriminatedUnion`; `minLength`
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

const providersSuccessSchema = z.object({
  ok: z.literal(true),
  /**
   * The configured providers, in catalog order. Never empty, because an
   * instance with no provider key answers a 503 failure instead.
   */
  providers: z.array(providerSummarySchema).check(z.minLength(1)),
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
