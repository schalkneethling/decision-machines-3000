/**
 * Reads every recorded provider exchange in `worker/providers/fixtures/`.
 * Node only: the tests, the benchmark, and the report use it. The Worker
 * entries import the JSON files directly instead.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type ProviderId = "typesafe" | "subq" | "openai";

export type Fixture = {
  provider: ProviderId;
  /** File name without `.json`, for example `three-types`. */
  name: string;
  method: string;
  status: number;
  body: unknown;
};

const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "worker", "providers", "fixtures");

export function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const provider of ["typesafe", "subq", "openai"] as const) {
    const directory = join(FIXTURES_DIR, provider);
    for (const file of readdirSync(directory).sort()) {
      if (!file.endsWith(".json")) continue;
      const recorded = JSON.parse(readFileSync(join(directory, file), "utf8")) as {
        request: { method: string };
        status: number;
        body: unknown;
      };
      fixtures.push({
        provider,
        name: file.slice(0, -".json".length),
        method: recorded.request.method,
        status: recorded.status,
        body: recorded.body,
      });
    }
  }
  return fixtures;
}

/** Which of the wire shapes a recorded exchange is, so the test picks the right schema. */
export function wireShapeOf(fixture: Fixture): "decision" | "error" | "models" {
  if (fixture.status >= 300) return "error";
  return fixture.method === "GET" ? "models" : "decision";
}
