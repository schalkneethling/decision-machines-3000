# ADR-0004: Zod Mini for schema validation at the data boundaries

- **Status:** Proposed. The spike's evidence is complete; the coordinator's review of PR #31 accepts or amends it.
- **Date:** 2026-10-13
- **Spike:** issue #31, results in [`docs/spikes/schema-library.md`](../spikes/schema-library.md)

## Context

All runtime validation is hand-written today: `src/decision/validate.ts` checks requests (about 440 lines), about ten type guards in `src/ui/client.ts` check the server's responses, and the TypeScript types in `src/decision/contract.ts` are written separately from those checks, so the two can drift. The plan adds more boundaries: the Worker's JSON and multipart requests (#8, #15) and three providers' responses (#7, #10, #11), two of them from beta APIs that may change.

Two libraries were compared on the project's real data: Valibot 1.5.0 and Zod Mini 4.6.7 (the `zod/mini` entry of the `zod` package). The same three schemas were written in each, idiomatically: the neutral `DecisionRequest` built from a provider's capabilities, the three providers' wire shapes, and the browser's `DecisionResponse`. The owner stated no preference; the choice had to come from evidence.

## Decision

Adopt a schema library, and choose **Zod Mini**, imported from `zod/mini`.

- Requests and responses are described once as schemas; the contract's types are inferred from them (`DecisionRequest<P>` becomes `Extract<z.output<Schema>, { primitive: P }>`), and constants such as `KEEP_ALIVE_SECONDS` stay hand-written next to them.
- Today's 39 user-facing messages and dotted paths are kept exactly, as inline `error` functions on the schemas that raise them.
- The Worker loads the English locale (`z.config(z.locales.en())`) so a provider response that fails its schema logs a readable default message; the browser does not, because the request schema carries its own wording.
- The migration of `contract.ts`, `validate.ts`, and `client.ts` is one issue; the new boundaries in #7, #8, #10, #11, and #15 use schemas from the start. Both are drafted at the end of the spike document.

## Why, in order of weight

1. **Where the wording can live.** The request boundary is the product's main user-facing surface, and its messages name the enclosing question (`Question "tone" has no criteria`). Zod resolves a message after every parent has added its key, so that wording sits on the schema that raises the issue. Valibot resolves a message the moment the issue is created, before the parent prepends its key, so the same wording has to be produced after the parse by a function that decodes paths and mirrors the schema's structure. Both reproduce all 39 messages exactly; only Zod lets structure and wording stay together.
2. **Arrays are not objects.** Valibot's object, record, and variant schemas accept arrays (`[]` passes `v.strictObject({})`; `["a", "b"]` passes a record as `{ "0": "a", "1": "b" }`), confirmed by the spike's tests and by open issue open-circle/valibot#1630. Schema 1 needed a plain-object guard at five positions, and every boundary the plan adds would need the same. Zod rejects arrays where an object is expected.
3. **Ecosystem and cadence.** Zod has about fifteen times the weekly downloads (346 million against 22.6 million), 58 releases on its current major against 9, 207 pull requests merged in the last quarter against 61, and a shrinking issue backlog (162 closed against 124 opened) where Valibot's grows (13 against 29). For two beta provider APIs, a library that ships fixes often matters.
4. **Smaller details that point the same way.** Zod has `z.json()` built in (Valibot needs an annotated recursive constant); its `.check(...checks)` is variadic where `v.pipe` has fixed arities; and Valibot's `minEntries`/`maxEntries`, which the option count needs, are still marked beta.

Both libraries tie on everything else that was measured: all fixtures parse, broken copies fail with the path, both run in workerd, all 16 type assertions hold, the request parses in 8.5 microseconds in both, and both implement Standard Schema under the MIT licence.

## What Valibot does better

- **Bundle size.** 5,123 bytes gzipped for the identical browser entry against 10,884 for Zod Mini (today's hand-written code: 2,519). On the app's 15.65 KB of script that is roughly +17% against +53%. This is the one measured row where Valibot wins clearly, and it is the reason to revisit below.
- **Default messages without setup.** `Invalid type: Expected number but received "1"` out of the box, quoting the received value; Zod Mini says `Invalid input` until a locale is loaded, and then names the type rather than the value.
- **Richer issue paths.** Each Valibot path item carries that level's `input`, `key`, and `value`, which made the post-parse wording function able to read the request's `primitive` from the path. Zod's path is keys only.
- **Stop at the first problem** is a parse option (`abortEarly`); Zod collects every issue.
- **Speed on the smallest payloads.** 0.8 against 1.5 microseconds for a one-answer Jev response; equal on the request.

## Consequences

- The browser downloads about 8.4 KB more gzipped script after the migration, and about 2.4 KB of hand-written validation goes away.
- Messages that depend on where a shared schema sits (`The default "criteria"` against `The "criteria" of question "tone"`) read the position from `issue.path` inside `error` functions. The `$ZodErrorMap` type declares `path` optional, so a test per message, as today, remains the safeguard.
- `z.core.toDotPath` writes `criteria[0]`; the project keeps its own `path.map(String).join(".")` to stay at `criteria.0`, and appends the key of an `unrecognized_keys` issue so unknown-field paths stay `questions.greeting.type`.
- Both `vp check` and `vp test` stay free of 1Password, because the schemas are pure code.
- `valibot` is removed from `devDependencies` when the spike folder is deleted.

## What would make us revisit

- A browser script budget the app approaches, or a measured load-time problem on the deployed Worker's assets, since Valibot would save about 5.8 KB gzipped.
- Zod stopping to fill `path` before schema-level `error` functions run, which the type already permits; the migration's message tests would catch it, and the fallback is a post-parse wording function as the spike's Valibot version shows.
- Valibot resolving messages after the path is complete, or rejecting arrays in object and record schemas by default (issue #1630), which would remove the two heaviest reasons above.
- Zod Mini's API changing under its fast release cadence in a way that costs the project more than a quarter's upkeep, or `zod/mini` losing parity with `zod`.
- Both libraries implement Standard Schema, so a later swap behind a `StandardSchemaV1` interface is possible for code that only needs validation; the wording functions and the `Extract`-based types are the parts a swap would have to redo.
