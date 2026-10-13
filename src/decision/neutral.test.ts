import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { examples } from "./examples.ts";
import { validateDecisionRequest } from "./validate.ts";
import { DEFAULT_PROVIDER } from "../providers/catalog.ts";

const root = join(import.meta.dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(join(root, directory), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("provider-neutral contract", () => {
  it("keeps primitive and noul in the examples and validates them unchanged", () => {
    expect(examples.noul.primitive).toBe("noul");
    for (const example of Object.values(examples)) {
      expect(validateDecisionRequest(example, DEFAULT_PROVIDER.capabilities).ok).toBe(true);
    }
  });

  it("leaves no Jev-named contract identifier in src or server", () => {
    const old =
      /\b(JevRequest|JevSuccess|JevFailure|JevResponse|validateJevRequest|ValidJevRequest|JEV_ENDPOINT)\b|src\/jev\/|\.\.\/jev\//;
    const offenders = [...sourceFiles("src"), ...sourceFiles("server")].filter(
      (file) => !file.endsWith("neutral.test.ts") && old.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("declares no interface in the contract files", () => {
    for (const name of ["contract.ts", "validate.ts"]) {
      expect(readFileSync(join(import.meta.dirname, name), "utf8")).not.toMatch(/\binterface\s/);
    }
  });

  it("names no provider in the page markup", () => {
    expect(readFileSync(join(root, "index.html"), "utf8")).not.toMatch(/Jev|TypeSafe/);
  });
});
