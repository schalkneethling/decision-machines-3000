/**
 * How the deploy scripts start the project's own Wrangler, on every platform.
 *
 * Spawning the bare name `wrangler` relies on `node_modules/.bin`, where npm
 * installs a `.cmd` shim on Windows, and `spawnSync` cannot launch a `.cmd`
 * file without a shell. A shell would have to parse the deploy arguments the
 * user typed, so instead this runs Wrangler's own entry file with the Node
 * that is running the script. The entry file is read from the `bin.wrangler`
 * field of Wrangler's `package.json`, because the package's `exports` expose
 * `./package.json` but not `./bin/wrangler.js` (wrangler 4.150.0).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** The executable and arguments that run the installed Wrangler with `args`. */
export function wranglerCommand(args: readonly string[]): [string, string[]] {
  const manifestPath = createRequire(import.meta.url).resolve("wrangler/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: { wrangler: string };
  };
  return [process.execPath, [join(dirname(manifestPath), manifest.bin.wrangler), ...args]];
}
