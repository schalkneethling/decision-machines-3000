import { describe, expect, it } from "vite-plus/test";

import {
  evaluateListing,
  firstErrorLine,
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

describe("failed listings show Wrangler's first error line", () => {
  it("includes the first non-empty line, without color codes", () => {
    const outcome = evaluateListing({
      status: 1,
      stdout: "",
      stderr: "\n\u001B[31m✘ [ERROR]\u001B[0m Authentication error [code: 10000]\nmore text",
    });
    expect(outcome.message).toContain("✘ [ERROR] Authentication error [code: 10000]");
    expect(outcome.message).not.toContain("\u001B");
    expect(outcome.message).not.toContain("more text");
  });

  it("replaces a credential from the environment and cuts long lines", () => {
    const line = firstErrorLine(`bad token tok-123 ${"x".repeat(300)}`, {
      CLOUDFLARE_API_TOKEN: "tok-123",
    });
    expect(line).not.toContain("tok-123");
    expect(line).toContain("[redacted]");
    expect(line.length).toBe(200);
  });

  it("leaves the exit code alone when stderr is empty", () => {
    const outcome = evaluateListing({ status: 2, stdout: "", stderr: "" });
    expect(outcome.message).toContain("exited with 2)");
  });
});

describe("isWorkerNotFound", () => {
  it("still matches when a color code sits inside the matched text", () => {
    const stderr = 'Worker \u001B[1m"dm3000-x"\u001B[22m \u001B[0mnot found.';
    expect(isWorkerNotFound({ status: 1, stdout: "", stderr })).toBe(true);
  });

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

describe("main with targeting arguments", () => {
  it("passes only the targeting arguments to the listing", () => {
    let seen: readonly string[] = [];
    main(
      (target) => {
        seen = target;
        return listed(names("SUBQ_API_KEY"));
      },
      ["--dry-run", "--name", "other", "--config=x.jsonc"],
    );
    expect(seen).toEqual(["--name", "other", "--config=x.jsonc"]);
  });
});
