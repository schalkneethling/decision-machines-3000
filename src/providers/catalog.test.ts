import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_REQUEST_BYTES,
  PROVIDERS,
  openai,
  subq,
  typesafe,
} from "./catalog.ts";
import type { ProviderDescriptor } from "./catalog.ts";

const srcRoot = join(import.meta.dirname, "..");

describe("provider catalog", () => {
  it("pins each provider to its model", () => {
    expect(typesafe.model).toBe("jev-1.13.0");
    expect(subq.model).toBe("subq-snap-preview");
    expect(openai.model).toBe("gpt-6-luna");
  });

  it("declares the warm path of each provider", () => {
    expect(typesafe.warmPath).toBe("/v1/models");
    expect(subq.warmPath).toBe("/v1/models");
    expect(openai.warmPath).toBe("/v1/models/gpt-6-luna");
  });

  it("accepts a descriptor with no warm path", () => {
    const bare: ProviderDescriptor = {
      id: typesafe.id,
      displayName: typesafe.displayName,
      model: typesafe.model,
      capabilities: typesafe.capabilities,
    };
    expect("warmPath" in bare).toBe(false);
  });

  it("gives every provider 255 choice options and 2 to 10 score levels", () => {
    for (const { capabilities } of Object.values(PROVIDERS)) {
      expect(capabilities.choiceOptions).toEqual({ min: 2, max: 255 });
      expect(capabilities.scoreLevels).toEqual({ min: 2, max: 10 });
    }
  });

  it("limits question names on SubQ only", () => {
    expect(subq.capabilities.questionNameMaxLength).toBe(100);
    expect(typesafe.capabilities.questionNameMaxLength).toBeUndefined();
    expect(openai.capabilities.questionNameMaxLength).toBeUndefined();
  });

  it("accepts no images on TypeSafe and caps them at 2 MiB on SubQ and OpenAI", () => {
    expect(typesafe.capabilities.images).toBe(false);
    expect(MAX_IMAGE_BYTES).toBe(2 * 1024 * 1024);
    expect(MAX_IMAGE_REQUEST_BYTES).toBe(2 * 1024 * 1024);
    expect(subq.capabilities.images).toEqual({
      maxCount: 4,
      maxBytesPerImage: MAX_IMAGE_BYTES,
      maxBytesPerRequest: MAX_IMAGE_REQUEST_BYTES,
      mediaTypes: ["image/png", "image/jpeg", "image/webp"],
    });
    expect(openai.capabilities.images).toMatchObject({
      maxCount: 8,
      maxBytesPerImage: MAX_IMAGE_BYTES,
      maxBytesPerRequest: MAX_IMAGE_REQUEST_BYTES,
    });
  });

  it("keys each descriptor by its own id and gives it a display name", () => {
    for (const [id, descriptor] of Object.entries(PROVIDERS)) {
      expect(descriptor.id).toBe(id);
      expect(descriptor.displayName).not.toBe("");
    }
  });

  it("is the only source file under src that names TypeSafe or Jev in a string the UI renders", () => {
    const pattern = /Jev|TypeSafe/;
    const offenders = readdirSync(srcRoot, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /\.(ts|css)$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith("catalog.ts"))
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .some(
            (line) => pattern.test(line) && /["'`]/.test(line) && !/^\s*(\/?\*|\/\/)/.test(line),
          ),
      );
    expect(offenders).toEqual([]);
  });
});
