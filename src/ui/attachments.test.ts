// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { encodeBase64 } from "../providers/base64.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import type { ImageCapabilities } from "../providers/catalog.ts";
import { toProviderSummary } from "../providers/contract.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import {
  ASK_ABOUT_IMAGES,
  PRIVACY_NOTE,
  createAttachments,
  fitsWithin,
  withImages as requestWithImages,
} from "./attachments.ts";
import type { ImageTransform } from "./attachments.ts";
import { capabilitySentence, formatList, imageInputSentence } from "./image-sentences.ts";
import { fileOf, gifBytes, jpegBytes, pngBytes, webpBytes } from "./fixtures/images.ts";

const typesafe = toProviderSummary(PROVIDERS.typesafe);
const subq = toProviderSummary(PROVIDERS.subq);
const openai = toProviderSummary(PROVIDERS.openai);

const KIB = 1024;

/** The limits every test reads from the catalog's SubQ entry, so a cap change reaches the assertions. */
const limits = subq.capabilities.images as ImageCapabilities;

/** `provider` with other image limits, so the tests do not depend on the two caps being equal. */
function withImages(
  provider: ProviderSummary,
  images: Partial<ImageCapabilities>,
): ProviderSummary {
  const base = provider.capabilities.images as ImageCapabilities;
  return {
    ...provider,
    capabilities: { ...provider.capabilities, images: { ...base, ...images } },
  };
}

function mount(): HTMLFormElement {
  document.body.innerHTML = `
    <form class="panel-form" data-primitive="noul" novalidate>
      <div class="attachments"></div>
      <button class="run" type="submit">Run</button>
    </form>`;
  const form = document.querySelector("form");
  if (form === null) throw new Error("No form.");
  return form;
}

function get<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (found === null) throw new Error(`Nothing matches ${selector}.`);
  return found;
}

function zone(): HTMLFieldSetElement {
  return get<HTMLFieldSetElement>(".attachments-zone");
}

function input(): HTMLInputElement {
  return get<HTMLInputElement>(".attachments-input");
}

function status(): string {
  return get(".attachments-status").textContent ?? "";
}

function notice(): string {
  return get(".attachments-notice").textContent ?? "";
}

function items(): HTMLLIElement[] {
  return [...document.querySelectorAll<HTMLLIElement>(".attachment")];
}

/** Chooses `files` through the file input, as a viewer would. */
function choose(...files: File[]): void {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input().files = transfer.files;
  input().dispatchEvent(new Event("change", { bubbles: true }));
}

/** An event of `type` carrying `files` in `dataTransfer`, as a drop would, or in `clipboardData`, as a paste would. */
function eventWithFiles(type: "drop" | "dragover" | "paste", files: File[]): Event {
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  if (type === "paste") {
    return new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
  }
  // happy-dom's DragEvent drops its dataTransfer, so the property is defined on a plain event.
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  return event;
}

const png = (name = "poster.png", size = 12 * KIB) => fileOf(pngBytes({ size }), name, "image/png");

/** The object URL spies, renewed per test: a thumbnail's URL names its file, so a test can tell them apart. */
let createObjectURL = vi.spyOn(URL, "createObjectURL");
let revokeObjectURL = vi.spyOn(URL, "revokeObjectURL");

beforeEach(() => {
  createObjectURL = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(
      (object: Blob | MediaSource) => `blob:test/${object instanceof File ? object.name : "blob"}`,
    );
  revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sentences", () => {
  it("names the formats", () => {
    expect(formatList(["image/png", "image/jpeg", "image/webp"])).toBe("PNG, JPEG, or WebP");
    expect(formatList(["image/png"])).toBe("PNG");
    expect(formatList(["image/png", "image/avif"])).toBe("PNG, or image/avif");
  });

  it("states the capability for the provider status line, from the capabilities alone", () => {
    expect(imageInputSentence(false)).toBe("Text only, no images.");
    expect(imageInputSentence(limits)).toBe(
      "Image input available: up to 4 PNG, JPEG, or WebP images, 64 KB in total.",
    );
    expect(
      imageInputSentence({
        ...limits,
        maxCount: 2,
        maxBytesPerImage: 2 * KIB * KIB,
        maxBytesPerRequest: 3 * KIB * KIB,
      }),
    ).toBe(
      "Image input available: up to 2 PNG, JPEG, or WebP images, 2 MB each and 3 MB in total.",
    );
  });

  it("states this instance's caps under the control and whose they are", () => {
    expect(capabilitySentence(openai, openai.capabilities.images as ImageCapabilities)).toBe(
      "OpenAI Decisions takes up to 8 images, 64 KB in total: PNG, JPEG, or WebP. These are this instance's limits, not the provider's.",
    );
  });
});

