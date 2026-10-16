/**
 * Byte counts as sentences write them. Both hosts and the browser import these,
 * so a limit reads the same in a 413, in a wire placeholder, and under the image
 * control. The units are binary (1 KB here is 1,024 bytes), written KB and MB
 * as the plan's placeholders are.
 */

/** A measured size, rounded for reading: `512 bytes`, `230 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** A limit, exact: `64 KB`, `2 MB`. Limits are set in whole kibibytes, so nothing is rounded away. */
export function sizeInWords(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes >= 1 ? `${mebibytes} MB` : `${bytes / 1024} KB`;
}
