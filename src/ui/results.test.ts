// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { create } from "./dom.ts";
import {
  answersSentence,
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

function result(questionType: string, providers: string[] = ["SubQ Snap"]): Result {
  return {
    questionType,
    at,
    runs: providers.map((provider) => ({
      provider,
      reading: create("div", { className: "reading", text: `${provider} reading` }),
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
    const article = renderResultArticle(result("Choice"));
    expect(article.tagName).toBe("ARTICLE");
    const heading = article.querySelector("h3");
    expect(heading?.textContent).toBe("Choice on SubQ Snap at 14:32:05");
    expect(heading?.querySelector("time")?.getAttribute("datetime")).toBe(at.toISOString());
  });

  it("keeps each provider's reading and wire view together, in the order given", () => {
    const article = renderResultArticle(result("Noul", ["TypeSafe Jev", "SubQ Snap"]));
    expect(article.querySelector("h3")?.textContent).toBe(
      "Noul on TypeSafe Jev and SubQ Snap at 14:32:05",
    );
    const runs = [...article.querySelectorAll(".result-run")];
    expect(runs.map((run) => run.querySelector(".reading")?.textContent)).toEqual([
      "TypeSafe Jev reading",
      "SubQ Snap reading",
    ]);
    for (const run of runs) expect(run.querySelector(".wire-view")).not.toBeNull();
  });
});

describe("the sentences", () => {
  it("counts answers in one short sentence", () => {
    expect(answersSentence("Choice", "SubQ Snap", 4)).toBe("Choice on SubQ Snap: 4 answers.");
    expect(answersSentence("Score", "TypeSafe Jev", 1)).toBe("Score on TypeSafe Jev: 1 answer.");
  });

  it("names the provider while a run waits", () => {
    expect(loadingSentence("SubQ Snap")).toBe("Asking SubQ Snap…");
  });
});

describe("setupResults", () => {
  it("adds each result at the top and announces only the sentence it is given", () => {
    const results = setupResults(document);
    results.add(result("Noul"), "Noul on SubQ Snap: 4 answers.");
    results.add(result("Choice"), "Choice on SubQ Snap: 4 answers.");
    expect(headings()).toEqual([
      "Choice on SubQ Snap at 14:32:05",
      "Noul on SubQ Snap at 14:32:05",
    ]);
    expect(document.querySelector("#results-status")?.textContent).toBe(
      "Choice on SubQ Snap: 4 answers.",
    );
  });

  it(`keeps the newest ${RESULT_LIMIT} results and drops the oldest`, () => {
    const results = setupResults(document);
    for (let index = 1; index <= RESULT_LIMIT + 2; index += 1) {
      results.add(result(`Run ${index}`), "");
    }
    const kept = headings();
    expect(kept).toHaveLength(RESULT_LIMIT);
    expect(kept[0]).toMatch(/^Run 22 /);
    expect(kept.at(-1)).toMatch(/^Run 3 /);
  });

  it("clears the list, shows the empty message, and puts focus on the heading", () => {
    const results = setupResults(document);
    results.add(result("Noul"), "");
    results.clear();
    expect(headings()).toEqual([]);
    expect(document.querySelector<HTMLElement>("#results-empty")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#results-clear")?.hidden).toBe(true);
    expect(document.activeElement?.id).toBe("results-title");
  });
});
