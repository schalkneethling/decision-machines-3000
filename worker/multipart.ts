/**
 * Reading a `multipart/form-data` decision request: one `request` part that
 * holds the JSON text, and one `image` part per picture, each a binary file.
 *
 * The work happens in three steps, so the cheap checks come first and the
 * expensive one last:
 *
 * 1. `readMultipart` parses the body and checks its shape and its declared
 *    sizes against the provider's `capabilities.images` with one Zod Mini
 *    schema (ADR-0004). Nothing is read from a file yet.
 * 2. `encodeImages`, called after the JSON part has passed validation, reads
 *    each file's first bytes to find its real format, then reads the bytes and
 *    encodes them to base64 once. A format the file's bytes do not show is
 *    refused, whatever the part declared.
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
import type { ImageCapabilities, ProviderDescriptor } from "../src/providers/catalog.ts";
import { sizeInWords } from "./body-limit.ts";
import type { ImageAttachment } from "./decide.ts";
import { failure } from "./respond.ts";

/** The answer to send instead of reading on. */
export type Refusal = { ok: false; response: Response };

/** A 400 with `error`, as a `Refusal`. */
function refuse(error: string): Refusal {
  return { ok: false, response: failure(400, error) };
}

const BOUNDARY_PARAMETER = /;\s*boundary\s*=\s*[^;\s]/i;

const MISSING_BOUNDARY =
  'The multipart Content-Type has no "boundary" parameter, so the body cannot be split into parts. ' +
  "Leave Content-Type for the client to set, because a hand-set header drops the boundary.";

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
 * The `request` text and the image files of a multipart body, or the refusal
 * to answer instead. The checks, in order: the Content-Type names a boundary,
 * the body parses, no part has a name other than `request` and `image`, and
 * the schema accepts the parts for this provider.
 */
export async function readMultipart(
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string,
  provider: ProviderDescriptor,
): Promise<({ ok: true } & Multipart) | Refusal> {
  if (!BOUNDARY_PARAMETER.test(contentType)) return refuse(MISSING_BOUNDARY);

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
  return { ok: true, text: parsed.data.request[0] as string, files: parsed.data.image };
}

// ---------------------------------------------------------------------------
// The real format, from the first bytes
// ---------------------------------------------------------------------------

/** The most bytes any signature below needs: `RIFF`, four size bytes, then `WEBP`. */
const SIGNATURE_BYTES = 12;

/** True when `bytes` holds `expected` starting at `offset`. */
function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return expected.every((value, index) => bytes[offset + index] === value);
}

/** `RIFF` and `WEBP` as bytes. */
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP = [0x57, 0x45, 0x42, 0x50];

/**
 * The media type the first bytes of an image show, or undefined when they
 * match none of PNG, JPEG, or WebP. The declared type is never consulted.
 * PNG is checked against its whole eight-byte signature, which is stricter
 * than the four bytes issue #15 names and just as cheap.
 */
export function detectMediaType(bytes: Uint8Array): string | undefined {
  if (hasBytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (hasBytesAt(bytes, 0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (hasBytesAt(bytes, 0, RIFF) && hasBytesAt(bytes, 8, WEBP)) {
    return "image/webp";
  }
  return undefined;
}

/**
 * The base64 text of `bytes` on one line. Workers has the native
 * `Uint8Array.prototype.toBase64`, which spike #1 measured as the faster of
 * the two encoders it tried (`docs/spikes/worker-toolchain.md`, "Base64 and
 * multipart"). Node's V8 before version 25 lacks it, and the Node dev host
 * runs this same code, so there the text is built from `btoa` in slices, which
 * keeps each argument list short.
 */
export function encodeBase64(bytes: Uint8Array): string {
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
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
