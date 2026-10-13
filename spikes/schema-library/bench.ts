/**
 * Parse speed on the real payloads. Run with `node spikes/schema-library/bench.ts`.
 *
 * Method: each schema parses its input `ITERATIONS` times in a tight loop; that is
 * one round. `ROUNDS` rounds run and the median round's operations per second is
 * reported, so one slow round (garbage collection, JIT warm-up) does not decide.
 * A warm-up round is run and discarded first. The hand-written validator is
 * included for schema 1 as the baseline the libraries replace.
 *
 * The payloads are small (a few hundred bytes to 2 KB), so the absolute numbers
 * matter less than the ratio to today's code and to the network round trip
 * (330 ms, docs/spikes/provider-probes.md).
 */

import { examples } from "../../src/decision/examples.ts";
import { PROVIDERS } from "../../src/providers/catalog.ts";
import { validateDecisionRequest as validateReference } from "../../src/decision/validate.ts";
import { loadFixtures } from "./shared/fixtures.ts";
import * as valibotProvider from "./valibot/provider.ts";
import { decisionRequestSchema as valibotRequest } from "./valibot/request.ts";
import * as v from "valibot";
import * as zodProvider from "./zod-mini/provider.ts";
import { decisionRequestSchema as zodRequest } from "./zod-mini/request.ts";

const ITERATIONS = 20_000;
const ROUNDS = 7;

const fixtures = loadFixtures();
const body = (provider: string, name: string) =>
  fixtures.find((f) => f.provider === provider && f.name === name)?.body;

const typesafeChoice = body("typesafe", "choice");
const subqThree = body("subq", "three-types");
const openaiThree = body("openai", "three-types");
const capabilities = PROVIDERS.typesafe.capabilities;

// Schemas are built once, outside the timed loop, as an app would do at module load.
const valibotRequestSchema = valibotRequest(capabilities);
const zodRequestSchema = zodRequest(capabilities);

type Candidate = { library: string; input: string; run: () => unknown };

const candidates: Candidate[] = [
  {
    library: "hand-written",
    input: "request: choice example (2.0 KB)",
    run: () => validateReference(examples.choice, capabilities),
  },
  {
    library: "Valibot",
    input: "request: choice example (2.0 KB)",
    run: () => v.safeParse(valibotRequestSchema, examples.choice, { abortEarly: true }),
  },
  {
    library: "Zod Mini",
    input: "request: choice example (2.0 KB)",
    run: () => zodRequestSchema.safeParse(examples.choice),
  },
  {
    library: "Valibot",
    input: "TypeSafe choice answer",
    run: () => v.safeParse(valibotProvider.jevDecision, typesafeChoice),
  },
  {
    library: "Zod Mini",
    input: "TypeSafe choice answer",
    run: () => zodProvider.jevDecision.safeParse(typesafeChoice),
  },
  {
    library: "Valibot",
    input: "SubQ three answers",
    run: () => v.safeParse(valibotProvider.jevDecision, subqThree),
  },
  {
    library: "Zod Mini",
    input: "SubQ three answers",
    run: () => zodProvider.jevDecision.safeParse(subqThree),
  },
  {
    library: "Valibot",
    input: "OpenAI three answers",
    run: () => v.safeParse(valibotProvider.openaiDecision, openaiThree),
  },
  {
    library: "Zod Mini",
    input: "OpenAI three answers",
    run: () => zodProvider.openaiDecision.safeParse(openaiThree),
  },
];

function round(run: () => unknown): number {
  const start = performance.now();
  for (let i = 0; i < ITERATIONS; i++) run();
  return (ITERATIONS / (performance.now() - start)) * 1000;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

console.log(
  `Node ${process.version}, ${ITERATIONS} parses per round, median of ${ROUNDS} rounds.\n`,
);
console.log("| Input | Library | Parses per second | Microseconds per parse |");
console.log("| --- | --- | --- | --- |");
for (const candidate of candidates) {
  const sample = candidate.run() as { ok?: boolean; success?: boolean };
  if (sample.ok === false || sample.success === false)
    throw new Error(`${candidate.library} rejected ${candidate.input}`);
  round(candidate.run);
  const opsPerSecond = median(Array.from({ length: ROUNDS }, () => round(candidate.run)));
  console.log(
    `| ${candidate.input} | ${candidate.library} | ${Math.round(opsPerSecond).toLocaleString("en-US")} | ${(1_000_000 / opsPerSecond).toFixed(1)} |`,
  );
}
