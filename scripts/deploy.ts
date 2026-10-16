/**
 * The `deploy` script: runs the provider-key check, then `wrangler deploy`, both
 * aimed at the same Worker.
 *
 * Arguments given to `vp run deploy` (for example `--name`, `--env`, `--config`,
 * `--dry-run`) used to reach only the last command of a `check && wrangler deploy`
 * chain, so the check could look at one Worker while the deploy changed another.
 * Here one script receives every argument, passes all of them to `wrangler deploy`,
 * and passes the targeting ones to the check (see `targetArguments`).
 *
 * `main` takes its process runners as arguments so tests never start Wrangler.
 */

import { spawnSync } from "node:child_process";

import { main as checkKeys } from "./check-provider-keys.ts";
import type { ListResult } from "./check-provider-keys.ts";

/** The two processes this script can start, replaceable in tests. */
export type DeployRunners = {
  /** Lists the Worker's secrets for the given targeting arguments. */
  list?: (target: readonly string[]) => ListResult;
  /** Runs `wrangler deploy` with the given arguments and returns its exit code. */
  deploy?: (argv: readonly string[]) => number;
};

/** Runs `wrangler deploy` with this process's terminal, so its output and prompts pass through. */
function runWranglerDeploy(argv: readonly string[]): number {
  const run = spawnSync("wrangler", ["deploy", ...argv], { stdio: "inherit" });
  if (run.error) {
    console.error(`Could not start wrangler: ${run.error.message}`);
    return 1;
  }
  return run.status ?? 1;
}

/**
 * Checks the Worker has a provider key and, only if it does, deploys. Returns the
 * process exit code: the check's when it fails, otherwise Wrangler's.
 */
export function main(argv: readonly string[], runners: DeployRunners = {}): number {
  const checked = checkKeys(runners.list, argv);
  if (checked !== 0) return checked;
  return (runners.deploy ?? runWranglerDeploy)(argv);
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
