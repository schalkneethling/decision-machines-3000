# Spike: Valibot or Zod Mini for the data boundaries

This records the result of issue #31. It answers which schema library, Valibot or Zod Mini, best fits how this project validates data at its boundaries, based on the same three schemas written in both libraries against the project's real data, and whether the evidence supports adopting one at all.

**Short answer.** Adopt a schema library, and make it Zod Mini. Both libraries reproduce every one of today's 39 request error messages and paths exactly, both infer types equal to the hand-written contract, both run in workerd, and both parse the request in about 8.5 microseconds. The evidence is too close to call on its own, as a separate fairness review confirmed; the owner chose Zod Mini on 2026-10-13 because it is safer by default in the browser, where these schemas run. Two things carry that judgement. First, Zod resolves a message after the whole path is known, so the wording that names the enclosing question (`Question "tone" has no criteria`) can live on the schema that raises it; Valibot resolves messages at once, before the parent adds its key, so that wording has to be produced after the parse by a function that decodes paths. Second, Valibot's object and record schemas accept arrays (`[]` passes `v.strictObject({})`, `["a", "b"]` passes a record as `{ "0": "a", "1": "b" }`), which needed a guard at five object positions in schema 1 and would need one at every boundary the plan adds. What Valibot does better is size: the browser pays 5.1 KB gzipped for Valibot against 10.9 KB for Zod Mini, next to 2.5 KB for today's hand-written code. ADR-0004 records the decision and what would make us revisit it.

