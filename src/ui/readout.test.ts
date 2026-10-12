// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import type { JevFailure } from "../jev/contract.ts";
import { choiceExample, noulExample, scoreExample } from "../jev/examples.ts";
import { isJevResponse } from "./client.ts";
import { choiceResponse } from "./fixtures/choice.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { scoreResponse } from "./fixtures/score.ts";
import { describeJsonError } from "./json-error.ts";
import {
  formatProbability,
  metadataSentence,
  questionText,
  renderLoading,
  renderResponse,
  renderUnreachable,
  scoreLevels,
} from "./readout.ts";

function texts(root: Element, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((element) => element.textContent ?? "");
}

function barValues(root: Element): string[] {
  return [...root.querySelectorAll<HTMLElement>(".bar")].map((bar) =>
    bar.style.getPropertyValue("--value"),
  );
}

describe("renderResponse for Noul", () => {
  const readout = renderResponse(noulExample, noulResponse);

  it("states who answered, how fast, with how many input tokens, and over which connection", () => {
    expect(readout.querySelector(".reading-meta")?.textContent).toBe(
      "Answered by jev-1.13.0 in 474 ms using 452 input tokens over the warm connection.",
    );
  });

  it("uses the sent instructions as each question and turns backticks into code", () => {
    const headings = readout.querySelectorAll("h3");
    expect(headings).toHaveLength(4);
    expect(headings[0]?.textContent).toBe("Does the reviewer recommend watching the film?");
    expect(headings[1]?.querySelector("code")?.textContent).toBe("review");
  });

  it("renders one bar per question with a two-decimal number", () => {
    expect(texts(readout, ".bar-value")).toEqual(["0.93", "0.97", "0.98", "0.98"]);
    expect(barValues(readout)).toEqual(["0.93", "0.97", "0.98", "0.98"]);
    for (const bar of readout.querySelectorAll(".bar")) {
      expect(bar.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("keeps the raw response open in a details element", () => {
    const details = readout.querySelector("details");
    expect(details?.open).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("Raw response");
    expect(JSON.parse(details?.querySelector("pre code")?.textContent ?? "")).toEqual(noulResponse);
  });
});

describe("renderResponse for Choice", () => {
  const readout = renderResponse(choiceExample, choiceResponse);
  const [, second] = readout.querySelectorAll(".answer");

  it("states the chosen option and its confidence", () => {
    expect(second?.querySelector(".answer-verdict")?.textContent).toBe(
      "Jev chose other with confidence 0.68.",
    );
  });

  it("lists every option sorted by probability, highest first", () => {
    if (!second) throw new Error("expected a second answer");
    const labels = texts(second, "dt");
    expect(labels).toHaveLength(7);
    expect(labels.slice(0, 3)).toEqual(["other", "romantic_comedy", "documentary"]);
    expect(texts(second, "dd .bar-value").slice(0, 3)).toEqual(["0.73", "0.26", "0.01"]);
  });
});

describe("renderResponse for Score", () => {
  const readout = renderResponse(scoreExample, scoreResponse);

  it("states the score on the scale with its confidence", () => {
    expect(readout.querySelector(".answer-verdict")?.textContent).toBe(
      "Jev scored this 0.89 on a scale of 0 to 3, with confidence 0.89.",
    );
  });

  it("places the marker on a track with one tick per level", () => {
    const track = readout.querySelector<HTMLElement>(".score-track");
    expect(readout.querySelectorAll(".score-track")).toHaveLength(4);
    expect(texts(track ?? readout, ".score-tick")).toEqual(["0", "1", "2", "3"]);
    const marker = track?.querySelector<HTMLElement>(".score-marker");
    expect(Number(marker?.style.getPropertyValue("--position"))).toBeCloseTo(0.89 / 3);
  });

  it("lists each level's legend with its probability", () => {
    const [first] = readout.querySelectorAll(".answer");
    if (!first) throw new Error("expected an answer");
    expect(texts(first, "dt")[0]).toBe(
      "0Gentle throughout: nothing frightening, violent, or upsetting.",
    );
    expect(texts(first, "dd .bar-value")).toEqual(["0.11", "0.89", "0.00", "0.00"]);
  });

  it("keeps non-numeric keys out of the scale but in the bars", () => {
    const [id, answer] = Object.entries(scoreResponse.answers)[0] ?? [];
    if (!id || !answer) throw new Error("expected an answer");
    const odd = renderResponse(scoreExample, {
      ...scoreResponse,
      answers: {
        [id]: { ...answer, legend: {}, probabilities: { "0": 0.1, "1": 0.2, "2": 0.6, x: 0.1 } },
      },
    });
    expect(odd.querySelector(".answer-verdict")?.textContent).toBe(
      "Jev scored this 0.89 on a scale of 0 to 2, with confidence 0.89.",
    );
    const [first] = odd.querySelectorAll(".answer");
    if (!first) throw new Error("expected an answer");
    expect(texts(first, ".score-tick")).toEqual(["0", "1", "2"]);
    expect(texts(first, ".bars-level")).toEqual(["0", "1", "2", "x"]);
  });

  it("describes levels whose legend entry is null", () => {
    const [id, answer] = Object.entries(scoreResponse.answers)[0] ?? [];
    if (!id || !answer) throw new Error("expected an answer");
    const undescribed = renderResponse(scoreExample, {
      ...scoreResponse,
      answers: { [id]: { ...answer, legend: { ...answer.legend, "3": null } } },
    });
    expect(texts(undescribed, "dt")[3]).toBe("3No description");
  });
});

describe("scoreLevels", () => {
  const answer = (legend: string[], probabilities: string[]) => ({
    type: "score" as const,
    score: 0,
    confidence: 1,
    legend: Object.fromEntries(legend.map((key) => [key, null])),
    probabilities: Object.fromEntries(probabilities.map((key) => [key, 0])),
  });

  it("sorts numeric keys by value and non-numeric keys after them", () => {
    expect(scoreLevels(answer(["2", "x", "0"], []))).toEqual(["0", "2", "x"]);
    expect(scoreLevels(answer(["2", "", "0"], []))).toEqual(["0", "2", ""]);
    expect(scoreLevels(answer(["2", "  ", "0"], []))).toEqual(["0", "2", "  "]);
    expect(scoreLevels(answer(["2", "0"], ["x", "1", "10"]))).toEqual(["0", "1", "2", "10", "x"]);
  });
});

describe("renderResponse for a failure", () => {
  const failure: JevFailure = {
    ok: false,
    error: "TypeSafe rejected the API key.",
    detail: "HTTP 401",
  };
  const readout = renderResponse({}, failure);

  it("announces the error and its detail as an alert", () => {
    const alert = readout.querySelector('[role="alert"]');
    expect(alert?.querySelector(".readout-error-message")?.textContent).toBe(failure.error);
    expect(alert?.querySelector(".readout-error-detail")?.textContent).toBe("HTTP 401");
    expect(alert?.querySelector("details")).toBeNull();
  });

  it("omits the detail line when there is none", () => {
    const bare = renderResponse({}, { ok: false, error: "Nope." });
    expect(bare.querySelector(".readout-error-detail")).toBeNull();
  });
});

describe("status renderers", () => {
  it("shows the loading sentence", () => {
    expect(renderLoading().textContent).toBe("Asking Jev…");
  });

  it("tells the user to start the dev server when the endpoint is unreachable", () => {
    const alert = renderUnreachable("Failed to fetch");
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.querySelector(".readout-error-message")?.textContent).toBe(
      "Could not reach the Jev endpoint. Is vp dev running?",
    );
    expect(alert.querySelector("code")?.textContent).toBe("vp dev");
  });
});

describe("questionText", () => {
  it("stringifies non-string instructions", () => {
    const sent = { questions: { a: { instructions: { ask: "Is it raining?" } } } };
    expect(questionText(sent, "a")).toBe('{"ask":"Is it raining?"}');
  });

  it("falls back to the question id", () => {
    expect(questionText(null, "film_0")).toBe("film_0");
    expect(questionText({ questions: {} }, "film_0")).toBe("film_0");
  });
});

describe("formatProbability", () => {
  it("rounds to two decimals", () => {
    expect(formatProbability(0.005)).toBe("0.01");
    expect(formatProbability(1)).toBe("1.00");
  });
});

describe("isJevResponse", () => {
  it("accepts the fixtures and failures", () => {
    expect(isJevResponse(noulResponse)).toBe(true);
    expect(isJevResponse(choiceResponse)).toBe(true);
    expect(isJevResponse(scoreResponse)).toBe(true);
    expect(isJevResponse({ ok: false, error: "Bad request." })).toBe(true);
  });

  it("rejects bodies that do not match the contract", () => {
    expect(isJevResponse("<!doctype html>")).toBe(false);
    expect(isJevResponse({ ok: false })).toBe(false);
    expect(isJevResponse({ ...noulResponse, answers: { a: { type: "noul" } } })).toBe(false);
    expect(isJevResponse({ ...noulResponse, connection: "warm" })).toBe(false);
    expect(isJevResponse({ ...noulResponse, keepAliveSeconds: 5 })).toBe(false);
  });
});

describe("describeJsonError", () => {
  function parseError(source: string): unknown {
    try {
      JSON.parse(source);
    } catch (error) {
      return error;
    }
    throw new Error("expected invalid JSON");
  }

  it("reports line and column from this engine's message", () => {
    const source = '{\n  "a": 1\n  "b": 2\n}';
    expect(describeJsonError(source, parseError(source))).toMatch(/^Line 3, column 3: /);
  });

  it("reads SpiderMonkey's line and column", () => {
    const error = new SyntaxError(
      "JSON.parse: expected ',' or '}' after property value in object at line 4 column 5 of the JSON data",
    );
    expect(describeJsonError("", error)).toBe(
      "Line 4, column 5: expected ',' or '}' after property value in object.",
    );
  });

  it("derives line and column from a bare position", () => {
    const error = new SyntaxError("Unexpected token } in JSON at position 9");
    expect(describeJsonError('{\n  "a": }', error)).toBe("Line 2, column 8: unexpected token }.");
  });

  it("falls back to the message when no position is given", () => {
    const error = new SyntaxError("JSON Parse error: Expected '}'");
    expect(describeJsonError("{", error)).toBe("This is not valid JSON: expected '}'.");
  });
});

describe("metadataSentence", () => {
  it("says a new connection was opened", () => {
    expect(metadataSentence({ ...noulResponse, latencyMs: 1384, connection: "new" })).toBe(
      "Answered by jev-1.13.0 in 1,384 ms using 452 input tokens over a new connection.",
    );
  });

  it("says the warm connection was reused", () => {
    expect(metadataSentence({ ...noulResponse, latencyMs: 402, connection: "reused" })).toBe(
      "Answered by jev-1.13.0 in 402 ms using 452 input tokens over the warm connection.",
    );
  });
});
