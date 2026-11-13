import type { DecisionSuccess } from "../decision/contract.ts";
import { appendWithInlineCode, create, required } from "./dom.ts";
import {
  metadataSentence,
  omittedImagesSentence,
  questionText,
  renderReading,
  renderResponse,
} from "./readout.ts";

/**
 * The result list: every run adds one result, newest first, so earlier answers
 * stay on the page to compare against. Each result is an `<article>` whose
 * heading names the question type, the provider, and the time the run started.
 * Results live only in the page, so a reload starts an empty list.
 */

/** How many results the list keeps. A run past this drops the oldest. */
export const RESULT_LIMIT = 20;

/**
 * What a provider made of a run: its answers, with how many attached images
 * it was sent without, or a failure, already rendered as an alert.
 */
export type Outcome =
  | { kind: "answered"; response: DecisionSuccess; omittedImages: number }
  | { kind: "failed"; reading: HTMLElement };

/**
 * What one provider made of a run, and, when the provider answered, the wire
 * view of what travelled. A result holds one per provider it asked.
 */
export type ProviderRun = {
  /** The provider's display name: "SubQ Snap". */
  provider: string;
  outcome: Outcome;
  /** Undefined when no answer arrived, such as when the endpoint could not be reached. */
  wire: HTMLElement | undefined;
};

export type Result = {
  /** The question type's plain name, as the question type choice names it: "Yes or no". */
  questionType: string;
  /** When the run started. */
  at: Date;
  /** The request that was sent, for the question text each answer is shown under. */
  sent: unknown;
  runs: ProviderRun[];
};

// Hours, minutes, and seconds, so two runs in the same minute still read apart.
const timeFormat = new Intl.DateTimeFormat("en", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/** The time a result shows, in the viewer's time zone: "14:32:05". */
export function formatTime(at: Date): string {
  return timeFormat.format(at);
}

const providerList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });

/** The providers a result ran on, as a heading names them: "TypeSafe Jev and SubQ Snap". */
function providerNames(runs: ProviderRun[]): string {
  return providerList.format(runs.map((run) => run.provider));
}

/** "Pick one option: SubQ Snap at 14:32:05", with the time in a `<time>` element. */
export function renderResultHeading(result: Result): HTMLHeadingElement {
  const time = create("time", {
    text: formatTime(result.at),
    attributes: { datetime: result.at.toISOString() },
  });
  return create("h3", { className: "result-title" }, [
    `${result.questionType}: ${providerNames(result.runs)} at `,
    time,
  ]);
}

/** The metadata line for an answered provider: who, how fast, and any images it was sent without. */
function metaLine(response: DecisionSuccess, omittedImages: number): HTMLParagraphElement {
  const meta =
    omittedImages > 0
      ? `${metadataSentence(response)} ${omittedImagesSentence(omittedImages)}`
      : metadataSentence(response);
  return create("p", { className: "reading-meta", text: meta });
}

/** One provider's run on its own: the full reading, then its wire view. */
function renderSingleRun(sent: unknown, run: ProviderRun): HTMLElement {
  const reading =
    run.outcome.kind === "answered"
      ? renderResponse(sent, run.outcome.response, run.outcome.omittedImages)
      : run.outcome.reading;
  return create("div", { className: "result-run" }, run.wire ? [reading, run.wire] : [reading]);
}

/**
 * The question ids the answers carry, in the order they first appear. Every
 * provider answers the same questions, so each row lines up; a provider that
 * failed contributes none.
 */