**Where the code is.** Everything the spike ran is in `spikes/schema-library/` on the branch [`issue-31-schema-library-spike`](https://github.com/schalkneethling/jev-3000/tree/issue-31-schema-library-spike), which is not merged into `main`; this document, ADR-0004, and the scenarios are. Every `spikes/schema-library/` path below refers to that branch. On the branch, the folder sits outside `src/` and outside the app build (`tsconfig.json` and `index.html` do not reach it). `vp test` runs its 198 comparison tests with the rest of the suite; `vp exec tsc -p spikes/schema-library/tsconfig.json` type-checks it, including the compile-time type assertions. Nothing under `src/` or `server/` changed. The oracle is today's hand-written validator, `src/decision/validate.ts` as PR #30 merged it (capabilities-aware, with the refusal answer in the contract): every message and path a library produces is compared with what it returns, and the spike imports `src/providers/catalog.ts` and `src/decision/count.ts` for the capabilities and the shared wording helpers.

| File                                                                  | What it is                                                                                                                |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `shared/wording.ts`, `shared/cases.ts`, `shared/fixtures.ts`          | The wording helpers both implementations reuse (copied from `validate.ts`), the request test set, and the fixture loader. |
| `valibot/request.ts`, `valibot/provider.ts`, `valibot/response.ts`    | Schemas 1, 2, and 3 in Valibot.                                                                                           |
| `zod-mini/request.ts`, `zod-mini/provider.ts`, `zod-mini/response.ts` | Schemas 1, 2, and 3 in Zod Mini.                                                                                          |
| `compare.test.ts`                                                     | The comparison: one `describe` per row, the same inputs and assertions for both libraries.                                |
| `types.ts`                                                            | Compile-time assertions that the inferred types equal the contract's types.                                               |
| `report.ts`, `bench.ts`                                               | Print the message table and the parse-speed table below.                                                                  |
| `bundle/`                                                             | Four identical browser entries and the Vite config and size script that measured them.                                    |
| `worker/`                                                             | Two tiny Workers and their Wrangler configs for the workerd check.                                                        |

## Installed versions

| Package                                                      | Version | How it was checked                                                                                                                                                      |
| ------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valibot`                                                    | 1.5.0   | `vp add -D valibot zod`; `npm view valibot dist-tags` shows `latest: 1.5.0` (published 2026-09-09).                                                                     |
| `zod` (Zod Mini is the `zod/mini` entry of the same package) | 4.6.7   | Same command; `npm view zod dist-tags` shows `latest: 4.6.7` (published 2026-10-12). The import path comes from `exports["./mini"]` in `node_modules/zod/package.json`. |
| `wrangler`                                                   | 4.150.0 | Added with `vp add -D wrangler` for the workerd check only; `npm view wrangler version` is 4.150.0. Bundles workerd 1.20261006.1.                                       |
| Node                                                         | 24.21.0 | The scripts run with plain `node`, which strips types.                                                                                                                  |
| Vite+                                                        | 0.2.8   | Unchanged.                                                                                                                                                              |

Both libraries went into `devDependencies` because the spike is not shipped. The migration moves the chosen one to `dependencies`.

## What was read before writing a schema

The brief forbade writing either API from memory. For Valibot: `node_modules/valibot/README.md`, `node_modules/valibot/dist/index.d.mts` (every function used), `node_modules/valibot/dist/index.mjs` (the `~run` of `strictObject`, `record`, `variant`, `pipe`, `lazy`, `rawCheck`, and `_addIssue`), and https://valibot.dev/guides/issues/ and https://valibot.dev/guides/pipelines/. For Zod Mini: `node_modules/zod/README.md`, `node_modules/zod/v4/mini/schemas.d.ts`, `node_modules/zod/v4/mini/checks.d.ts`, `node_modules/zod/v4/core/{errors,checks,api,parse,core}.d.ts`, `node_modules/zod/v4/core/{schemas,util,parse,errors}.js` (`$ZodDiscriminatedUnion`, `$ZodRecord`, `$ZodTuple`, `handlePipeResult`, `finalizeIssue`, `prefixIssues`, `toDotPath`), `node_modules/zod/v4/locales/en.js`, and https://zod.dev/packages/mini, https://zod.dev/error-customization, https://zod.dev/api. For Wrangler: `vp exec wrangler dev --help` and `node_modules/wrangler/config-schema.json`. For Vite: `BuildEnvironmentOptions` in `node_modules/vite/dist/vite/node/index.d.ts`.

## Findings at a glance

| Row                                                          | Valibot 1.5.0                                                                                                                                                 | Zod Mini 4.6.7                                                                                                                                                                                        | Evidence                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Today's request messages and paths reproduced                | 39 of 39 exactly                                                                                                                                              | 39 of 39 exactly                                                                                                                                                                                      | [Schema 1](#schema-1-the-request-and-todays-messages); `node spikes/schema-library/report.ts` |
| Where the wording lives                                      | After the parse, in one function that decodes the issue path, because messages resolve before the parent adds its key                                         | On the schema that raises the issue, because messages resolve after the full path is known                                                                                                            | [Hardest case: the enclosing question's id](#hardest-case-the-enclosing-questions-id)         |
| Workarounds needed                                           | A plain-object guard at every object position (arrays pass object and record schemas); length checks before the tuple schema; the empty-id rule on the record | The unknown key appended to the issue's path; a hand-rolled dot path; a negative test on the discriminated union's issue code; length checks before the tuple schema; the empty-id rule on the record | [Workarounds](#workarounds-in-each-library)                                                   |
| Every recorded fixture parses (33), plus a synthetic refusal | Yes                                                                                                                                                           | Yes                                                                                                                                                                                                   | [Schema 2](#schema-2-provider-responses)                                                      |
| A broken copy fails with the path                            | Yes, `answers.queue.probabilities.nurse_line`                                                                                                                 | Yes, same path                                                                                                                                                                                        | [Schema 2](#schema-2-provider-responses)                                                      |
| Default message for a broken response                        | `Invalid type: Expected number but received "1"`                                                                                                              | `Invalid input` until `z.config(z.locales.en())`; then `Invalid input: expected number, received string`                                                                                              | [Default wording](#default-wording-for-a-broken-response)                                     |
| Browser bundle, gzipped, identical entry                     | **5,123 B** (today's hand-written code: 2,519 B)                                                                                                              | 10,884 B; 11,940 B with the English locale                                                                                                                                                            | [Bundle cost](#bundle-cost)                                                                   |
| Runs in workerd                                              | Yes                                                                                                                                                           | Yes                                                                                                                                                                                                   | [Workerd](#workerd)                                                                           |
| Inferred types equal `contract.ts`                           | Yes, 16 of 16 assertions                                                                                                                                      | Yes, 16 of 16 assertions                                                                                                                                                                              | [Types](#types)                                                                               |
| Lines of code, schema 1 (hand-written: 401)                  | 251                                                                                                                                                           | 226                                                                                                                                                                                                   | [Ergonomics](#ergonomics)                                                                     |
| Parse of the 2.0 KB choice example (hand-written: 1.2 µs)    | 8.5 µs                                                                                                                                                        | 8.4 µs                                                                                                                                                                                                | [Parse speed](#parse-speed)                                                                   |
| Parse of the smallest provider answer                        | 0.8 µs                                                                                                                                                        | 1.5 µs                                                                                                                                                                                                | [Parse speed](#parse-speed)                                                                   |
| Standard Schema                                              | Yes (`"~standard"` in `dist/index.d.mts`)                                                                                                                     | Yes (`"~standard"` in `v4/core/schemas.d.ts`)                                                                                                                                                         | [Ecosystem](#ecosystem)                                                                       |
| Releases on the current major                                | 9 since 1.0.0 (2025-03-19)                                                                                                                                    | 58 since 4.0.0 (2025-07-09)                                                                                                                                                                           | [Ecosystem](#ecosystem)                                                                       |
| Weekly downloads, 2026-10-05 to 2026-10-11                   | 22.6 million                                                                                                                                                  | 346.1 million                                                                                                                                                                                         | [Ecosystem](#ecosystem)                                                                       |
| Licence                                                      | MIT                                                                                                                                                           | MIT                                                                                                                                                                                                   | `node_modules/*/package.json`                                                                 |

## Schema 1: the request, and today's messages

Both schema factories take a `ProviderCapabilities` object (the shape from `src/providers/catalog.ts`) and build the request schema from it: `choiceOptions.min` and `.max`, `scoreLevels.min` and `.max`, and `questionNameMaxLength` become checks. Both are discriminated on `primitive` with one object schema per primitive, so narrowing on `primitive` narrows the criteria shape, exactly as `ValidDecisionRequest` does today.

The test set is every invalid request in `src/decision/validate.test.ts`: the 16 that were there before PR #30 and the 8 that PR #30 added to exercise the capability-driven limits, plus 15 additional cases that reach messages the test file does not, such as a question that is text or an option with an empty name. The expected message and path of every case come from `src/decision/validate.ts` at run time. (The spike began against PR #30's branch, which merged while it ran; the merged files are identical to the branch's, so nothing in the results changed.) `node spikes/schema-library/report.ts` prints:

| Case                                                  | Source     | Reference detail              | Valibot | Zod Mini |
| ----------------------------------------------------- | ---------- | ----------------------------- | ------- | -------- |
| a request that is not an object                       | before #30 | none                          | exact   | exact    |
| a missing state                                       | before #30 | `state`                       | exact   | exact    |
| a null state                                          | before #30 | `state`                       | exact   | exact    |
| a numeric state                                       | before #30 | `state`                       | exact   | exact    |
| a boolean state                                       | before #30 | `state`                       | exact   | exact    |
| empty questions                                       | before #30 | `questions`                   | exact   | exact    |
| an unknown top-level key                              | before #30 | `model`                       | exact   | exact    |
| an unknown question key                               | before #30 | `questions.greeting.type`     | exact   | exact    |
| an unknown primitive                                  | before #30 | `primitive`                   | exact   | exact    |
| empty instructions                                    | before #30 | `questions.q.instructions`    | exact   | exact    |
| a choice question without criteria                    | before #30 | `questions.tone.criteria`     | exact   | exact    |
| a choice with a single option                         | before #30 | `criteria`                    | exact   | exact    |
| a score with one level                                | before #30 | `questions.warmth.criteria`   | exact   | exact    |
| a score with too many levels                          | before #30 | `criteria`                    | exact   | exact    |
| noul criteria with a key other than true or false     | before #30 | `questions.q.criteria.yes`    | exact   | exact    |
| numeric criteria descriptions                         | before #30 | `criteria.warm`               | exact   | exact    |
| an 11-level score when scoreLevels.max is 10          | #30        | `criteria`                    | exact   | exact    |
| four options when choiceOptions.max is 3              | #30        | `criteria`                    | exact   | exact    |
| a 101-character question id under SubQ                | #30        | `questions.qqq…`              | exact   | exact    |
| too few levels when scoreLevels.min is 3              | #30        | `criteria`                    | exact   | exact    |
| zero options when choiceOptions.min is 1              | #30        | `criteria`                    | exact   | exact    |
| a 150-character question id, truncated in the message | #30        | `questions.qqq…`              | exact   | exact    |
| 256 options                                           | #30        | `criteria`                    | exact   | exact    |
| 11 levels                                             | #30        | `criteria`                    | exact   | exact    |
| a missing primitive                                   | additional | `primitive`                   | exact   | exact    |
| a numeric primitive                                   | additional | `primitive`                   | exact   | exact    |
| an empty state                                        | additional | `state`                       | exact   | exact    |
| questions that are a list                             | additional | `questions`                   | exact   | exact    |
| a question that is text                               | additional | `questions.q`                 | exact   | exact    |
| a question with an empty id                           | additional | `questions`                   | exact   | exact    |
| missing instructions                                  | additional | `questions.q.instructions`    | exact   | exact    |
| numeric instructions                                  | additional | `questions.q.instructions`    | exact   | exact    |
| a null noul description                               | additional | `questions.q.criteria.true`   | exact   | exact    |
| noul criteria that are a list                         | additional | `questions.q.criteria`        | exact   | exact    |
| choice criteria that are a list                       | additional | `criteria`                    | exact   | exact    |
| an option with an empty name                          | additional | `criteria`                    | exact   | exact    |
| score criteria that are an object                     | additional | `criteria`                    | exact   | exact    |
| a numeric level description                           | additional | `questions.warmth.criteria.1` | exact   | exact    |
| a score question without criteria                     | additional | `questions.warmth.criteria`   | exact   | exact    |

Exact: Valibot 39 of 39, Zod Mini 39 of 39. The 11 valid cases (the three examples, inherited default criteria, a 100-character id under SubQ, exactly 10 levels, exactly 255 options, sixty emoji as an id, and so on) are accepted by both and returned structurally unchanged.

One semantic difference from the hand-written validator holds for both libraries: when a request has several problems, the first one reported can differ. The hand-written code checks unknown keys before the primitive and a criteria list's length before its items; both libraries check an object's known entries before its unknown keys and a record's values before the record-level checks. The test set has one problem per case, so it does not show this. Both libraries report every problem if asked (Valibot without `abortEarly`, Zod always), which the composer could use later.

### Hardest case: the enclosing question's id

Fourteen of the 39 messages name the question they belong to, for example `The "instructions" of question "q" are empty.` or `The "criteria" of question "tone" has 4 options. Use at most 3.`. The question's id is the key of the `questions` record, which the schema for one question never sees. How each library lets a message reach it is the main difference the spike found.

**Zod Mini** resolves messages lazily. `safeParse` returns a result whose `error` is built on first read; only then does `finalizeIssue` (node_modules/zod/v4/core/util.js) call the schema's `error` function, and by then every parent has prepended its key with `prefixIssues`. The error-customisation docs say the function "receives the issue, so it can use `input`, `code`, `path`, and other properties". So the wording sits on the schema that raises the issue and reads the id from `issue.path[1]`:

```ts
// spikes/schema-library/zod-mini/request.ts
const instructions = content((issue) =>
  issue.input === undefined
    ? `Question "${questionIdOf(issue)}" has no "instructions". Add the question you want answered.`
    : `The "instructions" of question "${questionIdOf(issue)}" must be text, an object, or a list, not ${describeKind(issue.input)}.`,
).check(
  z.refine(isNotBlank, {
    error: (issue) =>
      `The "instructions" of question "${questionIdOf(issue)}" are empty. Write the question you want answered.`,
  }),
);
```

One caveat: the `$ZodErrorMap` type declares `path` as optional on the raw issue, so the type system does not promise it is complete when the map runs; the implementation does.

**Valibot** resolves messages eagerly. `_addIssue` (node_modules/valibot/dist/index.mjs) computes `issue.message` the moment the issue is created, with only the path the failing schema itself supplied; the parent's `~run` then does `issue.path.unshift(pathItem)`. A message function on the `instructions` schema therefore sees no path at all, and one on the question object sees only its own key. The wording that needs the id has to be produced after `safeParse`, from the finished `issue.path`. The spike does that in one function, `describeRequestIssue`, which walks the path and chooses the sentence; the schema itself carries no messages except on the one `rawCheck` that already has the id in hand:

```ts
// spikes/schema-library/valibot/request.ts
export function describeRequestIssue(issue: Issue, capabilities: ProviderCapabilities): string {
  if (issue.type === "raw_check") return issue.message;
  const path = issue.path ?? [];
  const [head, second, third] = path;
  if (head === undefined) return NOT_OBJECT(issue.input);
  // …
    case "questions": {
      if (second === undefined) {
        return issue.type === "check" ? `Every question needs a non-empty id.` : ADD_QUESTIONS;
      }
      const id = String(second.key);
      if (second.origin === "key") {
        return idTooLongMessage(id, capabilities.questionNameMaxLength ?? Number.POSITIVE_INFINITY);
      }
      if (third === undefined) {
        return `Question "${id}" must be an object with "instructions" and optional "criteria", not ${describeKind(issue.input)}.`;
      }
      // …
```

Valibot's path items help here: each carries `input`, `key`, and `value` for its level, so the function reads the request's `primitive` from `path[0].input` to pick the criteria wording. Zod's path is keys only. The function is 90 lines and works, but it mirrors the schema's structure, so a change to the schema's shape must be mirrored in it, and nothing but the tests ties the two together. The same approach would work in Zod (as a per-parse `error` map), but Zod does not force it.

### Hardest case: the cross-field rule

A Choice or Score question needs criteria either on itself or at the top of the request. Both libraries express this as a custom check on the whole request that adds an issue at a path chosen at run time. The shapes differ in verbosity only:

```ts
// Valibot: v.rawCheck(({ dataset, addIssue }) => { … })
addIssue({
  message: `Question "${id}" has no criteria. Add "criteria" with its ${kind} to the question, or a default "criteria" at the top of the request.`,
  path: [
    { type: "object", origin: "value", input: request, key: "questions", value: request.questions },
    { type: "object", origin: "value", input: request.questions, key: id, value: question },
    { type: "object", origin: "value", input: question, key: "criteria", value: undefined },
  ],
});

// Zod Mini: .check((payload) => { … })
payload.issues.push({
  code: "custom",
  input: request,
  path: ["questions", id, "criteria"],
  message: `Question "${id}" has no criteria. Add "criteria" with its ${kind} to the question, or a default "criteria" at the top of the request.`,
});
```

### Hardest case: two to ten levels as a tuple

`ScoreCriteria` is `[Description, Description, ...Description[]]`. Both libraries have a tuple-with-rest schema (`v.tupleWithRest`, `z.tuple([a, b], rest)`), but neither checks the array's length before running the items, so `["Cold"]` would be reported as a missing item at `criteria.1` instead of today's `needs at least 2 levels to score between. It has 1.` at `criteria`. Both libraries let a pipeline run a length check first and the tuple schema second, and the inferred type is still the tuple:

```ts
// Valibot
v.pipe(v.array(v.unknown()), v.minLength(min), v.maxLength(max ?? Number.POSITIVE_INFINITY),
  v.tupleWithRest([description, description], description));

// Zod Mini
z.pipe(list.check(z.minLength(min, …), ...(max === undefined ? [] : [z.maxLength(max, …)])),
  z.tuple([levelDescription, levelDescription], levelDescription));
```

Valibot's `v.pipe` has one overload per arity, so an optional action cannot be spread in; the spike passes `Number.POSITIVE_INFINITY` as the maximum instead. Zod's `.check(...checks)` is variadic, so the optional check is spread.

### Hardest case: arrays are objects in Valibot

`v.strictObject`, `v.object`, `v.record`, and `v.variant` type-check their input with `input && typeof input === "object"` (`~run` in node_modules/valibot/dist/index.mjs), which arrays pass. Before the guard was added, the comparison test caught two cases: `criteria: []` on a Noul question was accepted as `{}`, and `criteria: ["warm", "cold"]` on a Choice request was accepted as `{ "0": "warm", "1": "cold" }`. The maintainers have this on record for `record` in open issue [open-circle/valibot#1630](https://github.com/open-circle/valibot/issues/1630) (opened 2026-09-09, open at the time of writing). Zod's `isObject` excludes arrays. The Valibot schema runs the project's `isPlainObject` first at each of its five object positions:

```ts
const plainObject = v.custom<Record<string, unknown>>(isPlainObject);
const noulCriteria = v.pipe(plainObject, v.strictObject({ … }));
```

### Workarounds in each library

Each is marked `WORKAROUND` or explained in a comment in the source.

Valibot:

- `plainObject` guard in front of every object, record, and variant position (five places), because arrays pass those schemas.
- Wording produced after the parse in `describeRequestIssue`, because messages resolve before the path is complete.
- The length checks before the tuple schema (shared with Zod).
- The empty-id rule as a check on the `questions` record instead of on the key schema, because a key issue's path would be `questions.` and today's is `questions` (shared with Zod).
- `v.minEntries` and `v.maxEntries` are marked `@beta` in `dist/index.d.mts`.
- `v.lazy` calls its getter on every parse, so the recursive JSON schema puts `lazy` at the two recursion points instead of around the whole union; the first version, written the way the Valibot docs show recursion, parsed the request in 18.9 µs instead of 8.5 µs.

Zod Mini:

- An `unrecognized_keys` issue sits on the object and lists the keys in `issue.keys`, so the result mapping appends the key to get `questions.greeting.type`.
- `z.core.toDotPath` writes numbers as `[0]` and quotes keys with special characters; today's paths are `criteria.0`, so the dot path is `issue.path.map(String).join(".")`.
- The declared issue type of `z.discriminatedUnion` is `invalid_union` only, but its parser also raises `invalid_type` for a non-object input, so the error map tests `issue.code !== "invalid_union"` to satisfy the compiler.
- A failed record key arrives wrapped in an `invalid_key` issue whose `input` is the key, so the question-id message lives on the record's error map rather than the key schema's.
- The tuple and empty-id items above.

## Schema 2: provider responses

`spikes/schema-library/{valibot,zod-mini}/provider.ts` declare the Jev wire shape shared by TypeSafe and SubQ (a choice answer with `probabilities` as a record), the OpenAI shape (an answer array with `probabilities` as an array, `confidence` optional, and a `refusal` answer type), both error envelopes (`{ detail: { error_type, message } }` and `{ error: { message, type, param, code } }`), and the three `GET /v1/models` shapes. They use plain `object` (unknown fields are stripped), which is the right stance for a response a provider may extend. No fixture contains a refusal; its shape `{ "type": "refusal", "name": … }` comes from the OpenAI-compatible Decisions reference at https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-decisions, which states it implements the same response shapes as OpenAI, and from the code samples in OpenAI's own guide at https://developers.openai.com/api/docs/guides/decisions, which check `answer.type === "refusal"` and read `answer.name`. OpenAI's reference page itself returned 403 and 404 to the fetches made here.

`compare.test.ts` parses the body of all 33 recorded exchanges with the schema for the provider and wire shape (every 2xx POST is a decision, every GET under 300 a models list, everything else an error). Both libraries accept all 33 and a synthetic refusal added to `openai/three-types`. Four deliberately broken copies fail in both with the expected path: `answers.queue.probabilities.nurse_line` (a probability as text), `answers.2.probabilities.1.probability` (the OpenAI array form), `answers.acuity.type` (an unknown answer type, reported at the discriminator by both), and `error.message` (a missing field).

### Default wording for a broken response

These are the libraries' own messages, with no customisation, as the Worker would log them. `node spikes/schema-library/report.ts` prints:

| Broken copy                                                              | Valibot path                             | Valibot message                                                            | Zod Mini path                            | Zod Mini message (no locale) | Zod Mini message (`en`)                                             |
| ------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------- |
| TypeSafe choice: `probabilities.nurse_line` is `"1"`                     | `answers.queue.probabilities.nurse_line` | Invalid type: Expected number but received "1"                             | `answers.queue.probabilities.nurse_line` | Invalid input                | Invalid input: expected number, received string                     |
| SubQ three-types: `answers.acuity.type` is `"rank"`                      | `answers.acuity.type`                    | Invalid type: Expected ("noul" \| "choice" \| "score") but received "rank" | `answers.acuity.type`                    | Invalid input                | Invalid discriminator value. Expected 'noul' \| 'choice' \| 'score' |
| SubQ three-types: `usage` missing                                        | `usage`                                  | Invalid type: Expected Object but received undefined                       | `usage`                                  | Invalid input                | Invalid input: expected object, received undefined                  |
| OpenAI three-types: `answers[2].probabilities[1].probability` is `"0.1"` | `answers.2.probabilities.1.probability`  | Invalid type: Expected number but received "0.1"                           | `answers.2.probabilities.1.probability`  | Invalid input                | Invalid input: expected number, received string                     |
| OpenAI bad-key: `error.message` missing                                  | `error.message`                          | Invalid type: Expected string but received undefined                       | `error.message`                          | Invalid input                | Invalid input: expected string, received undefined                  |

Valibot's defaults are readable out of the box and quote the received value. Zod Mini ships no locale, so every default message is `Invalid input` until `z.config(z.locales.en())` runs (https://zod.dev/packages/mini); with it the messages are as readable, and name the received type rather than the value. The locale costs about 1 KB gzipped in the browser (see below) and nothing worth measuring in the Worker, which is where provider responses are checked.

## Schema 3: the browser's `DecisionResponse`

`spikes/schema-library/{valibot,zod-mini}/response.ts` declare `DecisionSuccess` per primitive (so `primitive: "score"` implies score answers) with the refusal answer allowed in every `answers` record, and `DecisionFailure`. `isDecisionResponse` is `v.is(schema, value)` in Valibot and `z.validate(schema, value)` in Zod Mini, both type guards, so `src/ui/client.ts` keeps its shape. Both accept the three real responses in `src/ui/fixtures/`, a response with a refusal answer, and a failure, and both reject a keep-alive of 5 (`keepAliveSeconds`), an answer of an unknown type (`answers.recommends.type`), choice answers under the score primitive (`answers.film_0.type`), and a failure without an error (`error`). The first Valibot version used `v.union` for the answer and reported one level short (`answers.recommends`); `v.variant("type", …)`, the discriminated form, reports at `.type` like Zod's `discriminatedUnion`.

## Bundle cost

Four entries in `spikes/schema-library/bundle/` are identical except for two import paths: each reads a request and a response from the page, runs schema 1 and schema 3 on them, and logs the results, so nothing is tree-shaken away. `entry-hand-written.ts` is the baseline: the PR #30 validator plus `isDecisionResponse` from `src/ui/client.ts`. `entry-zod-mini-en.ts` adds `z.config(z.locales.en())`. Each was built with Vite's production defaults (minified, target `baseline-widely-available`) and measured with Node's `zlib` at gzip level 9 and Brotli's default quality:

```
vp build spikes/schema-library/bundle --mode valibot
vp build spikes/schema-library/bundle --mode zod-mini
vp build spikes/schema-library/bundle --mode zod-mini-en
vp build spikes/schema-library/bundle --mode hand-written
node spikes/schema-library/bundle/measure.ts
```

| Entry        | Minified bytes | Gzip bytes | Brotli bytes |
| ------------ | -------------- | ---------- | ------------ |
| hand-written | 7,109          | 2,519      | 2,217        |
| valibot      | 18,312         | 5,123      | 4,602        |
| zod-mini     | 36,005         | 10,884     | 9,849        |
| zod-mini-en  | 39,118         | 11,940     | 10,854       |

So Valibot adds about 2.6 KB gzipped to what the browser downloads today and Zod Mini about 8.4 KB (9.4 KB with the locale, which the browser does not need because schema 1 carries its own wording). The app's whole script is 15.65 KB gzipped today (`vp run build` on main after PR #30), so the two libraries would grow it by roughly 17% and 53%. In absolute terms 8 KB is a few milliseconds on an ordinary connection. For comparison, the libraries' own figures are "less than 700 bytes" to start for Valibot (its README) and 2.12 KB for `z.boolean()` and 4.0 KB for a small object for Zod Mini (https://zod.dev/packages/mini); the spike's schemas are larger than those examples and the numbers above are what this project would ship.

## Workerd

`spikes/schema-library/worker/{valibot,zod-mini}.ts` are the smallest Workers that prove the point: each imports schema 1, schema 2, the three examples, and three fixtures, and answers `GET /` with JSON. Their Wrangler configs set `main` and `compatibility_date: "2026-10-06"` (the newest the bundled workerd supports); keys were checked against `node_modules/wrangler/config-schema.json`. Nothing was deployed and no login was made. Run from the repository root, one at a time:

```
vp exec wrangler dev -c spikes/schema-library/worker/wrangler.valibot.jsonc --port 8791 --show-interactive-dev-session false
curl -s http://localhost:8791/
vp exec wrangler dev -c spikes/schema-library/worker/wrangler.zod-mini.jsonc --port 8792 --show-interactive-dev-session false
curl -s http://localhost:8792/
```

Both answered `200` with `"runtime": "Cloudflare-Workers"` (the value of `navigator.userAgent` in workerd). Valibot:

```json
{
  "library": "valibot",
  "runtime": "Cloudflare-Workers",
  "schema1": {
    "accepts": { "noul": true, "choice": true, "score": true },
    "rejects": {
      "ok": false,
      "error": "Set \"primitive\" to \"noul\", \"choice\", or \"score\". It is currently \"rank\".",
      "detail": "primitive"
    }
  },
  "schema2": {
    "typesafeChoice": { "success": true },
    "subqThreeTypes": { "success": true },
    "openaiThreeTypes": { "success": true },
    "broken": {
      "success": false,
      "path": "usage",
      "message": "Invalid type: Expected Object but received \"none\""
    }
  }
}
```

Zod Mini gave the same result with `"message":"Invalid input"` for the broken copy, since the Worker entry does not load the locale. One practical note: starting the two `wrangler dev` sessions at the same time from one checkout made the second fail with `SQLite failed … database is locked`, because both use the same `.wrangler/` state directory. Run them one after the other. `.wrangler` is now in `.gitignore`.

## Types

`spikes/schema-library/types.ts` holds 16 compile-time assertions, checked by `vp exec tsc -p spikes/schema-library/tsconfig.json`, with an `Equal<A, B>` type that is `true` only when the two types are assignable in both directions and neither is `any`. All 16 hold for both libraries:

- The whole inferred request type equals the hand-written validator's `ValidDecisionRequest`, the union of `DecisionRequest<"noul"> | DecisionRequest<"choice"> | DecisionRequest<"score">`.
- `Extract<Inferred, { primitive: P }>` equals the hand-written generic `DecisionRequest<P>` at each `P`. That is how the generic survives: the schema infers the discriminated union, and the generic becomes an `Extract` over it. `criteria?: …` stays exactly optional because both schemas use `exactOptional`.
- `state` equals `Content`, and the element type of a list state equals `JsonValue`, so the recursive JSON schema infers the same recursive type. Valibot needs the explicit annotation `v.GenericSchema<JsonValue>` on the recursive constant; Zod has `z.json()` built in.
- The inferred response type equals `DecisionSuccess<P>` per primitive with the refusal answer added, unioned with `DecisionFailure`, and `Extract<Response, { primitive: "score" }>["answers"][string]` equals `ScoreAnswer | RefusalAnswer`, so the answer-by-primitive mapping is recoverable from the union.
- The schema factories take `Readonly<CountRange>` and the frozen capability objects from `catalog.ts` without a cast, so the readonly capability data needs no change.

One thing a schema cannot express: `contract.ts` also holds constants such as `KEEP_ALIVE_SECONDS` and endpoint paths, which stay hand-written; the schemas import them, as `response.ts` does for the keep-alive picklist.

## Ergonomics

Non-blank, non-comment lines, counted with `grep -v -E '^\s*(//|\*|/\*\*?|\*/|$)' | wc -l`:

