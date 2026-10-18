import { describe, expect, it } from "vite-plus/test";
import { formatBytes, sizeAndLimit, sizeInWords } from "./byte-size.ts";

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

describe("sizeAndLimit", () => {
  it("writes a whole-kibibyte limit as the catalog does", () => {
    expect(sizeAndLimit(5 * 1024 * 1024, 64 * 1024)).toEqual({
      measured: "5.0 MB",
      limit: "64 KB",
    });
  });

  it("gives a size inside the limit's rounding window in exact bytes, keeping the limit's words", () => {
    expect(sizeAndLimit(65_800, 64 * 1024)).toEqual({ measured: "65,800 bytes", limit: "64 KB" });
    expect(sizeAndLimit(2 * 1024 * 1024 + 1000, 2 * 1024 * 1024)).toEqual({
      measured: "2,098,152 bytes",
      limit: "2 MB",
    });
  });

  it("rounds a budget that is not a whole number of kibibytes, without a decimal tail", () => {
    // 34,299 bytes is 33.4951171875 KB.
    expect(sizeAndLimit(40_000, 34_299)).toEqual({ measured: "39 KB", limit: "33 KB" });
    expect(sizeAndLimit(40_000, 500)).toEqual({ measured: "39 KB", limit: "500 bytes" });
  });

  it("rounds a budget that is a whole number of kibibytes by chance, but not a round size", () => {
    // 1,100 KiB is 1.07421875 MB, which `sizeInWords` would print in full.
    expect(sizeAndLimit(3 * 1024 * 1024, 1100 * 1024)).toEqual({
      measured: "3.0 MB",
      limit: "1.1 MB",
    });
    expect(sizeAndLimit(3 * 1024 * 1024, 1536 * 1024)).toEqual({
      measured: "3.0 MB",
      limit: "1.5 MB",
    });
  });

  it("switches both to bytes on the first size whose rounding reads equal to the budget's", () => {
    // 34,900 bytes reads as 34 KB; a picture of 35,327 bytes (34.499 KB) also reads 34 KB, and 35,328 (34.5 KB) reads 35 KB.
    expect(sizeAndLimit(35_327, 34_900)).toEqual({
      measured: "35,327 bytes",
      limit: "34,900 bytes",
    });
    expect(sizeAndLimit(35_328, 34_900)).toEqual({ measured: "35 KB", limit: "34 KB" });
  });

  it("never lets the size read as smaller than the budget", () => {
    // The issue's case: 35,000 bytes rounds to 34 KB, under the 34,900-byte budget's 34.08 KB.
    expect(sizeAndLimit(35_000, 34_900)).toEqual({
      measured: "35,000 bytes",
      limit: "34,900 bytes",
    });
    expect(sizeAndLimit(1280, 1279)).toEqual({ measured: "1,280 bytes", limit: "1,279 bytes" });
  });
});
