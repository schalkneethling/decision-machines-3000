/**
 * Reading the images of a decision request. The browser encodes each picture to
 * base64 and sends it in the request's JSON, in an `images` list of
 * `{ "name": …, "base64": … }` entries, so the Worker never parses a multipart
 * body or encodes bytes. A CPU measurement on Cloudflare found that reading a
 * multipart body cost more than the Free plan's 10 ms per request long before
 * the encoding did (PR #53), which is what held the image caps at 64 KiB.
 *
 * The base64 text is never scanned, because a pass over megabytes of text costs
 * more CPU than everything else the route does with it:
 *
 * - Each image's decoded size comes from the length of its text and its `=`
 *   padding, so the caps are checked without decoding.
 * - Its real format comes from decoding only the first 16 characters, the 12
 *   bytes `detectMediaType` reads. A format the bytes do not show is refused.
 *   Characters after those are not examined, so text that starts like a PNG and
 *   then holds anything passes here, as a file did before; the provider is the
 *   one that decodes the picture and refuses bad base64.
 * - The text reaches the provider through `JSON.stringify`, which escapes it,
 *   so it cannot change the shape of the provider's request.
 *
 * No message here quotes a name or the base64 text, because the client controls
 * both and Varlock's leak scanner replaces a reply that contains a key's value
 * (see `docs/deploy.md`). Messages name an image by its position ("Image 2") and
 * the limit it broke. The name is cleaned and clipped by `cleanFileName` only
 * so the adapters can label each image for the model (issue #57).
 *
 * Zod Mini APIs used, read from node_modules/zod/v4/mini/schemas.d.ts and
 * checks.d.ts: `array`, `strictObject`, `string`, `exactOptional`, `maxLength`,
 * `refine`, `.check()`, `safeParse`, and the `error` option.
 */

import * as z from "zod/mini";
import { isPlainObject } from "../src/decision/json.ts";
import { sizeInWords } from "../src/providers/byte-size.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import { SIGNATURE_BYTES, detectMediaType } from "../src/providers/image-bytes.ts";
import type { ImageAttachment } from "./decide.ts";
import { cleanFileName } from "./providers/image-labels.ts";
import { failure } from "./respond.ts";

/** The answer to send instead of reading on. */
export type Refusal = { ok: false; response: Response };

/** A 400 with `error`, as a `Refusal`. */
function refuse(error: string): Refusal {
  return { ok: false, response: failure(400, error) };
}

/**
 * The most characters of a name read. The label keeps far fewer
 * (`MAX_FILE_NAME_CHARACTERS`), but cleaning runs a regular expression over the
 * whole name, so a longer one is refused before that work.
 */
export const MAX_NAME_CHARACTERS = 1024;

/** Base64 characters that encode the first `SIGNATURE_BYTES` bytes: 4 characters per 3 bytes. */
const SIGNATURE_CHARACTERS = Math.ceil(SIGNATURE_BYTES / 3) * 4;

/** `Image 2`: how a message names the second image, by position, never by its name. */
function imageLabel(index: number): string {
  return `Image ${index + 1}`;
}

/**
 * How many bytes `base64` decodes to, from its length and its `=` padding alone.
 * Exact for well-formed base64; for anything else it is still bounded by the
 * text's length, so the caps hold whatever the client sends.
 */
