import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SampleImage } from "../decision/examples.ts";
import { pngBytes } from "./fixtures/images.ts";
import { fetchSampleImages } from "./sample-images.ts";

const samples: SampleImage[] = [
  { name: "one.png", mediaType: "image/png", url: "/samples/one.png" },
  { name: "two.png", mediaType: "image/png", url: "/samples/two.png" },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSampleImages", () => {
  it("fetches every sample and returns named, typed files in the given order", async () => {
    const fetchMock = vi.fn(
      async (url: string) =>
        new Response(pngBytes({ size: url.endsWith("one.png") ? 100 : 200 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const files = await fetchSampleImages(samples);
    expect(files.map((file) => [file.name, file.type, file.size])).toEqual([
      ["one.png", "image/png", 100],
      ["two.png", "image/png", 200],
    ]);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/samples/one.png",
      "/samples/two.png",
    ]);
  });

  it("returns no files for a set without pictures, and fetches nothing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchSampleImages([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when one sample answers with an error status, naming it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("two.png")
          ? new Response("", { status: 404 })
          : new Response(pngBytes(), { status: 200 }),
      ),
    );
    await expect(fetchSampleImages(samples)).rejects.toThrow("two.png answered HTTP 404.");
  });

  it("rejects when fetch itself fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(fetchSampleImages(samples)).rejects.toThrow("Failed to fetch");
  });
});
