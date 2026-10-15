import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_ORDER } from "../providers/catalog.ts";
import { VOCABULARY } from "./vocabulary.ts";

function term(shared: string, provider: (typeof PROVIDER_ORDER)[number]): string {
  const row = VOCABULARY.find((candidate) => candidate.shared === shared);
  if (row === undefined) throw new Error(`No row for ${shared}.`);
  return row.byProvider[provider];
}

describe("vocabulary legend", () => {
  it("has a word for every provider in every row", () => {
    for (const row of VOCABULARY) {
      for (const id of PROVIDER_ORDER) expect(row.byProvider[id], row.shared).not.toBe("");
    }
  });

  it("gives OpenAI score levels a label, and a description only for a structured level, as its adapter sends", () => {
    expect(term("Score levels", "openai")).toBe(
      "`levels`, a list of `label`, with a `description` for a structured level",
    );
  });

  it("says OpenAI gets the yes/no meanings as lines in the instructions, as its adapter sends", () => {
    expect(term("Yes/no meaning", "openai")).toBe(
      "No such field; added to `instructions` as “Yes means:” and “No means:” lines",
    );
  });

  it("says the refusal answer is this app's own shape, and that the other providers send none", () => {
    expect(term("A question the model declines", "openai")).toContain("This app shows it as");
    for (const id of ["typesafe", "subq"] as const) {
      expect(term("A question the model declines", id)).toBe(
        "No refusal answer in this provider's replies",
      );
    }
  });
});
