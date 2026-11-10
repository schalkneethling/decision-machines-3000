import type { Primitive } from "../decision/contract.ts";

/**
 * The plain names the page gives the three question types, so a visitor who has
 * never used these APIs can tell them apart. Each panel's heading in
 * `index.html`, the panel's status sentences, its result headings, and the
 * vocabulary legend all use these names. The API's own word for each type, such
 * as `noul`, stays in the JSON view and the wire view, and the panel heading
 * names it as a second line.
 */
export const QUESTION_TYPE_NAMES: Readonly<Record<Primitive, string>> = {
  noul: "Yes or no",
  choice: "Pick one option",
  score: "Score on a scale",
};
