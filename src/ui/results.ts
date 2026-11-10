import { create, required } from "./dom.ts";

/**
 * The result list: every run adds one result, newest first, so earlier answers
 * stay on the page to compare against. Each result is an `<article>` whose
 * heading names the question type, the provider, and the time the run started.
 * Results live only in the page, so a reload starts an empty list.
 */

/** How many results the list keeps. A run past this drops the oldest. */
export const RESULT_LIMIT = 20;

/**
 * What one provider made of a run: the reading the person reads, and, when the
 * provider answered, the wire view of what travelled. A result holds a list of
 * these so that a run on several providers can later show one column each.
 */
export type ProviderRun = {
  /** The provider's display name: "SubQ Snap". */
  provider: string;
  reading: HTMLElement;
  /** Undefined when no answer arrived, such as when the endpoint could not be reached. */
  wire: HTMLElement | undefined;
};

export type Result = {
  /** The question type's plain name, as its panel heading shows it: "Yes or no". */
  questionType: string;
  /** When the run started. */
  at: Date;
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

/** The providers a result ran on, as a heading names them: "TypeSafe Jev and SubQ Snap". */
function providerNames(runs: ProviderRun[]): string {
  const names = runs.map((run) => run.provider);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
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

/**
 * One result: its heading, then one block per provider with the reading and
 * its own wire view. The wire view sits in the result it describes, outside
 * any live region, and its disclosures start closed.
 */
export function renderResultArticle(result: Result): HTMLElement {
  const runs = result.runs.map((run) =>
    create("div", { className: "result-run" }, run.wire ? [run.reading, run.wire] : [run.reading]),
  );
  return create("article", { className: "result" }, [
    renderResultHeading(result),
    create("div", { className: "result-runs" }, runs),
  ]);
}

/** What the live region says once a run's answers arrive: "Pick one option: SubQ Snap gave 4 answers." */
export function answersSentence(questionType: string, provider: string, count: number): string {
  return `${questionType}: ${provider} gave ${count} ${count === 1 ? "answer" : "answers"}.`;
}

/** What the live region says while a run waits, naming the provider it was sent to. */
export function loadingSentence(provider: string): string {
  return `Asking ${provider}…`;
}

export type Results = {
  /** Says in the live region that a run is waiting on `provider`. */
  waiting: (provider: string) => void;
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
    waiting: (provider) => {
      status.textContent = loadingSentence(provider);
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
