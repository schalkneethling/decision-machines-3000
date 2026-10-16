import { describe, expect, it } from "vite-plus/test";
import { formatBytes, sizeInWords } from "./byte-size.ts";

describe("formatBytes", () => {
  it("rounds a measured size for reading", () => {
    expect(formatBytes(0)).toBe("0 bytes");
    expect(formatBytes(1023)).toBe("1023 bytes");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(12 * 1024 + 500)).toBe("12 KB");
    expect(formatBytes(65_800)).toBe("64 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(Math.round(3.2 * 1024 * 1024))).toBe("3.2 MB");
  });
});

describe("sizeInWords", () => {
  it("writes a limit exactly", () => {
    expect(sizeInWords(64 * 1024)).toBe("64 KB");
    expect(sizeInWords(1024 * 1024)).toBe("1 MB");
    expect(sizeInWords(2 * 1024 * 1024)).toBe("2 MB");
  });
});
