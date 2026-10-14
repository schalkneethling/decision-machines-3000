# ADR-0004: Zod Mini for schema validation at the data boundaries

- **Status:** Accepted, by the owner on 2026-10-13, after a fairness review of the spike.
- **Date:** 2026-10-13
- **Spike:** issue #31, results in [`docs/spikes/schema-library.md`](../spikes/schema-library.md)

The comparison code named below (`spikes/schema-library/`) is on the branch [`issue-31-schema-library-spike`](https://github.com/schalkneethling/jev-3000/tree/issue-31-schema-library-spike), not on `main`.

## Context

All runtime validation is hand-written today: `src/decision/validate.ts` checks requests (about 440 lines), about ten type guards in `src/ui/client.ts` check the server's responses, and the TypeScript types in `src/decision/contract.ts` are written separately from those checks, so the two can drift. The plan adds more boundaries: the Worker's JSON and multipart requests (#8, #15) and three providers' responses (#7, #10, #11), two of them from beta APIs that may change.

Two libraries were compared on the project's real data: Valibot 1.5.0 and Zod Mini 4.6.7 (the `zod/mini` entry of the `zod` package). The same three schemas were written in each, idiomatically: the neutral `DecisionRequest` built from a provider's capabilities, the three providers' wire shapes, and the browser's `DecisionResponse`. The owner stated no preference; the choice had to come from evidence. A fairness review then reproduced the measurements and found no invented numbers and no weakened Valibot code.

## Decision

Adopt a schema library, and choose **Zod Mini**, imported from `zod/mini`.

**The comparison was close.** Both libraries reproduce all 39 of today's request messages and paths exactly, parse every recorded fixture, run in workerd, infer types equal to the contract, parse the request in about 8.5 microseconds, implement Standard Schema, and need about five workarounds each. The fairness review judged the evidence too close to call on its own.

**The tie-breaker is safety by default.** The schemas ship to the browser, where the client validates requests and checks responses, and the owner values handling data well over bundle size. Zod Mini rejects an array where an object is expected without a guard anyone must remember, and keeps each message beside the rule that raises it. Bundle size is the accepted cost: about 5.7 KB more gzipped script than Valibot would add.

- Requests and responses are described once as schemas; the contract's types are inferred from them (`DecisionRequest<P>` becomes `Extract<z.output<Schema>, { primitive: P }>`), and constants such as `KEEP_ALIVE_SECONDS` stay hand-written next to them.
- Today's 39 user-facing messages and dotted paths are kept exactly, as inline `error` functions on the schemas that raise them.
- The Worker loads the English locale (`z.config(z.locales.en())`) so a provider response that fails its schema logs a readable default message; the browser does not, because the request schema carries its own wording.
- The migration of `contract.ts`, `validate.ts`, and `client.ts` is one issue; the new boundaries in #7, #8, #10, #11, and #15 use schemas from the start. Both are drafted at the end of the spike document. The migration adds a test for every position where an object is expected, asserting that an array is rejected, so the protection stays under test whichever library is in place.

## Why, in order of weight

1. **Arrays are rejected by default.** Valibot's object schemas with only optional keys, its records, and its variants accept arrays (`[]` passes `v.strictObject({})`; `["a", "b"]` passes a record as `{ "0": "a", "1": "b" }`), confirmed by the spike's tests and by issue open-circle/valibot#1630, which the maintainers label as intended. Objects with required keys already reject arrays. In schema 1 this opened two real holes: Noul criteria sent as a list were accepted as `{}`, and Choice criteria sent as a list were accepted as an object keyed by index. The Valibot workaround is bounded: a one-line helper such as `obj = (entries) => v.pipe(plainObject, v.strictObject(entries))` closes every position, and a test per object position keeps it closed. The cost is that someone must remember to use the helper at each new boundary; Zod needs no helper.
2. **Wording stays beside the rule.** Fourteen of the 39 messages name the enclosing question (`Question "tone" has no criteria`). Zod resolves a message after every parent has added its key, so that wording sits on the schema that raises the issue (`error` functions that read `issue.path`). Valibot resolves a message the moment the issue is created, before the parent prepends its key, so the same wording is produced after the parse by one function that decodes paths; the spike's version is 102 lines by the method in the spike document, and a record-level `v.rawCheck` that re-parses each entry with an id-specific schema would also work through the public API, at the cost of hand-stitched paths and lost type inference. The too-long-id message needs no path at all, because the key is the issue's `input`. Zod also decodes path positions (`path[1]`, `path.at(-1)`). The difference is where the wording code lives and whether a schema change must be mirrored elsewhere, not whether it is possible.
3. **Ecosystem, as a minor factor only.** Zod has about fifteen times the weekly downloads (346 million against 22.6 million), 58 releases on its current major against 9, and 207 pull requests merged in the last quarter against 61. This is a tie-breaker at most: changes in the providers' beta APIs are absorbed by editing this project's own schemas, not by library releases, and the rapid release cadence is itself listed below as a churn risk.
4. **Smaller details.** Zod has `z.json()` built in (Valibot needs an annotated recursive constant); its `.check(...checks)` is variadic where `v.pipe` has fixed arities; Valibot's `minEntries`/`maxEntries`, which the option count needs, are still marked beta; and Valibot's `v.lazy` calls its getter on every parse, which doubled the request parse time until `lazy` was moved to the recursion points.

## Zod Mini's own workarounds

The migration inherits these, each marked in `spikes/schema-library/zod-mini/request.ts`:

- Zod has no record-size check, so the option count is a `z.refine` with the limit in a closure; Valibot has `v.minEntries`/`v.maxEntries`.
- An `unrecognized_keys` issue sits on the object and lists the keys in `issue.keys`, so the result mapping appends the key to get today's `questions.greeting.type`.
- `z.core.toDotPath` writes numbers as `[0]` and quotes keys with special characters; today's paths are `criteria.0`, so the project joins `issue.path` with dots itself.
- A failed record key arrives wrapped in an `invalid_key` issue whose `input` is the key, so the question-id message lives on the record's error map rather than the key schema's.
- The declared issue type of `z.discriminatedUnion` is `invalid_union` only, but its parser also raises `invalid_type` for a non-object input, so the error map tests `issue.code !== "invalid_union"`.
- Shared with Valibot: a length check before the tuple schema (so a short criteria list reports "too few levels" at the list's path), and the empty-id rule on the `questions` record rather than on the key schema.

## What Valibot does better

- **Bundle size.** 5,123 bytes gzipped for the identical browser entry against 10,884 for Zod Mini (today's hand-written code: 2,519). About 3.7 KB of the gap is fixed library overhead (a minimal object-plus-record entry is 1,326 B against 5,023 B), so it cannot be engineered away. On the app's 15.65 KB of script that is roughly +17% against +53%. This is the one measured row where Valibot wins clearly, and it is an accepted cost of this decision and the first reason to revisit it.
- **Default messages without setup.** `Invalid type: Expected number but received "1"` out of the box, quoting the received value; Zod Mini says `Invalid input` until a locale is loaded, and then names the type rather than the value.
- **Richer issue paths.** Each Valibot path item carries that level's `input`, `key`, and `value`, which let the post-parse wording function read the request's `primitive` from the path. Zod's path is keys only.
- **Stop at the first problem** is a parse option (`abortEarly`); Zod collects every issue.
- **Speed on the smallest payloads.** 0.8 against 1.5 microseconds for a one-answer Jev response; equal on the request.

## Consequences

- The browser downloads about 8.4 KB more gzipped script after the migration than today, about 5.7 KB more than Valibot would have cost, and about 2.4 KB of hand-written validation goes away.
- Messages that depend on where a shared schema sits (`The default "criteria"` against `The "criteria" of question "tone"`) read the position from `issue.path` inside `error` functions. The `$ZodErrorMap` type declares `path` optional, so a test per message, as today, remains the safeguard.
- Every object position gets a test that an array is rejected, in the migration and at each new boundary.
- Both `vp check` and `vp test` stay free of 1Password, because the schemas are pure code.
- `valibot` is removed from `devDependencies` when the spike folder is deleted.

## What would make us revisit

- A browser bundle budget is set and this decision breaks it: reconsider Valibot with the `plainObject` helper at every object position and the array-rejection tests already in place, which would save about 5.7 KB gzipped.
- Zod stopping to fill `path` before schema-level `error` functions run, which the type already permits; the migration's message tests would catch it, and the fallback is a post-parse wording function as the spike's Valibot version shows.
- Valibot resolving messages after the path is complete, or rejecting arrays in object and record schemas by default (issue #1630), which would remove the two deciding factors above.
- Zod Mini's API changing under its fast release cadence in a way that costs the project more than a quarter's upkeep, or `zod/mini` losing parity with `zod`.
- Both libraries implement Standard Schema, so a later swap behind a `StandardSchemaV1` interface is possible for code that only needs validation; the wording functions and the `Extract`-based types are the parts a swap would have to redo.
