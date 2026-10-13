/**
 * Prints the size of every built entry in `dist/`: minified bytes, gzip at level
 * 9, and Brotli at the default quality (11), both from Node's `node:zlib`. Run
 * after the four `vp build` commands in vite.config.ts:
 *
 *   node spikes/schema-library/bundle/measure.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = join(import.meta.dirname, "dist");

console.log("| Entry | Minified bytes | Gzip bytes | Brotli bytes |");
console.log("| --- | --- | --- | --- |");
for (const mode of readdirSync(dist).sort()) {
  // Vite names the output after the input file, so `entry-<mode>.ts` becomes `entry-<mode>.js`.
  const file = join(dist, mode, `entry-${mode}.js`);
  const code = readFileSync(file);
  const gzip = gzipSync(code, { level: constants.Z_BEST_COMPRESSION }).byteLength;
  const brotli = brotliCompressSync(code).byteLength;
  console.log(
    `| ${mode} | ${code.byteLength.toLocaleString("en-US")} | ${gzip.toLocaleString("en-US")} | ${brotli.toLocaleString("en-US")} |`,
  );
}