describe("fitsWithin", () => {
  it("marks images past the count, over the per-image cap, or past the running total", () => {
    const caps = { ...limits, maxCount: 3, maxBytesPerImage: 10, maxBytesPerRequest: 15 };
    expect(fitsWithin([5, 11, 5, 5, 1], caps)).toEqual([true, false, true, true, false]);
    expect(fitsWithin([10, 6], caps)).toEqual([true, false]);
    expect(fitsWithin([], caps)).toEqual([]);
  });
});

describe("requestWithImages", () => {
  it("adds an images list to the request, one entry per file, in order, with its name and base64", async () => {
    const files = [
      png("a.png"),
      new File([pngBytes()], "pasted-image-1.png", { type: "image/png" }),
    ];
    const text = '{"primitive":"noul","state":"","questions":{}}';
    const body = JSON.parse(await requestWithImages(text, files)) as Record<string, unknown>;

    expect(body).toEqual({
      primitive: "noul",
      state: "",
      questions: {},
      images: [
        { name: "a.png", base64: encodeBase64(new Uint8Array(await files[0]!.arrayBuffer())) },
        { name: "pasted-image-1.png", base64: encodeBase64(pngBytes()) },
      ],
    });
  });
});

describe("markup", () => {
  it("is a fieldset with a legend, a visible labelled file input, linked instructions, and the privacy note", () => {
    const form = mount();
    createAttachments(form, { prefix: "noul-images", provider: subq });
    const fieldset = zone();
    expect(fieldset.hidden).toBe(false);
    expect(fieldset.firstElementChild?.tagName).toBe("LEGEND");
    expect(fieldset.firstElementChild?.textContent).toBe("Images");
    expect(input().type).toBe("file");
    expect(input().multiple).toBe(true);
    expect(input().hidden).toBe(false);
    expect(input().getAttribute("accept")).toBe("image/png,image/jpeg,image/webp");
    expect(get("label.attachments-label").getAttribute("for")).toBe(input().id);
    const described = (input().getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toEqual([
      "noul-images-instructions",
      "noul-images-hint",
      "noul-images-limits",
    ]);
    for (const id of described) expect(fieldset.querySelector(`#${id}`)).not.toBeNull();
    expect(get("#noul-images-limits").textContent).toBe(capabilitySentence(subq, limits));
    expect(fieldset.getAttribute("aria-describedby")).toBe("noul-images-privacy");
    expect(get("#noul-images-privacy").textContent).toBe(PRIVACY_NOTE);
    expect(get(".attachments-status").getAttribute("role")).toBe("status");
    expect(status()).toBe("");
  });

  it("tells the user to ask about the images, and the hint is part of the input's description", () => {
    createAttachments(mount(), { prefix: "noul-images", provider: openai });
    const hint = get("#noul-images-hint");
    expect(hint.textContent).toBe(ASK_ABOUT_IMAGES);
    expect(hint.textContent).toContain("state or a question");
    expect(hint.textContent).toContain("What does image 1 show?");
    expect(zone().contains(hint)).toBe(true);
    expect(input().getAttribute("aria-describedby")?.split(" ")).toContain(hint.id);
    expect(zone().hidden).toBe(false);
  });

  it("hides the hint with the control for a text-only provider", () => {
    createAttachments(mount(), { prefix: "noul-images", provider: typesafe });
    expect(zone().contains(get("#noul-images-hint"))).toBe(true);
    expect(zone().hidden).toBe(true);
  });

  it("is hidden for a text-only provider and while no provider is selected, and announces nothing", () => {
    createAttachments(mount(), { prefix: "noul-images", provider: typesafe });
    expect(zone().hidden).toBe(true);
    expect(status()).toBe("");
    createAttachments(mount(), { prefix: "noul-images", provider: undefined });
    expect(zone().hidden).toBe(true);
    expect(status()).toBe("");
  });

  it("follows a change between two image providers, down to the accept list", () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    expect(get("#noul-images-limits").textContent).toContain("up to 8 images");
    const pngOnly = withImages(subq, {
      maxCount: 2,
      mediaTypes: ["image/png"],
      maxBytesPerImage: 32 * KIB,
    });
    control.setProvider(pngOnly);
    expect(input().getAttribute("accept")).toBe("image/png");
    expect(get("#noul-images-limits").textContent).toBe(
      "SubQ Snap takes up to 2 images, 32 KB each and 64 KB in total: PNG. These are this instance's limits, not the provider's.",
    );
    // The generic capability is announced once, by the provider status line, not here.
    expect(status()).toBe("");
  });
});

