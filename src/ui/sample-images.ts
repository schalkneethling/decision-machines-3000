import type { SampleImage } from "../decision/examples.ts";

/**
 * Fetches an example set's sample pictures as the `File`s the image control's
 * `add` takes, in the set's order. Each file carries the sample's name, which
 * the control lists and the model's label uses, and its media type, which the
 * control checks again from the bytes. All or nothing: one picture that cannot
 * be fetched rejects the whole load, so the panel can stay as it is.
 */
export async function fetchSampleImages(images: readonly SampleImage[]): Promise<File[]> {
  return Promise.all(
    images.map(async (image) => {
      const response = await fetch(image.url);
      if (!response.ok) {
        throw new Error(`${image.name} answered HTTP ${response.status}.`);
      }
      return new File([await response.blob()], image.name, { type: image.mediaType });
    }),
  );
}
