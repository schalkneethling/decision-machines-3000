// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDERS } from "../providers/catalog.ts";
import type { ImageCapabilities } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import { createAttachments } from "./attachments.ts";
import type { ImageTransform } from "./attachments.ts";
import { fileOf, jpegBytes, pngBytes, webpBytes } from "./fixtures/images.ts";
import { browserRasterizer } from "./shrink-browser.ts";
import type { CanvasScope, Raster, Rasterizer } from "./shrink-browser.ts";
import { MAX_SOURCE_BYTES, createShrinkTransform, renamedFor } from "./shrink.ts";

const KIB = 1024;
const MIB = KIB * KIB;

const subq = toProviderSummary(PROVIDERS.subq);
const openai = toProviderSummary(PROVIDERS.openai);
const limits = subq.capabilities.images as ImageCapabilities;

/**
 * A stand-in for the browser's decoder: a picture of `width` by `height` whose
 * encodings are real-looking JPEG or WebP headers padded to `bytesAt(attempt)`.
 * It records closes, so a test can check the bitmap is released.
 */
function fakeRasterizer(
  options: {
    width?: number;
    height?: number;
    hasAlpha?: boolean;
    bytesAt?: (width: number, quality: number) => number;
    /** The `type` the encoded blob reports instead of the one asked for. */
    answerType?: string;
  } = {},
): { rasterize: Rasterizer; closes: () => number } {
  const {
    width = 4000,
    height = 3000,
    hasAlpha = false,
    bytesAt = () => 30 * KIB,
    answerType,
  } = options;
  let closed = 0;
  const rasterize: Rasterizer = async () => {
    const raster: Raster = {
      width,
      height,
      hasAlpha,
      encode: async (attempt) => {
        const size = bytesAt(attempt.width, attempt.quality);
        const bytes =
          attempt.type === "image/webp"
            ? webpBytes({ width: attempt.width, height: attempt.height, size })
            : jpegBytes({ width: attempt.width, height: attempt.height, size });
        return new Blob([bytes], { type: answerType ?? attempt.type });
      },
      close: () => {
        closed += 1;
      },
    };
    return raster;
  };
  return { rasterize, closes: () => closed };
}

function mount(): HTMLFormElement {
  document.body.innerHTML = `
    <form class="panel-form" data-primitive="noul" novalidate>
      <div class="attachments"></div>
    </form>`;
  const form = document.querySelector("form");
  if (form === null) throw new Error("No form.");
  return form;
}

const status = () => document.querySelector(".attachments-status")?.textContent ?? "";
const items = () => [...document.querySelectorAll<HTMLLIElement>(".attachment")];

beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    (object: Blob | MediaSource) => `blob:test/${object instanceof File ? object.name : "blob"}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renamedFor", () => {
  it("gives the name the extension of the format the bytes now have", () => {
    expect(renamedFor("photo.png", "image/jpeg")).toBe("photo.jpg");
    expect(renamedFor("photo.JPEG", "image/webp")).toBe("photo.webp");
    expect(renamedFor("photo", "image/jpeg")).toBe("photo.jpg");
    expect(renamedFor("my.holiday.photo.heic.png", "image/jpeg")).toBe("my.holiday.photo.heic.jpg");
  });
});

describe("createShrinkTransform", () => {
  const big = () =>
    fileOf(jpegBytes({ width: 4000, height: 3000, size: 5 * MIB }), "photo.jpg", "image/jpeg");

  it("returns a file within the budget as it is, without decoding it", async () => {
    const rasterize = vi.fn<Rasterizer>();
    const file = fileOf(pngBytes({ size: 12 * KIB }), "small.png", "image/png");
    const result = await createShrinkTransform(rasterize)({ file, mediaType: "image/png" }, limits);
    expect(result).toBe(file);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("leaves a file to the control's own check when there is no room at all", async () => {
    const rasterize = vi.fn<Rasterizer>();
    const file = big();
    const result = await createShrinkTransform(rasterize)(
      { file, mediaType: "image/jpeg" },
      { ...limits, maxBytesPerImage: 0 },
    );
    expect(result).toBe(file);
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("shrinks an opaque picture to a JPEG that fits and is named for it", async () => {
    const { rasterize, closes } = fakeRasterizer();
    const file = fileOf(pngBytes({ size: 3 * MIB }), "shot.png", "image/png");
    const result = await createShrinkTransform(rasterize)({ file, mediaType: "image/png" }, limits);
    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("shot.jpg");
    expect(result.size).toBeLessThanOrEqual(limits.maxBytesPerImage);
    expect(new Uint8Array(await result.arrayBuffer()).slice(0, 3)).toEqual(
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    expect(closes()).toBe(1);
  });

  it("shrinks a picture with transparency to a WebP", async () => {
    const { rasterize } = fakeRasterizer({ hasAlpha: true });
    const file = fileOf(pngBytes({ size: 3 * MIB }), "logo.png", "image/png");
    const result = await createShrinkTransform(rasterize)({ file, mediaType: "image/png" }, limits);
    expect(result.type).toBe("image/webp");
    expect(result.name).toBe("logo.webp");
    const head = new Uint8Array(await result.arrayBuffer()).slice(0, 12);
    expect(new TextDecoder().decode(head.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(head.slice(8, 12))).toBe("WEBP");
  });

  it("declares the type the encoder really produced when it could not make a WebP", async () => {
    const rasterize: Rasterizer = async () => ({
      width: 800,
      height: 600,
      hasAlpha: true,
      encode: async () => new Blob([pngBytes({ size: 20 * KIB })], { type: "image/png" }),
      close: () => {},
    });
    const file = fileOf(pngBytes({ size: 3 * MIB }), "logo.png", "image/png");
    const result = await createShrinkTransform(rasterize)({ file, mediaType: "image/png" }, limits);
    expect(result.type).toBe("image/png");
    expect(result.name).toBe("logo.png");
  });

  it("refuses with the smallest size it reached when nothing fits, and still closes the bitmap", async () => {
    const { rasterize, closes } = fakeRasterizer({ bytesAt: () => 71 * KIB });
    await expect(
      createShrinkTransform(rasterize)({ file: big(), mediaType: "image/jpeg" }, limits),
    ).rejects.toThrow(
      "it is 5.0 MB, over the 64 KB it must fit in. Even at 512 px on its long edge and the lowest quality it is still 71 KB.",
    );
    expect(closes()).toBe(1);
  });

  it("closes the bitmap when the encoder throws", async () => {
    const closed = vi.fn();
    const rasterize: Rasterizer = async () => ({
      width: 800,
      height: 600,
      hasAlpha: false,
      encode: async () => {
        throw new Error("encoder");
      },
      close: closed,
    });
    await expect(
      createShrinkTransform(rasterize)({ file: big(), mediaType: "image/jpeg" }, limits),
    ).rejects.toThrow("failed while making it smaller");
    expect(closed).toHaveBeenCalledOnce();
  });

  it("refuses with a reason in a browser that cannot shrink", async () => {
    await expect(
      createShrinkTransform(undefined)({ file: big(), mediaType: "image/jpeg" }, limits),
    ).rejects.toThrow(
      "it is 5.0 MB, over the 64 KB it must fit in, and this browser cannot shrink images.",
    );
  });

  it("refuses a picture with too many pixels without decoding it", async () => {
    const rasterize = vi.fn<Rasterizer>();
    const file = fileOf(
      pngBytes({ width: 20000, height: 20000, size: 300 * KIB }),
      "wall.png",
      "image/png",
    );
    await expect(
      createShrinkTransform(rasterize)({ file, mediaType: "image/png" }, limits),
    ).rejects.toThrow("at 20000 × 20000 pixels it is too large to shrink in the browser.");
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("refuses a file above the byte ceiling without decoding it", async () => {
    const rasterize = vi.fn<Rasterizer>();
    const file = fileOf(jpegBytes({ size: MAX_SOURCE_BYTES + 1 }), "huge.jpg", "image/jpeg");
    await expect(
      createShrinkTransform(rasterize)({ file, mediaType: "image/jpeg" }, limits),
    ).rejects.toThrow("too large to shrink in the browser.");
    expect(rasterize).not.toHaveBeenCalled();
  });

  it("explains an encoder failure instead of calling the file unreadable", async () => {
    const rasterize: Rasterizer = async () => ({
      width: 800,
      height: 600,
      hasAlpha: false,
      encode: () => Promise.reject(new Error("EncodingError")),
      close: () => {},
    });
    await expect(
      createShrinkTransform(rasterize)({ file: big(), mediaType: "image/jpeg" }, limits),
    ).rejects.toThrow("this browser failed while making it smaller.");
  });

  it("refuses a result in a format the provider does not take", async () => {
    const { rasterize } = fakeRasterizer({ hasAlpha: true });
    await expect(
      createShrinkTransform(rasterize)(
        { file: fileOf(pngBytes({ size: 3 * MIB }), "a.png", "image/png"), mediaType: "image/png" },
        { ...limits, mediaTypes: ["image/png", "image/jpeg"] },
      ),
    ).rejects.toThrow("which this provider does not take");
  });

  it("refuses a result whose format the browser did not name, without an empty type in the message", async () => {
    const { rasterize, closes } = fakeRasterizer({ answerType: "" });
    const refusal = createShrinkTransform(rasterize)(
      { file: big(), mediaType: "image/jpeg" },
      limits,
    );
    await expect(refusal).rejects.toThrow("made it smaller in a format it did not name.");
    await expect(refusal).rejects.not.toThrow(/ as ,/);
    expect(closes()).toBe(1);
  });

  it("refuses with a reason when the browser cannot decode the file", async () => {
    const rasterize: Rasterizer = () => Promise.reject(new Error("InvalidStateError"));
    await expect(
      createShrinkTransform(rasterize)({ file: big(), mediaType: "image/jpeg" }, limits),
    ).rejects.toThrow("this browser could not decode it to shrink it.");
  });
});

describe("the image control with the shrink transform", () => {
  it("shrinks an oversized photo when it is added, and says so in the list and in the status", async () => {
    const { rasterize } = fakeRasterizer({
      bytesAt: (width) => (width === 1024 ? 52 * KIB : 99 * KIB),
    });
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: createShrinkTransform(rasterize),
    });
    await control.add([
      fileOf(jpegBytes({ width: 4000, height: 3000, size: 5.8 * MIB }), "photo.jpg", "image/jpeg"),
    ]);
    expect(control.count()).toBe(1);
    expect(control.files()[0]?.type).toBe("image/jpeg");
    expect(control.files()[0]?.size).toBeLessThanOrEqual(limits.maxBytesPerImage);
    expect(status()).toBe(
      "Image 1 added: photo.jpg, 52 KB. Shrunk from 5.8 MB to 52 KB (1024 × 768).",
    );
    const text = items()[0]?.textContent ?? "";
    expect(text).toContain("Shrunk from 5.8 MB to 52 KB");
    expect(text).toContain("image/jpeg, 52 KB, 1024 × 768");
    expect(document.querySelectorAll(".attachment button")).toHaveLength(1);
  });

  it("does not mention shrinking for an image that fits", async () => {
    const { rasterize } = fakeRasterizer();
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: createShrinkTransform(rasterize),
    });
    await control.add([fileOf(pngBytes({ size: 12 * KIB }), "poster.png", "image/png")]);
    expect(status()).toBe("Image 1 added: poster.png, 12 KB.");
    expect(items()[0]?.textContent).not.toContain("Shrunk");
  });

  it("turns a PNG with transparency into a WebP", async () => {
    const { rasterize } = fakeRasterizer({ hasAlpha: true, bytesAt: () => 20 * KIB });
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: createShrinkTransform(rasterize),
    });
    await control.add([fileOf(pngBytes({ size: 2 * MIB }), "logo.png", "image/png")]);
    expect(control.files()[0]?.type).toBe("image/webp");
    expect(control.files()[0]?.name).toBe("logo.webp");
    expect(items()[0]?.textContent).toContain("image/webp");
  });

  it("aims at the room left in the request, not at the per-image cap", async () => {
    const asked: number[] = [];
    const inner = createShrinkTransform(fakeRasterizer({ bytesAt: () => 20 * KIB }).rasterize);
    const spy: ImageTransform = (image, caps) => {
      asked.push(caps.maxBytesPerImage);
      return inner(image, caps);
    };
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: openai,
      transform: spy,
    });
    await control.add([fileOf(pngBytes({ size: 40 * KIB }), "first.png", "image/png")]);
    await control.add([fileOf(jpegBytes({ size: 3 * MIB }), "second.jpg", "image/jpeg")]);
    expect(asked).toEqual([64 * KIB, 24 * KIB]);
  });

  describe("the room left in the request, as the refusal words it", () => {
    // The request holds 64 KiB, so attaching `taken` bytes first leaves 65,536 - taken bytes of room.
    async function refusedWithRoom(taken: number, size: number): Promise<string> {
      const control = createAttachments(mount(), {
        prefix: "noul-images",
        provider: openai,
        transform: createShrinkTransform(undefined),
      });
      await control.add([fileOf(pngBytes({ size: taken }), "first.png", "image/png")]);
      await control.add([fileOf(pngBytes({ size }), "next.png", "image/png")]);
      return status();
    }

    it("gives 34,299 bytes of room as a rounded size, not with every decimal", async () => {
      expect(await refusedWithRoom(31_237, 40_000)).toBe(
        "next.png was not added: it is 39 KB, over the 33 KB it must fit in, and this browser cannot shrink images.",
      );
    });

    it("shows a picture and the room it failed to fit in bytes when rounding would hide the difference", async () => {
      expect(await refusedWithRoom(30_636, 35_000)).toBe(
        "next.png was not added: it is 35,000 bytes, over the 34,900 bytes it must fit in, and this browser cannot shrink images.",
      );
    });

    it("still writes a budget that is the whole 64 KiB as 64 KB", async () => {
      const file = fileOf(jpegBytes({ size: 5 * MIB }), "wall.jpg", "image/jpeg");
      const refusal = createShrinkTransform(undefined)({ file, mediaType: "image/jpeg" }, limits);
      await expect(refusal).rejects.toThrow(
        "it is 5.0 MB, over the 64 KB it must fit in, and this browser cannot shrink images.",
      );
    });
  });

  it("fits large photos in the request in total, and refuses the one that cannot fit the room left", async () => {
    // The encodings are 40 KiB at 1024 px, 20 KiB at 768 px, and 10 KiB at 512 px, so the third photo has 4 KiB left and cannot fit.
    const { rasterize } = fakeRasterizer({
      bytesAt: (width) => (width === 1024 ? 40 * KIB : width === 768 ? 20 * KIB : 10 * KIB),
    });
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: openai,
      transform: createShrinkTransform(rasterize),
    });
    const photo = (name: string) => fileOf(jpegBytes({ size: 4 * MIB }), name, "image/jpeg");
    await control.add([photo("a.jpg"), photo("b.jpg"), photo("c.jpg")]);
    const sizes = control.files().map((file) => file.size);
    expect(sizes).toEqual([40 * KIB, 20 * KIB]);
    expect(status()).toContain("c.jpg was not added: it is 4.0 MB, over the 4 KB it must fit in.");
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(
      limits.maxBytesPerRequest,
    );
  });

  it("refuses an image when even the smallest step is over, and lists nothing", async () => {
    const { rasterize } = fakeRasterizer({ bytesAt: () => 71 * KIB });
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: createShrinkTransform(rasterize),
    });
    await control.add([fileOf(pngBytes({ size: 6.1 * MIB }), "huge.png", "image/png")]);
    expect(control.count()).toBe(0);
    expect(status()).toBe(
      "huge.png was not added: it is 6.1 MB, over the 64 KB it must fit in. Even at 512 px on its long edge and the lowest quality it is still 71 KB.",
    );
  });

  it("blocks Run while an image is being shrunk, says it is working, and lets go afterwards", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createShrinkTransform(fakeRasterizer().rasterize);
    const changes = vi.fn();
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: async (image, caps) => {
        await gate;
        return inner(image, caps);
      },
      onChange: changes,
    });
    expect(control.blocked()).toBeUndefined();
    const adding = control.add([fileOf(jpegBytes({ size: 3 * MIB }), "photo.jpg", "image/jpeg")]);
    expect(control.blocked()).toContain("still being added");
    await vi.waitFor(() => expect(status()).toBe("Making photo.jpg smaller to fit…"));
    release();
    await adding;
    await vi.waitFor(() => expect(control.blocked()).toBeUndefined());
    expect(changes).toHaveBeenCalled();
    expect(control.count()).toBe(1);
  });

  it("says nothing about shrinking for an image that already fits", async () => {
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: createShrinkTransform(fakeRasterizer().rasterize),
    });
    const adding = control.add([fileOf(pngBytes({ size: 12 * KIB }), "a.png", "image/png")]);
    expect(status()).toBe("");
    await adding;
  });

  it("keeps going with the rest of the selection after a refusal", async () => {
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: createShrinkTransform(undefined),
    });
    await control.add([
      fileOf(jpegBytes({ size: 5 * MIB }), "big.jpg", "image/jpeg"),
      fileOf(pngBytes({ size: 12 * KIB }), "small.png", "image/png"),
    ]);
    expect(control.files().map((file) => file.name)).toEqual(["small.png"]);
    expect(status()).toBe(
      "big.jpg was not added: it is 5.0 MB, over the 64 KB it must fit in, and this browser cannot shrink images. Image 1 added: small.png, 12 KB.",
    );
  });
});

describe("browserRasterizer", () => {
  it("is unavailable without OffscreenCanvas or without createImageBitmap", () => {
    const canvas = class {} as unknown as typeof OffscreenCanvas;
    const decode = vi.fn() as unknown as typeof createImageBitmap;
    expect(browserRasterizer({})).toBeUndefined();
    expect(browserRasterizer({ OffscreenCanvas: canvas })).toBeUndefined();
    expect(browserRasterizer({ createImageBitmap: decode })).toBeUndefined();
    expect(browserRasterizer({ OffscreenCanvas: canvas, createImageBitmap: decode })).toBeTypeOf(
      "function",
    );
  });

  /** Fakes for the two APIs: a bitmap of 2000 by 1000 whose pixels have `alpha`, and a canvas that encodes `encoded`. */
  function fakeScope(alpha: number, encoded = "image/webp") {
    const bitmap = { width: 2000, height: 1000, close: vi.fn() };
    const converted: unknown[] = [];
    const drawn: number[][] = [];
    class FakeCanvas {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext() {
        return {
          drawImage: (_image: unknown, _x: number, _y: number, w: number, h: number) => {
            drawn.push([w, h]);
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).fill(alpha),
          }),
        };
      }
      async convertToBlob(options: unknown) {
        converted.push(options);
        return new Blob([new Uint8Array(10)], { type: encoded });
      }
    }
    const scope = {
      OffscreenCanvas: FakeCanvas as unknown as typeof OffscreenCanvas,
      createImageBitmap: vi.fn(async () => bitmap) as unknown as typeof createImageBitmap,
    } satisfies CanvasScope;
    return { scope, bitmap, converted, drawn };
  }

  it("scans a PNG's alpha at no more than 512 px and reports transparency", async () => {
    const { scope, drawn } = fakeScope(0);
    const raster = await browserRasterizer(scope)?.(
      fileOf(pngBytes(), "a.png", "image/png"),
      "image/png",
    );
    expect(raster?.hasAlpha).toBe(true);
    expect(drawn[0]).toEqual([512, 256]);
    expect(scope.createImageBitmap).toHaveBeenCalledWith(expect.anything(), {
      imageOrientation: "from-image",
    });
  });

  it("reports an opaque picture, and does not scan a JPEG", async () => {
    const opaque = fakeScope(255);
    const png = await browserRasterizer(opaque.scope)?.(
      fileOf(pngBytes(), "a.png", "image/png"),
      "image/png",
    );
    expect(png?.hasAlpha).toBe(false);
    const jpeg = fakeScope(0);
    const raster = await browserRasterizer(jpeg.scope)?.(
      fileOf(jpegBytes(), "a.jpg", "image/jpeg"),
      "image/jpeg",
    );
    expect(raster?.hasAlpha).toBe(false);
    expect(jpeg.drawn).toEqual([]);
  });

  it("encodes with the type and quality asked for, and closes the bitmap on close", async () => {
    const { scope, bitmap, converted, drawn } = fakeScope(255);
    const raster = await browserRasterizer(scope)?.(
      fileOf(pngBytes(), "a.png", "image/png"),
      "image/png",
    );
    const blob = await raster?.encode({
      width: 1024,
      height: 512,
      type: "image/jpeg",
      quality: 0.6,
    });
    expect(blob?.size).toBe(10);
    expect(converted).toEqual([{ type: "image/jpeg", quality: 0.6 }]);
    expect(drawn.at(-1)).toEqual([1024, 512]);
    expect(bitmap.close).not.toHaveBeenCalled();
    raster?.close();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });

  it("closes the bitmap when the alpha scan fails", async () => {
    const { scope, bitmap } = fakeScope(255);
    class Broken {
      getContext() {
        return null;
      }
    }
    const rasterize = browserRasterizer({
      ...scope,
      OffscreenCanvas: Broken as unknown as typeof OffscreenCanvas,
    });
    await expect(
      rasterize?.(fileOf(pngBytes(), "a.png", "image/png"), "image/png"),
    ).rejects.toThrow();
    expect(bitmap.close).toHaveBeenCalledOnce();
  });
});
