import { describe, expect, it, vi } from "vite-plus/test";

import { targetArguments } from "./check-provider-keys.ts";
import type { ListResult } from "./check-provider-keys.ts";
import { main } from "./deploy.ts";

const withKey: ListResult = {
  status: 0,
  stdout: JSON.stringify([{ name: "SUBQ_API_KEY", type: "secret_text" }]),
  stderr: "",
};
const withoutKey: ListResult = { status: 0, stdout: "[]", stderr: "" };

describe("deploy", () => {
  it("gives the key check and the deploy the same target", () => {
    const argv = ["--name", "other-worker", "-e", "staging", "--dry-run"];
    const list = vi.fn(() => withKey);
    const deploy = vi.fn(() => 0);

    expect(main(argv, { list, deploy })).toBe(0);

    expect(list).toHaveBeenCalledExactlyOnceWith(["--name", "other-worker", "-e", "staging"]);
    expect(deploy).toHaveBeenCalledExactlyOnceWith(argv);
  });

  it("does not deploy, and exits non-zero, when the targeted Worker has no key", () => {
    const deploy = vi.fn(() => 0);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(["--name", "other-worker"], { list: () => withoutKey, deploy })).toBe(1);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("works with no arguments, as the Deploy to Cloudflare button runs it", () => {
    const list = vi.fn(() => withKey);
    const deploy = vi.fn(() => 0);

    expect(main([], { list, deploy })).toBe(0);
    expect(list).toHaveBeenCalledExactlyOnceWith([]);
    expect(deploy).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("exits with Wrangler's exit code", () => {
    expect(main([], { list: () => withKey, deploy: () => 3 })).toBe(3);
  });
});

describe("targetArguments", () => {
  it.each([
    [
      ["--name", "w"],
      ["--name", "w"],
    ],
    [["--name=w"], ["--name=w"]],
    [
      ["--env", "staging"],
      ["--env", "staging"],
    ],
    [
      ["-e", "staging"],
      ["-e", "staging"],
    ],
    [["-e=staging"], ["-e=staging"]],
    [
      ["--config", "a.jsonc"],
      ["--config", "a.jsonc"],
    ],
    [
      ["-c", "a.jsonc"],
      ["-c", "a.jsonc"],
    ],
    [["--config=a.jsonc"], ["--config=a.jsonc"]],
    [
      ["--cwd", "dir", "--profile", "work"],
      ["--cwd", "dir", "--profile", "work"],
    ],
  ])("keeps %j", (argv, expected) => {
    expect(targetArguments(argv)).toEqual(expected);
  });

  it("leaves out arguments that do not choose the target", () => {
    expect(targetArguments(["--dry-run", "--message", "hi", "--name", "w", "--tag", "t"])).toEqual([
      "--name",
      "w",
    ]);
  });

  it("takes the next argument as the value even when it looks like a flag", () => {
    expect(targetArguments(["--name", "--dry-run", "--env", "x"])).toEqual([
      "--name",
      "--dry-run",
      "--env",
      "x",
    ]);
  });

  it("does not mistake a flag that only starts like a target flag for one", () => {
    expect(targetArguments(["--name-extra", "x", "--envy", "y", "-cx"])).toEqual([]);
  });

  it("keeps a trailing flag with no value, so Wrangler reports it", () => {
    expect(targetArguments(["--name"])).toEqual(["--name"]);
  });

  it("returns nothing for no arguments", () => {
    expect(targetArguments([])).toEqual([]);
  });
});
