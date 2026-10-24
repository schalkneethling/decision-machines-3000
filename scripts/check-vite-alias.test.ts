import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vite-plus/test";

import { annotation, evaluatePackageJson, expectedAlias, main } from "./check-vite-alias.ts";

/** A package.json laid out like the real one, with the versions under test. */
const manifest = (vitePlus: string, devAlias?: string, overrideAlias?: string) =>
  JSON.stringify(
    {
      name: "fixture",
      devDependencies: {
        ...(devAlias === undefined ? {} : { vite: devAlias }),
        "vite-plus": vitePlus,
      },
      overrides: overrideAlias === undefined ? {} : { vite: overrideAlias },
    },
    null,
    2,
  );

const OLD = expectedAlias("0.2.8");
const NEW = expectedAlias("1.1.0");

describe("evaluatePackageJson", () => {
  it("passes when both aliases name the vite-plus version", () => {
    expect(evaluatePackageJson(manifest("1.1.0", NEW, NEW))).toEqual({
      ok: true,
      message: "The vite alias matches vite-plus 1.1.0.",
    });
  });

  it("passes on this repository's own package.json", () => {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    expect(evaluatePackageJson(text)).toMatchObject({ ok: true });
  });

  it("fails as on PR #73, where Dependabot bumped vite-plus only, and says what to set", () => {
    const outcome = evaluatePackageJson(manifest("1.1.0", OLD, OLD));
    expect(outcome).toMatchObject({ ok: false, line: 5 });
    expect(outcome.message).toContain(`devDependencies has "${OLD}"; overrides has "${OLD}"`);
    expect(outcome.message).toContain(
      `Set "vite" to "${NEW}" in both devDependencies and overrides`,
    );
    expect(outcome.message).toContain("run `vp install`");
  });

  it("names only the entry that is wrong", () => {
    const outcome = evaluatePackageJson(manifest("1.1.0", NEW, OLD));
    expect(outcome.message).toContain(`(overrides has "${OLD}")`);
  });

  it("reports a missing alias", () => {
    const outcome = evaluatePackageJson(manifest("1.1.0", NEW));
    expect(outcome.message).toContain("(overrides has no vite entry)");
  });

  it("accepts a prerelease version", () => {
    const beta = expectedAlias("1.2.0-beta.1");
    expect(evaluatePackageJson(manifest("1.2.0-beta.1", beta, beta))).toMatchObject({ ok: true });
  });

  it("rejects a range in vite-plus, because the alias must name one version", () => {
    const outcome = evaluatePackageJson(manifest("^1.1.0", NEW, NEW));
    expect(outcome).toMatchObject({ ok: false });
    expect(outcome.message).toContain('"^1.1.0", which is not an exact version');
  });

  it("reports a missing vite-plus entry", () => {
    const outcome = evaluatePackageJson(JSON.stringify({ devDependencies: {} }));
    expect(outcome.message).toBe("package.json has no `vite-plus` entry in devDependencies.");
  });

  it("reports text that is not JSON", () => {
    expect(evaluatePackageJson("{").message).toMatch(/^package\.json is not valid JSON: /);
  });
});

describe("annotation", () => {
  it("points at package.json and the given line", () => {
    expect(annotation("Fix it.", 5)).toBe(
      "::error file=package.json,line=5,title=vite alias out of step::Fix it.",
    );
  });

  it("leaves out the line when there is none", () => {
    expect(annotation("Fix it.")).toBe(
      "::error file=package.json,title=vite alias out of step::Fix it.",
    );
  });

  it("escapes percent signs and line breaks in the message", () => {
    expect(annotation("50%\r\nmore")).toMatch(/::50%25%0D%0Amore$/);
  });
});

describe("main", () => {
  it("returns 0 and prints to stdout when the aliases match", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(main(manifest("1.1.0", NEW, NEW), {})).toBe(0);
    expect(log).toHaveBeenCalledWith("The vite alias matches vite-plus 1.1.0.");
    log.mockRestore();
  });

  it("returns 1 and prints the plain message outside GitHub Actions", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(manifest("1.1.0", OLD, OLD), {})).toBe(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/^package\.json pins vite-plus 1\.1\.0/);
    error.mockRestore();
  });

  it("prints an annotation inside GitHub Actions", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(main(manifest("1.1.0", OLD, OLD), { GITHUB_ACTIONS: "true" })).toBe(1);
    expect(error.mock.calls[0]?.[0]).toMatch(/^::error file=package\.json,line=5,/);
    error.mockRestore();
  });
});
