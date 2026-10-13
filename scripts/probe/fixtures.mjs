/**
 * Turns a raw HTTP exchange into a fixture file that is safe to commit:
 * keys are never written, account identifiers are masked, and only a short
 * allow-list of response headers survives. Rate-limit headers are dropped on
 * purpose, because they reveal the account's usage tier and no adapter needs them.
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
    name === "openai-processing-ms"
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
  // Any other key-shaped token, such as a masked echo of a key. The three dots in SubQ's
  // own message "Bearer sk-..." are too short to match, so that text stays readable.
  [/\bsk-[A-Za-z0-9_*.-]{4,}/g, "sk-<redacted>"],
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

/** Matches a key-shaped token that scrubbing should have replaced with `sk-<redacted>`. */
const KEY_SHAPED_TOKEN = /\bsk-[A-Za-z0-9_*.-]{4,}/;

/**
 * Text that must never appear in a fixture: each key in full, its first 8 and its last 4
 * characters (so a partly masked echo is caught too).
 */
function leakNeedles(secrets) {
  return secrets
    .filter((secret) => secret !== "")
    .flatMap((secret) => [secret, secret.slice(0, 8), secret.slice(-4)]);
}

/** True when `text` contains a key, a piece of one, or a key-shaped token. */
export function hasLeak(text, secrets) {
  return (
    KEY_SHAPED_TOKEN.test(text) || leakNeedles(secrets).some((needle) => text.includes(needle))
  );
}

/**
 * Writes one fixture, but only after checking the exact text that would be written.
 * On a leak nothing is written and the error names the fixture, never its content.
 */
export async function writeFixture(directory, name, fixture, secrets) {
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (hasLeak(text, secrets)) {
    throw new Error(
      `redaction check FAILED before writing ${path.basename(directory)}/${name}.json`,
    );
  }
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${name}.json`), text);
}

/** Reads every fixture file under `root` from disk and returns the ones that leak. */
export async function findLeaks(root, secrets) {
  const leaking = [];
  for (const provider of await readdir(root, { withFileTypes: true })) {
    if (!provider.isDirectory()) continue;
    const directory = path.join(root, provider.name);
    for (const file of await readdir(directory)) {
      const content = await readFile(path.join(directory, file), "utf8");
      if (hasLeak(content, secrets)) leaking.push(`${provider.name}/${file}`);
    }
  }
  return leaking;
}
