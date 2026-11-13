// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { noulExample } from "../decision/examples.ts";
import { create } from "./dom.ts";
import { noulResponse } from "./fixtures/noul.ts";
import {
  answersSentence,
  comparedSentence,
  loadingSentence,
  RESULT_LIMIT,
  renderResultArticle,
  setupResults,
} from "./results.ts";
import type { Result } from "./results.ts";

const page = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
const body = (/<body>([\s\S]*)<\/body>/.exec(page)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);

// Built from local parts, so it reads 14:32:05 in whatever time zone the tests run.
const at = new Date(2026, 10, 10, 14, 32, 5);

/** A result whose providers all failed, so each reading is the element given. */
function result(questionType: string, providers: string[] = ["SubQ Snap"]): Result {
  return {
    questionType,
    at,
    sent: undefined,
    runs: providers.map((provider) => ({
      provider,
      outcome: {
        kind: "failed",
        reading: create("div", { className: "reading", text: `${provider} reading` }),
      },
      wire: create("div", { className: "wire-view" }),
    })),
  };
}

function headings(): string[] {
  return [...document.querySelectorAll("#results-list h3")].map((h3) => h3.textContent ?? "");
}

beforeEach(() => {
  document.body.innerHTML = body;
});

describe("renderResultArticle", () => {
  it("is an article whose h3 names the question type, the provider, and the time", () => {
    const article = renderResultArticle(result("Pick one option"));
    expect(article.tagName).toBe("ARTICLE");
    const heading = article.querySelector("h3");
    expect(heading?.textContent).toBe("Pick one option: SubQ Snap at 14:32:05");
    expect(heading?.querySelector("time")?.getAttribute("datetime")).toBe(at.toISOString());
  });

  it("keeps one provider's reading and wire view together", () => {
    const article = renderResultArticle(result("Yes or no"));
    const runs = [...article.querySelectorAll(".result-run")];
    expect(runs).toHaveLength(1);
    expect(runs[0]?.querySelector(".reading")?.textContent).toBe("SubQ Snap reading");
    expect(runs[0]?.querySelector(".wire-view")).not.toBeNull();
    expect(article.querySelector("table")).toBeNull();
  });
});

describe("a result from several providers (issue #101)", () => {
  /** TypeSafe Jev answered with the Noul fixture; SubQ Snap answered or failed. */
  function compared(subqFails: boolean): Result {
    if (!noulResponse.ok) throw new Error("The Noul fixture is a success.");
    return {
      questionType: "Yes or no",
      at,
      sent: noulExample,
      runs: [
        {
          provider: "TypeSafe Jev",
          outcome: { kind: "answered", response: noulResponse, omittedImages: 2 },
          wire: create("div", { className: "wire-view" }),
        },
        {
          provider: "SubQ Snap",
          outcome: subqFails
            ? {
                kind: "failed",
                reading: create("div", {
                  className: "readout-error",
                  text: "Error. Rate limited.",
                }),
              }
            : { kind: "answered", response: noulResponse, omittedImages: 0 },
          wire: undefined,
        },
      ],
    };
  }

  function cellTexts(row: Element): string[] {
    return [...row.querySelectorAll("th, td")].map((cell) => cell.textContent ?? "");
  }

  it("is one table with a row per question and a column per provider, in the order given", () => {
    const article = renderResultArticle(compared(false));
    expect(article.querySelector("h3")?.textContent).toBe(
      "Yes or no: TypeSafe Jev and SubQ Snap at 14:32:05",
    );
    const table = article.querySelector("table");
    expect(table?.querySelector("caption")?.textContent).toBe("Answers by question and provider");
    const [head, ...rows] = [...(table?.querySelectorAll("tr") ?? [])];
    expect(head === undefined ? [] : cellTexts(head)).toEqual([
      "Question",
      "TypeSafe Jev",
      "SubQ Snap",
    ]);
    expect(rows).toHaveLength(Object.keys(noulExample.questions).length);
    // A row is headed by the question as it was asked, so one row reads one question's answers.
    const [first] = rows;
    const header = first?.querySelector("th");
    expect(header?.getAttribute("scope")).toBe("row");
    expect(header?.textContent).toBe(noulExample.questions.recommends?.instructions);
    expect([...(first?.querySelectorAll("td") ?? [])].map((cell) => cell.dataset.provider)).toEqual(
      ["TypeSafe Jev", "SubQ Snap"],
    );
    expect(first?.querySelectorAll(".bar-value")).toHaveLength(2);
  });

  it("gives each provider its own metadata and wire view below the table", () => {
    const article = renderResultArticle(compared(false));
    const sections = [...article.querySelectorAll(".result-provider")];
    expect(sections.map((section) => section.querySelector("h4")?.textContent)).toEqual([
      "TypeSafe Jev",
      "SubQ Snap",
    ]);
    expect(sections[0]?.querySelector(".reading-meta")?.textContent).toContain(
      "Sent without the 2 attached images.",
    );
    expect(sections[0]?.querySelector(".wire-view")).not.toBeNull();
    expect(sections[1]?.querySelector(".wire-view")).toBeNull();
  });

  it("shows a failed provider's column as no answer, and its failure beside the answers that arrived", () => {
    const article = renderResultArticle(compared(true));
    const rows = [...article.querySelectorAll("tbody tr")];
    expect(rows).toHaveLength(Object.keys(noulExample.questions).length);
    for (const row of rows) {
      expect(row.querySelector('[data-provider="SubQ Snap"]')?.textContent).toBe("No answer");
    }
    const failed = [...article.querySelectorAll(".result-provider")][1];
    expect(failed?.querySelector(".readout-error")?.textContent).toBe("Error. Rate limited.");
  });
});

