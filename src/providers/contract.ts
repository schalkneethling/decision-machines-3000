/**
 * `GET /api/providers`: which providers this instance has a key for.
 *
 * The Worker answers with the public part of each configured provider's
 * catalog descriptor: its id, its display name, and its capabilities. The model
 * id and the warm path stay on the server, and no key, key length, or key
 * prefix is ever part of the answer.
 *
 * The shape is a Zod Mini schema, following `src/decision/contract.ts`
 * (ADR-0004), so the browser checks the body with the same schema the type is
 * inferred from. Zod Mini APIs used, read from node_modules/zod/v4/mini/schemas.d.ts:
 * `object`, `literal` (with an array of values), `number`, `string`, `array`,
 * `readonly`, `exactOptional`, `union`, and `discriminatedUnion`.
 */

import * as z from "zod/mini";
import { failureSchema } from "../decision/contract.ts";
import { PROVIDER_ORDER } from "./catalog.ts";
import type { ProviderDescriptor } from "./catalog.ts";

export const PROVIDERS_ENDPOINT = "/api/providers";

const countRangeSchema = z.readonly(
  z.object({ min: z.number(), max: z.exactOptional(z.number()) }),
);

const imageCapabilitiesSchema = z.object({
  maxCount: z.number(),
  maxBytesPerImage: z.number(),
  maxBytesPerRequest: z.number(),
  mediaTypes: z.readonly(z.array(z.string())),
});

const capabilitiesSchema = z.object({
  choiceOptions: countRangeSchema,
  scoreLevels: countRangeSchema,
  questionNameMaxLength: z.exactOptional(z.number()),
  images: z.union([imageCapabilitiesSchema, z.literal(false)]),
});

const providerSummarySchema = z.object({
  id: z.literal(PROVIDER_ORDER),
  displayName: z.string(),
  capabilities: capabilitiesSchema,
});

const providersSuccessSchema = z.object({
  ok: z.literal(true),
  /** The configured providers, in catalog order. */
  providers: z.array(providerSummarySchema),
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

/** Copies only the public fields of a descriptor, so nothing server-side leaks by accident. */
export function toProviderSummary(descriptor: ProviderDescriptor): ProviderSummary {
  return {
    id: descriptor.id,
    displayName: descriptor.displayName,
    capabilities: descriptor.capabilities,
  };
}
