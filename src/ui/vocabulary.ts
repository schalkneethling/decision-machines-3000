import type { ProviderId } from "../providers/catalog.ts";

/**
 * The words each provider uses for the parts of a request, shown in the
 * vocabulary legend next to the provider select. The page and its JSON use one
 * shared vocabulary (`state`, `noul`, `criteria`); this table says what each
 * provider calls the same thing. `backticked` spans render as code.
 *
 * Each row names where its words come from. "Recorded request" means the
 * request body in `worker/providers/fixtures/{provider}/three-types.json`, which
 * the probes in `docs/spikes/provider-probes.md` captured from the live API.
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
    // Recorded requests: TypeSafe and SubQ send `state`, OpenAI sends `input`.
    shared: "State",
    byProvider: { typesafe: "`state`", subq: "`state`", openai: "`input`" },
  },
  {
    // Recorded requests: `questions` is a map keyed by id for TypeSafe and SubQ,
    // and a list of objects with a `name` for OpenAI.
    shared: "Questions",
    byProvider: {
      typesafe: "`questions`, a map keyed by id",
      subq: "`questions`, a map keyed by id",
      openai: "`questions`, a list; the id becomes `name`",
    },
  },
  {
    // Recorded requests: question `type` is "noul" for TypeSafe and SubQ, and
    // "predicate" for OpenAI.
    shared: "Yes/no question",
    byProvider: { typesafe: "`noul`", subq: "`noul`", openai: "`predicate`" },
  },
  {
    // TypeSafe and SubQ: recorded request (`criteria` with `true` and `false`).
    // OpenAI: this is the adapter's mapping, not a field OpenAI has. The recorded
    // OpenAI request has no yes/no meaning, and the plan has the adapter append
    // the meanings to `instructions`; issue #13 shows them as "Yes means" and
    // "No means". Reconcile this row when the OpenAI adapter (#11) lands.
    shared: "Yes/no meaning",
    byProvider: {
      typesafe: "`criteria.true` and `criteria.false`",
      subq: "`criteria.true` and `criteria.false`",
      openai: "No such field; the adapter adds the meanings to the question's `instructions`",
    },
  },
  {
    // Recorded requests: `criteria` is a map of option to description for
    // TypeSafe and SubQ; OpenAI's `choices` is a list of `value` with an
    // optional `description`.
    shared: "Choice options",
    byProvider: {
      typesafe: "`criteria`, a map",
      subq: "`criteria`, a map",
      openai: "`choices`, a list of `value` and `description`",
    },
  },
  {
    // Recorded requests: `criteria` is a list of level texts for TypeSafe and
    // SubQ; OpenAI's `levels` is a list of objects with a `label`. No recorded
    // OpenAI level has a description, so none is named here.
    shared: "Score levels",
    byProvider: {
      typesafe: "`criteria`, a list",
      subq: "`criteria`, a list",
      openai: "`levels`, a list of `label`",
    },
  },
  {
    // Recorded replies: the yes/no answer is `noul` for TypeSafe and SubQ, and
    // `probability` for OpenAI.
    shared: "Probability of yes",
    byProvider: { typesafe: "`noul`", subq: "`noul`", openai: "`probability`" },
  },
  {
    // `{ "type": "refusal" }` is this app's normalised answer (the contract in
    // `src/decision/contract.ts`). No recorded reply from any provider contains
    // a refusal; the OpenAI shape rests on OpenAI's published guide, as
    // `docs/spikes/schema-library.md` records. No TypeSafe or SubQ reply
    // contains one either, so the legend says only that.
    shared: "A question the model declines",
    byProvider: {
      typesafe: "No refusal answer in this provider's replies",
      subq: "No refusal answer in this provider's replies",
      openai: 'This app shows it as `{ "type": "refusal" }`; the other answers still arrive',
    },
  },
];
