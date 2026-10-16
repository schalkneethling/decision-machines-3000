import { describe, expect, it } from "vite-plus/test";
import { gifBytes, jpegBytes, pngBytes, webpBytes } from "../ui/fixtures/images.ts";
import { SIGNATURE_BYTES, detectMediaType, imageDimensions } from "./image-bytes.ts";

describe("detectMediaType", () => {
  it("needs the whole PNG signature, not the first four bytes", () => {
    expect(detectMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    expect(detectMediaType(pngBytes())).toBe("image/png");
  });

  it("needs RIFF and WEBP both", () => {
    const riffOnly = webpBytes();
    riffOnly.set([0x41, 0x56, 0x49, 0x20], 8);
    expect(detectMediaType(riffOnly)).toBeUndefined();
    expect(detectMediaType(webpBytes())).toBe("image/webp");
  });

  it("needs three JPEG bytes", () => {
    expect(detectMediaType(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
    expect(detectMediaType(jpegBytes())).toBe("image/jpeg");
  });

  it("knows nothing else, including GIF and an empty file", () => {
    expect(detectMediaType(gifBytes(64))).toBeUndefined();
    expect(detectMediaType(new Uint8Array(0))).toBeUndefined();
  });

  it("reads no further than the twelve signature bytes", () => {
    for (const bytes of [pngBytes(), jpegBytes(), webpBytes()]) {
      expect(detectMediaType(bytes.subarray(0, SIGNATURE_BYTES))).toBe(detectMediaType(bytes));
    }
  });
});

describe("imageDimensions", () => {
  it("reads a PNG's IHDR", () => {
    expect(imageDimensions(pngBytes({ width: 640, height: 480 }), "image/png")).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("reads a PNG wider than 32,767 pixels as a positive number", () => {
    expect(imageDimensions(pngBytes({ width: 70_000, height: 1 }), "image/png")).toEqual({
      width: 70_000,
      height: 1,
    });
  });

  it("has no size for a PNG whose first chunk is not IHDR, or whose header is cut short", () => {
    const odd = pngBytes();
    odd.set([0x74, 0x45, 0x58, 0x74], 12);
    expect(imageDimensions(odd, "image/png")).toBeUndefined();
    expect(imageDimensions(pngBytes().subarray(0, 20), "image/png")).toBeUndefined();
    expect(imageDimensions(pngBytes({ width: 0 }), "image/png")).toBeUndefined();
  });

  it("walks a JPEG's segments to the frame header, past an APP1 segment as long as a camera's Exif", () => {
    expect(imageDimensions(jpegBytes({ width: 300, height: 200 }), "image/jpeg")).toEqual({
      width: 300,
      height: 200,
    });
    expect(
      imageDimensions(jpegBytes({ width: 4032, height: 3024, prelude: 60_000 }), "image/jpeg"),
    ).toEqual({ width: 4032, height: 3024 });
  });

  it("reads a progressive JPEG's frame header too, and treats Huffman tables as a plain segment", () => {
    // The frame header's marker byte follows the start of image (2 bytes) and the APP0 segment (18 bytes).
    const marker = 21;
    const progressive = jpegBytes({ width: 20, height: 10 });
    progressive[marker] = 0xc2;
    expect(imageDimensions(progressive, "image/jpeg")).toEqual({ width: 20, height: 10 });

    const tables = jpegBytes({ width: 20, height: 10 });
    tables[marker] = 0xc4;
    expect(imageDimensions(tables, "image/jpeg")).toBeUndefined();
  });

  it("stops at the start of scan, a stray byte, or the end", () => {
    const scanFirst = jpegBytes();
    scanFirst[21] = 0xda;
    expect(imageDimensions(scanFirst, "image/jpeg")).toBeUndefined();
    const broken = jpegBytes();
    broken[20] = 0x00;
    expect(imageDimensions(broken, "image/jpeg")).toBeUndefined();
    expect(imageDimensions(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg")).toBeUndefined();
  });

  it("reads each WebP layout", () => {
    for (const layout of ["VP8", "VP8L", "VP8X"] as const) {
      expect(
        imageDimensions(webpBytes({ width: 1024, height: 768, layout }), "image/webp"),
      ).toEqual({ width: 1024, height: 768 });
    }
  });

  it("ignores the scale bits of a VP8 size word", () => {
    const scaled = webpBytes({ width: 100, height: 50, layout: "VP8" });
    scaled[27] = (scaled[27] ?? 0) | 0xc0;
    expect(imageDimensions(scaled, "image/webp")).toEqual({ width: 100, height: 50 });
  });

  it("has no size for a WebP without a start code or a signature, or with an unknown chunk", () => {
    const noStartCode = webpBytes({ layout: "VP8" });
    noStartCode[23] = 0;
    expect(imageDimensions(noStartCode, "image/webp")).toBeUndefined();
    const noSignature = webpBytes({ layout: "VP8L" });
    noSignature[20] = 0;
    expect(imageDimensions(noSignature, "image/webp")).toBeUndefined();
    const alpha = webpBytes({ layout: "VP8X" });
    alpha.set([0x41, 0x4c, 0x50, 0x48], 12);
    expect(imageDimensions(alpha, "image/webp")).toBeUndefined();
    expect(imageDimensions(webpBytes().subarray(0, 24), "image/webp")).toBeUndefined();
    expect(
      imageDimensions(webpBytes({ layout: "VP8L" }).subarray(0, 24), "image/webp"),
    ).toBeUndefined();
    expect(
      imageDimensions(webpBytes({ layout: "VP8X" }).subarray(0, 29), "image/webp"),
    ).toBeUndefined();
  });

  it("has no size for a type it does not know", () => {
    expect(imageDimensions(gifBytes(64), "image/gif")).toBeUndefined();
  });
});
