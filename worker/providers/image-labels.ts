/**
 * The label each attached image carries in the text a model reads, such as
 * `Image 2: photo.jpg` (issue #57), and the cleaning of the file name inside it.
 *
 * The file name is typed by whoever picked the file, so it is text from outside
 * and is treated as such. `cleanFileName` runs once, where the Worker reads the
 * upload (`encodeImages`), so every later step holds a name that is one short
 * line. A name is placed in the provider's request and, because the wire view
 * shows that request, in the response. It is never placed in a log line or an
 * error message: those carry the image count only, because Varlock's leak
 * scanner replaces any response that contains a key's value (`docs/deploy.md`).
 */

/** The most characters (code points) of a file name kept in a label. A clipped name ends with `…`. */
export const MAX_FILE_NAME_CHARACTERS = 80;

/**
 * Characters that are removed from a name: control characters (line breaks and
 * tabs among them), format characters (zero-width and right-to-left overrides
 * among them), lone surrogates, private-use and unassigned code points, the
 * line and paragraph separators, variation selectors (which can carry hidden
 * bytes), and the few characters that draw as blank space. All of these can
 * hide text or break a label across lines.
 */
const UNSAFE_CHARACTERS =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Variation_Selector}\u034f\u115f\u1160\u3164\uffa0\u2800]/gu;

/**
 * A file name as it may appear in a label: only the part after the last `/` or
 * `\`, unsafe characters removed, runs of whitespace made one space, the ends
 * trimmed, and at most `MAX_FILE_NAME_CHARACTERS` characters kept, cut by code
 * point so a character outside the basic plane stays whole. A name cut short
 * ends with `…`. A name with nothing left returns the empty string.
 */
export function cleanFileName(name: string): string {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  const cleaned = base.replace(UNSAFE_CHARACTERS, "").replace(/\s+/gu, " ").trim();
  const characters = Array.from(cleaned);
  return characters.length <= MAX_FILE_NAME_CHARACTERS
    ? cleaned
    : `${characters.slice(0, MAX_FILE_NAME_CHARACTERS).join("").trimEnd()}…`;
}

/** What a label needs of an image: its already-cleaned name. */
export type Nameable = { name: string };

/** `Image 1: photo.jpg` for the first image, or `Image 1` when its name is empty. Numbers start at 1, as the list in the page does. */
export function imageLabel(image: Nameable, index: number): string {
  return image.name === "" ? `Image ${index + 1}` : `Image ${index + 1}: ${image.name}`;
}

/** One label per image, in the order the images are sent. */
export function imageLabels(images: readonly Nameable[]): string[] {
  return images.map(imageLabel);
}
