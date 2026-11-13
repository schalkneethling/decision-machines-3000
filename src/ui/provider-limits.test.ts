import { describe, expect, it } from "vite-plus/test";
import { PROVIDERS } from "../providers/catalog.ts";
import type { ImageCapabilities } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import {
  imageProviders,
  providerNames,
  strictestCapabilities,
  strictestImages,
  textOnlyProviders,
} from "./provider-limits.ts";

const typesafe = toProviderSummary(PROVIDERS.typesafe);
const subq = toProviderSummary(PROVIDERS.subq);
const openai = toProviderSummary(PROVIDERS.openai);

const images = (overrides: Partial<ImageCapabilities>): ImageCapabilities => ({
  maxCount: 8,
  maxBytesPerImage: 64,
  maxBytesPerRequest: 128,
  mediaTypes: ["image/png", "image/jpeg", "image/webp"],
  ...overrides,
});

describe("strictestImages", () => {
  it("takes the fewest images, the smallest caps, and only the formats every provider accepts", () => {
    expect(
      strictestImages([
        images({ maxCount: 4, maxBytesPerRequest: 256 }),
        images({ maxBytesPerImage: 32, mediaTypes: ["image/png", "image/webp"] }),
      ]),
    ).toEqual({
      maxCount: 4,
      maxBytesPerImage: 32,
      maxBytesPerRequest: 128,
      mediaTypes: ["image/png", "image/webp"],
    });
  });

  it("refuses an empty list, which has no limits to take", () => {
    expect(() => strictestImages([])).toThrow();
  });
});

describe("strictestCapabilities", () => {
  it("returns one provider's own limits unchanged", () => {
    expect(strictestCapabilities([subq])).toEqual(subq.capabilities);
  });

  it("narrows every range to what all the providers allow", () => {
    const loose: ProviderSummary = {
      ...subq,
      capabilities: {
        ...subq.capabilities,
        choiceOptions: { min: 1 },
        scoreLevels: { min: 1, max: 20 },
      },
    };
    const tight: ProviderSummary = {
      ...openai,
      capabilities: {
        ...openai.capabilities,
        choiceOptions: { min: 2, max: 5 },
        scoreLevels: { min: 3, max: 6 },
        questionNameMaxLength: 40,
      },
    };
    const strictest = strictestCapabilities([loose, tight]);
    expect(strictest.choiceOptions).toEqual({ min: 2, max: 5 });
    expect(strictest.scoreLevels).toEqual({ min: 3, max: 6 });
    expect(strictest.questionNameMaxLength).toBe(40);
  });

  it("judges images only by the providers that take them, and is false only when none does", () => {
    expect(strictestCapabilities([typesafe, subq]).images).toEqual(subq.capabilities.images);
    expect(strictestCapabilities([typesafe]).images).toBe(false);
  });
});

describe("the provider lists", () => {
  it("splits the providers by images, in order, and names them as a sentence does", () => {
    const all = [typesafe, subq, openai];
    expect(imageProviders(all)).toEqual([subq, openai]);
    expect(textOnlyProviders(all)).toEqual([typesafe]);
    expect(providerNames(all)).toBe("TypeSafe Jev, SubQ Snap, and OpenAI Decisions");
    expect(providerNames([subq])).toBe("SubQ Snap");
  });
});
