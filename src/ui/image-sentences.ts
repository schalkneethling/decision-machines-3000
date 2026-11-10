import { sizeInWords } from "../providers/byte-size.ts";
import type { ImageCapabilities } from "../providers/catalog.ts";
import type { ProviderSummary } from "../providers/contract.ts";

/**
 * The sentences that describe a provider's image capability. The provider
 * select and the image control both say them, so they live apart from either,
 * and every number in them comes from the capabilities the server sent.
 */

const FORMAT_NAMES: Readonly<Record<string, string>> = {
  "image/png": "PNG",
  "image/jpeg": "JPEG",
  "image/webp": "WebP",
};

/** `PNG, JPEG, or WebP`: the accepted formats as a sentence fragment. */
export function formatList(mediaTypes: readonly string[]): string {
  const names = mediaTypes.map((type) => FORMAT_NAMES[type] ?? type);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

/** `2 images`, `1 image`. */
export function imagesCount(count: number): string {
  return `${count} ${count === 1 ? "image" : "images"}`;
}

/** `64 KB each and 64 KB in total`. */
export function sizeLimits(images: ImageCapabilities): string {
  return `${sizeInWords(images.maxBytesPerImage)} each and ${sizeInWords(images.maxBytesPerRequest)} in total`;
}

/**
 * The effect of a provider's image capability, for the provider status line:
 * "Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB each and
 * 64 KB in total." or "Text only, no images."
 */
export function imageInputSentence(images: ImageCapabilities | false): string {
  if (images === false) return "Text only, no images.";
  return `Image input available: up to ${images.maxCount} ${formatList(images.mediaTypes)} images, ${sizeLimits(images)}.`;
}

/** `A`, `A or B`, `A, B, or C`: names as a sentence fragment. */
function orList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(" or ");
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

/**
 * The display names of the listed providers that take images, in list order.
 * The list is the one the page received from `GET /api/providers`, so a
 * provider that is not configured on this instance is never named.
 */
export function imageProviderNames(providers: readonly ProviderSummary[]): string[] {
  return providers
    .filter((provider) => provider.capabilities.images !== false)
    .map((provider) => provider.displayName);
}

/**
 * Says that `selected` is text only and where to go for images: "TypeSafe Jev is
 * text only. Choose SubQ Snap or OpenAI Decisions to attach images." `purpose`
 * completes "Choose … " ("to attach images", "first"). When no listed provider
 * takes images, it says that instead, because there is nowhere to go.
 */
export function textOnlySentence(
  selected: ProviderSummary,
  providers: readonly ProviderSummary[],
  purpose: string,
): string {
  const names = imageProviderNames(providers);
  if (names.length === 0) {
    return `${selected.displayName} is text only, and no provider on this instance takes images.`;
  }
  return `${selected.displayName} is text only. Choose ${orList(names)} ${purpose}.`;
}

/**
 * The capability line under the control. The byte caps are this project's own
 * for every provider (issue #15), so the last sentence is said for all of them.
 */
export function capabilitySentence(provider: ProviderSummary, images: ImageCapabilities): string {
  return (
    `${provider.displayName} takes up to ${images.maxCount} images, ${sizeLimits(images)}: ` +
    `${formatList(images.mediaTypes)}. These are this instance's limits, not the provider's.`
  );
}
