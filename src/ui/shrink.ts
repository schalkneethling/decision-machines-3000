import { formatBytes, sizeAndLimit } from "../providers/byte-size.ts";
import { SIGNATURE_BYTES, imageDimensions } from "../providers/image-bytes.ts";
import { ImageRefusal } from "./attachments.ts";
import type { ImageTransform } from "./attachments.ts";
import type { Rasterizer } from "./shrink-browser.ts";
import { DEFAULT_PLAN, searchSizes } from "./shrink-search.ts";
import type { SearchPlan } from "./shrink-search.ts";

/**
 * The transform that issue #25 plugs into the image control (see the pipeline
 * at the top of `attachments.ts`). An image within the budget passes through
 * untouched. An oversized one is decoded, then re-encoded at smaller sizes and
 * lower qualities until it fits: as a JPEG, or as a WebP when it has
 * transparency, since JPEG would turn the transparent areas black. The result
 * is a new `File` whose name and declared type match its new bytes.
 *
 * The budget is `limits.maxBytesPerImage`. The control passes it already
 * lowered to the room left in the request, so this module does not know about
 * the per-request cap or the images already attached.
 *
 * `rasterize` is undefined in a browser without `OffscreenCanvas` or
 * `createImageBitmap`; an oversized image is then refused with a sentence that
 * says why. Every refusal is an `ImageRefusal`, which the control announces.
 */

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/png": "png",
};

/** `photo.png` becomes `photo.jpg`: the name with the extension of the format the bytes now have. */
export function renamedFor(name: string, mediaType: string): string {
  const extension = EXTENSIONS[mediaType];
  if (extension === undefined) return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`;
}

/**
 * What the browser is asked to decode at most. Decoding allocates four bytes per
 * pixel, so a small file of a huge picture (a 20000 by 20000 PNG is a few
 * hundred kilobytes) could take gigabytes. 64 megapixels is about 256 MB of
 * pixels, above any phone camera; 40 MiB bounds the bytes read from disk.
 */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
export const MAX_SOURCE_PIXELS = 64_000_000;

/** The bytes read to find the pixel size: enough for a JPEG whose EXIF block comes before the frame header. */
const HEADER_BYTES = 128 * 1024;

/**
 * The `ImageTransform` the image control runs on each new file: a file within
 * its budget passes unchanged, and a larger one is decoded with `rasterize`,
 * searched down `plan` until it fits, and returned as a JPEG (or a WebP when it
 * has transparency) named for its new format. Every way it can fail throws an
 * `ImageRefusal` whose message the control announces. Without `rasterize` (a
 * browser lacking the canvas APIs), an oversized file is refused with a reason.
 */
export function createShrinkTransform(
  rasterize: Rasterizer | undefined,
  plan: SearchPlan = DEFAULT_PLAN,
): ImageTransform {
  return async ({ file, mediaType }, limits) => {
    const budget = limits.maxBytesPerImage;
    // With no room left the control's own size check refuses the image with the request total.
    if (file.size <= budget || budget <= 0) return file;

    const shown = sizeAndLimit(file.size, budget);
    const mustFit = `it is ${shown.measured}, over the ${shown.limit} it must fit in`;
    if (rasterize === undefined) {
      throw new ImageRefusal(`${mustFit}, and this browser cannot shrink images.`);
    }

    if (file.size > MAX_SOURCE_BYTES) {
      throw new ImageRefusal(`${mustFit}, and it is too large to shrink in the browser.`);
    }
    const header = new Uint8Array(
      await file.slice(0, Math.max(HEADER_BYTES, SIGNATURE_BYTES)).arrayBuffer(),
    );
    const size = imageDimensions(header, mediaType);
    if (size !== undefined && size.width * size.height > MAX_SOURCE_PIXELS) {
      throw new ImageRefusal(
        `${mustFit}, and at ${size.width} × ${size.height} pixels it is too large to shrink in the browser.`,
      );
    }

    const raster = await rasterize(file, mediaType).catch(() => {
      throw new ImageRefusal(`${mustFit}, and this browser could not decode it to shrink it.`);
    });
    try {
      const result = await searchSizes(
        raster,
        budget,
        raster.hasAlpha ? "image/webp" : "image/jpeg",
        raster.encode,
        plan,
      ).catch(() => {
        throw new ImageRefusal(`${mustFit}, and this browser failed while making it smaller.`);
      });
      if (result.kind === "too-big") {
        throw new ImageRefusal(
          `${mustFit}. Even at ${Math.max(result.width, result.height)} px on its long edge and the lowest quality it is still ${formatBytes(result.smallestBytes)}.`,
        );
      }
      const type = result.blob.type;
      if (type === "") {
        throw new ImageRefusal(
          `${mustFit}, and this browser made it smaller in a format it did not name.`,
        );
      }
      if (!limits.mediaTypes.includes(type)) {
        throw new ImageRefusal(
          `${mustFit}, and it could only be made smaller as ${type}, which this provider does not take.`,
        );
      }
      return new File([result.blob], renamedFor(file.name, type), { type });
    } finally {
      raster.close();
    }
  };
}
