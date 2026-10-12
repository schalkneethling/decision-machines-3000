/**
 * The server's one connection pool to TypeSafe, and an honest record of whether
 * each call had to open a new connection or reused a warm one.
 *
 * Production lesson: open the connection when the server boots, before the first
 * user request needs it, so nobody pays the TCP and TLS handshakes on the critical
 * path. Then set the keep-alive to outlast the usual gap between requests, because
 * Node drops an idle connection after 4 seconds and TypeSafe sends no keep-alive
 * hint to extend it.
 *
 * Sources: undici's `Agent` options (`keepAliveTimeout`, types/client.d.ts), the
 * `dispatcher` fetch option (types/fetch.d.ts), and the `undici:client:connected`
 * diagnostics channel (lib/core/diagnostics.js, published in
 * lib/dispatcher/client.js once a socket is connected).
 */

import { subscribe, unsubscribe } from "node:diagnostics_channel";
import type { Fetch } from "@typesafe-ai/sdk";
import { Agent, fetch as undiciFetch } from "undici";
import type { DiagnosticsChannel, RequestInit as UndiciRequestInit } from "undici";
import { DEFAULT_KEEP_ALIVE_SECONDS } from "../src/jev/contract.ts";
import type { ConnectionKind, KeepAliveSeconds } from "../src/jev/contract.ts";

/** Published by undici each time one of its clients finishes opening a socket. */
export const CONNECTED_CHANNEL = "undici:client:connected";

/** One call being tracked; `finish` reports whether a connection opened for it. */
export type TrackedCall = {
  finish(): ConnectionKind;
};

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
 * Owns the undici `Agent` every TypeSafe call goes through, and listens on
 * `undici:client:connected` to tell new connections from reused ones.
 */
export class TypeSafeConnection {
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
   * A fetch for `TypeSafeClientConfig.fetch` that always uses the current agent,
   * so changing the keep-alive never needs a new SDK client.
   *
   * The SDK sends a string method, a plain header record, a string body, and a
   * signal. Those fields are copied one by one because the DOM `RequestInit` and
   * undici's allow different types for the rest. The SDK reads the response with
   * `ok`, `status`, `headers.get()`, `text()`, `clone()`, and `body.getReader()`,
   * which undici's `Response` implements to the same spec. TypeScript still
   * rejects it as a DOM `Response` only because undici's header iterators lack
   * `[Symbol.dispose]`, hence the cast.
   */
  readonly fetch: Fetch = async (input, init) => {
    const options: UndiciRequestInit = { dispatcher: this.#agent };
    if (init?.method !== undefined) options.method = init.method;
    if (init?.signal !== undefined) options.signal = init.signal;
    if (init?.headers !== undefined)
      options.headers = Object.fromEntries(new Headers(init.headers));
    if (typeof init?.body === "string") options.body = init.body;
    else if (init?.body !== undefined && init.body !== null) {
      throw new TypeError("The TypeSafe connection only sends string bodies.");
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
      console.warn("[jev] closing the previous connection pool failed", error);
    });
  }

  /** Run one call to `origin` and report how long it took and which connection it used. */
  async measure<T>(
    origin: string,
    call: () => Promise<T>,
  ): Promise<{ value: T; latencyMs: number; connection: ConnectionKind }> {
    const tracked = this.#detector.begin(new URL(origin).host);
    const startedAt = performance.now();
    try {
      const value = await call();
      return {
        value,
        latencyMs: Math.round(performance.now() - startedAt),
        connection: tracked.finish(),
      };
    } finally {
      tracked.finish();
    }
  }

  /** Stop listening and close the pool; for dev-server restarts. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    unsubscribe(CONNECTED_CHANNEL, this.#onConnected);
    await this.#agent.close();
  }
}
