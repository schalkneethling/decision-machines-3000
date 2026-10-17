import type { SampleImage } from "../decision/examples.ts";

/** How long one sample picture may take to arrive. They are about a kilobyte each and served by the page's own origin. */
export const SAMPLE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Fetches an example set's sample pictures as the `File`s the image control's
 * `replace` takes, in the set's order. Each file carries the sample's name, which
 * the control lists and the model's label uses, and its media type, which the
 * control checks again from the bytes. All or nothing: one picture that cannot
 * be fetched rejects the whole load, so the panel can stay as it is.
 * A picture that has not arrived within `SAMPLE_FETCH_TIMEOUT_MS` counts as
 * one that cannot be fetched, because the panel takes no other load until
 * this one ends.
 */
export async function fetchSampleImages(images: readonly SampleImage[]): Promise<File[]> {
  return Promise.all(
    images.map(async (image) => {
      const response = await fetch(image.url, {
        signal: AbortSignal.timeout(SAMPLE_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${image.name} answered HTTP ${response.status}.`);
      }
      return new File([await response.blob()], image.name, { type: image.mediaType });
    }),
  );
}
