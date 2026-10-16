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

import { PROVIDERS } from "../src/providers/catalog.ts";
import { failure } from "./respond.ts";

/**
 * Room for the images of one request: the largest `maxBytesPerRequest` any
 * provider in the catalog accepts, 64 KiB today (the project's own cap, issue
 * #15, lowered from 2 MiB after a CPU measurement on Cloudflare; the reason is
 * in `src/providers/catalog.ts`). Read from the catalog, so a provider with a
 * larger cap widens the limit without a second edit. The new cap still has to
 * be confirmed by reading `cpuTime` from `wrangler tail` on a deployment (see
 * `scenarios/15-server-images.feature`).
 */
export const IMAGE_ALLOWANCE_BYTES = Math.max(
  0,
  ...Object.values(PROVIDERS).map(({ capabilities }) =>
    capabilities.images === false ? 0 : capabilities.images.maxBytesPerRequest,
  ),
);

/**
 * Room for the request's JSON text: 256 KiB, the cap the old `/api/jev`
 * middleware applied (`MAX_BODY_BYTES` in the deleted `server/jev-api.ts`).
 */
export const TEXT_ALLOWANCE_BYTES = 256 * 1024;

/**
 * Room for the multipart framing around those parts: the boundary lines and
 * each part's headers, which include a file name the client chooses. Without
 * it, a request that holds exactly the images and text the limits allow would
 * be refused for its wrapping alone. 16 KiB covers eight image parts with
 * file names of several hundred characters.
 */
export const FRAMING_ALLOWANCE_BYTES = 16 * 1024;

/**
 * The largest multipart body read: the text, image, and framing allowances
 * together. A JSON body has no images or framing, so it is held to
 * `TEXT_ALLOWANCE_BYTES` alone, and so is the `request` part of a multipart one.
 */
export const MAX_BODY_BYTES =
  TEXT_ALLOWANCE_BYTES + IMAGE_ALLOWANCE_BYTES + FRAMING_ALLOWANCE_BYTES;

/** A size in binary units, written KB and MB, as the wire record's image placeholders are. */
export function sizeInWords(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes >= 1 ? `${mebibytes} MB` : `${bytes / 1024} KB`;
}

export const TOO_LARGE_MESSAGE =
  `The request is too large. The request text may hold up to ${sizeInWords(TEXT_ALLOWANCE_BYTES)}, ` +
  `and a multipart request may add up to ${sizeInWords(IMAGE_ALLOWANCE_BYTES)} of images. ` +
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

/** The 413 for a body over its limit: `MAX_BODY_BYTES`, or `TEXT_ALLOWANCE_BYTES` for JSON text. */
export function tooLarge(): Response {
  return failure(413, TOO_LARGE_MESSAGE);
}
