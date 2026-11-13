/**
 * The largest request body `POST /api/decide/{provider}` reads, and the 413
 * both hosts send for a larger one. The Worker's route (`decide.ts`) and the
 * Node dev host (`server/vite-host.ts`) both take the limit and the answer
 * from here, so the two hosts cannot drift.
 *
 * The limit is what one request legitimately needs, not what the platform
 * allows. Cloudflare accepts 100 MB (docs/spikes/worker-toolchain.md, line
 * 49), but a body that size cannot be held in a 128 MB isolate, and reading
 * it costs far more CPU than the Free plan's 10 ms.
 */

import { sizeInWords } from "../src/providers/byte-size.ts";
import { PROVIDERS } from "../src/providers/catalog.ts";
import { failure } from "./respond.ts";

/**
 * Room for the images of one request, as decoded bytes: the largest
 * `maxBytesPerRequest` any provider in the catalog accepts (the project's own
 * cap; the reason is in `src/providers/catalog.ts`). Read from the catalog, so
 * a provider with a larger cap widens the limit without a second edit. A new
 * cap has to be confirmed by reading `cpuTime` from `wrangler tail` on a
 * deployment (see `scenarios/15-server-images.feature`).
 */
export const IMAGE_ALLOWANCE_BYTES = Math.max(
  0,
  ...Object.values(PROVIDERS).map(({ capabilities }) =>
    capabilities.images === false ? 0 : capabilities.images.maxBytesPerRequest,
  ),
);

/** The length of the base64 text for `bytes` bytes: four characters for every three bytes, padded. */
export function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/**
 * Room for the images as the body carries them: base64 text, a third larger
 * than the bytes it encodes.
 */
export const IMAGE_TEXT_ALLOWANCE_BYTES = base64Length(IMAGE_ALLOWANCE_BYTES);

/**
 * Room for the request's JSON text, everything except the images' base64:
 * 256 KiB, the cap the old `/api/jev` middleware applied (`MAX_BODY_BYTES` in
 * the deleted `server/jev-api.ts`).
 */
export const TEXT_ALLOWANCE_BYTES = 256 * 1024;

/**
 * Room for the JSON around each image: its braces, keys, and a name the client
 * chooses. Without it, a request that holds exactly the text and images the
 * limits allow would be refused for its wrapping alone. 64 KiB covers eight
 * images whose names are the longest the route reads (`MAX_NAME_CHARACTERS` in
 * `images.ts`, 1,024 characters) even when every character is written as a
 * six-byte `\u` escape.
 */
export const FRAMING_ALLOWANCE_BYTES = 64 * 1024;

/** The largest body read: the text, image, and framing allowances together. */
export const MAX_BODY_BYTES =
  TEXT_ALLOWANCE_BYTES + IMAGE_TEXT_ALLOWANCE_BYTES + FRAMING_ALLOWANCE_BYTES;

export const TOO_LARGE_MESSAGE =
  `The request is too large. The request text may hold up to ${sizeInWords(TEXT_ALLOWANCE_BYTES)}, ` +
  `and its images may add up to ${sizeInWords(IMAGE_ALLOWANCE_BYTES)}. ` +
  'Trim "state", ask fewer questions, or send smaller images.';

/**
 * The length a Content-Length header declares, or undefined when there is no
 * header or it is not a plain decimal number.
 */
export function declaredLength(header: string | null | undefined): number | undefined {
  return header !== null && header !== undefined && /^\d+$/.test(header)
    ? Number(header)
    : undefined;
}

/** The 413 for a body over `MAX_BODY_BYTES`, or whose text without the images is over `TEXT_ALLOWANCE_BYTES`. */
export function tooLarge(): Response {
  return failure(413, TOO_LARGE_MESSAGE);
}