function answeredIds(runs: readonly ProviderRun[]): string[] {
  const ids: string[] = [];
  for (const run of runs) {
    if (run.outcome.kind !== "answered") continue;
    for (const id of Object.keys(run.outcome.response.answers)) {
      if (!ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/**
 * The comparison table of a run on several providers (issue #101): one row per
 * question, headed by the question, and one column per provider, headed by
 * its name. Moving along a row reads one question's answers from every
 * provider together. Explicit roles keep the table's meaning on a phone, where
 * CSS lays each row out as a group; each cell names its provider there.
 */
function renderComparison(result: Result): HTMLTableElement {
  const head = create("thead", { attributes: { role: "rowgroup" } }, [
    create("tr", { attributes: { role: "row" } }, [
      create("th", { text: "Question", attributes: { scope: "col", role: "columnheader" } }),
      ...result.runs.map((run) =>
        create("th", { text: run.provider, attributes: { scope: "col", role: "columnheader" } }),
      ),
    ]),
  ]);
  const rows = answeredIds(result.runs).map((id) => {
    const question = create("th", {
      className: "comparison-question",
      attributes: { scope: "row", role: "rowheader" },
    });
    appendWithInlineCode(question, questionText(result.sent, id));
    const cells = result.runs.map((run) => {
      const cell = create("td", {
        className: "comparison-cell",
        attributes: { role: "cell", "data-provider": run.provider },
      });
      const answer = run.outcome.kind === "answered" ? run.outcome.response.answers[id] : undefined;
      if (answer === undefined) {
        cell.append(create("p", { className: "comparison-missing", text: "No answer" }));
      } else {
        cell.append(...renderReading(answer));
      }
      return cell;
    });
    return create("tr", { attributes: { role: "row" } }, [question, ...cells]);
  });
  return create("table", { className: "comparison", attributes: { role: "table" } }, [
    create("caption", { className: "visually-hidden", text: "Answers by question and provider" }),
    head,
    create("tbody", { attributes: { role: "rowgroup" } }, rows),
  ]);
}

/** One provider's part of a compared run: its metadata or its failure, then its wire view. */
function renderProviderDetails(run: ProviderRun): HTMLElement {
  const heading = create("h4", { className: "result-provider-name", text: run.provider });
  const body =
    run.outcome.kind === "answered"
      ? metaLine(run.outcome.response, run.outcome.omittedImages)
      : run.outcome.reading;
  return create(
    "section",
    { className: "result-provider" },
    run.wire ? [heading, body, run.wire] : [heading, body],
  );
}

/**
 * One result: its heading, then, for one provider, its reading and wire view,
 * as before. For several providers, the comparison table, then each provider's
 * metadata or failure and its own wire view. The wire view sits in the result
 * it describes, outside any live region, and its disclosures start closed.
 */
export function renderResultArticle(result: Result): HTMLElement {
  const [only] = result.runs;
  if (result.runs.length === 1 && only !== undefined) {
    return create("article", { className: "result" }, [
      renderResultHeading(result),
      create("div", { className: "result-runs" }, [renderSingleRun(result.sent, only)]),
    ]);
  }
  return create("article", { className: "result result-compared" }, [
    renderResultHeading(result),
    renderComparison(result),
    create("div", { className: "result-providers" }, result.runs.map(renderProviderDetails)),
  ]);
}

/** What the live region says once a run's answers arrive: "Pick one option: SubQ Snap gave 4 answers." */
export function answersSentence(questionType: string, provider: string, count: number): string {
  return `${questionType}: ${provider} gave ${count} ${count === 1 ? "answer" : "answers"}.`;
}

/**
 * What the live region says once a run on several providers ends:
 * "Yes or no: 2 of 3 providers answered, TypeSafe Jev and SubQ Snap." A
 * failure's alert in its result says the rest, so this names only who answered.
 */
export function comparedSentence(
  questionType: string,
  answered: readonly string[],
  asked: number,
): string {
  if (answered.length === 0) return "";
  return `${questionType}: ${answered.length} of ${asked} providers answered, ${providerList.format(answered)}.`;
}

/** What the live region says while a run waits, naming the providers it was sent to. */
export function loadingSentence(providers: readonly string[]): string {
  return `Asking ${providerList.format(providers)}…`;
}

export type Results = {
  /** Says in the live region that a run is waiting on `providers`. */
  waiting: (providers: readonly string[]) => void;
  /**
   * Puts `result` at the top of the list and drops the oldest past
   * `RESULT_LIMIT`. The live region then says `announcement`; an empty
   * announcement clears it, for a failure whose alert speaks for itself.
   */
  add: (result: Result, announcement: string) => void;
  /** Empties the list, says so, and moves focus to the Results heading. */
  clear: () => void;
};

/**
 * Wires the Results section of `root`: the list, its live status line, the
 * message shown while the list is empty, and the Clear results button.
 */
export function setupResults(root: Document): Results {
  const heading = required(root, "#results-title", HTMLElement);
  const list = required(root, "#results-list", HTMLOListElement);
  const status = required(root, "#results-status", HTMLElement);
  const empty = required(root, "#results-empty", HTMLElement);
  const clearButton = required(root, "#results-clear", HTMLButtonElement);

  /** The empty message and the Clear button take turns: one shows while the list is empty, the other while it is not. */
  function showCount(): void {
    const hasResults = list.childElementCount > 0;
    empty.hidden = hasResults;
    clearButton.hidden = !hasResults;
  }

  function clear(): void {
    list.replaceChildren();
    status.textContent = "Results cleared.";
    showCount();
    // The Clear button just hid itself, so focus goes to the heading of the section it cleared.
    heading.focus();
  }

  clearButton.addEventListener("click", clear);
  showCount();

  return {
    waiting: (providers) => {
      status.textContent = loadingSentence(providers);
    },
    add: (result, announcement) => {
      list.prepend(create("li", { className: "results-item" }, [renderResultArticle(result)]));
      while (list.childElementCount > RESULT_LIMIT) list.lastElementChild?.remove();
      status.textContent = announcement;
      showCount();
    },
    clear,
  };
}
