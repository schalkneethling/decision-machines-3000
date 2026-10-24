/**
 * The vite alias check: fails when package.json's `vite` alias names a different
 * `@voidzero-dev/vite-plus-core` version than `vite-plus`, and says what to change.
 *
 * Vite+ needs `vite` to resolve to the core package of its own version, so
 * package.json pins `"vite": "npm:@voidzero-dev/vite-plus-core@<version>"` in both
 * `devDependencies` and `overrides`. Dependabot bumps only `vite-plus` and leaves
 * both aliases behind (PR #73, 0.2.8 to 1.1.0), and the build then fails deep in
 * its log with "Expected @voidzero-dev/vite-plus-core@1.1.0, but found ...@0.2.8".
 * CI runs this check before installing anything, so such a pull request fails in
 * seconds with the fix in the message. Locally: `node scripts/check-vite-alias.ts`.
 *
 * The decision logic is a pure function of package.json's text, tested without
 * touching the real file. Only `main` reads it.
 */

import { readFileSync } from "node:fs";

/** The package that `vite` must be an alias for. */
const CORE_PACKAGE = "@voidzero-dev/vite-plus-core";

/**
 * An exact version, such as `1.1.0` or `1.2.0-beta.1`. The alias must name one
 * version, so a range in `vite-plus` cannot be copied into it.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The two places package.json pins the alias, as the reader would name them. */
const ALIAS_LOCATIONS = ["devDependencies", "overrides"] as const;

/** What the check decided. `line` is package.json's `vite-plus` line, when found. */
export type CheckOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; line?: number };

/** The alias value that matches a given `vite-plus` version. */
export function expectedAlias(version: string): string {
  return `npm:${CORE_PACKAGE}@${version}`;
}

/** Reads a field out of parsed JSON, or `undefined` when `record` is not an object. */
function field(record: unknown, key: string): unknown {
  if (typeof record !== "object" || record === null) return undefined;
  return (record as Record<string, unknown>)[key];
}

/** Reads a string field out of parsed JSON, or `undefined` when it is not a string. */
function stringField(record: unknown, key: string): string | undefined {
  const value = field(record, key);
  return typeof value === "string" ? value : undefined;
}

/**
 * The 1-based line of the `"vite-plus":` entry, so a GitHub annotation lands on
 * the line Dependabot changed, which the pull request's diff shows.
 */
function vitePlusLine(text: string): number | undefined {
  const index = text.split("\n").findIndex((line) => /^\s*"vite-plus"\s*:/.test(line));
  return index === -1 ? undefined : index + 1;
}

/** Decides from package.json's text whether both aliases match `vite-plus`. */
export function evaluatePackageJson(text: string): CheckOutcome {
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `package.json is not valid JSON: ${(error as Error).message}` };
  }
  const line = vitePlusLine(text);
  const at = line === undefined ? {} : { line };

  const version = stringField(field(manifest, "devDependencies"), "vite-plus");
  if (version === undefined) {
    return { ok: false, message: "package.json has no `vite-plus` entry in devDependencies." };
  }
  if (!EXACT_VERSION.test(version)) {
    return {
      ok: false,
      ...at,
      message:
        `package.json gives vite-plus as "${version}", which is not an exact version. ` +
        "Pin vite-plus to one version, such as 1.1.0, so the vite alias can name the same version.",
    };
  }

  const expected = expectedAlias(version);
  const wrong = ALIAS_LOCATIONS.flatMap((location) => {
    const actual = stringField(field(manifest, location), "vite");
    if (actual === expected) return [];
    return [`${location} has ${actual === undefined ? "no vite entry" : `"${actual}"`}`];
  });
  if (wrong.length === 0) {
    return { ok: true, message: `The vite alias matches vite-plus ${version}.` };
  }
  return {
    ok: false,
    ...at,
    message:
      `package.json pins vite-plus ${version}, but the vite alias does not match it ` +
      `(${wrong.join("; ")}). Vite+ needs both to name the same version, or \`vp run build\` fails. ` +
      `Set "vite" to "${expected}" in both devDependencies and overrides, run \`vp install\`, ` +
      "and commit package.json and package-lock.json.",
  };
}

/**
 * Formats a failure as a GitHub Actions error annotation, escaped the way
 * `@actions/core` escapes command data and properties (packages/core/src/command.ts
 * in actions/toolkit).
 */
export function annotation(message: string, line?: number): string {
  const data = message.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  const properties = ["file=package.json", ...(line === undefined ? [] : [`line=${line}`])];
  return `::error ${properties.join(",")},title=vite alias out of step::${data}`;
}

/**
 * Runs the check on the given package.json text, prints the outcome, and returns
 * the process exit code. Inside GitHub Actions a failure is also printed as an
 * annotation, so it shows on the pull request.
 */
export function main(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const outcome = evaluatePackageJson(text);
  if (outcome.ok) {
    console.log(outcome.message);
    return 0;
  }
  console.error(
    env["GITHUB_ACTIONS"] === "true" ? annotation(outcome.message, outcome.line) : outcome.message,
  );
  return 1;
}

if (import.meta.main) {
  process.exitCode = main(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
}
