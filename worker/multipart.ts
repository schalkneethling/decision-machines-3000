/**
 * Reading a `multipart/form-data` decision request: one `request` part that
 * holds the JSON text, and one `image` part per picture, each a binary file.
 *
 * The work happens in these steps, so the cheap checks come first and the
 * expensive one last:
 *
 * 0. Before the body is parsed, `readMultipart` counts the parts by their
 *    delimiter lines and refuses a body with more than the provider can use,
 *    because `formData()` builds every part before anything can be counted
 *    and thousands of empty parts cost far more than the Free plan's 10 ms.
 * 1. `readMultipart` parses the body and checks its shape and its declared
 *    sizes against the provider's `capabilities.images` with one Zod Mini
 *    schema (ADR-0004). Nothing is read from a file yet.
 * 2. `encodeImages`, called after the JSON part has passed validation, reads
 *    each file's first bytes to find its real format, then reads the bytes and
 *    encodes them to base64 once. A format the file's bytes do not show is
 *    refused, whatever the part declared. The check is on the signature only,
 *    to stop the declared type from being trusted. Bytes after a valid signature
 *    are not examined, so a file that starts like a PNG and then holds anything
 *    passes here; the provider is the one that decodes the picture.
 * 3. The route hands the result to the adapter, which places it on the wire.
 *
 * No message here names a part, a file name, or a declared type, because the
 * client controls all three and Varlock's leak scanner replaces a reply that
 * contains a key's value (see `docs/deploy.md`). Messages name the image by its
 * position in the request ("Image 2") and the limit it broke.
 *
 * Zod Mini APIs used, read from node_modules/zod/v4/mini/schemas.d.ts and
 * node_modules/zod/v4/core/errors.d.ts: `object`, `array`, `string`, `custom`,
 * `refine`, `.check()`, `safeParse`, and the `error` option, which takes a
 * string or a function of the issue. `Uint8Array.prototype.toBase64` is typed
 * by `lib.esnext.typedarrays.d.ts` in the `typescript` package.
 */

import * as z from "zod/mini";
import { sizeInWords } from "../src/providers/byte-size.ts";
import type { ImageCapabilities, ProviderDescriptor } from "../src/providers/catalog.ts";
import { SIGNATURE_BYTES, detectMediaType } from "../src/providers/image-bytes.ts";
import { TEXT_ALLOWANCE_BYTES, tooLarge } from "./body-limit.ts";
import type { ImageAttachment } from "./decide.ts";
import { failure } from "./respond.ts";

/** The answer to send instead of reading on. */
export type Refusal = { ok: false; response: Response };

/** A 400 with `error`, as a `Refusal`. */
function refuse(error: string): Refusal {
  return { ok: false, response: failure(400, error) };
}

const MISSING_BOUNDARY =
  'The multipart Content-Type has no "boundary" parameter, so the body cannot be split into parts. ' +
  "Leave Content-Type for the client to set, because a hand-set header drops the boundary.";

/**
 * Parts beyond `1 + maxCount` that are counted before the refusal, so that a
 * small mistake (a second "request" part, one image too many) still reaches the
 * schema and gets its specific message. Only a body with a flood of parts meets
 * the blunter one.
 */
export const EXTRA_PARTS_ALLOWANCE = 2;

const BOUNDARY_VALUE = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i;

const UNREADABLE = "The multipart body could not be read. Check its boundary and parts.";

/** `Image 2`: how a message names the second image part, by position, never by what the client called it. */
function imageLabel(index: number): string {
  return `Image ${index + 1}`;
}

/** The size of an entry that should be a file, and 0 for anything else, which the schema reports itself. */
function sizeOf(entry: unknown): number {
  return entry instanceof File ? entry.size : 0;
}

/**
 * The schema of a multipart request for one provider. Its input is the parts
 * grouped by name: `{ request, image }`, each a list of form entries. The
 * checks run in the order they are written, and `readMultipart` reports the
 * first issue.
 */
