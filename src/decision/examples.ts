import type { DecisionRequest, Primitive } from "./contract.ts";
import { validateDecisionRequest } from "./validate.ts";
import type { ValidDecisionRequest } from "./validate.ts";
import { PROVIDER_ORDER, PROVIDERS } from "../providers/catalog.ts";
import filmNoul from "./examples/film/noul.json" with { type: "json" };
import filmChoice from "./examples/film/choice.json" with { type: "json" };
import filmScore from "./examples/film/score.json" with { type: "json" };
import imagesNoul from "./examples/images/noul.json" with { type: "json" };
import imagesChoice from "./examples/images/choice.json" with { type: "json" };
import imagesScore from "./examples/images/score.json" with { type: "json" };
// `?no-inline` keeps each picture a file in the build (Vite's asset suffix, declared in
// node_modules/vite/dist/vite/client.d.ts); without it, a picture this small would be
// inlined into the bundle as base64, which the owner ruled out for the samples.
import redSquare from "./examples/images/picture-1.png?no-inline";
import blueCircle from "./examples/images/picture-2.png?no-inline";
import greenTriangle from "./examples/images/picture-3.png?no-inline";
import busyScene from "./examples/images/picture-4.png?no-inline";

/**
 * The two example sets a panel can load (issue #58). Neither loads by itself:
 * every panel opens empty, and a person presses a load button.
 *
 * Each request is a JSON file under `examples/`, so the data is plain data,
 * and it is checked with the request validator the moment this module loads.
 * JSON has no literal types, so an imported file is typed as strings and
 * objects; `validated` turns it into a `DecisionRequest` through the schema,
 * never a cast, and throws if a file stops being a valid request for any
 * provider. `examples.test.ts` loads every file so that such a change fails
 * there first.
 *
 * - **Film reviews.** All three share one subject, a small fictional film
 *   catalogue, so the reader can compare what each primitive is good for:
 *   Noul answers several independent yes/no questions about one review,
 *   Choice sorts every film into a genre in a single request (one question per
 *   film), and Score places every film on the same ordered scale so the answers
 *   can be ranked. Backticked paths such as `films[2]` point the model at one
 *   part of a structured state.
 * - **Images.** Each request asks about the four sample pictures the set
 *   attaches, naming them "image 1" to "image 4" in the order they are listed
 *   (issue #57 labels them so for the model). Noul asks yes/no questions about
 *   single pictures, Choice names what each one shows, and Score rates how
 *   cluttered each is. The pictures are this project's own, drawn by
 *   `scripts/sample-images.ts`; `examples/images/README.md` records their licence.
 *
 * Question ids are for code only; the model never sees them, so each
 * `instructions` carries the complete question.
 */

export type ExampleSetId = "film" | "images";

export const EXAMPLE_SET_IDS: readonly ExampleSetId[] = ["film", "images"];

/** Whether `value` names an example set; the load buttons carry the id in a data attribute. */
export function isExampleSetId(value: string | undefined): value is ExampleSetId {
  return EXAMPLE_SET_IDS.some((id) => id === value);
}

/** A picture an example set attaches, as a bundled asset the browser fetches. */
export type SampleImage = {
  /** The file name the image control lists, and the one the model's label carries. */
  name: string;
  mediaType: "image/png";
  /** Where the browser fetches it from: the file's URL in the build, never inlined. */
  url: string;
};

export type ExampleSet = {
  id: ExampleSetId;
  /** How a button and a status line name the set: "film example", "image example". */
  label: string;
  requests: { [P in Primitive]: DecisionRequest<P> };
  /** The pictures the set attaches, in the order they are listed. Empty for a text-only set. */
  images: readonly SampleImage[];
};

/** The member of the validated union for one primitive; `DecisionRequest<P>` equals it at every concrete `P`. */
type RequestFor<P extends Primitive> = Extract<ValidDecisionRequest, { primitive: P }>;

/** Whether a validated request is the member for `primitive`; narrows the union to that member. */
function isFor<P extends Primitive>(
  value: ValidDecisionRequest,
  primitive: P,
): value is RequestFor<P> {
  return value.primitive === primitive;
}

/**
 * `raw`, read from `file`, as the request it must be: valid for every
 * provider's limits and of the expected primitive. Throws otherwise, naming
 * the file and the first provider that refuses it.
 */
function validated<P extends Primitive>(primitive: P, file: string, raw: unknown): RequestFor<P> {
  let value: ValidDecisionRequest | undefined;
  for (const id of PROVIDER_ORDER) {
    const provider = PROVIDERS[id];
    const result = validateDecisionRequest(raw, provider.capabilities);
    if (!result.ok) {
      const where = result.detail === undefined ? "" : ` Path: ${result.detail}.`;
      throw new Error(
        `The example ${file} is not a valid request for ${provider.displayName}: ${result.error}${where}`,
      );
    }
    value = result.value;
  }
  if (value === undefined || !isFor(value, primitive)) {
    throw new Error(`The example ${file} must be a "${primitive}" request.`);
  }
  return value;
}

export const filmExamples: ExampleSet = {
  id: "film",
  label: "film example",
  requests: {
    noul: validated("noul", "film/noul.json", filmNoul),
    choice: validated("choice", "film/choice.json", filmChoice),
    score: validated("score", "film/score.json", filmScore),
  },
  images: [],
};

export const imageExamples: ExampleSet = {
  id: "images",
  label: "image example",
  requests: {
    noul: validated("noul", "images/noul.json", imagesNoul),
    choice: validated("choice", "images/choice.json", imagesChoice),
    score: validated("score", "images/score.json", imagesScore),
  },
  // Numbered, not descriptive, names: the model reads each file name in the image's label (#57), and a name
  // that describes the picture would answer the questions without the model looking at it.
  images: [
    { name: "picture-1.png", mediaType: "image/png", url: redSquare },
    { name: "picture-2.png", mediaType: "image/png", url: blueCircle },
    { name: "picture-3.png", mediaType: "image/png", url: greenTriangle },
    { name: "picture-4.png", mediaType: "image/png", url: busyScene },
  ],
};

export const EXAMPLE_SETS: Readonly<Record<ExampleSetId, ExampleSet>> = {
  film: filmExamples,
  images: imageExamples,
};

/** The film requests by their long-standing names; the fixtures and the adapter tests answer them. */
export const noulExample: DecisionRequest<"noul"> = filmExamples.requests.noul;
export const choiceExample: DecisionRequest<"choice"> = filmExamples.requests.choice;
export const scoreExample: DecisionRequest<"score"> = filmExamples.requests.score;
