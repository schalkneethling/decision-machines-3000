import type {
  ChoiceAnswer,
  DecisionResponse,
  DecisionSuccess,
  JsonValue,
  NoulAnswer,
  RefusalAnswer,
  ScoreAnswer,
} from "../decision/contract.ts";
import { PROVIDERS } from "../providers/catalog.ts";
import { appendWithInlineCode, create } from "./dom.ts";

/**
 * Pure renderers for the readout. Each takes data and returns a detached element;
 * `panels.ts` decides when to put it in the page.
 */

type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer | RefusalAnswer;

/** What the readout says in place of bars when the model declines a question. */
export const REFUSAL_TEXT = "The model declined to answer this question.";

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

function renderRefusal(): Node[] {
  return [create("p", { className: "answer-refusal", text: REFUSAL_TEXT })];
}

function renderReading(answer: Answer): Node[] {
  switch (answer.type) {
    case "refusal":
      return renderRefusal();
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

/**
 * Who answered, how fast, and with how many input tokens: "Answered by TypeSafe
 * Jev (jev-1.13.0) in 474 ms using 452 input tokens." It is the one place a
 * success names its provider: the catalog's display name for the id the server
 * reports, then the model the provider says it used.
 */
export function metadataSentence(response: DecisionSuccess): string {
  const provider = PROVIDERS[response.provider].displayName;
  const latency = numberFormat.format(Math.round(response.latencyMs));
  const tokens = numberFormat.format(response.usage.input_tokens);
  return `Answered by ${provider} (${response.model}) in ${latency} ms using ${tokens} input tokens.`;
}

/** The line shown while a run waits, naming the provider it was sent to. */
export function renderLoading(providerName: string): HTMLElement {
  return create("p", { className: "readout-status", text: `Asking ${providerName}…` });
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

/** No answer arrived, because `fetch` itself rejected. */
export function renderUnreachable(detail?: string): HTMLElement {
  return renderError(
    "Could not reach the decision endpoint. Check the connection and try again.",
    detail,
  );
}

/** An answer arrived, but its body is not JSON, such as a proxy's HTML error page. */
export function renderNonJson(status: number): HTMLElement {
  return renderError(
    `The decision endpoint answered with HTTP ${status} and a body that is not JSON.`,
  );
}

/**
 * The readout for a finished run: a failure, or metadata and answers. It is what a
 * screen reader announces, so the JSON of the wire view is rendered apart from it
 * by `renderWire`.
 */
export function renderResponse(sent: unknown, response: DecisionResponse): HTMLElement {
  if (!response.ok) {
    return create("div", { className: "reading" }, [renderError(response.error, response.detail)]);
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
  ]);
}
