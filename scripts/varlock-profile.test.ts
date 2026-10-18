/**
 * Static checks on the Varlock profile: the schema, the script, the Vite config, and
 * the docs. They read files only. Resolving the schema needs 1Password, so that part
 * is a manual step in scenarios/18-varlock-profile.feature.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { isKeySet, PROVIDER_KEY_NAMES } from "../worker/env.ts";

/** Reads a file of the repository root as text. */
function readRoot(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

/** One schema item: its name, its value expression, and the comment lines above it. */
type SchemaItem = { name: string; value: string; comments: string[] };

/**
 * Splits the part of a `.env.schema` after its `# ---` divider into items. A blank
 * line ends the comment block above an item, as Varlock does, so only the comment
 * lines directly above an item belong to it.
 */
function parseItems(schema: string): SchemaItem[] {
  const body = schema.split("\n# ---\n")[1] ?? "";
  const items: SchemaItem[] = [];
  let comments: string[] = [];
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      comments = [];
    } else if (line.startsWith("#")) {
      comments.push(line);
    } else {
      const equals = line.indexOf("=");
      items.push({
        name: line.slice(0, equals),
        value: line.slice(equals + 1),
        comments,
      });
      comments = [];
    }
  }
  return items;
}

const keyNames = Object.values(PROVIDER_KEY_NAMES);
const items = parseItems(readRoot(".env.schema"));
const decorators = (item: SchemaItem): string[] =>
  item.comments.flatMap((line) => line.replace(/^#\s*/, "").split(/\s+/));

/**
 * The regular expression in an item's `@type=string(matches=regex("pattern", "flags"))`
 * line. Varlock hands the pattern to `new RegExp` as written, so a single backslash
 * is right (checked against Varlock 1.22.0 with `varlock load`; `\\s` there matches a
 * literal backslash and lets every value through).
 */
function keyTypeRule(item: SchemaItem): RegExp {
  const line = item.comments.find((comment) => comment.includes("@type="));
  const match = line?.match(/^#\s*@type=string\(matches=regex\("(.*)", "([a-z]*)"\)\)$/);
  if (!match) throw new Error(`${item.name} has no @type=string(matches=regex(...)) line`);
  const [, pattern, flags] = match;
  if (pattern === undefined || flags === undefined)
    throw new Error(`${item.name} has an unreadable @type line`);
  return new RegExp(pattern, flags);
}

describe("the schema", () => {
  it("declares exactly the catalog's keys and the check item", () => {
    expect(items.map((item) => item.name).toSorted()).toEqual(
      [...keyNames, "AT_LEAST_ONE_PROVIDER_KEY"].toSorted(),
    );
  });

  it.each(keyNames)("makes %s optional and sensitive, and reads its own vault field", (name) => {
    const item = items.find((candidate) => candidate.name === name);
    expect(item).toBeDefined();
    expect(decorators(item!)).toEqual(expect.arrayContaining(["@optional", "@sensitive"]));
    // `@optional` alone does not cover a missing vault field: the load still fails
    // unless the `op()` call allows it (checked against Varlock 1.22.0).
    expect(item!.value).toMatch(
      new RegExp(`^op\\(op://dev/[a-z0-9]+/${name}, allowMissing=true\\)$`),
    );
  });

  it.each(keyNames)(
    "gives %s a type that accepts exactly the values the Worker counts as a key",
    (name) => {
      const item = items.find((candidate) => candidate.name === name);
      const rule = keyTypeRule(item!);
      const samples = [
        "dummy-not-a-key",
        "unset-not",
        "not-unset",
        "x",
        "unset",
        "UNSET",
        "Unset",
        " unset ",
        "\tUnSet\n",
        "",
        " ",
        "   ",
        "\t\n",
        "\u00a0",
        "\u2003unset\u2003",
      ];
      for (const sample of samples) {
        expect(rule.test(sample), JSON.stringify(sample)).toBe(isKeySet(sample));
      }
    },
  );

  it("uses one type rule for all three keys", () => {
    const sources = keyNames.map((name) => keyTypeRule(items.find((i) => i.name === name)!).source);
    expect(new Set(sources).size).toBe(1);
  });

  it("makes the check item required, public, and dependent on every key", () => {
    const item = items.find((candidate) => candidate.name === "AT_LEAST_ONE_PROVIDER_KEY");
    expect(decorators(item!)).toEqual(expect.arrayContaining(["@required", "@sensitive=false"]));
    for (const name of keyNames) expect(item!.value).toContain(`$${name}`);
    expect(item!.value).toMatch(/, ok\)$/);
  });
});

describe("the scripts", () => {
  const scripts = (JSON.parse(readRoot("package.json")) as { scripts: Record<string, string> })
    .scripts;

  it("runs varlock-wrangler deploy, and nothing before it", () => {
    // The plain `deploy` script's key check reads the secrets already on the Worker,
    // which a first Varlock deploy has not uploaded yet. Varlock's own load enforces
    // "at least one key" before it uploads anything.
    expect(scripts["deploy:varlock"]).toBe("varlock-wrangler deploy");
  });
});

describe("the Vite config", () => {
  it("reaches the Varlock plugin only through a dynamic import", () => {
    const config = readRoot("vite.config.ts");
    expect(config).not.toMatch(/^import .*@varlock/m);
    expect(config).toMatch(/await import\("@varlock\/cloudflare-integration"\)/);
  });
});

describe("the README", () => {
  const readme = readRoot("README.md");

  it("quotes no copy of the schema", () => {
    expect(readme).not.toContain("op(op://");
    expect(readme).not.toContain("@initOp");
  });

  it("does not describe the Vite integration package as the loaded plugin", () => {
    expect(readme).not.toContain("@varlock/vite-integration");
  });

  it("points at the deploy guide for the Varlock profile", () => {
    expect(readme).toContain("docs/deploy.md#");
  });
});

describe("the deploy guide", () => {
  it("never puts a provider key value on a command line", () => {
    const guide = readRoot("docs/deploy.md");
    // Every line inside a fenced `sh` block is a command line or its continuation.
    const commands = [...guide.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((block) =>
      (block[1] ?? "").split("\n"),
    );
    expect(commands.length).toBeGreaterThan(0);
    for (const line of commands) {
      for (const name of keyNames) {
        expect(line).not.toMatch(new RegExp(`--var\\s+['"]?${name}`));
        expect(line).not.toMatch(new RegExp(`${name}=\\S`));
      }
    }
  });
});
