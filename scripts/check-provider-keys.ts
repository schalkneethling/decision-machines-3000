/**
 * The deploy-time key check: stops `vp run deploy` when the Worker holds none of
 * the three provider keys, so a deployment cannot go out that answers every
 * request with the setup notice.
 *
 * It reads secret names only. `wrangler secret list --format json` never returns
 * values, and this module never prints anything but variable names. Because it
 * sees names only, it cannot tell a real key from the Deploy button's placeholder
 * `unset`; the Worker's runtime rule (`isKeySet` in `worker/env.ts`) covers that.
 *
 * The decision logic is a set of pure functions, tested without Wrangler. Only
 * `main` starts a process.
 */

import { spawnSync } from "node:child_process";

import { PROVIDER_KEY_NAMES } from "../worker/env.ts";

/** The three variable names, taken from the catalog through `PROVIDER_KEY_NAMES`. */
const KEY_NAMES: readonly string[] = Object.values(PROVIDER_KEY_NAMES);

/** What one `wrangler secret list` invocation produced. */
export type ListResult = { status: number | null; stdout: string; stderr: string };

/** What the check decided, and the line to print for it. */
export type CheckOutcome =
  | { ok: true; message: string }
  | { ok: false; message: string; reason: "no-keys" | "list-failed" };

/** The message printed when no provider key exists. It names variables, never values. */
export const NO_KEYS_MESSAGE =
  `None of the provider keys is set on this Worker. Set at least one of ${KEY_NAMES.join(", ")} ` +
  "before deploying, for example with `wrangler secret put` (see docs/deploy.md).";

// Wrangler colors its errors even when its output is not a terminal, and it ignores
// NO_COLOR. A color code can therefore sit inside the text this module matches (for
// example around the Worker name) or shows to the reader, so codes are removed
// before either.
// oxlint-disable-next-line no-control-regex -- matching the ESC character is the point
const ANSI_ESCAPE = /\u001B\[[0-9;]*m/g;

/**
 * Environment variables whose values must never reach the output, even though
 * `secret list` has no reason to print them.
 */
const CREDENTIAL_VARIABLES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY"] as const;

/**
 * The first line of Wrangler's error output, for the failed-listing message, so a
 * changed Wrangler wording or a wrong account shows up instead of generic advice.
 * `secret list` prints names only, and its errors come from the Cloudflare API or
 * from login, so no secret value should appear. As a second guard, any credential
 * in `env` is replaced, and the line is cut at 200 characters.
 */
export function firstErrorLine(
  stderr: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let line =
    stderr
      .replace(ANSI_ESCAPE, "")
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text !== "") ?? "";
  for (const name of CREDENTIAL_VARIABLES) {
    const value = env[name];
    if (value) line = line.replaceAll(value, "[redacted]");
  }
  return line.slice(0, 200);
}

/**
 * Whether a failed listing means "this Worker does not exist yet". Wrangler prints
 * `Worker "<name>" not found.` and exits 1 (observed on wrangler 4.150.0), which
 * before a first deploy just means no keys have been set.
 */
export function isWorkerNotFound(result: ListResult): boolean {
  if (result.status !== 1) return false;
  return /Worker\s+".*"\s+not found/.test(result.stderr.replace(ANSI_ESCAPE, ""));
}

/**
 * Reads the secret names out of the JSON array `wrangler secret list --format json`
 * prints. Returns `undefined` when the text is not that array, so the caller can
 * report a failed listing instead of guessing.
 */
export function parseSecretNames(stdout: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const names: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string") return undefined;
    names.push(name);
  }
  return names;
}

/** Decides from one listing whether the deploy may go ahead. */
export function evaluateListing(result: ListResult): CheckOutcome {
  if (isWorkerNotFound(result)) {
    return { ok: false, reason: "no-keys", message: NO_KEYS_MESSAGE };
  }
  const names = result.status === 0 ? parseSecretNames(result.stdout) : undefined;
  if (names === undefined) {
    const detail = firstErrorLine(result.stderr);
    return {
      ok: false,
      reason: "list-failed",
      message:
        "Could not read this Worker's secret names, so the key check cannot run " +
        `(\`wrangler secret list\` exited with ${result.status ?? "no status"}` +
        `${detail === "" ? "" : `: ${detail}`}). ` +
        "Log in with `wrangler login` or set CLOUDFLARE_API_TOKEN, then try again.",
    };
  }
  if (!KEY_NAMES.some((name) => names.includes(name))) {
    return { ok: false, reason: "no-keys", message: NO_KEYS_MESSAGE };
  }
  return { ok: true, message: "At least one provider key is set on this Worker." };
}

/**
 * The flags that decide which Worker, in which account, a Wrangler command acts
 * on. Each exists on both `wrangler deploy` and `wrangler secret list`, checked in
 * their `--help` output on wrangler 4.150.0: `--name` is a command option, and
 * `--env`/`-e`, `--config`/`-c`, `--cwd` (which changes where the config file is
 * found), `--profile` (which account's login is used), and `--env-file` (which
 * can supply the account) are global flags. Every one takes a value.
 */
const TARGET_FLAGS: ReadonlySet<string> = new Set([
  "--name",
  "--env",
  "-e",
  "--config",
  "-c",
  "--cwd",
  "--profile",
  "--env-file",
]);

/**
 * Picks out of a deploy command's arguments the ones that choose the target, so
 * the key check can look at the same Worker the deploy will change. It accepts
 * `--flag value` and `--flag=value`, and keeps them in the order given. Every
 * other argument (for example `--dry-run`) is left out, because it does not
 * change which Worker is meant.
 */
export function targetArguments(argv: readonly string[]): string[] {
  const picked: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const flag = argument.split("=", 1)[0];
    if (!TARGET_FLAGS.has(flag)) continue;
    picked.push(argument);
    // The separate-value form: the next argument is this flag's value, whatever it looks like.
    if (argument === flag && index + 1 < argv.length) {
      index += 1;
      picked.push(argv[index]);
    }
  }
  return picked;
}

/** Runs `wrangler secret list --format json` for the given target and captures its output. */
function listSecrets(target: readonly string[]): ListResult {
  const run = spawnSync("wrangler", ["secret", "list", "--format", "json", ...target], {
    encoding: "utf8",
  });
  if (run.error) {
    return { status: null, stdout: "", stderr: run.error.message };
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

/**
 * Runs the check, prints one line, and returns the process exit code. `argv` is
 * the deploy command's arguments, of which only the targeting ones are used, and
 * `list` receives those.
 */
export function main(
  list: (target: readonly string[]) => ListResult = listSecrets,
  argv: readonly string[] = [],
): number {
  const outcome = evaluateListing(list(targetArguments(argv)));
  (outcome.ok ? console.log : console.error)(outcome.message);
  return outcome.ok ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(undefined, process.argv.slice(2));
}
