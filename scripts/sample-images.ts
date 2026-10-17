/**
 * Draws the sample pictures of the image example set (issue #58) and writes them
 * to `src/decision/examples/images/` as PNG files.
 *
 * The pictures are this project's own, so their licence is clear (see the
 * README beside them), and they are drawn here rather than committed as opaque
 * binaries only: anyone can re-run `vp run sample-images` and get the same
 * pixels. Each picture is simple and clearly different from the others, so a
 * model's answers about them are easy to judge: a red square, a blue circle, a
 * green triangle, each alone on white, and a busy scene of many overlapping
 * shapes. The questions in `src/decision/examples/images/*.json` are written
 * against exactly these pictures.
 *
 * The encoder writes an 8-bit RGB PNG with no filtering: a signature, an IHDR
 * chunk, one IDAT chunk holding the zlib-compressed scanlines, and IEND
 * (PNG specification, https://www.w3.org/TR/png-3/, sections 5 and 11). The
 * pixels are deterministic. The compressed bytes depend on the zlib Node links,
 * so the test compares pixels, not files: it inflates each committed IDAT and
 * checks it against `rasterise`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

/** A colour as the three channel values a PNG stores. */
export type Rgb = readonly [red: number, green: number, blue: number];

/** A filled shape in picture coordinates, with `y` growing downwards. */
export type Shape =
  | { kind: "square"; x: number; y: number; size: number; colour: Rgb }
  | { kind: "circle"; cx: number; cy: number; radius: number; colour: Rgb }
  | {
      kind: "triangle";
      a: readonly [number, number];
      b: readonly [number, number];
      c: readonly [number, number];
      colour: Rgb;
    };

/** One sample picture: its file name, size, background, and shapes painted in order. */
export type SamplePicture = {
  name: string;
  width: number;
  height: number;
  background: Rgb;
  shapes: readonly Shape[];
};

const SIDE = 160;
const WHITE: Rgb = [255, 255, 255];
const RED: Rgb = [220, 38, 38];
const BLUE: Rgb = [37, 99, 235];
const GREEN: Rgb = [22, 163, 74];
const AMBER: Rgb = [245, 158, 11];
const PURPLE: Rgb = [147, 51, 234];
const TEAL: Rgb = [13, 148, 136];
const PINK: Rgb = [236, 72, 153];
const PARCHMENT: Rgb = [247, 242, 232];

/** The four pictures, in the order the image example attaches them. */
export const SAMPLE_PICTURES: readonly SamplePicture[] = [
  {
    name: "picture-1.png",
    width: SIDE,
    height: SIDE,
    background: WHITE,
    shapes: [{ kind: "square", x: 40, y: 40, size: 80, colour: RED }],
  },
  {
    name: "picture-2.png",
    width: SIDE,
    height: SIDE,
    background: WHITE,
    shapes: [{ kind: "circle", cx: 80, cy: 80, radius: 44, colour: BLUE }],
  },
  {
    name: "picture-3.png",
    width: SIDE,
    height: SIDE,
    background: WHITE,
    shapes: [{ kind: "triangle", a: [80, 30], b: [28, 128], c: [132, 128], colour: GREEN }],
  },
  {
    name: "picture-4.png",
    width: SIDE,
    height: SIDE,
    background: PARCHMENT,
    shapes: [
      { kind: "circle", cx: 34, cy: 36, radius: 26, colour: AMBER },
      { kind: "square", x: 48, y: 14, size: 38, colour: PURPLE },
      { kind: "triangle", a: [118, 8], b: [86, 60], c: [152, 60], colour: TEAL },
      { kind: "circle", cx: 126, cy: 70, radius: 22, colour: RED },
      { kind: "square", x: 8, y: 70, size: 46, colour: BLUE },
      { kind: "triangle", a: [60, 56], b: [38, 112], c: [96, 112], colour: PINK },
      { kind: "circle", cx: 92, cy: 104, radius: 28, colour: GREEN },
      { kind: "square", x: 112, y: 96, size: 40, colour: AMBER },
      { kind: "circle", cx: 30, cy: 132, radius: 20, colour: PURPLE },
      { kind: "triangle", a: [70, 118], b: [44, 156], c: [100, 156], colour: BLUE },
      { kind: "square", x: 100, y: 128, size: 28, colour: PINK },
      { kind: "circle", cx: 144, cy: 144, radius: 14, colour: TEAL },
    ],
  },
];

