import { describe, expect, it } from "vite-plus/test";
import { PROVIDERS, PROVIDER_ORDER, openai, subq } from "./catalog.ts";
import type { ProviderDescriptor } from "./catalog.ts";
import { toProviderSummary } from "./contract.ts";

/** Every object key in a value, as dotted paths, so a stray field anywhere shows up. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    return [path, ...keyPaths(child, path)];
  });
}

describe("toProviderSummary", () => {
  it("copies exactly the public fields of a summary and of its capabilities", () => {
    const summary = toProviderSummary(openai);

    expect(Object.keys(summary).sort()).toEqual(["capabilities", "displayName", "id", "model"]);
    expect(Object.keys(summary.capabilities).sort()).toEqual([
      "choiceOptions",
      "images",
      "scoreLevels",
    ]);
    expect(keyPaths(summary).sort()).toEqual([
      "capabilities",
      "capabilities.choiceOptions",
      "capabilities.choiceOptions.max",
      "capabilities.choiceOptions.min",
      "capabilities.images",
      "capabilities.images.maxBytesPerImage",
      "capabilities.images.maxBytesPerRequest",
      "capabilities.images.maxCount",
      "capabilities.images.mediaTypes",
      "capabilities.scoreLevels",
      "capabilities.scoreLevels.max",
      "capabilities.scoreLevels.min",
      "displayName",
      "id",
      "model",
    ]);
  });

  it("carries the question-name limit only for a provider that has one", () => {
    expect(Object.keys(toProviderSummary(subq).capabilities)).toContain("questionNameMaxLength");
    expect(Object.keys(toProviderSummary(openai).capabilities)).not.toContain(
      "questionNameMaxLength",
    );
  });

  it("keeps every catalog value", () => {
    for (const id of PROVIDER_ORDER) {
      const descriptor = PROVIDERS[id];
      expect(toProviderSummary(descriptor)).toEqual({
        id: descriptor.id,
        displayName: descriptor.displayName,
        model: descriptor.model,
        capabilities: descriptor.capabilities,
      });
    }
  });

  it("drops a server-only field added anywhere in a descriptor", () => {
    // Simulates a later catalog change that adds fields the browser must not get.
    const extended = {
      ...subq,
      apiBase: "https://internal.example",
      capabilities: {
        ...subq.capabilities,
        upstreamQuota: 7,
        choiceOptions: { ...subq.capabilities.choiceOptions, internal: true },
        images: subq.capabilities.images && {
          ...subq.capabilities.images,
          bucket: "private",
        },
      },
    } as ProviderDescriptor;

    const paths = keyPaths(toProviderSummary(extended));

    expect(paths).not.toContain("apiBase");
    expect(paths).not.toContain("warmPath");
    expect(paths).not.toContain("capabilities.upstreamQuota");
    expect(paths).not.toContain("capabilities.choiceOptions.internal");
    expect(paths).not.toContain("capabilities.images.bucket");
  });

  it("copies the media types instead of sharing the catalog's array", () => {
    const summary = toProviderSummary(subq);

    expect(summary.capabilities.images).not.toBe(false);
    if (summary.capabilities.images === false || subq.capabilities.images === false) return;
    expect(summary.capabilities.images.mediaTypes).toEqual(subq.capabilities.images.mediaTypes);
    expect(summary.capabilities.images.mediaTypes).not.toBe(subq.capabilities.images.mediaTypes);
  });
});
