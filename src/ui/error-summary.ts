import { create } from "./dom.ts";

/** One reason a panel cannot run, as its error summary lists it. */
export type Problem = {
  /**
   * Names the problem across refreshes, so a fixed problem can be dropped
   * without rebuilding the rest. Two problems in one summary never share a key.
   */
  key: string;
  message: string;
  /**
   * The control the problem is about: `href` names it for the link, and
   * `focus` moves focus there when the link is followed. A problem without a
   * control, such as a request the shared validator refuses as a whole, is
   * listed as plain text.
   */
  target?: { href: string; focus: () => void };
};

export type ErrorSummary = {
  /** Lists `problems` under the heading, and empties the summary when there are none. */
  show(problems: readonly Problem[]): void;
  /**
   * Brings a shown summary in line with `problems` after a change elsewhere,
   * such as an edit, a removed image, or another provider. A fixed problem is
   * removed, and a problem whose message or link changed is replaced in place.
   * A problem that was not listed is left for the next press of Run, because
   * the summary reports what that press found, not every keystroke since.
   * Nothing here moves focus.
   */
  update(problems: readonly Problem[]): void;
  /** Empties the summary, which hides it. */
  clear(): void;
  /** Whether the summary lists any problem. */
  shown(): boolean;
  /** Moves focus to the summary itself, so its heading and list are read next. */
  focus(): void;
};

/**
 * Fills `element`, a box with `tabindex="-1"` that starts empty, as an error
 * summary in the GOV.UK pattern: a heading, then one link per problem that
 * moves focus to the control it is about. The caller moves focus to the box
 * after `show`, which makes a screen reader read it; it is not a live region,
 * because the announcement and the focus move would say the same problem
 * twice. The box is empty, and hidden by CSS, whenever there is nothing to list.
 */
export function createErrorSummary(element: HTMLElement, heading: string): ErrorSummary {
  /** The listed problems by key, with the list item that shows each. */
  let listed = new Map<string, { problem: Problem; item: HTMLLIElement }>();

  function itemFor(problem: Problem): HTMLLIElement {
    const { target } = problem;
    if (target === undefined) return create("li", { text: problem.message });
    const link = create("a", { text: problem.message, attributes: { href: target.href } });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      target.focus();
    });
    return create("li", {}, [link]);
  }

  function clear(): void {
    listed = new Map();
    element.replaceChildren();
  }

  function show(problems: readonly Problem[]): void {
    if (problems.length === 0) {
      clear();
      return;
    }
    listed = new Map(problems.map((problem) => [problem.key, { problem, item: itemFor(problem) }]));
    const list = create(
      "ul",
      { className: "error-summary-list", attributes: { role: "list" } },
      [...listed.values()].map(({ item }) => item),
    );
    element.replaceChildren(
      create("h3", { className: "error-summary-title", text: heading }),
      list,
    );
  }

  return {
    show,
    update(problems) {
      if (listed.size === 0) return;
      const next = new Map(problems.map((problem) => [problem.key, problem]));
      for (const [key, entry] of listed) {
        const problem = next.get(key);
        if (problem === undefined) {
          entry.item.remove();
          listed.delete(key);
        } else if (
          problem.message !== entry.problem.message ||
          (problem.target === undefined) !== (entry.problem.target === undefined)
        ) {
          const item = itemFor(problem);
          entry.item.replaceWith(item);
          listed.set(key, { problem, item });
        }
      }
      if (listed.size === 0) clear();
    },
    clear,
    shown: () => listed.size > 0,
    focus: () => element.focus(),
  };
}
