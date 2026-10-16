import { describe, expect, it } from "vite-plus/test";
import {
  MAX_FILE_NAME_CHARACTERS,
  cleanFileName,
  imageLabel,
  imageLabels,
} from "./image-labels.ts";

describe("cleanFileName", () => {
  it("keeps an ordinary name as it is", () => {
    expect(cleanFileName("photo.jpg")).toBe("photo.jpg");
    expect(cleanFileName("Holiday photo (2).PNG")).toBe("Holiday photo (2).PNG");
  });

  it("keeps only what follows the last slash or backslash", () => {
    expect(cleanFileName("../../etc/secret.png")).toBe("secret.png");
    expect(cleanFileName("C:\\Users\\me\\pic.webp")).toBe("pic.webp");
  });

  it("removes line breaks, tabs, and other control characters", () => {
    expect(cleanFileName("a\nb\r\nc\td\u0000e\u001bf\u0085g.png")).toBe("abcdefg.png");
  });

  it("removes zero-width, bidi, and separator characters that can hide or reorder text", () => {
    expect(cleanFileName("a\u200bb\u202ec\u2066d\u2028e\u2029f\ufeffg.png")).toBe("abcdefg.png");
  });

  it("removes variation selectors, tag characters, and characters that draw as blank", () => {
    expect(cleanFileName("a\ufe0fb\u{e0100}c\u{e0041}d\u034fe\u3164f\u2800g\ue000h.png")).toBe(
      "abcdefgh.png",
    );
  });

  it("removes lone surrogates", () => {
    expect(cleanFileName("a\ud800b.png")).toBe("ab.png");
  });

  it("makes runs of whitespace one space and trims the ends", () => {
    expect(cleanFileName("  my   holiday \u00a0 photo.png  ")).toBe("my holiday photo.png");
  });

  it("returns an empty string when nothing is left", () => {
    expect(cleanFileName("")).toBe("");
    expect(cleanFileName("\n\t\u200b")).toBe("");
    expect(cleanFileName("folder/")).toBe("");
  });

  it("clips a 300-character name to the limit and ends it with an ellipsis", () => {
    const clipped = cleanFileName(`${"x".repeat(296)}.png`);
    expect(Array.from(clipped)).toHaveLength(MAX_FILE_NAME_CHARACTERS + 1);
    expect(clipped).toBe(`${"x".repeat(MAX_FILE_NAME_CHARACTERS)}…`);
  });

  it("leaves a name of exactly the limit unclipped", () => {
    const name = "y".repeat(MAX_FILE_NAME_CHARACTERS);
    expect(cleanFileName(name)).toBe(name);
  });

  it("clips by code point, so a character outside the basic plane is never split", () => {
    const clipped = cleanFileName("🙂".repeat(200));
    expect(clipped).toBe(`${"🙂".repeat(MAX_FILE_NAME_CHARACTERS)}…`);
    expect(clipped.isWellFormed()).toBe(true);
  });
});

describe("imageLabel and imageLabels", () => {
  it("numbers from 1 and names the file", () => {
    expect(imageLabel({ name: "a.png" }, 0)).toBe("Image 1: a.png");
    expect(imageLabel({ name: "b.jpg" }, 1)).toBe("Image 2: b.jpg");
  });

  it("uses the number alone when there is no name", () => {
    expect(imageLabel({ name: "" }, 2)).toBe("Image 3");
  });

  it("labels a list in order", () => {
    expect(imageLabels([{ name: "a.png" }, { name: "" }, { name: "c.webp" }])).toEqual([
      "Image 1: a.png",
      "Image 2",
      "Image 3: c.webp",
    ]);
    expect(imageLabels([])).toEqual([]);
  });
});
