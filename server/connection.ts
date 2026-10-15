/**
 * The Node dev host's one connection pool to every provider, and an honest
 * record of whether each call had to open a new connection or reused a warm one.
 *
 * The dev host passes the pool to the Worker's `handle` as `deps.connections`
 * and its `fetch` as `deps.fetch`, so the decide and warm routes go through it.
 * It is Node-only (undici and `node:diagnostics_channel`), so nothing under
 * `worker/` imports it and the Worker bundle never contains it (ADR-0002).
 * undici's `Agent` keeps a separate set of connections per origin, so one agent
 * serves all three providers, and one keep-alive applies to all of them.
 *
 * Production lesson: open the connection when the server boots, before the first
 * user request needs it, so nobody pays the TCP and TLS handshakes on the critical
 * path. Then set the keep-alive to outlast the usual gap between requests, because
 * Node drops an idle connection after 4 seconds and TypeSafe sends no keep-alive
 * hint to extend it.
 *
 * Sources: undici's `Agent` options (`keepAliveTimeout`, types/client.d.ts), the
 * `dispatcher` and `redirect` fetch options (types/fetch.d.ts), and the
 * `undici:client:connected` diagnostics channel (lib/core/diagnostics.js,
 * published in lib/dispatcher/client.js once a socket is connected).
 */

import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { Agent, fetch as undiciFetch } from "undici";
import type { DiagnosticsChannel, RequestInit as UndiciRequestInit } from "undici";
import { DEFAULT_KEEP_ALIVE_SECONDS } from "../src/decision/contract.ts";
import type { ConnectionKind, KeepAliveSeconds } from "../src/decision/contract.ts";
import type { ConnectionMetrics, TrackedCall } from "../worker/handler.ts";

/** Published by undici each time one of its clients finishes opening a socket. */
export const CONNECTED_CHANNEL = "undici:client:connected";

type InFlight = {
  host: string;
  opened: boolean;
};

/**
 * Attributes "connection opened" events to calls in flight. Pure: no network,
 * no channel, no clock, so it is testable on its own.
 *
 * Each event for a host goes to the oldest call to that host that is in flight
 * and has not been given a connection yet. A connection pool opens a socket
 * because a queued call needs one, and with one call at a time (as in this demo)
 * the attribution is exact. With overlapping calls to the same host it is a
 * best guess: the pool may hand the new socket to a younger call and the older
 * one may take a socket that another call freed. Exact per-call attribution
 * would need to tag each request so `undici:client:sendHeaders` could name it.
 * Events with no matching call in flight (another client, or a socket opened
 * after its call gave up) are ignored.
 */
export class ConnectionDetector {
  readonly #inFlight: InFlight[] = [];

  begin(host: string): TrackedCall {
    const call: InFlight = { host, opened: false };
    this.#inFlight.push(call);
    let finished: ConnectionKind | undefined;
    return {
      finish: () => {
        if (finished !== undefined) return finished;
        const index = this.#inFlight.indexOf(call);
        if (index !== -1) this.#inFlight.splice(index, 1);
        finished = call.opened ? "new" : "reused";
        return finished;
      },
    };
  }

  connected(host: string): void {
    const waiting = this.#inFlight.find((call) => call.host === host && !call.opened);
    if (waiting !== undefined) waiting.opened = true;
  }

  /** How many calls are in flight; for tests and diagnostics. */
  get pending(): number {
    return this.#inFlight.length;
  }
}

function isConnectedMessage(
  message: unknown,
): message is DiagnosticsChannel.ClientConnectedMessage {
  if (typeof message !== "object" || message === null || !("connectParams" in message)) {
    return false;
  }
  const { connectParams } = message;
  return (
    typeof connectParams === "object" &&
    connectParams !== null &&
    "host" in connectParams &&
    typeof connectParams.host === "string"
  );
}

