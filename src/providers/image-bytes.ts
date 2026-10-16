/**
 * What the first bytes of an image file say about it: its real format, and its
 * pixel size. The browser uses both for early feedback under the image control
 * (issue #16); the Worker repeats the format check and is authoritative (issue
 * #15). The declared type and the file name are never consulted, because
 * browsers infer `File.type` from the extension, and SubQ refuses bytes that do
 * not match the declared type.
 *
 * Nothing here decodes a picture. The sizes come from each format's header, so
 * a 64 KiB file costs a few byte reads, and a file whose header the parser does
 * not understand simply has no known size.
 *
 * Sources: the PNG signature and IHDR layout from the PNG specification (W3C,
 * section 11.2.1: width and height are the first two four-byte fields of the
 * chunk that follows the eight-byte signature); the JPEG segment structure
 * (`FF` marker, then a big-endian length that counts itself) and the SOFn frame
 * header (precision, height, width, each after the length) from ITU T.81
 * section B.2.2, with the SOF marker codes listed by corkami's `jpeg.md`; the
 * WebP container from Google's RIFF container specification (chunks of a
 * FourCC and a little-endian size, the first at byte 12), the VP8 key-frame
 * header from RFC 6386 section 9.1 (start code `9D 01 2A`, then 14-bit width
 * and height in little-endian words), and the VP8L header from the WebP
 * lossless bitstream specification (signature `2F`, then width minus one and
 * height minus one as 14-bit fields, least significant bits first).
 */

/** The most bytes `detectMediaType` needs: `RIFF`, four size bytes, then `WEBP`. */
export const SIGNATURE_BYTES = 12;

/** True when `bytes` holds `expected` starting at `offset`. */
function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
/** `RIFF` and `WEBP` as bytes. */
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * The media type the first bytes of an image show, or undefined when they
 * match none of PNG, JPEG, or WebP. PNG is checked against its whole eight-byte
 * signature, which is stricter than the four bytes issue #15 names and just as
 * cheap.
 */
export function detectMediaType(bytes: Uint8Array): string | undefined {
  if (hasBytesAt(bytes, 0, PNG_SIGNATURE)) return "image/png";
  if (hasBytesAt(bytes, 0, JPEG_SIGNATURE)) return "image/jpeg";
  if (hasBytesAt(bytes, 0, RIFF) && hasBytesAt(bytes, 8, WEBP)) return "image/webp";
  return undefined;
}

/** A picture's size in pixels. */
export type ImageSize = { width: number; height: number };

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return readUint16LE(bytes, offset) | ((bytes[offset + 2] ?? 0) << 16);
}

/** Big-endian, and never negative: `>>> 0` keeps a width with the top bit set a positive number. */
function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((readUint16BE(bytes, offset) << 16) | readUint16BE(bytes, offset + 2)) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (readUint16LE(bytes, offset) | (readUint16LE(bytes, offset + 2) << 16)) >>> 0;
}

/** A size only when both dimensions are at least one pixel; a zero means the header is not trustworthy. */
function sizeOf(width: number, height: number): ImageSize | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/** `IHDR` as bytes. */
const IHDR = [0x49, 0x48, 0x44, 0x52];

/** The IHDR chunk follows the signature: four length bytes, `IHDR`, then width and height. */
function pngSize(bytes: Uint8Array): ImageSize | undefined {
  if (bytes.length < 24 || !hasBytesAt(bytes, 12, IHDR)) return undefined;
  return sizeOf(readUint32BE(bytes, 16), readUint32BE(bytes, 20));
}

/**
 * True for the SOFn markers, which open a frame header: `C0` to `CF`, except
 * `C4` (Huffman tables), `C8` (reserved), and `CC` (arithmetic conditioning).
 */
function isFrameHeaderMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Walks the segments from the start-of-image marker to the first frame header.
 * Each segment is `FF`, a marker byte, and, for all but the stand-alone
 * markers, a big-endian length that counts itself. Fill bytes (`FF` repeated)
 * are skipped. The walk ends at the frame header, at the start of scan (the
 * compressed data has no further headers), or at the end of the bytes.
 */
function jpegSize(bytes: Uint8Array): ImageSize | undefined {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Stand-alone markers: TEM, the restart markers, and start and end of image.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda) return undefined;
    if (isFrameHeaderMarker(marker)) {
      // After the length: one byte of sample precision, then height, then width.
      if (offset + 9 > bytes.length) return undefined;
      return sizeOf(readUint16BE(bytes, offset + 7), readUint16BE(bytes, offset + 5));
    }
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return undefined;
    offset += 2 + length;
  }
  return undefined;
}

/** The chunk FourCCs as bytes: `VP8 ` (with a trailing space), `VP8L`, and `VP8X`. */
const VP8 = [0x56, 0x50, 0x38, 0x20];
const VP8L = [0x56, 0x50, 0x38, 0x4c];
const VP8X = [0x56, 0x50, 0x38, 0x58];

/** The key-frame start code inside a `VP8 ` chunk, after the three-byte frame tag. */
const VP8_START_CODE = [0x9d, 0x01, 0x2a];

/** The signature byte that opens a `VP8L` chunk's payload. */
const VP8L_SIGNATURE = 0x2f;

/** The three-byte signature, then the fourteen bits of width minus one, then the fourteen of height minus one. */
const FOURTEEN_BITS = 0x3fff;

/**
 * The first chunk starts at byte 12, its payload at byte 20. A lossy file
 * puts the size in the VP8 key-frame header, a lossless one in the VP8L header,
 * and an extended one in the VP8X canvas fields, as 24-bit values minus one.
 */
function webpSize(bytes: Uint8Array): ImageSize | undefined {
  if (hasBytesAt(bytes, 12, VP8X)) {
    if (bytes.length < 30) return undefined;
    return sizeOf(readUint24LE(bytes, 24) + 1, readUint24LE(bytes, 27) + 1);
  }
  if (hasBytesAt(bytes, 12, VP8L)) {
    if (bytes.length < 25 || bytes[20] !== VP8L_SIGNATURE) return undefined;
    const packed = readUint32LE(bytes, 21);
    return sizeOf((packed & FOURTEEN_BITS) + 1, ((packed >>> 14) & FOURTEEN_BITS) + 1);
  }
  if (hasBytesAt(bytes, 12, VP8) && hasBytesAt(bytes, 23, VP8_START_CODE)) {
    if (bytes.length < 30) return undefined;
    // The top two bits of each word are a scale factor the decoder applies; the picture itself is the low fourteen.
    return sizeOf(readUint16LE(bytes, 26) & FOURTEEN_BITS, readUint16LE(bytes, 28) & FOURTEEN_BITS);
  }
  return undefined;
}

/**
 * The pixel size an image's header declares, or undefined when the header is
 * absent, truncated, or of a layout this parser does not know. `mediaType` is
 * what `detectMediaType` returned for the same bytes.
 */
export function imageDimensions(bytes: Uint8Array, mediaType: string): ImageSize | undefined {
  switch (mediaType) {
    case "image/png":
      return pngSize(bytes);
    case "image/jpeg":
      return jpegSize(bytes);
    case "image/webp":
      return webpSize(bytes);
    default:
      return undefined;
  }
}
