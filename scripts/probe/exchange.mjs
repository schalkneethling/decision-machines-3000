/**
 * Sends one probe request, saves the sanitised fixture, and keeps score of what happened.
 * The network call and the output folder are parameters, so tests can run it without the
 * network.
 */

import path from "node:path";
import { isSelected } from "./filter.mjs";
import { pickSafeHeaders, scrub, writeFixture } from "./fixtures.mjs";

/** A made-up key that is sent for the bad-key probes. It belongs to nobody. */
const BAD_KEY = "probe-invalid-key-0000000000000000";

/** The same made-up key with the `sk-` prefix that real keys usually carry. */
const BAD_KEY_WITH_PREFIX = `sk-${BAD_KEY}`;

const REQUEST_TIMEOUT_MS = 60_000;

/** Keep a long model list readable: the first few entries plus any that matter to this project. */
function trimModelList(body) {
  if (typeof body !== "object" || body === null || !Array.isArray(body.data)) return body;
  if (JSON.stringify(body).length < 8_000) return body;
  const relevant = /luna|decision|snap|subq|jev/i;
  const kept = body.data.filter((model, index) => index < 3 || relevant.test(model?.id ?? ""));
  return { ...body, data: kept, trimmed: { originalCount: body.data.length } };
}

/**
 * Creates the `exchange` function for one run.
 *
 * - `keys`: the real key per provider (empty string when absent).
 * - `secrets`: every key present, used for redaction.
 * - `fixtureRoot`: the folder that holds one subfolder per provider.
 * - `fetchImpl`: the `fetch` to call.
 * - `caseFilter`: the parsed command-line filter.
 *
 * The returned `ran` set holds `provider:case` for every case that was attempted, and
 * `failures` holds the cases whose HTTP exchange failed before a response was read.
 */
export function createExchange({ keys, secrets, fixtureRoot, fetchImpl, caseFilter }) {
  const results = [];
  const failures = [];
  const ran = new Set();

  /**
   * Sends one request, saves the sanitised fixture, and prints one summary line.
   * `auth` is "valid" (the real key), "bad" (a made-up key), "bad-sk" (a made-up key with
   * the `sk-` prefix), or "none" (no header).
   *
   * When the HTTP exchange itself fails (a timeout or a dropped connection), nothing is
   * written, so a recorded response is never replaced by a failure. The case is added to
   * `failures` and the function returns `undefined`.
   */
  async function exchange(provider, name, options) {
    if (!isSelected(caseFilter, provider, name)) return undefined;
    ran.add(`${provider}:${name}`);

    const { method = "POST", url, body, auth = "valid", agent, trim = false } = options;
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (auth === "valid") headers.authorization = `Bearer ${keys[provider]}`;
    if (auth === "bad") headers.authorization = `Bearer ${BAD_KEY}`;
    if (auth === "bad-sk") headers.authorization = `Bearer ${BAD_KEY_WITH_PREFIX}`;

    const recordedRequest = {
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        authorization: auth === "none" ? "none" : "Bearer <redacted>",
      },
      ...(body === undefined ? {} : { body }),
    };

    const startedAt = performance.now();
    let status = 0;
    let responseHeaders = {};
    let text = "";
    try {
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher: agent,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      responseHeaders = pickSafeHeaders(response.headers);
      text = await response.text();
    } catch (error) {
      failures.push(`${provider}:${name}`);
      const reason = error instanceof Error ? error.name : "unknown failure";
      console.error(
        `${provider.padEnd(9)} ${name.padEnd(34)} FAILED before a response (${reason}); fixture left as it was`,
      );
      return undefined;
    }
    const latencyMs = Math.round(performance.now() - startedAt);

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text.slice(0, 2_000);
    }

    const fixture = scrub(
      {
        request: recordedRequest,
        status,
        headers: responseHeaders,
        body: trim ? trimModelList(parsed) : parsed,
        latencyMs,
        responseBytes: Buffer.byteLength(text),
      },
      secrets,
    );
    await writeFixture(path.join(fixtureRoot, provider), name, fixture, secrets);

    results.push({ provider, name, status, latencyMs, bytes: fixture.responseBytes });
    console.log(
      `${provider.padEnd(9)} ${name.padEnd(34)} status=${String(status).padEnd(3)} latency=${String(latencyMs).padStart(5)}ms bytes=${fixture.responseBytes}`,
    );
    return fixture;
  }

  return { exchange, results, failures, ran };
}
