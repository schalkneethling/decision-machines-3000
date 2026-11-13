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

/**
 * `64 KB in total`, or `32 KB each and 64 KB in total`. The per-image cap is
 * named only when it is below the total, because otherwise the total is the
 * only limit an image can reach, and naming both read as if each image could
 * take the full amount.
 */
export function sizeLimits(images: ImageCapabilities): string {
  const total = `${sizeInWords(images.maxBytesPerRequest)} in total`;
  if (images.maxBytesPerImage >= images.maxBytesPerRequest) return total;
  return `${sizeInWords(images.maxBytesPerImage)} each and ${total}`;
}

/**
 * The effect of a provider's image capability, for the provider status line:
 * "Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB in total."
 * or "Text only, no images."
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

const andList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** "TypeSafe Jev is", "A and B are": the subject of a sentence about `textOnly`. */
function textOnlySubject(textOnly: readonly ProviderSummary[]): string {
  const subject = andList.format(textOnly.map((provider) => provider.displayName));
  return `${subject} ${textOnly.length === 1 ? "is" : "are"}`;
}

/**
 * Says that the ticked providers in `textOnly` are text only and where to go
 * for images: "TypeSafe Jev is text only. Choose SubQ Snap or OpenAI Decisions
 * to attach images." `purpose` completes "Choose … " ("to attach images",
 * "first"). When no listed provider takes images, it says that instead,
 * because there is nowhere to go.
 */
export function textOnlySentence(
  textOnly: readonly ProviderSummary[],
  providers: readonly ProviderSummary[],
  purpose: string,
): string {
  const names = imageProviderNames(providers);
  const subject = textOnlySubject(textOnly);
  if (names.length === 0) {
    return `${subject} text only, and no provider on this instance takes images.`;
  }
  return `${subject} text only. Choose ${orList(names)} ${purpose}.`;
}

/** "TypeSafe Jev is text only and gets the request without images.": its line among the image limits. */
export function textOnlyLimitSentence(provider: ProviderSummary): string {
  return `${provider.displayName} is text only and gets the request without images.`;
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
