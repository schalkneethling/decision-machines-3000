import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createExchange } from "./exchange.mjs";
import { isSelected, parseCaseFilter, unmatchedCases, withPrerequisites } from "./filter.mjs";

describe("case filter", () => {
  it("selects every case when no filter is given", () => {
    expect(isSelected(parseCaseFilter([]), "subq", "three-types")).toBe(true);
  });

  it("limits a provider to the cases named", () => {
    const filter = parseCaseFilter(["subq:bad-key,invalid-body"]);
    expect(isSelected(filter, "subq", "bad-key")).toBe(true);
    expect(isSelected(filter, "subq", "three-types")).toBe(false);
  });

  it("reports a misspelled case as unmatched", () => {
    const filter = parseCaseFilter(["subq:three-type,bad-key", "openai"]);
    expect(unmatchedCases(filter, new Set(["subq:bad-key"]))).toEqual(["subq:three-type"]);
  });

  it("reports nothing when every named case ran", () => {
    const filter = parseCaseFilter(["subq:bad-key"]);
    expect(unmatchedCases(filter, new Set(["subq:bad-key"]))).toEqual([]);
  });

  it("also selects the 11-level case when only the 50-level case is named", () => {
    const filter = withPrerequisites(parseCaseFilter(["openai:score-50-levels"]));
    expect(isSelected(filter, "openai", "score-11-levels")).toBe(true);
    expect(isSelected(filter, "openai", "score-50-levels")).toBe(true);
    expect(isSelected(filter, "openai", "bad-key")).toBe(false);
  });

  it("does not list a deliberately skipped case as unmatched", () => {
    const filter = parseCaseFilter(["openai:score-50-levels"]);
    const skipped = new Map([["openai:score-50-levels", "OpenAI refused 11 levels"]]);
    expect(unmatchedCases(filter, new Set(), skipped)).toEqual([]);
  });
});

describe("exchange", () => {
  let root;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "probe-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  function setup(fetchImpl, caseFilter = parseCaseFilter([])) {
    return createExchange({
      keys: { subq: "" },
      secrets: [],
      fixtureRoot: root,
      fetchImpl,
      caseFilter,
    });
  }

  it("keeps the recorded fixture and records a failure when the request fails", async () => {
    const directory = path.join(root, "subq");
    await mkdir(directory);
    await writeFile(path.join(directory, "three-types.json"), '{"recorded":true}\n');

    const { exchange, failures, results } = setup(() =>
      Promise.reject(new TypeError("fetch failed")),
    );
    const outcome = await exchange("subq", "three-types", { url: "https://example.test/x" });

    expect(outcome).toBeUndefined();
    expect(failures).toEqual(["subq:three-types"]);
    expect(results).toEqual([]);
    expect(await readFile(path.join(directory, "three-types.json"), "utf8")).toBe(
      '{"recorded":true}\n',
    );
  });

  it("writes nothing when reading the response body fails", async () => {
    const response = {
      status: 200,
      headers: new Headers(),
      text: () => Promise.reject(new Error("terminated")),
    };
    const { exchange, failures } = setup(() => Promise.resolve(response));
    await exchange("subq", "three-types", { url: "https://example.test/x" });

    expect(failures).toEqual(["subq:three-types"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("writes a fixture for an error response, because that is a real answer", async () => {
    const response = {
      status: 422,
      headers: new Headers({ "content-type": "application/json" }),
      text: () => Promise.resolve('{"detail":{"error_type":"validation_error"}}'),
    };
    const { exchange, failures, ran } = setup(() => Promise.resolve(response));
    await exchange("subq", "invalid-body", { url: "https://example.test/x", body: {} });

    expect(failures).toEqual([]);
    expect(ran.has("subq:invalid-body")).toBe(true);
    const saved = JSON.parse(await readFile(path.join(root, "subq", "invalid-body.json"), "utf8"));
    expect(saved.status).toBe(422);
  });

  describe("the 50-level case", () => {
    const fiftyOptions = { url: "https://example.test/x", body: {} };
    const respondWith = (status) => () =>
      Promise.resolve({
        status,
        headers: new Headers(),
        text: () => Promise.resolve("{}"),
      });

    it("is skipped, not unmatched, when OpenAI refuses 11 levels", async () => {
      const filter = withPrerequisites(parseCaseFilter(["openai:score-50-levels"]));
      const { exchange, exchangeAfter, ran, skipped } = setup(respondWith(400), filter);

      const eleven = await exchange("openai", "score-11-levels", fiftyOptions);
      await exchangeAfter(
        eleven,
        "OpenAI refused 11 levels",
        "openai",
        "score-50-levels",
        fiftyOptions,
      );

      expect(ran.has("openai:score-11-levels")).toBe(true);
      expect(ran.has("openai:score-50-levels")).toBe(false);
      expect(skipped.get("openai:score-50-levels")).toBe("OpenAI refused 11 levels");
      expect(unmatchedCases(filter, ran, skipped)).toEqual([]);
    });

    it("runs when OpenAI accepts 11 levels", async () => {
      const filter = withPrerequisites(parseCaseFilter(["openai:score-50-levels"]));
      const { exchange, exchangeAfter, ran, skipped } = setup(respondWith(200), filter);

      const eleven = await exchange("openai", "score-11-levels", fiftyOptions);
      await exchangeAfter(
        eleven,
        "OpenAI refused 11 levels",
        "openai",
        "score-50-levels",
        fiftyOptions,
      );

      expect(ran.has("openai:score-50-levels")).toBe(true);
      expect(skipped.size).toBe(0);
    });
  });
});
