import { existsSync } from "node:fs";
import { basename } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { wranglerCommand } from "./wrangler.ts";

describe("wranglerCommand", () => {
  it("runs the installed Wrangler's entry file with this Node, not a shell or a .cmd shim", () => {
    const [command, args] = wranglerCommand(["secret", "list", "--name", "some worker"]);

    expect(command).toBe(process.execPath);
    expect(basename(args[0])).toBe("wrangler.js");
    expect(existsSync(args[0])).toBe(true);
    // Each argument stays one argument, so nothing is parsed by a shell.
    expect(args.slice(1)).toEqual(["secret", "list", "--name", "some worker"]);
  });
});