/** The folder the pictures are written to, relative to the repository root. */
export const SAMPLE_IMAGES_DIRECTORY = join("src", "decision", "examples", "images");

/** The sign of the cross product: which side of the line `a`→`b` the point is on. */
function side(
  point: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  return (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0]);
}

/** Whether the pixel whose centre is (`x` + 0.5, `y` + 0.5) lies inside `shape`. */
function covers(shape: Shape, x: number, y: number): boolean {
  const px = x + 0.5;
  const py = y + 0.5;
  switch (shape.kind) {
    case "square":
      return (
        px >= shape.x && px < shape.x + shape.size && py >= shape.y && py < shape.y + shape.size
      );
    case "circle":
      return (px - shape.cx) ** 2 + (py - shape.cy) ** 2 <= shape.radius ** 2;
    case "triangle": {
      const point: readonly [number, number] = [px, py];
      const first = side(point, shape.a, shape.b);
      const second = side(point, shape.b, shape.c);
      const third = side(point, shape.c, shape.a);
      const hasNegative = first < 0 || second < 0 || third < 0;
      const hasPositive = first > 0 || second > 0 || third > 0;
      return !(hasNegative && hasPositive);
    }
  }
}

/**
 * The picture's scanlines as PNG stores them before compression: for each row,
 * a filter-type byte of 0 ("None") and then three bytes per pixel. Later shapes
 * paint over earlier ones.
 */
export function rasterise(picture: SamplePicture): Uint8Array {
  const rowLength = 1 + picture.width * 3;
  const raw = new Uint8Array(rowLength * picture.height);
  for (let y = 0; y < picture.height; y += 1) {
    const row = y * rowLength;
    raw[row] = 0;
    for (let x = 0; x < picture.width; x += 1) {
      let colour = picture.background;
      for (const shape of picture.shapes) {
        if (covers(shape, x, y)) colour = shape.colour;
      }
      const offset = row + 1 + x * 3;
      raw[offset] = colour[0];
      raw[offset + 1] = colour[1];
      raw[offset + 2] = colour[2];
    }
  }
  return raw;
}

function uint32BE(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}

/** A PNG chunk: the data length, the type, the data, and a CRC over the type and data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = ascii(type);
  return concat([uint32BE(data.length), typeBytes, data, uint32BE(crc32(data, crc32(typeBytes)))]);
}

/** The PNG file signature (PNG specification, section 5.2). */
export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An 8-bit RGB PNG of `picture`, with the whole image in one IDAT chunk. */
export function encodePng(picture: SamplePicture): Uint8Array {
  // Width, height, bit depth 8, colour type 2 (truecolour), compression 0, filter 0, interlace 0.
  const header = concat([
    uint32BE(picture.width),
    uint32BE(picture.height),
    new Uint8Array([8, 2, 0, 0, 0]),
  ]);
  const data = deflateSync(rasterise(picture), { level: 9 });
  return concat([
    PNG_SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** Writes every picture into `directory` and returns each file's name and size. */
export function writeSampleImages(directory: string): { name: string; bytes: number }[] {
  mkdirSync(directory, { recursive: true });
  return SAMPLE_PICTURES.map((picture) => {
    const bytes = encodePng(picture);
    writeFileSync(join(directory, picture.name), bytes);
    return { name: picture.name, bytes: bytes.length };
  });
}

if (import.meta.main) {
  for (const written of writeSampleImages(SAMPLE_IMAGES_DIRECTORY)) {
    console.log(`${written.name}: ${written.bytes} bytes`);
  }
}
