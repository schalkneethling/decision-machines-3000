/**
 * The search that finds the largest picture that fits a byte budget (issue
 * #25). It knows nothing about canvases or the DOM: it is given the picture's
 * size, the budget, and an `encode` function, and it walks a fixed list of
 * long-edge sizes and encoder qualities until one result fits. The browser
 * supplies a real encoder (`shrink-browser.ts`); tests supply a fake one,
 * because happy-dom can neither decode nor encode an image.
 *
 * The order is: the largest edge first, and at each edge the highest quality
 * first. The first result at or under the budget wins, so the user keeps as
 * much of the picture as the budget allows, and the search encodes at most
 * `edges.length * qualities.length` times, so it cannot loop.
 */

/** The only two formats the search asks for: JPEG for opaque pictures, WebP for pictures with transparency. */
export type OutputType = "image/jpeg" | "image/webp";

/** One thing to try: a pixel size, a format, and an encoder quality between 0 and 1. */
export type Attempt = { width: number; height: number; type: OutputType; quality: number };

/**
 * Encodes the picture as `attempt` says. The blob's own `type` is what the
 * encoder really produced, which can differ from `attempt.type`: a canvas
 * answers PNG for a format it cannot encode.
 */
export type Encoder = (attempt: Attempt) => Promise<Blob>;

export type SearchPlan = {
  /** Long-edge sizes in pixels, largest first. */
  edges: readonly number[];
  /** Encoder qualities, highest first. */
  qualities: readonly number[];
};

/**
 * Edges of 1024, 768, and 512 px, and qualities of 0.8, 0.6, and 0.4. At the
 * 64 KiB caps a 12-megapixel photo usually fits at 1024 px or 768 px; 512 px
 * at 0.4 is the floor, below which a picture stops being useful to a model.
 */
export const DEFAULT_PLAN: SearchPlan = {
  edges: [1024, 768, 512],
  qualities: [0.8, 0.6, 0.4],
};

export type SearchResult =
  | { kind: "fit"; blob: Blob; width: number; height: number }
  | {
      kind: "too-big";
      /** The smallest pixel size that was tried. */
      width: number;
      height: number;
      /** The smallest byte count any attempt produced. */
      smallestBytes: number;
    };

/** The pixel sizes to try: each edge scaled to, never enlarging the picture, and without a repeated size. */
export function sizesFor(
  width: number,
  height: number,
  edges: readonly number[],
): { width: number; height: number }[] {
  const longEdge = Math.max(width, height);
  const sizes: { width: number; height: number }[] = [];
  for (const edge of edges) {
    const scale = Math.min(1, edge / longEdge);
    const size = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
    const previous = sizes.at(-1);
    if (
      previous === undefined ||
      previous.width !== size.width ||
      previous.height !== size.height
    ) {
      sizes.push(size);
    }
  }
  return sizes;
}

/**
 * Finds the first attempt whose result is at most `budget` bytes. A result whose
 * `type` differs from the one asked for (a browser without a WebP encoder
 * answering PNG) is kept if it fits, because the caller declares the type the
 * bytes show; and since PNG has no quality, the remaining qualities at that
 * edge are skipped. `budget` must be positive and the picture at least 1 by 1.
 */
export async function searchSizes(
  picture: { width: number; height: number },
  budget: number,
  type: OutputType,
  encode: Encoder,
  plan: SearchPlan = DEFAULT_PLAN,
): Promise<SearchResult> {
  const sizes = sizesFor(picture.width, picture.height, plan.edges);
  let smallestBytes = Number.POSITIVE_INFINITY;
  for (const { width, height } of sizes) {
    for (const quality of plan.qualities) {
      const blob = await encode({ width, height, type, quality });
      smallestBytes = Math.min(smallestBytes, blob.size);
      if (blob.size <= budget) return { kind: "fit", blob, width, height };
      if (blob.type !== type) break;
    }
  }
  const last = sizes.at(-1) ?? { width: picture.width, height: picture.height };
  return { kind: "too-big", width: last.width, height: last.height, smallestBytes };
}
