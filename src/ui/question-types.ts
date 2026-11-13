import type { Primitive } from "../decision/contract.ts";

/**
 * The plain names the page gives the three question types, so a visitor who has
 * never used these APIs can tell them apart. The question type choice in
 * `index.html`, the request form's status sentences, the result headings, and
 * the vocabulary legend all use these names. The API's own word for each type,
 * such as `noul`, stays in the JSON view and the wire view, and each option in
 * the question type choice names it as its last line.
 */
export const QUESTION_TYPE_NAMES: Readonly<Record<Primitive, string>> = {
  noul: "Yes or no",
  choice: "Pick one option",
  score: "Score on a scale",
};