export function decodedLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** The bytes the first characters of `base64` decode to, or an empty array when they are not base64. */
function signatureOf(base64: string): Uint8Array {
  try {
    const binary = atob(base64.slice(0, SIGNATURE_CHARACTERS));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

/** The accepted formats as a sentence fragment: `image/png, image/jpeg, or image/webp`. */
function listOf(mediaTypes: readonly string[]): string {
  if (mediaTypes.length <= 1) return mediaTypes.join("");
  return `${mediaTypes.slice(0, -1).join(", ")}, or ${mediaTypes.at(-1)}`;
}

/** The position named in an issue's path, such as `[1, "base64"]`, as "Image 2". */
function imageAt(issue: z.core.$ZodRawIssue): string {
  const index = issue.path?.[0];
  return typeof index === "number" ? imageLabel(index) : "An image";
}

const entry = z.strictObject(
  {
    base64: z.string({
      error: (issue) => `${imageAt(issue)} needs "base64": the picture's bytes as base64 text.`,
    }),
    name: z.exactOptional(
      z.string({ error: (issue) => `The "name" of ${imageAt(issue)} must be text.` }).check(
        z.maxLength(MAX_NAME_CHARACTERS, {
          error: (issue) =>
            `The "name" of ${imageAt(issue)} is longer than ${MAX_NAME_CHARACTERS} characters.`,
        }),
      ),
    ),
  },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `${imageAt(issue)} may hold only "name" and "base64".`
        : `${imageAt(issue)} must be an object with "base64" and an optional "name".`,
  },
);

/** The schema of the `images` list for one provider. The checks run in order, and the first issue is reported. */
function imagesSchema(provider: ProviderDescriptor) {
  const { displayName, capabilities } = provider;
  const images = capabilities.images;
  const list = z.array(entry, { error: `"images" must be a list of images.` });

  if (images === false) {
    return list.check(
      z.refine((entries) => entries.length === 0, {
        error: `${displayName} evaluates text only, so it does not accept images. Remove them and run again.`,
      }),
    );
  }

  return list.check(
    z.refine((entries) => entries.length <= images.maxCount, {
      error: (issue) =>
        `This request has ${(issue.input as unknown[]).length} images. ` +
        `${displayName} takes at most ${images.maxCount} per request in this project.`,
    }),
    z.refine(
      (entries) => entries.every(({ base64 }) => decodedLength(base64) <= images.maxBytesPerImage),
      {
        error: (issue) => {
          const index = (issue.input as { base64: string }[]).findIndex(
            ({ base64 }) => decodedLength(base64) > images.maxBytesPerImage,
          );
          return (
            `${imageLabel(index)} is over this project's limit of ` +
            `${sizeInWords(images.maxBytesPerImage)} per image. Use a smaller picture.`
          );
        },
      },
    ),
    z.refine(
      (entries) =>
        entries.reduce((total, { base64 }) => total + decodedLength(base64), 0) <=
        images.maxBytesPerRequest,
      {
        error:
          `The images add up to more than this project's limit of ` +
          `${sizeInWords(images.maxBytesPerRequest)} per request. Send fewer or smaller pictures.`,
      },
    ),
  );
}

/** A request body with its images taken out and checked: the rest of the request, and the images in order. */
export type TakenImages = { ok: true; request: unknown; images: ImageAttachment[] };

/**
 * Takes the `images` list out of a parsed body and checks it for `provider`:
 * its shape, the count, each image's size and the total, then each image's real
 * format. Returns the body without `images`, for the request validator, and the
 * images as the adapters take them. A body that is not an object, or has no
 * `images`, is returned as it is with no images, and the validator reports on it.
 */
export function takeImages(body: unknown, provider: ProviderDescriptor): TakenImages | Refusal {
  if (!isPlainObject(body) || !Object.hasOwn(body, "images")) {
    return { ok: true, request: body, images: [] };
  }
  const { images: listed, ...request } = body;

  const parsed = imagesSchema(provider).safeParse(listed);
  // A failed parse always has an issue; the fallback only satisfies the type.
  if (!parsed.success) return refuse(parsed.error.issues[0]?.message ?? `"images" is not valid.`);

  const { images } = provider.capabilities;
  if (images === false) return { ok: true, request, images: [] };

  const attachments: ImageAttachment[] = [];
  for (const [index, { base64, name }] of parsed.data.entries()) {
    const mediaType = detectMediaType(signatureOf(base64));
    if (mediaType === undefined || !images.mediaTypes.includes(mediaType)) {
      return refuse(
        `${imageLabel(index)} is not ${listOf(images.mediaTypes)}, judging by its first bytes.`,
      );
    }
    attachments.push({
      mediaType,
      base64,
      byteLength: decodedLength(base64),
      name: cleanFileName(name ?? ""),
    });
  }
  return { ok: true, request, images: attachments };
}
