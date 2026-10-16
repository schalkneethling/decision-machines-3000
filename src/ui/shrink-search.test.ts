import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_PLAN, searchSizes, sizesFor } from "./shrink-search.ts";
import type { Attempt, Encoder } from "./shrink-search.ts";

const KIB = 1024;

/** An encoder that records every attempt and answers with `bytes(attempt)` bytes of `type`. */
function fakeEncoder(
  bytes: (attempt: Attempt) => number,
  answerType?: (attempt: Attempt) => string,
): { encode: Encoder; calls: Attempt[] } {
  const calls: Attempt[] = [];
  return {
    calls,
    encode: async (attempt) => {
      calls.push(attempt);
      return new Blob([new Uint8Array(bytes(attempt))], {
        type: answerType?.(attempt) ?? attempt.type,
      });
    },
  };
}

describe("sizesFor", () => {
  it("scales each edge and keeps the aspect ratio", () => {
    expect(sizesFor(4000, 3000, [1024, 768, 512])).toEqual([
      { width: 1024, height: 768 },
      { width: 768, height: 576 },
      { width: 512, height: 384 },
    ]);
    expect(sizesFor(3000, 4000, [1024])).toEqual([{ width: 768, height: 1024 }]);
  });

  it("never enlarges, and drops a repeated size", () => {
    expect(sizesFor(600, 400, [1024, 768, 512])).toEqual([
      { width: 600, height: 400 },
      { width: 512, height: 341 },
    ]);
  });

  it("keeps a very thin picture at least one pixel wide", () => {
    expect(sizesFor(10000, 2, [512])).toEqual([{ width: 512, height: 1 }]);
    expect(sizesFor(2, 10000, [512])).toEqual([{ width: 1, height: 512 }]);
  });
});

describe("searchSizes", () => {
  it("asks for the largest edge at the highest quality first, and stops at the first fit", async () => {
    // 1024 px is 90 KiB at 0.8, 70 KiB at 0.6, 50 KiB at 0.4.
    const { encode, calls } = fakeEncoder(
      ({ quality }) => Math.round(quality * 100 * KIB) + 10 * KIB,
    );
    const result = await searchSizes({ width: 4000, height: 3000 }, 64 * KIB, "image/jpeg", encode);
    expect(calls.map(({ width, quality }) => [width, quality])).toEqual([
      [1024, 0.8],
      [1024, 0.6],
      [1024, 0.4],
    ]);
    expect(result).toMatchObject({ kind: "fit", width: 1024, height: 768 });
    expect(result.kind === "fit" && result.blob.size).toBeLessThanOrEqual(64 * KIB);
  });

  it("steps down in size once every quality at an edge is over", async () => {
    const { encode, calls } = fakeEncoder(({ width }) => (width > 512 ? 80 * KIB : 30 * KIB));
    const result = await searchSizes({ width: 4000, height: 3000 }, 64 * KIB, "image/jpeg", encode);
    const edges = [...new Set(calls.map(({ width }) => width))];
    expect(edges).toEqual([1024, 768, 512]);
    expect(calls).toHaveLength(2 * DEFAULT_PLAN.qualities.length + 1);
    expect(result).toMatchObject({ kind: "fit", width: 512, height: 384 });
  });

  it("accepts a result of exactly the budget", async () => {
    const { encode } = fakeEncoder(() => 64 * KIB);
    const result = await searchSizes({ width: 4000, height: 3000 }, 64 * KIB, "image/jpeg", encode);
    expect(result.kind).toBe("fit");
  });

  it("gives up with the smallest size and byte count when even the last attempt is over, and encodes no more than the plan allows", async () => {
    const { encode, calls } = fakeEncoder(({ width }) => 70 * KIB + width);
    const result = await searchSizes({ width: 4000, height: 3000 }, 64 * KIB, "image/jpeg", encode);
    expect(calls).toHaveLength(DEFAULT_PLAN.edges.length * DEFAULT_PLAN.qualities.length);
    expect(result).toEqual({
      kind: "too-big",
      width: 512,
      height: 384,
      smallestBytes: 70 * KIB + 512,
    });
  });

  it("skips the other qualities when the encoder answers another type, since PNG has no quality", async () => {
    const { encode, calls } = fakeEncoder(
      () => 80 * KIB,
      () => "image/png",
    );
    const result = await searchSizes({ width: 4000, height: 3000 }, 64 * KIB, "image/webp", encode);
    expect(calls.map(({ width, quality }) => [width, quality])).toEqual([
      [1024, 0.8],
      [768, 0.8],
      [512, 0.8],
    ]);
    expect(result.kind).toBe("too-big");
  });

  it("returns an answer of another type when it fits, so the caller can declare the type it really is", async () => {
    const { encode } = fakeEncoder(
      () => 10 * KIB,
      () => "image/png",
    );
    const result = await searchSizes({ width: 800, height: 600 }, 64 * KIB, "image/webp", encode);
    expect(result.kind === "fit" && result.blob.type).toBe("image/png");
  });

  it("asks for the type it is given", async () => {
    const { encode, calls } = fakeEncoder(() => KIB);
    await searchSizes({ width: 800, height: 600 }, 64 * KIB, "image/webp", encode);
    expect(calls[0]?.type).toBe("image/webp");
  });
});
