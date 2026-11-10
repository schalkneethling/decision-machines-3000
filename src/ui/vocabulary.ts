import type { Primitive } from "../decision/contract.ts";
import { PROVIDER_ORDER, PROVIDERS } from "../providers/catalog.ts";
import type { ProviderId } from "../providers/catalog.ts";
import { QUESTION_TYPE_NAMES } from "./question-types.ts";

/**
 * The words each provider uses for the parts of a request, shown in the
 * vocabulary legend next to the provider select. Each row is named with the
 * plain term the page's headings and labels use, such as "What the model reads",
 * and says what each provider's API calls the same thing. The JSON view keeps
 * the request's own keys (`state`, `noul`, `criteria`). `backticked` spans
 * render as code.
 *
 * Each row names where its words come from. "Recorded request" means the
 * request body in `worker/providers/fixtures/{provider}/three-types.json` for
 * SubQ and OpenAI, and in `noul.json`, `choice.json`, and `score.json` for
 * TypeSafe, which the probes in `docs/spikes/provider-probes.md` captured from
 * the live API.
 */

/** One part of a request: the page's plain name for it, and the word each provider uses for it. */
export type VocabularyRow = {
  /** What the page's headings and labels call it. */
  shared: string;
  /** What each provider's own API calls it. */
  byProvider: Readonly<Record<ProviderId, string>>;
};

export const VOCABULARY: readonly VocabularyRow[] = [
  {
    // Recorded requests: TypeSafe and SubQ send `state`, OpenAI sends `input`.
    shared: "What the model reads",
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
    shared: QUESTION_TYPE_NAMES.noul,
    byProvider: { typesafe: "`noul`", subq: "`noul`", openai: "`predicate`" },
  },
  {
    // Recorded requests: question `type` is "choice" for every provider.
    shared: QUESTION_TYPE_NAMES.choice,
    byProvider: { typesafe: "`choice`", subq: "`choice`", openai: "`choice`" },
  },
  {
    // Recorded requests: question `type` is "score" for every provider.
    shared: QUESTION_TYPE_NAMES.score,
    byProvider: { typesafe: "`score`", subq: "`score`", openai: "`score`" },
  },
  {
    // TypeSafe and SubQ: recorded request (`criteria` with `true` and `false`).
    // OpenAI has no such field. Its adapter's `toWire`
    // (`worker/providers/openai.ts`) appends each meaning to the question's
    // `instructions` as a "Yes means:" or "No means:" line.
    shared: "Yes/no meaning",
    byProvider: {
      typesafe: "`criteria.true` and `criteria.false`",
      subq: "`criteria.true` and `criteria.false`",
      openai: "No such field; added to `instructions` as “Yes means:” and “No means:” lines",
    },
  },
  {
    // Recorded requests: `criteria` is a map of option to description for
    // TypeSafe and SubQ; OpenAI's `choices` is a list of `value` with an
    // optional `description`.
    shared: "Options",
    byProvider: {
      typesafe: "`criteria`, a map",
      subq: "`criteria`, a map",
      openai: "`choices`, a list of `value` and `description`",
    },
  },
  {
    // Recorded requests: `criteria` is a list of level texts for TypeSafe and
    // SubQ; OpenAI's `levels` is a list of objects with a `label`. The OpenAI
    // adapter's `toLevels` also sends a `description`, but only for a level that
    // is an object or a list, which it then labels by index.
    shared: "Levels",
    byProvider: {
      typesafe: "`criteria`, a list",
      subq: "`criteria`, a list",
      openai: "`levels`, a list of `label`, with a `description` for a structured level",
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

const providerList = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The API term for a question type, as the second line under its panel heading
 * says it: "`noul` in TypeSafe Jev and SubQ Snap, `predicate` in OpenAI
 * Decisions", or "`choice` in every provider" when they all agree. It reads the
 * type's legend row, so the heading and the legend cannot disagree. It is built
 * here rather than written in `index.html` because the page markup names no
 * provider (the provider-neutral contract, #23).
 */
export function questionTypeTerm(primitive: Primitive): string {
  const row = VOCABULARY.find((candidate) => candidate.shared === QUESTION_TYPE_NAMES[primitive]);
  if (row === undefined) throw new Error(`The vocabulary has no row for ${primitive}.`);
  const byTerm = new Map<string, string[]>();
  for (const id of PROVIDER_ORDER) {
    const term = row.byProvider[id];
    byTerm.set(term, [...(byTerm.get(term) ?? []), PROVIDERS[id].displayName]);
  }
  const groups = [...byTerm];
  const [only] = groups;
  if (groups.length === 1 && only !== undefined) return `${only[0]} in every provider`;
  return groups.map(([term, names]) => `${term} in ${providerList.format(names)}`).join(", ");
}