function multipartSchema(provider: ProviderDescriptor) {
  const { displayName, capabilities } = provider;
  const images = capabilities.images;

  const request = z
    .array(
      z.string({
        error: 'The "request" part must be text that holds the request as JSON, not a file.',
      }),
    )
    .check(
      z.refine((parts) => parts.length === 1, {
        error: (issue) =>
          (issue.input as unknown[]).length === 0
            ? 'The "request" part is required. Send it as text that holds the request as JSON.'
            : 'Send exactly one "request" part, not several.',
      }),
    );

  const file = z.custom<File>((entry) => entry instanceof File, {
    error: 'Each "image" part must be a file.',
  });

  if (images === false) {
    const image = z.array(file).check(
      z.refine((files) => files.length === 0, {
        error: `${displayName} evaluates text only, so it does not accept images. Remove them and run again.`,
      }),
    );
    return z.object({ request, image });
  }

  const image = z.array(file).check(
    z.refine((files) => files.length <= images.maxCount, {
      error: (issue) =>
        `This request has ${(issue.input as unknown[]).length} images. ` +
        `${displayName} takes at most ${images.maxCount} per request in this project.`,
    }),
    z.refine((files) => files.every((entry) => sizeOf(entry) <= images.maxBytesPerImage), {
      error: (issue) => {
        const index = (issue.input as unknown[]).findIndex(
          (entry) => sizeOf(entry) > images.maxBytesPerImage,
        );
        return (
          `${imageLabel(index)} is over this project's limit of ` +
          `${sizeInWords(images.maxBytesPerImage)} per image. Use a smaller picture.`
        );
      },
    }),
    z.refine(
      (files) =>
        files.reduce((total, entry) => total + sizeOf(entry), 0) <= images.maxBytesPerRequest,
      {
        error:
          `The images add up to more than this project's limit of ` +
          `${sizeInWords(images.maxBytesPerRequest)} per request. Send fewer or smaller pictures.`,
      },
    ),
  );
  return z.object({ request, image });
}

/** A multipart body, parsed and checked: the text of the `request` part and the image files in order. */
export type Multipart = { text: string; files: readonly File[] };

/**
 * How many parts the body has, counted from the delimiter lines `--boundary`
 * at the start of a line, stopping once the count passes `limit`. A delimiter
 * counts only when the line ends after it, allowing the spaces and tabs RFC
 * 2046 5.1.1 calls transport padding, so a line of file content that merely
 * starts with the boundary (`--boundaryX`) is not a part. The closing
 * delimiter (`--boundary--`) is not a part either. A delimiter on the body's
 * last line, with no line break after it, still counts: over-counting a
 * malformed body only refuses it sooner.
 *
 * It scans for line feeds with the native `indexOf`, which is fast even in a
 * binary body, and never parses a part. The count is a bound for refusing
 * floods, not a parse: a body whose parts are really split another way is
 * still checked by `formData()`.
 */
export function countParts(bytes: Uint8Array, boundary: string, limit: number): number {
  const marker = new TextEncoder().encode(`--${boundary}`);
  const startsWithMarker = (offset: number): boolean =>
    offset + marker.length <= bytes.length && marker.every((b, i) => bytes[offset + i] === b);
  const endsLineAt = (start: number): boolean => {
    let at = start;
    while (bytes[at] === 0x20 || bytes[at] === 0x09) at += 1;
    if (at >= bytes.length) return true;
    return bytes[at] === 0x0a || (bytes[at] === 0x0d && bytes[at + 1] === 0x0a);
  };
  const opensPartAt = (offset: number): boolean =>
    startsWithMarker(offset) && endsLineAt(offset + marker.length);

  let parts = 0;
  let offset = 0;
  while (parts <= limit) {
    if (opensPartAt(offset)) parts += 1;
    const lineFeed = bytes.indexOf(0x0a, offset);
    if (lineFeed === -1) break;
    offset = lineFeed + 1;
  }
  return parts;
}

/** The refusal for a body with more parts than the provider can use. It does not say how many arrived. */
function tooManyParts(provider: ProviderDescriptor): Refusal {
  const { displayName } = provider;
  const { images } = provider.capabilities;
  return refuse(
    images === false
      ? `The multipart body has too many parts. Send one "request" part and no "image" parts, because ${displayName} evaluates text only.`
      : `The multipart body has too many parts. Send one "request" part and up to ${images.maxCount} "image" parts.`,
  );
}

/**
 * The `request` text and the image files of a multipart body, or the refusal
 * to answer instead. The checks, in order: the Content-Type names a boundary,
 * the delimiter lines do not show more parts than the provider can use, the
 * body parses, no part has a name other than `request` and `image`, and
 * the schema accepts the parts for this provider.
 */
