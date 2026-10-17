import { formatBytes, measuredAgainst, sizeInWords } from "../providers/byte-size.ts";
import type { ImageCapabilities } from "../providers/catalog.ts";
import type { ProviderSummary } from "../providers/contract.ts";
import { SIGNATURE_BYTES, detectMediaType, imageDimensions } from "../providers/image-bytes.ts";
import type { ImageSize } from "../providers/image-bytes.ts";
import { create, required } from "./dom.ts";
import { capabilitySentence, formatList, imagesCount, sizeLimits } from "./image-sentences.ts";

/**
 * The image control of one panel (issue #16): a fieldset with a file input,
 * a drop zone, and a paste listener on the panel form, which follows the
 * selected provider. It appears only for a provider that takes images, and its
 * `accept` list, count, and size limits come from that provider's
 * `capabilities.images`, as `GET /api/providers` serves them. The client holds
 * no limit of its own.
 *
 * Every image goes through one pipeline, `admit`, whatever brought it in:
 *
 * 1. The count is checked against `maxCount`, before anything is read.
 * 2. The first twelve bytes are read and the real format detected. A file of
 *    no accepted format is refused here; the name and the declared type are
 *    never trusted (the Worker detects the format again and is authoritative).
 * 3. **The transform point.** The file, with its detected type and the
 *    provider's limits, goes through the `transform` the control was given.
 *    The default returns it unchanged. Issue #25 ("Shrink to fit",
 *    `shrink.ts`) plugs in here to downscale and re-encode an oversized
 *    picture, which may change its format, so step 2 runs again on what comes
 *    back. The limits it receives have `maxBytesPerImage` lowered to the room
 *    left in the request (the per-request cap minus the images that will be
 *    sent), so one budget is all the transform needs. It may refuse a file by
 *    throwing an `ImageRefusal`, whose message is announced as the reason.
 * 4. The size is checked against `maxBytesPerImage`, and the running total
 *    against `maxBytesPerRequest`, after the transform, so a shrunk picture is
 *    judged by its new size. An oversized file is refused without being read.
 * 5. The accepted file is read once for its pixel size, given an object URL
 *    for its thumbnail, and listed. It is kept as a `File` whose declared type
 *    is the detected one, and with a generated name when it arrived as a
 *    nameless `Blob`, so every multipart part has a filename and a true type.
 *
 * The status line (`role="status"`) announces what the user caused: an image
 * added, removed, or refused with the reason, and what a provider change does
 * to this panel's images. It says nothing on initial render, and nothing about
 * a provider change that leaves an empty list alone: the provider select's own
 * status line announces the new capability once, for all three panels.
 */

/** A picture the user attached, as the panel keeps it. */
export type Attachment = {
  /** The file as it will be sent: named, and declared as the type its bytes show. */
  file: File;
  mediaType: string;
  size: ImageSize | undefined;
  /** The thumbnail's object URL, revoked when the attachment is removed. */
  previewUrl: string;
  /** The size in bytes the file arrived with, when the transform made it smaller; otherwise undefined. */
  shrunkFrom: number | undefined;
  /** True when the selected provider cannot take this image, by count or by bytes. */
  overLimit: boolean;
  element: HTMLLIElement;
};

/** What the transform receives: the file as it arrived, named, with the type its first bytes show. */
export type ArrivedImage = { file: File; mediaType: string };

/**
 * The step between "a file arrived" and "check it against the limits". It
 * returns the file to go on with: the same one, or a new `File` with other
 * bytes, a matching declared type, and a name. The result is detected and
 * measured again before it is checked, so a transform may change the format.
 */
export type ImageTransform = (image: ArrivedImage, limits: ImageCapabilities) => Promise<File>;

/** The default transform: the file as it arrived. */
export const keepAsIs: ImageTransform = ({ file }) => Promise.resolve(file);

/**
 * Thrown by a transform to refuse a file with a reason the user should read,
 * such as "this browser cannot shrink images". The message completes the
 * sentence "photo.jpg was not added: ".
 */
export class ImageRefusal extends Error {}

export type AttachmentsOptions = {
  /** The prefix of every id the control mints, such as `noul-images`. */
  prefix: string;
  /** The provider selected when the control is built. The first render announces nothing. */
  provider: ProviderSummary | undefined;
  transform?: ImageTransform;
  /** Called after every change to the list or to what the provider makes of it. */
  onChange?: () => void;
};

