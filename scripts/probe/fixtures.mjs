/**
 * Turns a raw HTTP exchange into a fixture file that is safe to commit:
 * keys are never written, account identifiers are masked, and only a short
 * allow-list of response headers survives.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Response headers worth keeping. Everything else (request ids, cf-ray, org ids) is dropped. */
function isSafeHeader(name) {
  return (
    name === "content-type" ||
    name === "retry-after" ||
    name === "www-authenticate" ||
    name === "keep-alive" ||
    name === "connection" ||
    name === "openai-processing-ms" ||
    name.startsWith("x-ratelimit-") ||
    name.startsWith("ratelimit-")
  );
}

export function pickSafeHeaders(headers) {
  const kept = {};
  for (const [name, value] of headers) {
    if (isSafeHeader(name.toLowerCase())) kept[name.toLowerCase()] = value;
  }
  return kept;
}

const MASKS = [
  [/\breq_[A-Za-z0-9]{6,}/g, "req_REDACTED"],
  [/\borg-[A-Za-z0-9]{6,}/g, "org-REDACTED"],
  [/\bproj_[A-Za-z0-9]{6,}/g, "proj_REDACTED"],
  [/\buser-[A-Za-z0-9]{6,}/g, "user-REDACTED"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "REDACTED-UUID"],
];

/** Masks identifiers and any key value inside a JSON-serialisable value. */
export function scrub(value, secrets) {
  let text = JSON.stringify(value) ?? "null";
  for (const secret of secrets) {
    // JSON.stringify escapes some characters, so mask both the raw and the escaped form.
    text = text.split(secret).join("<redacted-key>");
    text = text.split(JSON.stringify(secret).slice(1, -1)).join("<redacted-key>");
  }
  for (const [pattern, replacement] of MASKS) text = text.replace(pattern, replacement);
  return JSON.parse(text);
}

export async function writeFixture(directory, name, fixture) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
}

/** Reads every fixture under `root` and returns the files that contain any secret value. */
export async function findLeaks(root, secrets) {
  const leaking = [];
  for (const provider of await readdir(root, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const directory = path.join(root, provider.name);
    for (const file of await readdir(directory)) {
      const content = await readFile(path.join(directory, file), "utf8");
      if (secrets.some((secret) => secret !== "" && content.includes(secret))) {
        leaking.push(`${provider.name}/${file}`);
      }
    }
  }
  return leaking;
}