describe("attaching", () => {
  it("lists a chosen PNG with its type, size, dimensions, and a thumbnail, and announces it", async () => {
    const form = mount();
    const control = createAttachments(form, { prefix: "noul-images", provider: subq });
    choose(fileOf(pngBytes({ width: 64, height: 48, size: 12 * KIB }), "poster.png", "image/png"));
    await vi.waitFor(() => expect(items()).toHaveLength(1));
    const item = items()[0]!;
    expect(item.querySelector("img")?.getAttribute("alt")).toBe("poster.png");
    expect(item.querySelector("img")?.getAttribute("src")).toBe("blob:test/poster.png");
    expect(item.textContent).toContain("image/png");
    expect(item.textContent).toContain("12 KB");
    expect(item.textContent).toContain("64 × 48");
    expect(status()).toBe("Image 1 added: poster.png, 12 KB.");
    expect(control.count()).toBe(1);
    expect(control.files()[0]?.name).toBe("poster.png");
    // Cleared, so the same file can be chosen again.
    expect(input().value).toBe("");
  });

  it("refuses a photo over the per-image cap without reading it, with a sentence that names both sizes", async () => {
    const form = mount();
    const control = createAttachments(form, { prefix: "noul-images", provider: subq });
    const reads = vi.spyOn(Blob.prototype, "arrayBuffer");
    choose(fileOf(jpegBytes({ size: Math.round(3.2 * KIB * KIB) }), "holiday.jpg", "image/jpeg"));
    await vi.waitFor(() => expect(status()).not.toBe(""));
    expect(status()).toBe(
      "holiday.jpg was not added: it is 3.2 MB, over this instance's limit of 64 KB per image.",
    );
    expect(items()).toHaveLength(0);
    expect(control.count()).toBe(0);
    expect(createObjectURL).not.toHaveBeenCalled();
    // Only the twelve-byte head was read, as a slice.
    for (const call of reads.mock.contexts) expect((call as Blob).size).toBeLessThanOrEqual(12);
  });

  it("refuses an image that would push the total over the per-request cap", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    await control.add([png("a.png", 40 * KIB)]);
    await control.add([png("b.png", 30 * KIB)]);
    expect(status()).toBe(
      "b.png was not added: with it the images would add up to 70 KB, over this instance's limit of 64 KB per request.",
    );
    expect(control.count()).toBe(1);
  });

  it("refuses a fifth image on SubQ Snap before reading any of it", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([
      png("a.png", 8 * KIB),
      png("b.png", 8 * KIB),
      png("c.png", 8 * KIB),
      png("d.png", 8 * KIB),
    ]);
    expect(control.count()).toBe(4);
    const reads = vi.spyOn(Blob.prototype, "arrayBuffer");
    zone().dispatchEvent(eventWithFiles("drop", [png("fifth.png", 8 * KIB)]));
    await vi.waitFor(() => expect(status()).toContain("fifth.png"));
    expect(status()).toBe(
      "fifth.png was not added: SubQ Snap takes at most 4 images per request, and 4 are attached.",
    );
    expect(reads).not.toHaveBeenCalled();
    expect(control.count()).toBe(4);
  });

  it("takes the media type from the bytes, not the name or the declared type", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([fileOf(jpegBytes({ size: 4 * KIB }), "photo.png", "image/png")]);
    expect(items()[0]?.textContent).toContain("image/jpeg");
    expect(items()[0]?.textContent).not.toContain("image/png");
    const sent = control.files()[0];
    expect(sent?.type).toBe("image/jpeg");
    expect(sent?.name).toBe("photo.png");
  });

  it("refuses bytes of no accepted format, judging by the first bytes", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([fileOf(gifBytes(2 * KIB), "loop.gif", "image/gif")]);
    expect(status()).toBe(
      "loop.gif was not added: it is not a PNG, JPEG, or WebP image, judging by its first bytes.",
    );
    await control.add([
      fileOf(
        new TextEncoder().encode("hello") as Uint8Array<ArrayBuffer>,
        "notes.png",
        "image/png",
      ),
    ]);
    expect(status()).toContain("notes.png was not added");
    expect(control.count()).toBe(0);
  });

  it("honours the provider's own media types", async () => {
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: withImages(subq, { mediaTypes: ["image/png"] }),
    });
    await control.add([fileOf(jpegBytes({ size: 2 * KIB }), "photo.jpg", "image/jpeg")]);
    expect(status()).toBe(
      "photo.jpg was not added: it is not a PNG image, judging by its first bytes.",
    );
  });

  it("reads the pixel size from each format's header, and says when it cannot", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    await control.add([
      fileOf(pngBytes({ width: 10, height: 20, size: KIB }), "a.png"),
      fileOf(jpegBytes({ width: 30, height: 40, prelude: 2000, size: 4 * KIB }), "b.jpg"),
      fileOf(webpBytes({ width: 50, height: 60, layout: "VP8L", size: KIB }), "c.webp"),
      fileOf(webpBytes({ width: 70, height: 80, layout: "VP8X", size: KIB }), "d.webp"),
      fileOf(webpBytes({ width: 90, height: 100, layout: "VP8", size: KIB }), "e.webp"),
      fileOf(pngBytes().subarray(0, 8) as Uint8Array<ArrayBuffer>, "f.png"),
    ]);
    expect(items().map((item) => item.querySelector(".attachment-meta")?.textContent)).toEqual([
      "image/png, 1 KB, 10 × 20",
      "image/jpeg, 4 KB, 30 × 40",
      "image/webp, 1 KB, 50 × 60",
      "image/webp, 1 KB, 70 × 80",
      "image/webp, 1 KB, 90 × 100",
      "image/png, 8 bytes, size unknown",
    ]);
    expect(status()).toMatch(
      /^Image 1 added: a.png, 1 KB\. Image 2 added: b.jpg, 4 KB\. .*Image 6 added: f.png, 8 bytes\.$/,
    );
  });

  it("attaches a pasted image from the panel form, naming a nameless blob by its detected type", async () => {
    const form = mount();
    const control = createAttachments(form, { prefix: "noul-images", provider: subq });
    const paste = eventWithFiles("paste", [fileOf(pngBytes({ size: 2 * KIB }), "", "image/png")]);
    form.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(control.count()).toBe(1));
    expect(control.files()[0]?.name).toBe("pasted-image-1.png");
    expect(items()[0]?.querySelector("img")?.getAttribute("alt")).toBe("pasted-image-1.png");
    expect(status()).toBe("Image 1 added: pasted-image-1.png, 2 KB.");

    // The generated extension follows the bytes, and the count goes on.
    await control.add([new Blob([jpegBytes({ size: KIB })])]);
    expect(control.files()[1]?.name).toBe("pasted-image-2.jpg");
    const body = JSON.parse(await requestWithImages("{}", control.files())) as {
      images: { name: string }[];
    };
    expect(body.images.map((image) => image.name)).toEqual([
      "pasted-image-1.png",
      "pasted-image-2.jpg",
    ]);
  });

  it("leaves a text paste to the focused field", () => {
    const form = mount();
    createAttachments(form, { prefix: "noul-images", provider: subq });
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "hello");
    const paste = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    });
    form.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(false);
    expect(status()).toBe("");
  });

  it("refuses a paste while a text-only provider is selected, instead of attaching silently", async () => {
    const form = mount();
    const control = createAttachments(form, { prefix: "noul-images", provider: typesafe });
    form.dispatchEvent(
      eventWithFiles("paste", [fileOf(pngBytes({ size: KIB }), "image.png", "image/png")]),
    );
    await vi.waitFor(() => expect(status()).not.toBe(""));
    expect(status()).toBe("image.png was not added: TypeSafe Jev is text only.");
    expect(control.count()).toBe(0);
  });

  it("accepts a drop after cancelling dragover, and ignores a drag without files", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    const over = eventWithFiles("dragover", [png()]);
    zone().dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(zone().dataset.dragging).toBe("true");

    const textOnly = new Event("dragover", { bubbles: true, cancelable: true });
    Object.defineProperty(textOnly, "dataTransfer", { value: new DataTransfer() });
    zone().dispatchEvent(textOnly);
    expect(textOnly.defaultPrevented).toBe(false);

    const drop = eventWithFiles("drop", [png("a.png"), png("b.png")]);
    zone().dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(zone().dataset.dragging).toBeUndefined();
    await vi.waitFor(() => expect(control.count()).toBe(2));
    expect(control.files().map((file) => file.name)).toEqual(["a.png", "b.png"]);
  });

  it("runs the transform between detection and the size checks, and detects the result again", async () => {
    const seen: { name: string; mediaType: string; maxCount: number }[] = [];
    const shrink: ImageTransform = async ({ file, mediaType }, caps) => {
      seen.push({ name: file.name, mediaType, maxCount: caps.maxCount });
      // A stand-in for #25: a smaller file of another format.
      return new File([webpBytes({ width: 8, height: 8, size: 2 * KIB })], "shrunk.webp", {
        type: "image/webp",
      });
    };
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: shrink,
    });
    await control.add([fileOf(pngBytes({ size: 3 * KIB * KIB }), "huge.png", "image/png")]);
    expect(seen).toEqual([{ name: "huge.png", mediaType: "image/png", maxCount: 4 }]);
    expect(control.count()).toBe(1);
    expect(control.files()[0]?.name).toBe("shrunk.webp");
    expect(control.files()[0]?.type).toBe("image/webp");
    expect(items()[0]?.textContent).toContain("image/webp, 2 KB, 8 × 8");
  });

  it("does not transform a file that failed the count check or the format check", async () => {
    const transform = vi.fn<ImageTransform>(async ({ file }) => file);
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: withImages(subq, { maxCount: 1 }),
      transform,
    });
    await control.add([fileOf(gifBytes(KIB), "a.gif")]);
    expect(transform).not.toHaveBeenCalled();
    await control.add([png("a.png"), png("b.png")]);
    expect(transform).toHaveBeenCalledOnce();
    expect(control.count()).toBe(1);
  });

  it("refuses what a transform returns when its bytes are not an accepted format", async () => {
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: async () => new File([gifBytes(KIB)], "odd.gif"),
    });
    await control.add([png()]);
    expect(control.count()).toBe(0);
    expect(status()).toContain("not a PNG, JPEG, or WebP image");
  });

  it("announces nothing for an empty selection", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([]);
    choose();
    await Promise.resolve();
    expect(status()).toBe("");
  });
});

