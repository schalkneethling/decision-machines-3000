import { describe, expect, it } from "vite-plus/test";

import {
  evaluateListing,
  isWorkerNotFound,
  main,
  NO_KEYS_MESSAGE,
  parseSecretNames,
} from "./check-provider-keys.ts";
import type { ListResult } from "./check-provider-keys.ts";

const names = (...list: string[]) =>
  JSON.stringify(list.map((name) => ({ name, type: "secret_text" })));
const listed = (stdout: string): ListResult => ({ status: 0, stdout, stderr: "" });
const NOT_FOUND =
  '\u001B[31m✘ [ERROR]\u001B[0m Worker "dm3000-x" not found.\n\n  If this is a new Worker, run `wrangler deploy` first.';

describe("evaluateListing", () => {
  it.each(["TYPESAFE_API_KEY", "SUBQ_API_KEY", "OPENAI_API_KEY"])("passes with only %s", (key) => {
    expect(evaluateListing(listed(names("ACCESS_AUD", key)))).toMatchObject({ ok: true });
  });

  it("stops when the Worker has secrets but none is a provider key", () => {
    const outcome = evaluateListing(listed(names("ACCESS_AUD", "ACCESS_TEAM_DOMAIN")));
    expect(outcome).toEqual({ ok: false, reason: "no-keys", message: NO_KEYS_MESSAGE });
  });

  it("stops on an empty list", () => {
    expect(evaluateListing(listed("[]"))).toMatchObject({ ok: false, reason: "no-keys" });
  });

  it("counts a Worker that does not exist yet as having no keys, not as an error", () => {
    const outcome = evaluateListing({ status: 1, stdout: "", stderr: NOT_FOUND });
    expect(outcome).toMatchObject({ ok: false, reason: "no-keys" });
  });

  it("reports any other failure as a failed listing", () => {
    const outcome = evaluateListing({ status: 1, stdout: "", stderr: "Authentication error" });
    expect(outcome).toMatchObject({ ok: false, reason: "list-failed" });
  });

  it("reports unreadable output as a failed listing, even with exit code 0", () => {
    expect(evaluateListing(listed("not json"))).toMatchObject({
      ok: false,
      reason: "list-failed",
    });
  });

  it("names the three variables and prints no value", () => {
    for (const name of ["TYPESAFE_API_KEY", "SUBQ_API_KEY", "OPENAI_API_KEY"]) {
      expect(NO_KEYS_MESSAGE).toContain(name);
    }
  });
});

describe("isWorkerNotFound", () => {
  it("needs exit code 1 and the not-found text together", () => {
    expect(isWorkerNotFound({ status: 1, stdout: "", stderr: NOT_FOUND })).toBe(true);
    expect(isWorkerNotFound({ status: 2, stdout: "", stderr: NOT_FOUND })).toBe(false);
    expect(isWorkerNotFound({ status: 1, stdout: "", stderr: "route not found" })).toBe(false);
  });
});

describe("parseSecretNames", () => {
  it("returns the names", () => {
    expect(parseSecretNames(names("A", "B"))).toEqual(["A", "B"]);
  });

  it.each(["{}", '[{"type":"secret_text"}]', "[1]", "[null]", ""])("rejects %j", (text) => {
    expect(parseSecretNames(text)).toBeUndefined();
  });
});

describe("main", () => {
  it("returns 0 when a key exists and 1 when none does", () => {
    expect(main(() => listed(names("SUBQ_API_KEY")))).toBe(0);
    expect(main(() => listed("[]"))).toBe(1);
  });
});
