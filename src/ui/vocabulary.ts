import type { ProviderId } from "../providers/catalog.ts";

/**
 * The words each provider uses for the parts of a request, shown in the
 * vocabulary legend next to the provider select. The page and its JSON use one
 * shared vocabulary (`state`, `noul`, `criteria`); this table says what each
 * provider calls the same thing. The rows follow the plan's Vocabulary table.
 * `backticked` spans render as code.
 */

/** One part of a request: the shared name, and the word each provider uses for it. */
export type VocabularyRow = {
  /** What the page and its JSON call it. */
  shared: string;
  /** What each provider's own API calls it. */
  byProvider: Readonly<Record<ProviderId, string>>;
};

export const VOCABULARY: readonly VocabularyRow[] = [
  {
    shared: "State",
    byProvider: { typesafe: "`state`", subq: "`state`", openai: "`input`" },
  },
  {
    shared: "Questions",
    byProvider: {
      typesafe: "`questions`, a map keyed by id",
      subq: "`questions`, a map keyed by id",
      openai: "`questions`, a list; the id becomes `name`",
    },
  },
  {
    shared: "Yes/no question",
    byProvider: { typesafe: "`noul`", subq: "`noul`", openai: "`predicate`" },
  },
  {
    shared: "Yes/no meaning",
    byProvider: {
      typesafe: "`criteria.true` and `criteria.false`",
      subq: "`criteria.true` and `criteria.false`",
      openai: "No such field; the meanings are added to the question's `instructions`",
    },
  },
  {
    shared: "Choice options",
    byProvider: {
      typesafe: "`criteria`, a map",
      subq: "`criteria`, a map",
      openai: "`choices`, a list of `value` and `description`",
    },
  },
  {
    shared: "Score levels",
    byProvider: {
      typesafe: "`criteria`, a list",
      subq: "`criteria`, a list",
      openai: "`levels`, a list of `label` and `description`",
    },
  },
  {
    shared: "Probability of yes",
    byProvider: { typesafe: "`noul`", subq: "`noul`", openai: "`probability`" },
  },
  {
    shared: "A question the model declines",
    byProvider: {
      typesafe: "This provider does not decline questions",
      subq: "This provider does not decline questions",
      openai: '`{ "type": "refusal" }`, while the other answers still arrive',
    },
  },
];