describe("removing", () => {
  it("revokes the object URL, drops the item, moves focus, and announces", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([png("a.png", 4 * KIB), png("b.png", 4 * KIB)]);
    const [first] = items();
    const remove = first?.querySelector<HTMLButtonElement>(".attachment-remove");
    if (!remove) throw new Error("No Remove button.");
    expect(remove.textContent).toBe("Remove a.png");
    remove.click();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test/a.png");
    expect(items()).toHaveLength(1);
    expect(control.files().map((file) => file.name)).toEqual(["b.png"]);
    expect(status()).toBe("Image removed: a.png. 1 image remains.");
    expect(document.activeElement).toBe(items()[0]?.querySelector(".attachment-remove"));

    items()[0]?.querySelector<HTMLButtonElement>(".attachment-remove")?.click();
    expect(status()).toBe("Image removed: b.png. No images remain.");
    expect(document.activeElement).toBe(input());
  });
});

/** A transform that holds each file until the test calls `release`, so an add can be caught in flight. */
function heldTransform(): { transform: ImageTransform; release: () => void } {
  const waiting: (() => void)[] = [];
  return {
    transform: ({ file }) =>
      new Promise<File>((resolve) => {
        waiting.push(() => resolve(file));
      }),
    release: () => {
      for (const resolve of waiting.splice(0)) resolve();
    },
  };
}