describe("the sentences", () => {
  it("counts answers in one short sentence", () => {
    expect(answersSentence("Pick one option", "SubQ Snap", 4)).toBe(
      "Pick one option: SubQ Snap gave 4 answers.",
    );
    expect(answersSentence("Score on a scale", "TypeSafe Jev", 1)).toBe(
      "Score on a scale: TypeSafe Jev gave 1 answer.",
    );
  });

  it("names the providers while a run waits", () => {
    expect(loadingSentence(["SubQ Snap"])).toBe("Asking SubQ Snap…");
    expect(loadingSentence(["TypeSafe Jev", "SubQ Snap"])).toBe(
      "Asking TypeSafe Jev and SubQ Snap…",
    );
  });

  it("says how many of the asked providers answered, and names them", () => {
    expect(comparedSentence("Yes or no", ["TypeSafe Jev", "SubQ Snap"], 3)).toBe(
      "Yes or no: 2 of 3 providers answered, TypeSafe Jev and SubQ Snap.",
    );
    // Every failure announces itself in its own alert.
    expect(comparedSentence("Yes or no", [], 2)).toBe("");
  });
});

describe("setupResults", () => {
  it("adds each result at the top and announces only the sentence it is given", () => {
    const results = setupResults(document);
    results.add(result("Yes or no"), "Yes or no: SubQ Snap gave 4 answers.");
    results.add(result("Pick one option"), "Pick one option: SubQ Snap gave 4 answers.");
    expect(headings()).toEqual([
      "Pick one option: SubQ Snap at 14:32:05",
      "Yes or no: SubQ Snap at 14:32:05",
    ]);
    expect(document.querySelector("#results-status")?.textContent).toBe(
      "Pick one option: SubQ Snap gave 4 answers.",
    );
  });

  it(`keeps the newest ${RESULT_LIMIT} results and drops the oldest`, () => {
    const results = setupResults(document);
    for (let index = 1; index <= RESULT_LIMIT + 2; index += 1) {
      results.add(result(`Run ${index}`), "");
    }
    const kept = headings();
    expect(kept).toHaveLength(RESULT_LIMIT);
    expect(kept[0]).toMatch(/^Run 22: /);
    expect(kept.at(-1)).toMatch(/^Run 3: /);
  });

  it("clears the list, shows the empty message, and puts focus on the heading", () => {
    const results = setupResults(document);
    results.add(result("Yes or no"), "");
    results.clear();
    expect(headings()).toEqual([]);
    expect(document.querySelector<HTMLElement>("#results-empty")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#results-clear")?.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("results-title");
  });
});
