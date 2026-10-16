/**
 * Small synthetic image files for the image-control tests. Each starts with a
 * real header that `detectMediaType` and `imageDimensions` read, and is then
 * padded with a filler byte to the size a test asks for. None is a picture a
 * decoder would accept; the browser code under test never decodes.
 */

const FILLER = 0x07;

type Options = { width?: number; height?: number; size?: number };

/** `head` followed by filler up to `size` bytes, or just `head` when it is longer. */
function padded(head: number[], size: number | undefined): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(size ?? 0, head.length)).fill(FILLER);
  bytes.set(head);
  return bytes;
}

function uint16BE(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function uint32BE(value: number): number[] {
  return [...uint16BE(value >>> 16), ...uint16BE(value & 0xffff)];
}

function uint16LE(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint24LE(value: number): number[] {
  return [...uint16LE(value & 0xffff), (value >>> 16) & 0xff];
}

function uint32LE(value: number): number[] {
  return [...uint16LE(value & 0xffff), ...uint16LE(value >>> 16)];
}

function ascii(text: string): number[] {
  return Array.from(text, (character) => character.charCodeAt(0));
}

/** The eight-byte signature, then an IHDR chunk: length 13, `IHDR`, width, height, five layout bytes, and a CRC. */
export function pngBytes({ width = 64, height = 48, size }: Options = {}): Uint8Array<ArrayBuffer> {
  const head = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...uint32BE(13),
    ...ascii("IHDR"),
    ...uint32BE(width),
    ...uint32BE(height),
    8,
    2,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  return padded(head, size);
}

/**
 * Start of image, an APP0 (JFIF) segment, optionally an APP1 segment of
 * `prelude` filler bytes as cameras write Exif, then a baseline frame header
 * (SOF0) with the height before the width, as the standard orders them.
 */
export function jpegBytes({
  width = 64,
  height = 48,
  size,
  prelude = 0,
}: Options & { prelude?: number } = {}): Uint8Array<ArrayBuffer> {
  const app0 = [0xff, 0xe0, ...uint16BE(16), ...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const app1 =
    prelude > 0
      ? [0xff, 0xe1, ...uint16BE(prelude + 2), ...Array.from({ length: prelude }, () => 0)]
      : [];
  const sof0 = [
    0xff,
    0xc0,
    ...uint16BE(17),
    8,
    ...uint16BE(height),
    ...uint16BE(width),
    3,
    1,
    0x22,
    0,
    2,
    0x11,
    1,
    3,
    0x11,
    1,
  ];
  return padded([0xff, 0xd8, ...app0, ...app1, ...sof0], size);
}

export type WebpLayout = "VP8" | "VP8L" | "VP8X";

/** `RIFF`, a size, `WEBP`, then one chunk in the layout asked for, holding the width and height. */
export function webpBytes({
  width = 64,
  height = 48,
  size,
  layout = "VP8",
}: Options & { layout?: WebpLayout } = {}): Uint8Array<ArrayBuffer> {
  const chunk = (fourCC: string, payload: number[]): number[] => [
    ...ascii(fourCC),
    ...uint32LE(payload.length),
    ...payload,
  ];
  const payload = {
    // A key frame: a three-byte frame tag, the start code, then the two little-endian size words.
    VP8: chunk("VP8 ", [
      0x10,
      0x02,
      0x00,
      0x9d,
      0x01,
      0x2a,
      ...uint16LE(width),
      ...uint16LE(height),
    ]),
    // The signature byte, then width minus one and height minus one packed in fourteen bits each, least significant first.
    VP8L: chunk("VP8L", [0x2f, ...uint32LE((width - 1) | ((height - 1) << 14))]),
    // The flags byte, three reserved bytes, then the canvas width and height minus one in 24 bits each.
    VP8X: chunk("VP8X", [0x10, 0, 0, 0, ...uint24LE(width - 1), ...uint24LE(height - 1)]),
  }[layout];
  const head = [...ascii("RIFF"), ...uint32LE(4 + payload.length), ...ascii("WEBP"), ...payload];
  return padded(head, size);
}

/** `GIF89a`, a format no provider accepts. */
export function gifBytes(size?: number): Uint8Array<ArrayBuffer> {
  return padded(ascii("GIF89a"), size);
}

/** A `File` of `bytes`, declared as `type`; the declaration is what a browser would infer from `name`. */
export function fileOf(bytes: Uint8Array<ArrayBuffer>, name: string, type = ""): File {
  return new File([bytes], name, { type });
}
