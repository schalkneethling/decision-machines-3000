import { channel } from "node:diagnostics_channel";
import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CONNECTED_CHANNEL, ConnectionDetector, ConnectionPool } from "./connection.ts";

const HOST = "api.typesafe.ai";
const ORIGIN = `https://${HOST}`;

/** What undici publishes once a socket is open; only `connectParams.host` is read. */
function publishConnected(host: string): void {
  channel(CONNECTED_CHANNEL).publish({
    connectParams: { host, hostname: host, protocol: "https:", port: "", servername: host },
  });
}

describe("ConnectionDetector", () => {
  it("reports a reused connection when nothing connected during the call", () => {
    const detector = new ConnectionDetector();
    const call = detector.begin(HOST);
    expect(call.finish()).toBe("reused");
    expect(detector.pending).toBe(0);
  });

  it("reports a new connection when one opened during the call", () => {
    const detector = new ConnectionDetector();
    const call = detector.begin(HOST);
    detector.connected(HOST);
    expect(call.finish()).toBe("new");
  });

  it("ignores connections to other hosts", () => {
    const detector = new ConnectionDetector();
    const call = detector.begin(HOST);
    detector.connected("fonts.googleapis.com");
    expect(call.finish()).toBe("reused");
  });

  it("ignores connections opened before or after the call", () => {
    const detector = new ConnectionDetector();
    detector.connected(HOST);
    const call = detector.begin(HOST);
    expect(call.finish()).toBe("reused");
    detector.connected(HOST);
    expect(detector.begin(HOST).finish()).toBe("reused");
  });

  it("gives each connection to one overlapping call, oldest first", () => {
    const detector = new ConnectionDetector();
    const first = detector.begin(HOST);
    const second = detector.begin(HOST);
    detector.connected(HOST);
    expect(second.finish()).toBe("reused");
    expect(first.finish()).toBe("new");
  });

  it("gives a second connection to the next call still waiting", () => {
    const detector = new ConnectionDetector();
    const first = detector.begin(HOST);
    const second = detector.begin(HOST);
    detector.connected(HOST);
    detector.connected(HOST);
    expect(first.finish()).toBe("new");
    expect(second.finish()).toBe("new");
  });

  it("keeps its first answer when finished twice", () => {
    const detector = new ConnectionDetector();
    const call = detector.begin(HOST);
    detector.connected(HOST);
    expect(call.finish()).toBe("new");
    expect(call.finish()).toBe("new");
  });
});

describe("ConnectionPool", () => {
  let pool: ConnectionPool | undefined;
  const servers: Server[] = [];

  afterEach(async () => {
    await pool?.close();
    pool = undefined;
    await Promise.all(
      servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  /** A local HTTP server that answers every request with `answer`; returns its origin. */
  async function serveLocally(answer: (res: ServerResponse) => void): Promise<string> {
    const server = createServer((_req, res) => {
      answer(res);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("hears undici's connected channel while a tracked call is in flight", () => {
    pool = new ConnectionPool();
    const call = pool.track(ORIGIN);
    publishConnected(HOST);
    expect(call.finish()).toBe("new");
  });

  it("reports reuse when no socket opened during the call", () => {
    pool = new ConnectionPool();
    expect(pool.track(ORIGIN).finish()).toBe("reused");
  });

  it("opens one connection through its own fetch and reuses it for the next call", async () => {
    const origin = await serveLocally((res) => {
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
    pool = new ConnectionPool(30);

    const first = pool.track(origin);
    await (await pool.fetch(`${origin}/v1/models`, { method: "GET" })).text();
    expect(first.finish()).toBe("new");
    // undici hands the socket back to the pool just after the body ends, so give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = pool.track(origin);
    await (await pool.fetch(`${origin}/v1/models`, { method: "GET" })).text();

    expect(second.finish()).toBe("reused");
  });

  it("passes redirect: error on, so a redirect never carries the key header elsewhere", async () => {
    const origin = await serveLocally((res) => {
      res.statusCode = 302;
      res.setHeader("location", "http://127.0.0.1:1/elsewhere");
      res.end();
    });
    pool = new ConnectionPool();

    await expect(
      pool.fetch(`${origin}/v1/models`, {
        headers: { authorization: "Bearer pool-test-key" },
        redirect: "error",
      }),
    ).rejects.toThrow(TypeError);
  });

  it("sends the method, headers, and string body it is given", async () => {
    let seen: { method?: string; authorization?: string; body: string } | undefined;
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seen = {
          method: req.method,
          authorization: req.headers.authorization,
          body: Buffer.concat(chunks).toString(),
        };
        res.end("{}");
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    pool = new ConnectionPool();

    const response = await pool.fetch(`${origin}/v1/systemone`, {
      method: "POST",
      headers: { authorization: "Bearer pool-test-key" },
      body: '{"state":"x"}',
    });

    expect(response.status).toBe(200);
    expect(seen).toEqual({
      method: "POST",
      authorization: "Bearer pool-test-key",
      body: '{"state":"x"}',
    });
  });

  it("refuses a Request object and a body that is not a string", async () => {
    pool = new ConnectionPool();

    await expect(pool.fetch(new Request(ORIGIN))).rejects.toThrow(TypeError);
    await expect(pool.fetch(ORIGIN, { method: "POST", body: new Uint8Array(1) })).rejects.toThrow(
      "The connection pool only sends string bodies.",
    );
  });

  it("stops listening once closed", async () => {
    pool = new ConnectionPool();
    await pool.close();
    expect(channel(CONNECTED_CHANNEL).hasSubscribers).toBe(false);
  });

  it("starts at Node's default keep-alive and changes it on request", () => {
    pool = new ConnectionPool();
    expect(pool.keepAliveSeconds).toBe(4);
    pool.setKeepAlive(60);
    expect(pool.keepAliveSeconds).toBe(60);
  });

  it("opens a new connection after the keep-alive changes, because the agent is replaced", async () => {
    const origin = await serveLocally((res) => {
      res.end("{}");
    });
    pool = new ConnectionPool();
    await (await pool.fetch(origin)).text();

    pool.setKeepAlive(30);
    const after = pool.track(origin);
    await (await pool.fetch(origin)).text();

    expect(after.finish()).toBe("new");
  });
});