| Code                                     | Valibot | Zod Mini | Hand-written                                                            |
| ---------------------------------------- | ------- | -------- | ----------------------------------------------------------------------- |
| Schema 1 (request, with all 39 messages) | 251     | 226      | 401 (`src/decision/validate.ts`, which also validates the warm request) |
| Schema 2 (three providers' wire shapes)  | 99      | 105      | none yet                                                                |
| Schema 3 (browser response)              | 56      | 60       | about 90 in `src/ui/client.ts`                                          |

The counts were taken on the committed files after formatting, with the command above run per file from the repository root; an earlier version of this table was counted before the formatter reflowed the code and before the plain-object guards and the `src/` imports were added, which is why the fairness review found it stale. By the same method, Valibot's post-parse wording block (`describeCriteriaIssue` and `describeRequestIssue` in `valibot/request.ts`) is 102 lines. Both libraries cut the request validator by more than a third and give every provider's wire shape in about 100 lines. The qualitative differences:

- Runtime limits read naturally in both: `v.minEntries(min)`, `v.maxEntries(max)`, `z.minLength(min)`, or a `refine` with the count in a closure. Valibot has `minEntries`/`maxEntries` for records (beta); Zod has no record-size check, so the option count is a `z.refine`.
- The cross-field rule ("the number of levels depends on the capabilities, and a question needs criteria from one of two places") is a custom check in both; Zod's path is a plain array, Valibot's is three path-item objects.
- Zod's `.check(...checks)` takes a spread; Valibot's `v.pipe` has fixed arities, so optional actions need a value such as `Number.POSITIVE_INFINITY`.
- Zod's inline `error` maps keep structure and wording together; Valibot's eager messages split them.
- Valibot's `abortEarly` gives today's stop-at-first behaviour directly; Zod collects every issue and the spike takes `issues[0]`.
- Valibot's `is` and Zod's `validate` are both boolean type guards for the browser.

## Parse speed

`node spikes/schema-library/bench.ts` parses each input 20,000 times per round and reports the median of 7 rounds after a warm-up, on Node 24.21.0 on an Apple M3 Pro. Schemas are built once, outside the loop, as an app would at module load.

| Input                            | Library      | Parses per second | Microseconds per parse |
| -------------------------------- | ------------ | ----------------- | ---------------------- |
| request: choice example (2.0 KB) | hand-written | 824,084           | 1.2                    |
| request: choice example (2.0 KB) | Valibot      | 117,917           | 8.5                    |
| request: choice example (2.0 KB) | Zod Mini     | 118,433           | 8.4                    |
| TypeSafe choice answer           | Valibot      | 1,245,702         | 0.8                    |
| TypeSafe choice answer           | Zod Mini     | 659,516           | 1.5                    |
| SubQ three answers               | Valibot      | 260,302           | 3.8                    |
| SubQ three answers               | Zod Mini     | 261,814           | 3.8                    |
| OpenAI three answers             | Valibot      | 347,794           | 2.9                    |
| OpenAI three answers             | Zod Mini     | 276,944           | 3.6                    |

Both libraries are about seven times slower than the hand-written validator on the request and equal to each other; Valibot is faster on the smallest answer and on the OpenAI array form. Every number is microseconds against a 330 ms network round trip (`docs/spikes/provider-probes.md`), so speed does not separate them. Zod also offers `z.compile(schema)` for an ahead-of-time fast path (its README quotes a median 2.4x; not measured here). The Valibot `lazy` placement noted above halved its request time; the first, docs-style version measured 18.9 µs.

For an independent source, the Runtype Benchmarks suite (https://github.com/moltar/typescript-runtime-type-benchmarks, results at https://moltar.github.io/typescript-runtime-type-benchmarks) includes both libraries; its results page did not render as text to the fetch made here, so no figure from it is quoted.

## Ecosystem

All figures were read on 2026-10-13.

| Fact                                 | Valibot                                                   | Zod                                               | Source                                                                                               |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Standard Schema                      | Yes                                                       | Yes                                               | `"~standard"` in `node_modules/valibot/dist/index.d.mts` and `node_modules/zod/v4/core/schemas.d.ts` |
| Licence                              | MIT                                                       | MIT                                               | `node_modules/*/package.json`, `LICENSE` files                                                       |
| Latest stable                        | 1.5.0, 2026-09-09                                         | 4.6.7, 2026-10-12                                 | `npm view <pkg> dist-tags time`                                                                      |
| Releases on the current major        | 9 (1.0.0 2025-03-19 to 1.5.0), about one every two months | 58 (4.0.0 2025-07-09 to 4.6.7), several per month | `npm view <pkg> time`                                                                                |
| Weekly downloads                     | 22,574,355                                                | 346,095,287                                       | `https://api.npmjs.org/downloads/point/last-week/<pkg>`                                              |
| GitHub stars                         | 9,036                                                     | 44,112                                            | `gh api repos/open-circle/valibot`, `gh api repos/colinhacks/zod`                                    |
| Open issues                          | 94                                                        | 70                                                | `gh api search/issues`                                                                               |
| Issues opened / closed, last 90 days | 29 / 13                                                   | 124 / 162                                         | `gh api search/issues … created:>2026-07-13`, `closed:>2026-07-13`                                   |
| Pull requests merged, last 90 days   | 61                                                        | 207                                               | `gh api search/issues … is:pr is:merged merged:>2026-07-13`                                          |
| Commits, last 90 days                | 61                                                        | 100 or more (one page)                            | `gh api repos/<repo>/commits?since=2026-07-13`                                                       |
| Lead maintainer's share of commits   | fabian-hiller 2,348; next contributor 278                 | colinhacks 1,086; next contributor 63             | `gh api repos/<repo>/contributors`                                                                   |
| npm publishers                       | fabian-hiller                                             | colinhacks                                        | `npm view <pkg> maintainers`                                                                         |
| Last push                            | 2026-10-10                                                | 2026-10-13                                        | `gh api repos/<repo>`                                                                                |

Both are led by one person who writes most of the code. Zod has the larger community, more frequent releases, and about fifteen times the downloads; Valibot's cadence is slower and its issue backlog grows (29 opened against 13 closed in the quarter). Both implement Standard Schema, so either can be swapped behind a `StandardSchemaV1` interface by code that only needs validation.

## Fairness review

A separate review reproduced the measurements before the owner decided. It found no invented numbers and no deliberately weakened Valibot code, and judged the evidence too close to call; the owner chose Zod Mini on safety by default (see ADR-0004). Its five findings, which this document and the ADR now reflect:

1. **Wording.** Valibot does resolve messages early (`node_modules/valibot/dist/index.mjs`, line 200 in `_addIssue`, against Zod's `finalizeIssue` at `node_modules/zod/v4/core/util.js`, line 573), but the cost is bounded: the post-parse wording block is about a hundred lines, and a record-level `v.rawCheck` that re-parses each entry with an id-specific schema would also work through the public API, at the cost of hand-stitched paths and lost type inference. The too-long-id message does not need the path, because `issue.input` is the key. Zod also decodes path positions (`path[1]`, `path.at(-1)`). The real difference is where the wording code lives, not whether it is possible.
2. **Arrays.** Valibot accepts arrays for objects whose keys are all optional and for records, and issue #1630 is labelled "intended". Only two of the five guards in schema 1 close real holes: without them, Noul criteria sent as a list are accepted as `{}` and Choice criteria as a list are accepted as `{ "0": … }`. The root guard only changes the message (the variant would otherwise report a missing `primitive`), and the question-object and questions-record guards changed no result, because objects with required keys already reject arrays. A one-line helper, `obj = (entries) => v.pipe(plainObject, v.strictObject(entries))`, replaces all five.
3. **Bundle.** The measurement is fair: 5,123 B against 10,884 B gzip. About 3.7 KB of the gap is fixed library overhead, from a minimal object-plus-record entry at 1,326 B against 5,023 B. Bundle size is the only conceded point whose cost cannot be engineered away.
4. **Ecosystem** is the weakest reason. Provider API changes are absorbed by editing this project's own schemas, not by library releases, and the ADR itself lists Zod's rapid releases as a churn risk. It is defensible only as a tie-breaker, and the ADR now ranks it as a minor factor.
5. **Stale counts.** The first version of the Ergonomics table was counted before formatting and before the guards were added. The recount above gives 251 lines for Valibot's `request.ts` against 226 for Zod's. Both libraries need about five workarounds; Zod's (no record-size check, so a `refine`; `unrecognized_keys` paths; `toDotPath`; `invalid_key` wrapping; the discriminated union's declared issue type) are now listed in the ADR as well as here.

## What this changes in the other issues

- **#6 and #7 (the Worker and the first adapter).** Write the request validation and the provider's response parsing against Zod Mini from the start, with `z.config(z.locales.en())` in the Worker so logged provider errors read as in the table above.
- **#8 and #15 (JSON and multipart requests).** The multipart boundary needs a schema for the form fields and the image limits in `capabilities.images`; `z.file()` exists in Zod Mini for the `File` parts.
- **#10 and #11 (SubQ and OpenAI adapters).** The wire shapes in `spikes/schema-library/zod-mini/provider.ts` are a starting point; the OpenAI schema already includes the refusal answer and `confidence` as optional.
- **PR #30.** `validateDecisionRequest(value, capabilities)` keeps its signature; the migration replaces its body.

## Follow-up issues

These are drafts for the coordinator to file. They were not created on GitHub.

### Draft 1: Migrate `contract.ts` and `validate.ts` to Zod Mini with identical messages and tests

**Primary review question.** Does the schema-based validator return exactly what today's hand-written validator returns, for every test in `src/decision/validate.test.ts`, with no test weakened?

**Why.** ADR-0004 chose Zod Mini. `src/decision/validate.ts` (about 440 lines) and the ten type guards in `src/ui/client.ts` are hand-written next to the types in `src/decision/contract.ts`, so the two can drift. The spike (`docs/spikes/schema-library.md`) showed that a Zod Mini schema reproduces all 39 request messages and paths and infers the contract's types, in `spikes/schema-library/zod-mini/`.

**Scope.**

- Move `zod` from `devDependencies` to `dependencies`, keep `zod/mini` as the import path, and add the `prefer-vite-plus-imports`-style guard the project uses if one applies.
- Replace the body of `validateDecisionRequest(value, capabilities)` with the schema factory from the spike, keeping the signature and the `ValidationResult` shape from PR #30. Keep `describeKind`, `quoteList`, `quoteChoices`, and `count.ts` as the wording helpers. Keep `validateWarmRequest` hand-written or as a two-line schema, whichever is shorter.
- Derive the request types from the schema: `ValidDecisionRequest = z.output<…>` and `DecisionRequest<P> = Extract<ValidDecisionRequest, { primitive: P }>`. Keep the constants (`KEEP_ALIVE_SECONDS`, endpoints) hand-written in `contract.ts`. Keep `type` aliases, not interfaces.
- Replace `isDecisionResponse` and `isWarmResponse` in `src/ui/client.ts` with `z.validate` over response schemas, including the refusal answer from PR #30.
- Cache one schema per `ProviderCapabilities` object (the spike rebuilt it per call).
- Add a test for every position where an object is expected (the request, each question, the `questions` record, Noul criteria, Choice criteria, and the response objects), asserting that an array is rejected with today's message and path. Zod rejects arrays by default; the tests keep that protection explicit and would hold under any later library change.
- Record the browser bundle before and after with `vp run build`; the spike predicts about 8.4 KB gzipped more.

**Out.** Changing any message or path; adding the English locale to the browser (schema 1 carries its own wording); provider response schemas (draft 2).

**Acceptance criteria.**

- `src/decision/validate.test.ts` passes unchanged, and the comparison test from the spike (`spikes/schema-library/compare.test.ts`) still passes against the migrated validator when pointed at it.
- The compile-time assertions in `spikes/schema-library/types.ts` hold against the migrated types, then the spike folder is deleted in the same PR or the next.
- `vp check`, `vp test`, and `vp run build` pass, and the PR description records the gzipped bundle size before and after.
- Every object position has a test that an array is rejected, and all of them pass.
- No `interface` is introduced; `src/decision/neutral.test.ts` still passes.

**Dependencies.** None; PR #30 (the capabilities object) is merged. **Decision or spike.** Neither; applies ADR-0004.

### Draft 2: Validate the new boundaries with Zod Mini schemas (#7, #8, #10, #11, #15)

**Primary review question.** Does every byte that crosses into the Worker, from the browser and from the three providers, pass a schema before any code reads it, and does a malformed body produce a logged path?

**Why.** The plan adds the Worker's JSON and multipart request boundaries (#8, #15) and three providers' response boundaries (#7, #10, #11), two of them beta APIs that may change shape. ADR-0004 chose Zod Mini for these. The spike wrote the three wire shapes, both error envelopes, and the models lists in `spikes/schema-library/zod-mini/provider.ts` and parsed all 33 recorded fixtures with them.

**Scope.**

- One `schema.ts` per provider adapter, starting from the spike's `provider.ts`: decision response (strip unknown fields), error envelope, and warm-path response. The OpenAI schema includes the `refusal` answer and treats `confidence` as optional, as the fixtures show.
- A fixture test per adapter that parses every file in `worker/providers/fixtures/<provider>/` and one deliberately broken copy, asserting the path.
- The Worker calls `z.config(z.locales.en())` once at module load, so a parse failure logs `Invalid input: expected number, received string` with its dot path rather than `Invalid input`. The browser does not load the locale.
- #8: the Worker validates the JSON request with the migrated `validateDecisionRequest` from draft 1 and returns its message and path as today.
- #15: a schema for the multipart fields and for each image part (`z.file()`, `maxCount`, `maxBytesPerImage`, `maxBytesPerRequest`, `mediaTypes` from `capabilities.images`), with messages written in the project's voice.
- A mapping from a provider parse failure to the `DecisionFailure` the browser shows, with the dot path in `detail`.

**Out.** Changing the fixtures; validating provider responses in the browser (the Worker normalises them first).

**Acceptance criteria.**

- Every fixture parses in its adapter's test; a broken copy fails and the test names the path.
- A request with an image over `maxBytesPerImage` is refused with a message naming the limit and the part, before any provider call.
- A provider response the schema rejects becomes a `DecisionFailure` whose `detail` is the dot path, and the Worker log line contains the English default message.
- `vp check`, `vp test`, and `vp run build` pass.

**Dependencies.** Draft 1; #6 (the Worker). **Decision or spike.** Neither; applies ADR-0004.