function createAgent(keepAliveSeconds: KeepAliveSeconds): Agent {
  return new Agent({ keepAliveTimeout: keepAliveSeconds * 1000 });
}

/**
 * What the dev host needs from a pool: the metrics the routes read, the
 * `fetch` that goes through it, and a way to close it when the server stops.
 */
export type DevConnections = ConnectionMetrics & {
  readonly fetch: typeof fetch;
  close(): Promise<void>;
};

/**
 * Owns the undici `Agent` every provider call on the dev host goes through,
 * and listens on `undici:client:connected` to tell new connections from
 * reused ones.
 */
export class ConnectionPool implements DevConnections {
  readonly #detector = new ConnectionDetector();
  #agent: Agent;
  #keepAliveSeconds: KeepAliveSeconds;
  #closed = false;

  readonly #onConnected = (message: unknown): void => {
    if (isConnectedMessage(message)) this.#detector.connected(message.connectParams.host);
  };

  constructor(keepAliveSeconds: KeepAliveSeconds = DEFAULT_KEEP_ALIVE_SECONDS) {
    this.#keepAliveSeconds = keepAliveSeconds;
    this.#agent = createAgent(keepAliveSeconds);
    subscribe(CONNECTED_CHANNEL, this.#onConnected);
  }

  get keepAliveSeconds(): KeepAliveSeconds {
    return this.#keepAliveSeconds;
  }

  /**
   * A `fetch` that always uses the current agent, so changing the keep-alive
   * never needs a new one.
   *
   * The adapters' `fetchJson` sends a URL string, a string method, a plain
   * header record, a string body or none, a signal, and `redirect: "error"`.
   * Those fields are copied one by one, because the DOM `RequestInit` and
   * undici's allow different types for the rest. `redirect` must be among
   * them, because following a redirect would carry the key header to another
   * host. A `Request` object or a body that is not a string is refused rather
   * than converted. undici's `Response` implements the same spec as the DOM's;
   * TypeScript rejects it as a DOM `Response` only because undici's header
   * iterators lack `[Symbol.dispose]`, hence the cast.
   */
  readonly fetch: typeof fetch = async (input, init) => {
    if (typeof input !== "string" && !(input instanceof URL)) {
      throw new TypeError("The connection pool takes a URL, not a Request.");
    }
    const options: UndiciRequestInit = { dispatcher: this.#agent };
    if (init?.method !== undefined) options.method = init.method;
    if (init?.signal !== undefined) options.signal = init.signal;
    if (init?.redirect !== undefined) options.redirect = init.redirect;
    if (init?.headers !== undefined) {
      options.headers = Object.fromEntries(new Headers(init.headers));
    }
    if (typeof init?.body === "string") options.body = init.body;
    else if (init?.body !== undefined && init.body !== null) {
      throw new TypeError("The connection pool only sends string bodies.");
    }
    const response = await undiciFetch(input, options);
    return response as unknown as Response;
  };

  /** Close the old agent, gracefully, and route new calls through one with this keep-alive. */
  setKeepAlive(keepAliveSeconds: KeepAliveSeconds): void {
    if (keepAliveSeconds === this.#keepAliveSeconds) return;
    const previous = this.#agent;
    this.#agent = createAgent(keepAliveSeconds);
    this.#keepAliveSeconds = keepAliveSeconds;
    previous.close().catch((error: unknown) => {
      // The class name only: undici's messages can name the origin and the socket.
      const name = error instanceof Error ? error.name : typeof error;
      console.warn(`[api] closing the previous connection pool failed: ${name}`);
    });
  }

  /** Starts tracking one call to `origin`; its `finish` says whether a socket opened for it. */
  track(origin: string): TrackedCall {
    return this.#detector.begin(new URL(origin).host);
  }

  /** Stops listening and closes the pool, for when the dev server stops or restarts. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    unsubscribe(CONNECTED_CHANNEL, this.#onConnected);
    await this.#agent.close();
  }
}