export async function readMultipart(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  provider: ProviderDescriptor,
): Promise<({ ok: true } & Multipart) | Refusal> {
  const boundary = BOUNDARY_VALUE.exec(contentType);
  const boundaryText = boundary?.[1] ?? boundary?.[2];
  if (boundaryText === undefined || boundaryText === "") return refuse(MISSING_BOUNDARY);

  const maxParts =
    1 + (provider.capabilities.images === false ? 0 : provider.capabilities.images.maxCount);
  if (
    countParts(bytes, boundaryText, maxParts + EXTRA_PARTS_ALLOWANCE) >
    maxParts + EXTRA_PARTS_ALLOWANCE
  ) {
    return tooManyParts(provider);
  }

  let form: FormData;
  try {
    form = await new Response(bytes, { headers: { "content-type": contentType } }).formData();
  } catch {
    return refuse(UNREADABLE);
  }

  const names = new Set(form.keys());
  if ([...names].some((name) => name !== "request" && name !== "image")) {
    return refuse('A multipart request may hold only a "request" part and "image" parts.');
  }

  const parsed = multipartSchema(provider).safeParse({
    request: form.getAll("request"),
    image: form.getAll("image"),
  });
  if (!parsed.success) return refuse(parsed.error.issues[0].message);
  // The schema holds one text part and the files, so the casts only restate what it checked.
  const text = parsed.data.request[0] as string;
  // A string is at least as many bytes as it has UTF-16 units, so the cheap test comes first.
  if (
    text.length > TEXT_ALLOWANCE_BYTES ||
    new TextEncoder().encode(text).byteLength > TEXT_ALLOWANCE_BYTES
  ) {
    return { ok: false, response: tooLarge() };
  }
  return { ok: true, text, files: parsed.data.image };
}

// ---------------------------------------------------------------------------
// The real format, from the first bytes
// ---------------------------------------------------------------------------

// `detectMediaType` lives in `src/providers/image-bytes.ts`, because the browser
// runs the same check for early feedback (issue #16). This check is the one that counts.

/**
 * The base64 text of `bytes` on one line. Workers has the native
 * `Uint8Array.prototype.toBase64`, which spike #1 measured as the faster of
 * the two encoders it tried (`docs/spikes/worker-toolchain.md`, "Base64 and
 * multipart"). Node's V8 before version 25 lacks it, and the Node dev host
 * runs this same code, so there the text is built from `btoa` in slices, which
 * keeps each argument list short.
 */
export function encodeBase64(bytes: Uint8Array): string {
  // Typed as optional on purpose: this file is compiled for Node too, and a browser may lack the method.
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  const slice = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += slice) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + slice));
  }
  return btoa(binary);
}

/** The accepted formats as a sentence fragment: `image/png, image/jpeg, or image/webp`. */
function listOf(mediaTypes: readonly string[]): string {
  if (mediaTypes.length <= 1) return mediaTypes.join("");
  return `${mediaTypes.slice(0, -1).join(", ")}, or ${mediaTypes.at(-1)}`;
}

/**
 * The images as the neutral request carries them, in the order they arrived,
 * or a 400 for the first image whose bytes are not an accepted format.
 *
 * Every image's format is checked from its first twelve bytes before any image
 * is read in full, so a bad image costs no encoding. Each accepted file is then
 * read, encoded once, and let go before the next, so the Worker holds one
 * file's bytes and the base64 strings so far, never every file's bytes too.
 */
export async function encodeImages(
  files: readonly File[],
  images: ImageCapabilities,
): Promise<{ ok: true; images: ImageAttachment[] } | Refusal> {
  const mediaTypes: string[] = [];
  for (const [index, file] of files.entries()) {
    const head = new Uint8Array(await file.slice(0, SIGNATURE_BYTES).arrayBuffer());
    const mediaType = detectMediaType(head);
    if (mediaType === undefined || !images.mediaTypes.includes(mediaType)) {
      return refuse(
        `${imageLabel(index)} is not ${listOf(images.mediaTypes)}, judging by its first bytes. ` +
          "The type the upload declares is ignored.",
      );
    }
    mediaTypes.push(mediaType);
  }

  const attachments: ImageAttachment[] = [];
  for (const [index, file] of files.entries()) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    attachments.push({
      mediaType: mediaTypes[index] as string,
      base64: encodeBase64(bytes),
      byteLength: bytes.byteLength,
    });
  }
  return { ok: true, images: attachments };
}
