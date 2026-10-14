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

import { MAX_IMAGE_REQUEST_BYTES } from "../src/providers/catalog.ts";
import { failure } from "./respond.ts";

/**
 * Room for the images of one request: the project's own cap of 2 MiB of
 * images per request, recorded on issue #15 and held in the catalog as
 * `MAX_IMAGE_REQUEST_BYTES`. Issue #15 confirms this budget by measurement
 * once images are sent.
 */
export const IMAGE_ALLOWANCE_BYTES = MAX_IMAGE_REQUEST_BYTES;

/**
 * Room for the request's JSON text: 256 KiB, the cap the old `/api/jev`
 * middleware applied (`MAX_BODY_BYTES` in the deleted `server/jev-api.ts`).
 */
export const TEXT_ALLOWANCE_BYTES = 256 * 1024;

/** The largest body read: the text allowance plus the image allowance, 2.25 MiB. */
export const MAX_BODY_BYTES = TEXT_ALLOWANCE_BYTES + IMAGE_ALLOWANCE_BYTES;

/** A size in binary units, written KB and MB, as the wire record's image placeholders are. */
function sizeInWords(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes >= 1 ? `${mebibytes} MB` : `${bytes / 1024} KB`;
}

export const TOO_LARGE_MESSAGE =
  `The request is too large. It may hold up to ${sizeInWords(TEXT_ALLOWANCE_BYTES)} of text ` +
  `and ${sizeInWords(IMAGE_ALLOWANCE_BYTES)} of images, ${sizeInWords(MAX_BODY_BYTES)} in all. ` +
  'Trim "state" or ask fewer questions.';

/**
 * The length a Content-Length header declares, or undefined when there is no
 * header or it is not a plain decimal number.
 */
export function declaredLength(header: string | null | undefined): number | undefined {
  return header !== null && header !== undefined && /^\d+$/.test(header)
    ? Number(header)
    : undefined;
}

/** The 413 for a body over `MAX_BODY_BYTES`. */
export function tooLarge(): Response {
  return failure(413, TOO_LARGE_MESSAGE);
}
