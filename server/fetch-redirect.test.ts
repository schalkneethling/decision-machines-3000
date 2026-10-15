import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { typesafe } from "../src/providers/catalog.ts";
import { ProviderError, fetchJson } from "../worker/providers/adapter.ts";

/**
 * `fetchJson` against Node's own `fetch`, the one the Node dev host uses, and
 * real local servers. The Worker's tests stub `fetch`; this one shows that a
 * provider's redirect is never followed, so the key never reaches its target.
 */

const API_KEY = "sk-test-0123456789abcdef-never-logged";
const POST = { method: "POST", body: "{}" } as const;

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderError) return error;
    throw error;
  }
  throw new Error("Expected a ProviderError, but the call resolved.");
}

describe("fetchJson and redirects with Node's own fetch", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("never reaches the redirect target, so the key stays with the provider's host", async () => {
    const reached: IncomingHttpHeaders[] = [];
    const target = await listen((request, response) => {
      reached.push(request.headers);
      response.end("{}");
    });
    const provider = await listen((_request, response) => {
      response.writeHead(302, { location: `${target}/steal` });
      response.end();
    });

    const error = await rejection(
      fetchJson(
        globalThis.fetch,
        new AbortController().signal,
        typesafe,
        API_KEY,
        `${provider}/v1`,
        POST,
      ),
    );

    expect(error.kind).toBe("upstream");
    expect(error.detail).toBe("302 redirect");
    expect(reached).toEqual([]);
  });
});
