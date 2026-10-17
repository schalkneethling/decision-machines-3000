import type { Attempt } from "./shrink-search.ts";

/**
 * The browser side of issue #25: decoding a picture and encoding it again at
 * another size, with the APIs MDN documents:
 *
 * - `createImageBitmap(blob)` decodes a `Blob` to an `ImageBitmap` (with the
 *   option `imageOrientation: "from-image"`, which MDN lists as the default,
 *   asked for explicitly so the EXIF rotation is applied);
 *   `ImageBitmap.close()` frees its memory at once.
 * - `new OffscreenCanvas(width, height)` and `getContext("2d")` give a canvas
 *   that needs no element in the page; `drawImage(bitmap, 0, 0, width, height)`
 *   scales into it, and `getImageData` reads its pixels back as RGBA bytes.
 * - `convertToBlob({ type, quality })` encodes it. A `type` the browser cannot
 *   encode gives PNG, silently, so the caller reads the blob's own `type`.
 *   Safari encodes JPEG but not WebP this way (MDN's browser compatibility data
 *   for `OffscreenCanvas.convertToBlob`).
 *
 * The unit tests reach this module only through a fake `scope`, because
 * happy-dom has neither a decoder nor an encoder.
 */

/** A decoded picture, ready to be encoded at any size. Call `close` when done. */
export type Raster = {
  width: number;
  height: number;
  /** True when at least one pixel is not fully opaque, so JPEG would turn it black. */
  hasAlpha: boolean;
  encode: (attempt: Attempt) => Promise<Blob>;
  close: () => void;
};

/** Decodes `file`, whose bytes show `mediaType`. Rejects when the browser cannot decode it. */
export type Rasterizer = (file: File, mediaType: string) => Promise<Raster>;

/** The part of the global scope the rasterizer uses, so a test can supply fakes. */
export type CanvasScope = {
  OffscreenCanvas?: typeof OffscreenCanvas;
  createImageBitmap?: typeof createImageBitmap;
};

/** The longest edge of the copy that is scanned for transparency. */
const ALPHA_SCAN_EDGE = 512;

/** The canvas's 2D context, set to its best smoothing where the browser supports the setting. */
function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("No 2D canvas context.");
  // `imageSmoothingQuality` is not available everywhere (MDN lists it as limited availability).
  if ("imageSmoothingQuality" in context) context.imageSmoothingQuality = "high";
  return context;
}

/**
 * True when any pixel's alpha is below 255 (MDN: `getImageData` returns RGBA
 * bytes, alpha 0 to 255). The picture is drawn at no more than 512 px first:
 * scaling blends a transparent pixel with its neighbours, which leaves its alpha
 * below 255, so a transparent area survives the scaling.
 */
function bitmapHasAlpha(Canvas: typeof OffscreenCanvas, bitmap: ImageBitmap): boolean {
  const scale = Math.min(1, ALPHA_SCAN_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new Canvas(width, height);
  try {
    const context = context2d(canvas);
    context.drawImage(bitmap, 0, 0, width, height);
    const { data } = context.getImageData(0, 0, width, height);
    for (let index = 3; index < data.length; index += 4) {
      if ((data[index] ?? 255) < 255) return true;
    }
    return false;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * A rasterizer built on `scope`'s `createImageBitmap` and `OffscreenCanvas`, or
 * undefined when either is missing, so the caller can keep the plain over-limit
 * refusal in a browser that cannot shrink. A JPEG is not scanned for
 * transparency, because it has no alpha channel.
 */
export function browserRasterizer(scope: CanvasScope = globalThis): Rasterizer | undefined {
  const { OffscreenCanvas: Canvas, createImageBitmap: decode } = scope;
  if (typeof Canvas !== "function" || typeof decode !== "function") return undefined;

  return async (file, mediaType) => {
    const bitmap = await decode(file, { imageOrientation: "from-image" });
    try {
      const hasAlpha = mediaType === "image/jpeg" ? false : bitmapHasAlpha(Canvas, bitmap);
      return {
        width: bitmap.width,
        height: bitmap.height,
        hasAlpha,
        encode: async ({ width, height, type, quality }) => {
          const canvas = new Canvas(width, height);
          try {
            context2d(canvas).drawImage(bitmap, 0, 0, width, height);
            return await canvas.convertToBlob({ type, quality });
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        },
        close: () => bitmap.close(),
      };
    } catch (error) {
      bitmap.close();
      throw error;
    }
  };
}
