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

/**
 * A catalog limit, exact: `64 KB`, `2 MB`. Catalog limits are set in whole
 * kibibytes, so nothing is rounded away. An amount worked out at run time (the
 * room left in a request) is not, so it goes through `sizeAndLimit` instead.
 */
export function sizeInWords(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes >= 1 ? `${mebibytes} MB` : `${bytes / 1024} KB`;
}

const numberFormat = new Intl.NumberFormat("en");

function inBytes(bytes: number): string {
  return `${numberFormat.format(bytes)} bytes`;
}

/** What `formatBytes` shows for `bytes`, as a byte count: the size a reader takes the text to mean. */
function asRead(bytes: number): number {
  if (bytes < 1024) return bytes;
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) * 1024;
  return Number((bytes / (1024 * 1024)).toFixed(1)) * 1024 * 1024;
}

/**
 * A measured size beside a limit it broke, each as a reader will see it. The
 * limit is written exactly when rounding would not change it (a catalog limit,
 * so `64 KB` reads as it always has) and rounded like the size otherwise (the
 * room left in a request, which can be any number of bytes, and can be a whole
 * number of kibibytes by chance, such as 1,100 KiB). The size must always
 * read as larger than the limit: `formatBytes` rounds, so a file a few hundred
 * bytes over would read "64 KB, over the limit of 64 KB", or "34 KB, over the
 * 34.1 KB". When the two would not read in that order, the size is given in
 * exact bytes, and so is a limit that was not already exact.
 */
export function sizeAndLimit(size: number, limit: number): { measured: string; limit: string } {
  // Under 1 MB `sizeInWords` is exact only for whole kibibytes; above it, only for what `formatBytes` would show anyway.
  const exact = limit % 1024 === 0 && asRead(limit) === limit;
  const limitRead = exact ? limit : asRead(limit);
  const limitText = exact ? sizeInWords(limit) : formatBytes(limit);
  if (asRead(size) > limitRead) return { measured: formatBytes(size), limit: limitText };
  // An exact limit already reads as its bytes, so only the size needs them.
  return { measured: inBytes(size), limit: exact ? limitText : inBytes(limit) };
}
