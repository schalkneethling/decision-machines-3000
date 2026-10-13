/**
 * Prints the evidence tables for docs/spikes/schema-library.md as Markdown.
 * Run with `node spikes/schema-library/report.ts` (Node 24 strips the types).
 *
 * The tables: per invalid request case, whether each library's message and path
 * equal the reference validator's; and for each deliberately broken provider
 * response, each library's default wording. Zod Mini ships no locale, so its
 * defaults are shown twice: bare, and after `z.config(z.locales.en())`.
 */

import * as z from "zod/mini";
import { validateDecisionRequest as validateReference } from "../../src/decision/validate.ts";
import { invalidCases } from "./shared/cases.ts";
import { loadFixtures } from "./shared/fixtures.ts";
import type { Fixture } from "./shared/fixtures.ts";
import * as valibotProvider from "./valibot/provider.ts";
import { validateDecisionRequest as validateWithValibot } from "./valibot/request.ts";
import * as zodProvider from "./zod-mini/provider.ts";
import { validateDecisionRequest as validateWithZodMini } from "./zod-mini/request.ts";

type Failure = { ok: false; error: string; detail?: string };

function mark(actual: Failure | { ok: true }, expected: Failure): string {
  if (actual.ok) return "accepted (wrong)";
  const message = actual.error === expected.error;
  const path = actual.detail === expected.detail;
  if (message && path) return "exact";
  if (message) return `path differs: \`${actual.detail ?? "none"}\``;
  if (path) return `message differs`;
  return "both differ";
}

console.log("## Schema 1: invalid request cases\n");
console.log("| Case | Source | Reference detail | Valibot | Zod Mini |");
console.log("| --- | --- | --- | --- | --- |");
let exact = { valibot: 0, zod: 0 };
for (const c of invalidCases) {
  const expected = validateReference(c.request, c.capabilities);
  if (expected.ok) throw new Error(`Case "${c.name}" is not invalid`);
  const valibot = mark(validateWithValibot(c.request, c.capabilities), expected);
  const zod = mark(validateWithZodMini(c.request, c.capabilities), expected);
  if (valibot === "exact") exact.valibot++;
  if (zod === "exact") exact.zod++;
  const detail =
    expected.detail === undefined
      ? "none"
      : `\`${expected.detail.length > 40 ? `${expected.detail.slice(0, 40)}…` : expected.detail}\``;
  console.log(`| ${c.name} | ${c.source} | ${detail} | ${valibot} | ${zod} |`);
}
console.log(
  `\nExact: Valibot ${exact.valibot}/${invalidCases.length}, Zod Mini ${exact.zod}/${invalidCases.length}.\n`,
);

const fixtures = loadFixtures();
const fixtureOf = (provider: Fixture["provider"], name: string): Fixture => {
  const found = fixtures.find((f) => f.provider === provider && f.name === name);
  if (!found) throw new Error(`No fixture ${provider}/${name}`);
  return found;
};

function broken(body: unknown, dotPath: string, replacement: unknown): unknown {
  const copy = structuredClone(body) as Record<string, unknown>;
  const keys = dotPath.split(".");
  let node: Record<string, unknown> = copy;
  for (const key of keys.slice(0, -1)) node = node[key] as Record<string, unknown>;
  node[keys.at(-1) ?? ""] = replacement;
  return copy;
}

const brokenFixtures = [
  {
    name: 'TypeSafe choice: `probabilities.nurse_line` is `"1"`',
    body: broken(
      fixtureOf("typesafe", "choice").body,
      "answers.queue.probabilities.nurse_line",
      "1",
    ),
    jev: true,
  },
  {
    name: 'SubQ three-types: `answers.acuity.type` is `"rank"`',
    body: broken(fixtureOf("subq", "three-types").body, "answers.acuity.type", "rank"),
    jev: true,
  },
  {
    name: "SubQ three-types: `usage` missing",
    body: broken(fixtureOf("subq", "three-types").body, "usage", undefined),
    jev: true,
  },
  {
    name: 'OpenAI three-types: `answers[2].probabilities[1].probability` is `"0.1"`',
    body: broken(
      fixtureOf("openai", "three-types").body,
      "answers.2.probabilities.1.probability",
      "0.1",
    ),
    jev: false,
  },
  {
    name: "OpenAI bad-key: `error.message` missing",
    body: broken(fixtureOf("openai", "bad-key").body, "error.message", undefined),
    jev: false,
    error: true,
  },
];

console.log("## Schema 2: default wording for a broken response\n");
console.log(
  "| Broken copy | Valibot path | Valibot message | Zod Mini path | Zod Mini message (no locale) | Zod Mini message (`en`) |",
);
console.log("| --- | --- | --- | --- | --- | --- |");
for (const b of brokenFixtures) {
  const vSchema = b.error
    ? valibotProvider.openaiError
    : b.jev
      ? valibotProvider.jevDecision
      : valibotProvider.openaiDecision;
  const zSchema = b.error
    ? zodProvider.openaiError
    : b.jev
      ? zodProvider.jevDecision
      : zodProvider.openaiDecision;
  const valibot = valibotProvider.describeParse(vSchema, b.body);
  const zodBare = zodProvider.describeParse(zSchema, b.body);
  z.config(z.locales.en());
  const zodEn = zodProvider.describeParse(zSchema, b.body);
  z.config({ localeError: undefined });
  const cell = (r: { success: true } | { success: false; path: string; message: string }) =>
    r.success ? ["accepted", "accepted"] : [`\`${r.path}\``, r.message];
  console.log(
    `| ${b.name} | ${cell(valibot).join(" | ")} | ${cell(zodBare).join(" | ")} | ${cell(zodEn)[1]} |`,
  );
}
