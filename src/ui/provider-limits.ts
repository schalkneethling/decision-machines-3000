import type { CountRange, ImageCapabilities, ProviderCapabilities } from "../providers/catalog.ts";
import type { ProviderSummary } from "../providers/contract.ts";

/**
 * What a request must satisfy when it goes to several providers at once
 * (issue #101). The request form checks one request against the providers the
 * person ticked, so it needs the limits all of them accept: the strictest of
 * each. Each provider's own limits still decide what that provider is sent.
 */

const names = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "TypeSafe Jev", "TypeSafe Jev and SubQ Snap", "A, B, and C". */
export function providerNames(providers: readonly ProviderSummary[]): string {
  return names.format(providers.map((provider) => provider.displayName));
}

/** The range every one of `ranges` allows: the highest minimum and the lowest maximum. */
function strictestRange(ranges: readonly Readonly<CountRange>[]): CountRange {
  const min = Math.max(...ranges.map((range) => range.min));
  const maxima = ranges.flatMap((range) => (range.max === undefined ? [] : [range.max]));
  return maxima.length === 0 ? { min } : { min, max: Math.min(...maxima) };
}

/**
 * The image limits every one of `images` allows: the fewest images, the
 * smallest caps, and only the formats they all accept.
 */
export function strictestImages(images: readonly ImageCapabilities[]): ImageCapabilities {
  const [first, ...rest] = images;
  if (first === undefined) throw new Error("strictestImages needs at least one provider's limits.");
  return {
    maxCount: Math.min(first.maxCount, ...rest.map((each) => each.maxCount)),
    maxBytesPerImage: Math.min(
      first.maxBytesPerImage,
      ...rest.map((each) => each.maxBytesPerImage),
    ),
    maxBytesPerRequest: Math.min(
      first.maxBytesPerRequest,
      ...rest.map((each) => each.maxBytesPerRequest),
    ),
    mediaTypes: first.mediaTypes.filter((type) =>
      rest.every((each) => each.mediaTypes.includes(type)),
    ),
  };
}

/**
 * The limits a request must meet to be accepted by every provider in
 * `providers`. Images are judged only against the providers that take them,
 * because a text-only provider is sent the request without its images; the
 * result is `false` only when none of them takes images.
 */
export function strictestCapabilities(providers: readonly ProviderSummary[]): ProviderCapabilities {
  const [first] = providers;
  if (first === undefined) {
    throw new Error("strictestCapabilities needs at least one provider.");
  }
  const capabilities = providers.map((provider) => provider.capabilities);
  const nameLimits = capabilities.flatMap((each) =>
    each.questionNameMaxLength === undefined ? [] : [each.questionNameMaxLength],
  );
  const images = capabilities.flatMap((each) => (each.images === false ? [] : [each.images]));
  const strictest: ProviderCapabilities = {
    choiceOptions: strictestRange(capabilities.map((each) => each.choiceOptions)),
    scoreLevels: strictestRange(capabilities.map((each) => each.scoreLevels)),
    images: images.length === 0 ? false : strictestImages(images),
  };
  if (nameLimits.length > 0) strictest.questionNameMaxLength = Math.min(...nameLimits);
  return strictest;
}

/** The providers in `providers` that take images, in order. */
export function imageProviders(providers: readonly ProviderSummary[]): ProviderSummary[] {
  return providers.filter((provider) => provider.capabilities.images !== false);
}

/** The providers in `providers` that are text only, in order. */
export function textOnlyProviders(providers: readonly ProviderSummary[]): ProviderSummary[] {
  return providers.filter((provider) => provider.capabilities.images === false);
}
