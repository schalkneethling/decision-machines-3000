import { existsSync } from "node:fs";
import { basename } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { wranglerCommand } from "./wrangler.ts";

describe("wranglerCommand", () => {
  it("runs the installed Wrangler's entry file with this Node, not a shell or a .cmd shim", () => {
    const [command, args] = wranglerCommand(["secret", "list", "--name", "some worker"]);

    expect(command).toBe(process.execPath);
    const [entry] = args;
    if (entry === undefined)
      throw new Error("Expected the Wrangler entry file as the first argument.");
    expect(basename(entry)).toBe("wrangler.js");
    expect(existsSync(entry)).toBe(true);
    // Each argument stays one argument, so nothing is parsed by a shell.
    expect(args.slice(1)).toEqual(["secret", "list", "--name", "some worker"]);
  });
});
