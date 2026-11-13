import { describe, expect, it } from "vite-plus/test";
import { encodeBase64 } from "./base64.ts";

describe("encodeBase64", () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
  // Built one character at a time, so it shares no slicing with the code under test.
  const expected = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

  it("encodes a known value", () => {
    expect(encodeBase64(new TextEncoder().encode("Hello"))).toBe("SGVsbG8=");
  });

  it("matches a one-character-at-a-time encoding on the btoa path used where the native encoder is missing", () => {
    const prototype = Uint8Array.prototype as { toBase64?: unknown };
    const original = Object.getOwnPropertyDescriptor(prototype, "toBase64");
    delete prototype.toBase64;
    try {
      expect(encodeBase64(bytes)).toBe(expected);
    } finally {
      if (original !== undefined) Object.defineProperty(prototype, "toBase64", original);
    }
  });

  it("uses the native encoder when the runtime has one", () => {
    const prototype = Uint8Array.prototype as { toBase64?: unknown };
    const original = Object.getOwnPropertyDescriptor(prototype, "toBase64");
    Object.defineProperty(prototype, "toBase64", {
      configurable: true,
      value: () => "native",
    });
    try {
      expect(encodeBase64(bytes)).toBe("native");
    } finally {
      if (original === undefined) delete prototype.toBase64;
      else Object.defineProperty(prototype, "toBase64", original);
    }
  });
});
