import type {
  ChoiceAnswer,
  DecisionResponse,
  DecisionSuccess,
  JsonValue,
  NoulAnswer,
  ScoreAnswer,
} from "../decision/contract.ts";
import { create } from "./dom.ts";

/**
 * Pure renderers for the readout. Each takes data and returns a detached element;
 * `panels.ts` decides when to put it in the page.
 */

type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

const numberFormat = new Intl.NumberFormat("en");

/** Probabilities and scores always read with two decimals. */
export function formatProbability(value: number): string {
  return value.toFixed(2);
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Appends text, turning `backticked` spans into `<code>` elements. */
function appendWithInlineCode(parent: HTMLElement, text: string): void {
  text.split(/`([^`]+)`/).forEach((part, index) => {
    if (part === "") {
      return;
    }
    parent.append(index % 2 === 1 ? create("code", { text: part }) : part);
  });
}

/**
 * The question as the user wrote it: `instructions` from the request that was sent.
 * Falls back to the question id when the sent request has no such question.
 */
export function questionText(sent: unknown, id: string): string {
  if (typeof sent === "object" && sent !== null && "questions" in sent) {
    const { questions } = sent;
    if (typeof questions === "object" && questions !== null && id in questions) {
      const question: unknown = Reflect.get(questions, id);
      if (typeof question === "object" && question !== null && "instructions" in question) {
        return jsonText(question.instructions);
      }
    }
  }
  return id;
}

function bar(value: number): HTMLSpanElement {
  const fill = create("span", { className: "bar-fill" });
  const track = create("span", { className: "bar" }, [fill]);
  track.setAttribute("aria-hidden", "true");
  track.style.setProperty("--value", String(clampUnit(value)));
  return track;
}

function barValue(value: number): HTMLSpanElement {
  return create("span", { className: "bar-value", text: formatProbability(value) });
}

/** A `<dl>` of labelled bars: one `<dt>` label and one `<dd>` bar with its number per entry. */
function barList(
  entries: { label: (Node | string)[]; value: number }[],
  className: string,
): HTMLDListElement {
  const list = create("dl", { className: `bars ${className}` });
  for (const { label, value } of entries) {
    list.append(
      create("dt", { className: "bars-label" }, label),
      create("dd", { className: "bars-reading" }, [bar(value), barValue(value)]),
    );
  }
  return list;
}

function renderNoul(answer: NoulAnswer): Node[] {
  const label = create("span", { className: "visually-hidden", text: "Probability true: " });
  return [
    create("p", { className: "bars-reading bars-reading-single" }, [
      label,
      bar(answer.noul),
      barValue(answer.noul),
    ]),
  ];
}

function renderChoice(answer: ChoiceAnswer): Node[] {
  const verdict = create("p", { className: "answer-verdict" }, [
    "Choice: ",
    create("strong", { text: answer.choice }),
    `, with confidence ${formatProbability(answer.confidence)}.`,
  ]);
  const options = Object.entries(answer.probabilities)
    .sort(([, a], [, b]) => b - a)
    .map(([option, probability]) => ({
      label: [option],
      value: probability,
    }));
  return [verdict, barList(options, "bars-inline")];
}

/** Numeric keys by value, then keys that are not numbers, so a stray key never reorders the scale. */
function compareLevels(a: string, b: string): number {
  const firstIsNumber = isNumericKey(a);
  const secondIsNumber = isNumericKey(b);
  if (firstIsNumber && secondIsNumber) return Number(a) - Number(b);
  if (firstIsNumber !== secondIsNumber) return firstIsNumber ? -1 : 1;
  // A plain code-unit comparison, so the order never depends on the runtime's locale.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Blank keys parse as 0, so they are not numbers. */
function isNumericKey(key: string): boolean {
  return key.trim() !== "" && Number.isFinite(Number(key));
}

/** Levels in rubric order, taken from the legend, then any extra probability keys. */
export function scoreLevels(answer: ScoreAnswer): string[] {
  const keys = new Set([...Object.keys(answer.legend), ...Object.keys(answer.probabilities)]);
  return [...keys].sort(compareLevels);
}

function scoreTrack(score: number, levels: string[]): HTMLDivElement {
  const span = Math.max(1, levels.length - 1);
  const track = create("div", { className: "score-track" });
  track.setAttribute("aria-hidden", "true");
  levels.forEach((level, index) => {
    const tick = create("span", { className: "score-tick", text: level });
    tick.style.setProperty("--position", String(index / span));
    track.append(tick);
  });
  const marker = create("span", { className: "score-marker" });
  marker.style.setProperty("--position", String(clampUnit(score / span)));
  track.append(marker);
  return track;
}

function legendText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return "No description";
  }
  return jsonText(value);
}

function renderScore(answer: ScoreAnswer): Node[] {
  const levels = scoreLevels(answer);
  // The scale runs over the numeric levels only; other keys still get a bar below it.
  const scale = levels.filter(isNumericKey);
  const lowest = scale[0] ?? "0";
  const highest = scale.at(-1) ?? lowest;
  const verdict = create("p", { className: "answer-verdict" }, [
    "Score: ",
    create("strong", { text: formatProbability(answer.score) }),
    ` on a scale of ${lowest} to ${highest}, with confidence ${formatProbability(answer.confidence)}.`,
  ]);
  const entries = levels.map((level) => ({
    label: [
      create("span", { className: "bars-level", text: level }),
      legendText(answer.legend[level]),
    ],
    value: answer.probabilities[level] ?? 0,
  }));
  return [verdict, scoreTrack(answer.score, scale), barList(entries, "bars-stacked")];
}

function renderReading(answer: Answer): Node[] {
  switch (answer.type) {
    case "noul":
      return renderNoul(answer);
    case "choice":
      return renderChoice(answer);
    case "score":
      return renderScore(answer);
  }
}

/** One question: its text, then the primitive-specific reading. */
export function renderAnswer(question: string, answer: Answer): HTMLLIElement {
  const heading = create("h3", { className: "answer-question" });
  appendWithInlineCode(heading, question);
  return create("li", { className: "answer" }, [heading, ...renderReading(answer)]);
}

export function metadataSentence(response: DecisionSuccess): string {
  const latency = numberFormat.format(Math.round(response.latencyMs));
  const tokens = numberFormat.format(response.usage.input_tokens);
  const connection = response.connection === "new" ? "a new connection" : "the warm connection";
  return `Answered by ${response.model} in ${latency} ms using ${tokens} input tokens over ${connection}.`;
}

function rawResponse(response: DecisionResponse): HTMLDetailsElement {
  const code = create("code", { text: JSON.stringify(response, null, 2) });
  const details = create("details", { className: "raw" }, [
    create("summary", { className: "raw-summary", text: "Raw response" }),
    create("pre", { className: "raw-code" }, [code]),
  ]);
  details.open = true;
  return details;
}

export function renderLoading(): HTMLElement {
  return create("p", { className: "readout-status", text: "Asking the model…" });
}

export function renderError(message: string | (Node | string)[], detail?: string): HTMLElement {
  const lead = create("p", { className: "readout-error-message" });
  lead.append(...(typeof message === "string" ? [message] : message));
  const alert = create("div", { className: "readout-error" }, [lead]);
  alert.setAttribute("role", "alert");
  if (detail) {
    alert.append(create("p", { className: "readout-error-detail", text: detail }));
  }
  return alert;
}

export function renderUnreachable(detail?: string): HTMLElement {
  return renderError(
    ["Could not reach the decision endpoint. Is ", create("code", { text: "vp dev" }), " running?"],
    detail,
  );
}

/** The full readout for a finished run: failure, or metadata, answers, and raw JSON. */
export function renderResponse(sent: unknown, response: DecisionResponse): HTMLElement {
  if (!response.ok) {
    return create("div", { className: "reading" }, [
      renderError(response.error, response.detail),
      rawResponse(response),
    ]);
  }

  const answers = create(
    "ul",
    { className: "answers" },
    Object.entries(response.answers).map(([id, answer]) =>
      renderAnswer(questionText(sent, id), answer),
    ),
  );
  answers.setAttribute("role", "list");

  return create("div", { className: "reading" }, [
    create("p", { className: "reading-meta", text: metadataSentence(response) }),
    answers,
    rawResponse(response),
  ]);
}