export type Attachments = {
  /** Follows a provider change: shows or hides the control, updates its limits, marks the excess, and announces the effect. */
  setProvider(provider: ProviderSummary | undefined): void;
  /** The attached files, in order, as they are sent. */
  files(): readonly File[];
  count(): number;
  /** Why Run must wait, or undefined when every image fits the selected provider. */
  blocked(): string | undefined;
  /**
   * Runs `sources` through the pipeline, in order, and announces the outcome.
   * The way the file input, drop, and paste add images. With `quiet`, nothing is
   * announced, for a caller that announces the result in its own words.
   */
  add(sources: readonly Blob[], options?: { quiet?: boolean }): Promise<void>;
  /**
   * Removes every image, after any add still in flight, without announcing it:
   * the caller says what replaced them. Run's block and the limits follow.
   */
  clear(): Promise<void>;
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export const PRIVACY_NOTE =
  "Images go from your browser to this instance's Worker and then to the provider you picked. " +
  "The Worker does not store them. The provider may keep what it receives under its own terms. " +
  "Do not upload images you are not allowed to share with that company.";

/** Says how to ask about the pictures: the model reads them with the state and questions, and numbers them in list order. */
export const ASK_ABOUT_IMAGES =
  "Ask about the images in the state or a question, for example \u201cWhat does image 1 show?\u201d " +
  "The first image in the list is image 1, the next is image 2, and so on.";

/** `64 × 48`, or "size unknown" when the header did not say. */
function sizeText(size: ImageSize | undefined): string {
  return size === undefined ? "size unknown" : `${size.width} × ${size.height}`;
}

/**
 * The multipart body Run sends: the request JSON as the text of one `request`
 * part, then one `image` part per file, in order, each with its filename.
 * Parts are added with `append`, because `set` would replace the earlier
 * `image` parts (MDN, FormData.set). Nothing here sets a Content-Type: the
 * browser writes `multipart/form-data` with its boundary when it sends the form.
 */
export function toFormData(requestText: string, files: readonly File[]): FormData {
  const form = new FormData();
  form.append("request", requestText);
  for (const file of files) form.append("image", file, file.name);
  return form;
}

/**
 * Which attachments the provider can take, in order: an image fits while the
 * images that fit so far are fewer than the count, it is within the per-image
 * cap, and it keeps their running total within the per-request cap. The rest
 * are over the limit. Exported for its tests.
 */
export function fitsWithin(sizes: readonly number[], images: ImageCapabilities): boolean[] {
  let total = 0;
  let kept = 0;
  return sizes.map((size) => {
    const fits =
      kept < images.maxCount &&
      size <= images.maxBytesPerImage &&
      total + size <= images.maxBytesPerRequest;
    if (fits) {
      total += size;
      kept += 1;
    }
    return fits;
  });
}

/** The files a drop or a paste carries: the file items, or the `files` list when a browser fills only that. */
function filesIn(data: DataTransfer): File[] {
  const fromItems = [...data.items]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  return fromItems.length > 0 ? fromItems : [...data.files];
}

/** True when a drag carries at least one file, so the drop zone may accept it. */
function carriesFiles(data: DataTransfer | null | undefined): data is DataTransfer {
  return (
    data !== null && data !== undefined && [...data.items].some((item) => item.kind === "file")
  );
}

/** Builds the control in `form`'s `.attachments` container and wires the file input, the drop zone, and paste. */
export function createAttachments(
  form: HTMLFormElement,
  { prefix, provider, transform = keepAsIs, onChange }: AttachmentsOptions,
): Attachments {
  const host = required(form, ".attachments", HTMLElement);
  const ids = {
    input: `${prefix}-input`,
    instructions: `${prefix}-instructions`,
    hint: `${prefix}-hint`,
    limits: `${prefix}-limits`,
    privacy: `${prefix}-privacy`,
  };

  const legend = create("legend", { className: "attachments-legend", text: "Images" });
  const instructions = create("p", {
    className: "attachments-instructions",
    text: "Choose files with the button, drop them on this box, or paste an image into this panel.",
    attributes: { id: ids.instructions },
  });
  const hint = create("p", {
    className: "attachments-hint",
    text: ASK_ABOUT_IMAGES,
    attributes: { id: ids.hint },
  });
  const limits = create("p", { className: "attachments-limits", attributes: { id: ids.limits } });
  const label = create("label", {
    className: "attachments-label",
    text: "Choose images",
    attributes: { for: ids.input },
  });
  const input = create("input", {
    className: "attachments-input",
    attributes: {
      type: "file",
      id: ids.input,
      multiple: "",
      "aria-describedby": `${ids.instructions} ${ids.hint} ${ids.limits}`,
    },
  });
  const list = create("ul", { className: "attachments-list", attributes: { role: "list" } });
  const privacy = create("p", {
    className: "attachments-privacy",
    text: PRIVACY_NOTE,
    attributes: { id: ids.privacy },
  });
  const zone = create(
    "fieldset",
    { className: "attachments-zone", attributes: { "aria-describedby": ids.privacy } },
    [legend, instructions, hint, limits, label, input, list, privacy],
  );
  // Kept in the page, empty, so that filling it is announced; the zone may be hidden while it speaks.
  const notice = create("p", { className: "attachments-notice" });
  const status = create("p", { className: "attachments-status", attributes: { role: "status" } });
  host.replaceChildren(zone, notice, status);

  let current = provider;
  const attachments: Attachment[] = [];
  let pastedCount = 0;
  /** How many `add` calls have not finished; Run waits for them, or it would go without an image still being shrunk. */
  let pending = 0;
  /** Adds run one after another, so two drops cannot both pass the count check. */
  let queue: Promise<unknown> = Promise.resolve();

  function imagesOf(selected: ProviderSummary | undefined): ImageCapabilities | false {
    return selected === undefined ? false : selected.capabilities.images;
  }

  /** The bytes of the images that will be sent: the marked ones are left out, as they are of the request. */
  function totalBytes(): number {
    return attachments
      .filter((attachment) => !attachment.overLimit)
      .reduce((sum, attachment) => sum + attachment.file.size, 0);
  }

  function announce(text: string): void {
    status.textContent = text;
  }

  function setNotice(text: string, tone: "note" | "alert" = "note"): void {
    notice.textContent = text;
    notice.dataset.tone = tone;
  }

  /** The over-limit marks for the selected provider, and how many images carry one. */
  function markOverLimit(): number {
    const images = imagesOf(current);
    const fits =
      images === false
        ? attachments.map(() => true)
        : fitsWithin(
            attachments.map((attachment) => attachment.file.size),
            images,
          );
    let over = 0;
    attachments.forEach((attachment, index) => {
      attachment.overLimit = !(fits[index] ?? true);
      if (attachment.overLimit) over += 1;
      attachment.element.toggleAttribute("data-over-limit", attachment.overLimit);
      const flag = attachment.element.querySelector(".attachment-flag");
      if (flag instanceof HTMLElement) flag.hidden = !attachment.overLimit;
    });
    return over;
  }

  function blockedMessage(over: number): string | undefined {
    const images = imagesOf(current);
    if (over === 0 || images === false || current === undefined) return undefined;
    return (
      `${imagesCount(over)} ${over === 1 ? "is" : "are"} over the limits of ${current.displayName}: ` +
      `up to ${images.maxCount} images, ${sizeLimits(images)}. ` +
      `Remove the ${over === 1 ? "marked image" : `${over} marked images`} to run.`
    );
  }

  /** "Your 2 images fit the limits of SubQ Snap": said when a change makes every image fit again. */
  function fitSentence(): string {
    return `Your ${imagesCount(attachments.length)} fit the limits of ${current?.displayName ?? ""}`;
  }

  /** The fieldset, its limits, and the notice for the current provider. Returns the blocking message, if any. */
  function render(): string | undefined {
    const images = imagesOf(current);
    zone.hidden = images === false;
    if (images === false || current === undefined) {
      limits.textContent = "";
      input.removeAttribute("accept");
      markOverLimit();
      if (current !== undefined && attachments.length > 0) {
        setNotice(
          `${current.displayName} is text only. Your ${imagesCount(attachments.length)} ${attachments.length === 1 ? "is" : "are"} kept and will not be sent.`,
        );
      } else {
        setNotice("");
      }
      return undefined;
    }
    limits.textContent = capabilitySentence(current, images);
    // A comma-separated list of MIME types, as MDN's `accept` attribute page gives it.
    input.setAttribute("accept", images.mediaTypes.join(","));
    const blocked = blockedMessage(markOverLimit());
    if (blocked === undefined) setNotice("");
    else setNotice(blocked, "alert");
    return blocked;
  }

  function removeAttachment(attachment: Attachment): void {
    const index = attachments.indexOf(attachment);
    if (index === -1) return;
    const wasBlocked = attachments.some((other) => other.overLimit);
    attachments.splice(index, 1);
    URL.revokeObjectURL(attachment.previewUrl);
    attachment.element.remove();
    const blocked = render();
    // The pressed Remove is gone; hand focus to the next one, or back to the input.
    const next = attachments[index] ?? attachments.at(-1);
    (next?.element.querySelector<HTMLElement>(".attachment-remove") ?? input).focus();
    const remain =
      attachments.length === 0
        ? "No images remain."
        : `${imagesCount(attachments.length)} remain${attachments.length === 1 ? "s" : ""}.`;
    const freed =
      wasBlocked && blocked === undefined && attachments.length > 0 ? ` ${fitSentence()}.` : "";
    announce(`Image removed: ${attachment.file.name}. ${remain}${freed}`);
    onChange?.();
  }

  /** What a list item shows; the item itself and the over-limit mark are added once it is built. */
  type Listed = Omit<Attachment, "element" | "overLimit">;

  function itemFor(listed: Listed, onRemove: () => void): HTMLLIElement {
    const remove = create(
      "button",
      { className: "text-button attachment-remove", attributes: { type: "button" } },
      ["Remove ", create("span", { className: "visually-hidden", text: listed.file.name })],
    );
    remove.addEventListener("click", onRemove);
    return create("li", { className: "attachment" }, [
      create("img", {
        className: "attachment-thumb",
        attributes: { src: listed.previewUrl, alt: listed.file.name },
      }),
      create("span", { className: "attachment-name", text: listed.file.name }),
      create("span", {
        className: "attachment-meta",
        text: `${listed.mediaType}, ${formatBytes(listed.file.size)}, ${sizeText(listed.size)}`,
      }),
      ...(listed.shrunkFrom === undefined
        ? []
        : [
            create("span", {
              className: "attachment-shrunk",
              text: `Shrunk from ${formatBytes(listed.shrunkFrom)} to ${formatBytes(listed.file.size)}`,
            }),
          ]),
      create("span", {
        className: "attachment-flag",
        text: "Over the limit",
        attributes: { hidden: "" },
      }),
      remove,
    ]);
  }

  async function typeOf(blob: Blob): Promise<string | undefined> {
    return detectMediaType(new Uint8Array(await blob.slice(0, SIGNATURE_BYTES).arrayBuffer()));
  }

  /** The name a file arrived with, or a generated one for a nameless blob, such as a pasted image. */
  function nameFor(source: Blob, mediaType: string): string {
    if (source instanceof File && source.name !== "") return source.name;
    pastedCount += 1;
    return `pasted-image-${pastedCount}.${EXTENSIONS[mediaType] ?? "bin"}`;
  }

  /** A `File` of `source`'s bytes that is named and declared as its bytes show, reusing `source` when it already is. */
  function asFile(source: Blob, name: string, mediaType: string): File {
    if (source instanceof File && source.name === name && source.type === mediaType) return source;
    return new File([source], name, { type: mediaType });
  }

  /** How a refusal names the file: by its name, or as "The pasted image" for a nameless blob. */
  function labelOf(source: Blob): string {
    return source instanceof File && source.name !== "" ? source.name : "The pasted image";
  }

  /** The pipeline described at the top of this file. Returns the sentence to announce. */
  async function admit(source: Blob): Promise<string> {
    const label = labelOf(source);
    const images = imagesOf(current);
    if (current === undefined) return `${label} was not added: no provider is selected.`;
    if (images === false) return `${label} was not added: ${current.displayName} is text only.`;
    if (attachments.length >= images.maxCount) {
      return `${label} was not added: ${current.displayName} takes at most ${images.maxCount} images per request, and ${attachments.length} are attached.`;
    }

    const notAnImage = `${label} was not added: it is not a ${formatList(images.mediaTypes)} image, judging by its first bytes.`;
    const arrivedType = await typeOf(source);
    if (arrivedType === undefined || !images.mediaTypes.includes(arrivedType)) return notAnImage;
    const name = nameFor(source, arrivedType);
    const arrived = asFile(source, name, arrivedType);

    // The transform's budget is the smaller of the per-image cap and the room left in the request.
    const room = Math.max(0, images.maxBytesPerRequest - totalBytes());
    const budget = { ...images, maxBytesPerImage: Math.min(images.maxBytesPerImage, room) };
    let transformed: File;
    if (transform !== keepAsIs && arrived.size > budget.maxBytesPerImage) {
      announce(`Making ${name} smaller to fit…`);
    }
    try {
      transformed = await transform({ file: arrived, mediaType: arrivedType }, budget);
    } catch (error) {
      if (error instanceof ImageRefusal) return `${name} was not added: ${error.message}`;
      throw error;
    }
    const mediaType = transformed === arrived ? arrivedType : await typeOf(transformed);
    if (mediaType === undefined || !images.mediaTypes.includes(mediaType)) return notAnImage;

    if (transformed.size > images.maxBytesPerImage) {
      return `${name} was not added: it is ${measuredAgainst(transformed.size, images.maxBytesPerImage)}, over this instance's limit of ${sizeInWords(images.maxBytesPerImage)} per image.`;
    }
    const total = totalBytes() + transformed.size;
    if (total > images.maxBytesPerRequest) {
      return `${name} was not added: with it the images would add up to ${measuredAgainst(total, images.maxBytesPerRequest)}, over this instance's limit of ${sizeInWords(images.maxBytesPerRequest)} per request.`;
    }

    const file = asFile(transformed, transformed.name === "" ? name : transformed.name, mediaType);
    const size = imageDimensions(new Uint8Array(await file.arrayBuffer()), mediaType);
    const shrunkFrom = transformed === arrived ? undefined : arrived.size;
    const listed: Listed = {
      file,
      mediaType,
      size,
      shrunkFrom,
      previewUrl: URL.createObjectURL(file),
    };
    const attachment: Attachment = {
      ...listed,
      overLimit: false,
      element: itemFor(listed, () => removeAttachment(attachment)),
    };
    attachments.push(attachment);
    list.append(attachment.element);
    render();
    onChange?.();
    const shrunk =
      shrunkFrom === undefined
        ? ""
        : ` Shrunk from ${formatBytes(shrunkFrom)} to ${formatBytes(file.size)} (${sizeText(size)}).`;
    return `Image ${attachments.length} added: ${file.name}, ${formatBytes(file.size)}.${shrunk}`;
  }

  function add(sources: readonly Blob[], { quiet = false } = {}): Promise<void> {
    if (sources.length === 0) return Promise.resolve();
    pending += 1;
    onChange?.();
    const run = queue.then(async () => {
      const sentences: string[] = [];
      for (const source of sources) {
        try {
          sentences.push(await admit(source));
        } catch {
          // A file moved or changed since it was chosen cannot be read; the rest of the selection still goes on.
          sentences.push(`${labelOf(source)} was not added: it could not be read.`);
        }
      }
      if (!quiet) announce(sentences.join(" "));
    });
    queue = run.catch(() => {});
    return run;
  }

  function clear(): Promise<void> {
    const run = queue.then(() => {
      for (const attachment of attachments) URL.revokeObjectURL(attachment.previewUrl);
      attachments.length = 0;
      list.replaceChildren();
      // Emptied quietly, so the last sentence about an image is not left behind for a later read.
      announce("");
      render();
      onChange?.();
    });
    run
      .finally(() => {
        pending -= 1;
        onChange?.();
      })
      .catch(() => {});
    queue = run.catch(() => {});
    return run;
  }

  input.addEventListener("change", () => {
    const chosen = [...(input.files ?? [])];
    // Cleared so the same file can be chosen again, and so the input never holds a stale selection.
    input.value = "";
    add(chosen).catch(() => {});
  });

  // The drop zone must cancel dragover for drop to fire (MDN, File drag and drop).
  zone.addEventListener("dragover", (event) => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    zone.dataset.dragging = "true";
  });
  zone.addEventListener("dragleave", () => {
    delete zone.dataset.dragging;
  });
  zone.addEventListener("drop", (event) => {
    delete zone.dataset.dragging;
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    add(filesIn(event.dataTransfer)).catch(() => {});
  });

  // A paste that carries files is taken for the images; a text paste is left to the focused field.
  form.addEventListener("paste", (event) => {
    const data = event.clipboardData;
    if (!carriesFiles(data)) return;
    event.preventDefault();
    add(filesIn(data)).catch(() => {});
  });

  render();

  return {
    setProvider(next) {
      const before = current;
      current = next;
      const blocked = render();
      onChange?.();
      if (next === undefined || attachments.length === 0) return;
      const count = imagesCount(attachments.length);
      if (next.capabilities.images === false) {
        announce(
          `${next.displayName} is text only; your ${count} ${attachments.length === 1 ? "is" : "are"} kept and will not be sent`,
        );
      } else if (blocked !== undefined) {
        announce(blocked);
      } else if (before === undefined || before.capabilities.images === false) {
        announce(`Image input available again; your ${count} will be sent.`);
      } else {
        announce(`${fitSentence()} and will be sent.`);
      }
    },
    files: () => attachments.map((attachment) => attachment.file),
    count: () => attachments.length,
    blocked: () =>
      pending > 0
        ? "Images are still being added. Run is available once they are."
        : blockedMessage(attachments.filter((attachment) => attachment.overLimit).length),
    add,
    clear,
  };
}