/** Lets every promise that is ready settle, so the queue moves on as far as it can. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe("replacing (issue #58)", () => {
  it("swaps every image for the new ones, revokes the old object URLs, and announces nothing", async () => {
    const onChange = vi.fn();
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq, onChange });
    await control.add([png("a.png", 4 * KIB), png("b.png", 4 * KIB)]);
    onChange.mockClear();

    const { added, refused } = await control.replace([png("sample.png", 4 * KIB)]);
    expect(control.files().map((file) => file.name)).toEqual(["sample.png"]);
    expect(added).toEqual(control.files());
    expect(refused).toEqual([]);
    expect(items()).toHaveLength(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test/a.png");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test/b.png");
    expect(onChange).toHaveBeenCalled();
    expect(status()).toBe("");
  });

  it("empties the control when given nothing, and lifts the block that over-limit images put on Run", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    await control.add(Array.from({ length: 6 }, (_, index) => png(`${index + 1}.png`, 4 * KIB)));
    control.setProvider(subq);
    expect(control.blocked()).toBeDefined();

    expect(await control.replace([])).toEqual({ added: [], refused: [] });
    expect(control.count()).toBe(0);
    expect(control.blocked()).toBeUndefined();
    expect(notice()).toBe("");
  });

  it("returns a sentence for each source it could not attach, and attaches the rest", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    const sources = Array.from({ length: limits.maxCount + 1 }, (_, index) =>
      png(`${index + 1}.png`, KIB),
    );
    const { added, refused } = await control.replace(sources);
    expect(added).toHaveLength(limits.maxCount);
    expect(refused).toEqual([
      `${limits.maxCount + 1}.png was not added: SubQ Snap takes at most ${limits.maxCount} images per request, and ${limits.maxCount} are attached.`,
    ]);
    expect(status()).toBe("");
  });

  it("runs after an add still in flight, so the image that add admits is removed too", async () => {
    const held = heldTransform();
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: held.transform,
    });
    const adding = control.add([png("late.png", 4 * KIB)]);
    const replacing = control.replace([png("sample.png", 4 * KIB)]);
    await flush();
    held.release();
    await adding;
    await flush();
    held.release();
    const { added } = await replacing;
    expect(control.files().map((file) => file.name)).toEqual(["sample.png"]);
    expect(added.map((file) => file.name)).toEqual(["sample.png"]);
  });

  it("lets an add made during the swap land after the new images, and leaves it out of what it attached", async () => {
    const held = heldTransform();
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: held.transform,
    });
    const replacing = control.replace([png("sample.png", 4 * KIB)]);
    const adding = control.add([png("mine.png", 4 * KIB)]);
    await flush();
    held.release();
    const { added } = await replacing;
    await flush();
    held.release();
    await adding;
    expect(control.files().map((file) => file.name)).toEqual(["sample.png", "mine.png"]);
    expect(added.map((file) => file.name)).toEqual(["sample.png"]);
  });

  it("blocks Run while it runs, as an add does", async () => {
    const held = heldTransform();
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: held.transform,
    });
    const replacing = control.replace([png("sample.png", 4 * KIB)]);
    await flush();
    expect(control.blocked()).toBe("Images are still being added. Run is available once they are.");
    held.release();
    await replacing;
    await flush();
    expect(control.blocked()).toBeUndefined();
  });

  it("leaves no shrink progress sentence behind", async () => {
    let finish = (): void => {};
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      // A shrink that holds on, so the progress sentence can be seen while it works.
      transform: ({ file }) =>
        new Promise<File>((resolve) => {
          finish = () => resolve(fileOf(pngBytes({ size: 4 * KIB }), file.name, "image/png"));
        }),
    });
    const replacing = control.replace([png("big.png", limits.maxBytesPerImage + KIB)]);
    await flush();
    expect(status()).toBe("Making big.png smaller to fit…");
    finish();
    expect((await replacing).added).toHaveLength(1);
    expect(status()).toBe("");
  });
});

describe("settling (issue #58)", () => {
  it("resolves at once when nothing is being added", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await expect(control.settled()).resolves.toBeUndefined();
  });

  it("waits for an add in flight, and for one started while it waits", async () => {
    const held = heldTransform();
    const control = createAttachments(mount(), {
      prefix: "noul-images",
      provider: subq,
      transform: held.transform,
    });
    void control.add([png("first.png", 4 * KIB)]);
    let done = false;
    const settling = control.settled().then(() => {
      done = true;
    });
    await flush();
    void control.add([png("second.png", 4 * KIB)]);
    held.release();
    await flush();
    expect(done).toBe(false);
    expect(control.count()).toBe(1);

    held.release();
    await settling;
    expect(control.files().map((file) => file.name)).toEqual(["first.png", "second.png"]);
  });
});

describe("provider changes with images attached", () => {
  it("keeps the images on a text-only provider, says so visibly and in the status, and sends none", async () => {
    const onChange = vi.fn();
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq, onChange });
    await control.add([png("a.png", 4 * KIB), png("b.png", 4 * KIB)]);
    onChange.mockClear();

    control.setProvider(typesafe);
    expect(zone().hidden).toBe(true);
    expect(control.count()).toBe(2);
    expect(control.files()).toHaveLength(2);
    expect(notice()).toBe(
      "TypeSafe Jev is text only. Your 2 images are kept and will not be sent.",
    );
    expect(status()).toBe("TypeSafe Jev is text only; your 2 images are kept and will not be sent");
    expect(control.blocked()).toBeUndefined();
    expect(onChange).toHaveBeenCalledOnce();

    control.setProvider(subq);
    expect(zone().hidden).toBe(false);
    expect(items()).toHaveLength(2);
    expect(notice()).toBe("");
    expect(status()).toBe("Image input available again; your 2 images will be sent.");
  });

  it("says nothing about an empty panel on a provider change", () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    control.setProvider(typesafe);
    expect(notice()).toBe("");
    expect(status()).toBe("");
    control.setProvider(openai);
    expect(status()).toBe("");
  });

  it("marks the excess on a provider with a lower count and blocks Run until it is removed", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    await control.add(Array.from({ length: 8 }, (_, index) => png(`${index + 1}.png`, 4 * KIB)));
    expect(control.count()).toBe(8);

    control.setProvider(subq);
    const marked = items().map((item) => item.hasAttribute("data-over-limit"));
    expect(marked).toEqual([false, false, false, false, true, true, true, true]);
    const flagOf = (index: number): HTMLElement => {
      const flag = items()[index]?.querySelector<HTMLElement>(".attachment-flag");
      if (!flag) throw new Error(`No flag on item ${index}.`);
      return flag;
    };
    expect(flagOf(4).textContent).toBe("Over the limit");
    expect(flagOf(4).hidden).toBe(false);
    expect(flagOf(0).hidden).toBe(true);
    const message =
      "4 images are over the limits of SubQ Snap: up to 4 images, 64 KB in total. Remove the 4 marked images to run.";
    expect(control.blocked()).toBe(message);
    expect(notice()).toBe(message);
    expect(get(".attachments-notice").dataset.tone).toBe("alert");
    expect(status()).toBe(message);

    for (let index = 0; index < 4; index += 1) {
      items().at(-1)?.querySelector<HTMLButtonElement>(".attachment-remove")?.click();
    }
    expect(control.count()).toBe(4);
    expect(control.blocked()).toBeUndefined();
    expect(notice()).toBe("");
    expect(items().some((item) => item.hasAttribute("data-over-limit"))).toBe(false);
    // The removal that cleared the block says so, after the usual removal sentence.
    expect(status()).toBe(
      "Image removed: 5.png. 4 images remain. Your 4 images fit the limits of SubQ Snap.",
    );
  });

  it("judges a new image against the images that will be sent, not the marked ones", async () => {
    // A provider with room for both, then one whose per-request cap marks the second.
    const roomy = withImages(openai, { maxBytesPerRequest: 128 * KIB });
    const control = createAttachments(mount(), { prefix: "noul-images", provider: roomy });
    await control.add([png("a.png", 40 * KIB), png("b.png", 40 * KIB)]);
    control.setProvider(subq);
    expect(items().map((item) => item.hasAttribute("data-over-limit"))).toEqual([false, true]);
    await control.add([png("c.png", 30 * KIB)]);
    // 40 KB kept plus 30 KB: the marked 40 KB is not counted, so the sentence names 70 KB.
    expect(status()).toBe(
      "c.png was not added: with it the images would add up to 70 KB, over this instance's limit of 64 KB per request.",
    );
  });

  it("marks by bytes too, by position and running total, and uses the singular", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    await control.add([png("a.png", 30 * KIB), png("b.png", 30 * KIB)]);
    control.setProvider(withImages(subq, { maxBytesPerRequest: 32 * KIB }));
    expect(items().map((item) => item.hasAttribute("data-over-limit"))).toEqual([false, true]);
    expect(control.blocked()).toBe(
      "1 image is over the limits of SubQ Snap: up to 4 images, 32 KB in total. Remove the marked image to run.",
    );
    control.setProvider(withImages(subq, { maxBytesPerImage: 16 * KIB }));
    expect(items().map((item) => item.hasAttribute("data-over-limit"))).toEqual([true, true]);
    control.setProvider(openai);
    expect(control.blocked()).toBeUndefined();
    expect(status()).toBe("Your 2 images fit the limits of OpenAI Decisions and will be sent.");
  });

  it("drops the marks when the provider is text only, because nothing will be sent", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: openai });
    await control.add(Array.from({ length: 5 }, (_, index) => png(`${index + 1}.png`, 4 * KIB)));
    control.setProvider(subq);
    expect(control.blocked()).not.toBeUndefined();
    control.setProvider(typesafe);
    expect(control.blocked()).toBeUndefined();
    expect(items().some((item) => item.hasAttribute("data-over-limit"))).toBe(false);
  });

  it("refuses to add while no provider is selected", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: undefined });
    await control.add([png()]);
    expect(status()).toBe("poster.png was not added: no provider is selected.");
    control.setProvider(undefined);
    expect(status()).toBe("poster.png was not added: no provider is selected.");
  });
});

describe("edges the review asked for", () => {
  it("names a file within a kibibyte of the cap by its exact byte count, so the sentence cannot contradict itself", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([png("edge.png", 65_800)]);
    expect(status()).toBe(
      "edge.png was not added: it is 65,800 bytes, over this instance's limit of 64 KB per image.",
    );
    await control.add([png("a.png", 40 * KIB), png("b.png", 24 * KIB + 300)]);
    expect(status()).toContain(
      "b.png was not added: with it the images would add up to 65,836 bytes, over this instance's limit of 64 KB per request.",
    );
  });

  it("reports a file that cannot be read and goes on with the rest of the selection", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    const unreadable = png("gone.png");
    vi.spyOn(unreadable, "slice").mockImplementation(() => {
      throw new DOMException("The requested file could not be read.", "NotReadableError");
    });
    await control.add([png("a.png"), unreadable, png("b.png")]);
    expect(status()).toBe(
      "Image 1 added: a.png, 12 KB. gone.png was not added: it could not be read. Image 2 added: b.png, 12 KB.",
    );
    expect(control.files().map((file) => file.name)).toEqual(["a.png", "b.png"]);
    // The queue is not stuck: a later add still runs.
    await control.add([png("c.png")]);
    expect(control.count()).toBe(3);
  });

  it("keeps the file input and every Remove button in the tab order, each with a name", async () => {
    const form = mount();
    const control = createAttachments(form, { prefix: "noul-images", provider: subq });
    await control.add([png("a.png"), png("b.png")]);
    const focusable = [
      ...zone().querySelectorAll<HTMLElement>("input, button, a[href], [tabindex]"),
    ];
    expect(focusable.map((element) => element.tagName)).toEqual(["INPUT", "BUTTON", "BUTTON"]);
    for (const element of focusable) {
      expect(element.tabIndex).toBeGreaterThanOrEqual(0);
      expect(element.hasAttribute("disabled")).toBe(false);
    }
    expect(form.querySelector(`label[for="${input().id}"]`)?.textContent).toBe("Choose images");
    expect(focusable.slice(1).map((button) => button.textContent)).toEqual([
      "Remove a.png",
      "Remove b.png",
    ]);
  });

  it("keeps the same object URLs through a text-only round trip", async () => {
    const control = createAttachments(mount(), { prefix: "noul-images", provider: subq });
    await control.add([png("a.png"), png("b.png")]);
    const before = items().map((item) => item.querySelector("img")?.getAttribute("src"));
    createObjectURL.mockClear();
    control.setProvider(typesafe);
    control.setProvider(subq);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(items().map((item) => item.querySelector("img")?.getAttribute("src"))).toEqual(before);
  });
});
