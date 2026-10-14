import { describe, expect, it } from "vite-plus/test";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_REQUEST_BYTES,
  PROVIDERS,
  PROVIDER_ORDER,
  openai,
  subq,
  typesafe,
} from "./catalog.ts";

describe("provider catalog", () => {
  it("declares the warm path of each provider", () => {
    expect(typesafe.warmPath).toBe("/v1/models");
    expect(subq.warmPath).toBe("/v1/models");
    expect(openai.warmPath).toBe("/v1/models/gpt-6-luna");
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

  it("lists every provider once in an explicit order", () => {
    expect(PROVIDER_ORDER).toEqual(["typesafe", "subq", "openai"]);
    expect([...PROVIDER_ORDER].sort()).toEqual(Object.keys(PROVIDERS).sort());
  });

  it("gives each provider the HTTPS origin its paths resolve against", () => {
    expect(typesafe.baseUrl).toBe("https://api.typesafe.ai");
    expect(subq.baseUrl).toBe("https://api.subq.ai");
    expect(openai.baseUrl).toBe("https://api.openai.com");
    for (const { baseUrl } of Object.values(PROVIDERS)) {
      expect(new URL(baseUrl).origin).toBe(baseUrl);
    }
  });

  it("builds OpenAI's warm path from its model", () => {
    expect(openai.warmPath).toBe(`/v1/models/${openai.model}`);
  });

  it("keys each descriptor by its own id and gives it a display name", () => {
    for (const [id, descriptor] of Object.entries(PROVIDERS)) {
      expect(descriptor.id).toBe(id);
      expect(descriptor.displayName).not.toBe("");
    }
  });
});
