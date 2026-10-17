import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import {
  PNG_SIGNATURE,
  SAMPLE_IMAGES_DIRECTORY,
  SAMPLE_PICTURES,
  rasterise,
} from "../../scripts/sample-images.ts";
import type { SamplePicture } from "../../scripts/sample-images.ts";
import { PROVIDER_ORDER, PROVIDERS } from "../providers/catalog.ts";
import type { ImageCapabilities, ProviderDescriptor } from "../providers/catalog.ts";
import { detectMediaType, imageDimensions } from "../providers/image-bytes.ts";
import {
  EXAMPLE_SET_IDS,
  EXAMPLE_SETS,
  choiceExample,
  filmExamples,
  imageExamples,
  noulExample,
  scoreExample,
} from "./examples.ts";
import { PRIMITIVES, validateDecisionRequest } from "./validate.ts";

const examplesDirectory = join(import.meta.dirname, "examples");
const imagesDirectory = join(import.meta.dirname, "..", "..", SAMPLE_IMAGES_DIRECTORY);

/** Every example request, named "film noul", "images choice", and so on. */
const requests = Object.values(EXAMPLE_SETS).flatMap((set) =>
  PRIMITIVES.map((primitive) => [`${set.id} ${primitive}`, set.requests[primitive]] as const),
);

/** The providers that take images, with their limits. */
const imageProviders = PROVIDER_ORDER.map((id) => PROVIDERS[id]).flatMap(
  (provider): [ProviderDescriptor, ImageCapabilities][] =>
    provider.capabilities.images === false ? [] : [[provider, provider.capabilities.images]],
);

function sampleBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(imagesDirectory, name)));
}

describe("the example files", () => {
  it("are the JSON files under examples/, one per set and primitive, and nothing else", () => {
    const files = EXAMPLE_SET_IDS.flatMap((set) =>
      readdirSync(join(examplesDirectory, set))
        .filter((name) => name.endsWith(".json"))
        .map((name) => `${set}/${name}`),
    );
    expect(files.sort()).toEqual(
      EXAMPLE_SET_IDS.flatMap((set) =>
        PRIMITIVES.map((primitive) => `${set}/${primitive}.json`),
      ).sort(),
    );
  });

  it.each(requests)("%s is a valid request for every provider", (_name, request) => {
    for (const id of PROVIDER_ORDER) {
      const result = validateDecisionRequest(request, PROVIDERS[id].capabilities);
      expect(result).toEqual({ ok: true, value: request });
    }
  });

  it.each(EXAMPLE_SET_IDS)("the %s set's files validate exactly as loaded from disk", (set) => {
    for (const primitive of PRIMITIVES) {
      const raw: unknown = JSON.parse(
        readFileSync(join(examplesDirectory, set, `${primitive}.json`), "utf8"),
      );
      for (const id of PROVIDER_ORDER) {
        const result = validateDecisionRequest(raw, PROVIDERS[id].capabilities);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.value).toStrictEqual(EXAMPLE_SETS[set].requests[primitive]);
      }
      expect(EXAMPLE_SETS[set].requests[primitive].primitive).toBe(primitive);
    }
  });

  it("keeps the film requests under their long-standing names", () => {
    expect(noulExample).toBe(filmExamples.requests.noul);
    expect(choiceExample).toBe(filmExamples.requests.choice);
    expect(scoreExample).toBe(filmExamples.requests.score);
    expect(filmExamples.images).toEqual([]);
  });

  it("names image 1 to image 4 in the image set, and nothing beyond the pictures it attaches", () => {
    const count = imageExamples.images.length;
    for (const primitive of PRIMITIVES) {
      const text = JSON.stringify(imageExamples.requests[primitive]);
      for (let number = 1; number <= count; number += 1) {
        expect(text).toContain(`image ${number}`);
      }
      expect(text).not.toContain(`image ${count + 1}`);
    }
  });
});

describe("the sample images", () => {
  it("are the PNG files beside the image set, in the set's order, each with a URL to fetch", () => {
    const onDisk = readdirSync(imagesDirectory)
      .filter((name) => name.endsWith(".png"))
      .sort();
    expect(imageExamples.images.map((image) => image.name).sort()).toEqual(onDisk);
    expect(imageExamples.images.map((image) => image.name)).toEqual(
      SAMPLE_PICTURES.map((picture) => picture.name),
    );
    for (const image of imageExamples.images) {
      expect(image.mediaType).toBe("image/png");
      expect(image.url).not.toBe("");
    }
  });

  it("are PNGs by their first bytes, of the size the generator draws", () => {
    for (const picture of SAMPLE_PICTURES) {
      const bytes = sampleBytes(picture.name);
      expect(bytes.subarray(0, PNG_SIGNATURE.length)).toEqual(PNG_SIGNATURE);
      expect(detectMediaType(bytes)).toBe("image/png");
      expect(imageDimensions(bytes, "image/png")).toEqual({
        width: picture.width,
        height: picture.height,
      });
    }
  });

  it.each(imageProviders)(
    "fit %s's caps: each under the per-image cap, all under the per-request cap, and no more than the count",
    (_provider, images) => {
      const sizes = imageExamples.images.map((image) => sampleBytes(image.name).length);
      for (const size of sizes) {
        // "Well under": at most half the cap, so a redrawn picture cannot creep up to it.
        expect(size).toBeLessThanOrEqual(images.maxBytesPerImage / 2);
      }
      const total = sizes.reduce((sum, size) => sum + size, 0);
      expect(total).toBeLessThanOrEqual(images.maxBytesPerRequest / 2);
      expect(sizes.length).toBeLessThanOrEqual(images.maxCount);
    },
  );

  /** The scanlines a committed PNG holds: its IDAT chunks' data, inflated. */
  function committedScanlines(name: string): Uint8Array {
    const bytes = sampleBytes(name);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const data: Uint8Array[] = [];
    let offset = PNG_SIGNATURE.length;
    while (offset < bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (type === "IDAT") data.push(bytes.subarray(offset + 8, offset + 8 + length));
      offset += 12 + length;
    }
    return new Uint8Array(inflateSync(Buffer.concat(data)));
  }

  it.each(SAMPLE_PICTURES.map((picture): [string, SamplePicture] => [picture.name, picture]))(
    "%s holds exactly the pixels scripts/sample-images.ts draws",
    (name, picture) => {
      expect(committedScanlines(name)).toEqual(rasterise(picture));
    },
  );

  it("draws four clearly different pictures: three single shapes on white and one busy scene", () => {
    const [square, circle, triangle, busy] = SAMPLE_PICTURES;
    expect(square?.shapes.map((shape) => shape.kind)).toEqual(["square"]);
    expect(circle?.shapes.map((shape) => shape.kind)).toEqual(["circle"]);
    expect(triangle?.shapes.map((shape) => shape.kind)).toEqual(["triangle"]);
    expect(busy?.shapes.length).toBeGreaterThan(3);
    for (const picture of [square, circle, triangle])
      expect(picture?.background).toEqual([255, 255, 255]);
  });
});
