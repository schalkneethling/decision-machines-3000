/**
 * What every provider adapter looks like, and the parts they share.
 *
 * An adapter translates the neutral decision request into one provider's wire
 * format (`toWire`), translates the provider's reply back (`fromWire`), and
 * runs the HTTP exchange between the two (`decide`). The two translations are
 * pure functions so they can be tested against recorded fixtures without a
 * network. `decide` is handed the `fetch` to use, so the Node dev host and the
 * Worker can each pass their own, and tests can pass a stub.
 *
 * Everything a provider does not decide lives here: how the HTTP status of a
 * failed reply becomes an error kind and a message, how `Retry-After` is read,
 * how a transport failure is reported, and how a reply the schema rejects is
 * described. An adapter supplies only its wire shapes and its own wording of
 * the provider's error envelope. The API key is never written into a message,
 * a detail, or a log: it travels in a request header and nowhere else.
 *
 * Standard types used: `fetch`, `RequestInit`, `Response`, `Headers`, and
 * `AbortSignal`, which Node's `@types/node` and Cloudflare's Workers types both
 * declare as globals. Nothing here needs the DOM library. Zod Mini APIs used,
 * read from node_modules/zod/v4/core/errors.d.ts: the `$ZodIssue` union and
 * the `expected` and `input` fields of `$ZodIssueInvalidType`.
 */

import type * as z from "zod/mini";
import type { DecisionSuccess } from "../../src/decision/contract.ts";
import type { ValidDecisionRequest } from "../../src/decision/validate.ts";
import type { ProviderDescriptor } from "../../src/providers/catalog.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a provider call failed, independent of the provider:
 * - `auth`: the provider rejected the API key (401 or 403).
 * - `rate_limited`: the provider asked us to slow down (429); `retryAfterSeconds` carries its `Retry-After` when it sent one.
 * - `invalid_request`: the provider refused the request itself (400 or 422).
 * - `upstream`: the provider failed (404, 5xx, 529) or answered in a shape this app cannot read.
 * - `timeout`: the abort signal fired before the reply arrived.
 * - `unreachable`: `fetch` itself rejected, so no reply arrived at all.
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limited"
  | "invalid_request"
  | "upstream"
  | "timeout"
  | "unreachable";

export type ProviderErrorOptions = {
  /** Developer-facing detail: an upstream status, a dot path into the reply, or a transport message. Never the API key. */
  detail?: string;
  /** For `rate_limited`: the seconds the provider asked us to wait, when it said. */
  retryAfterSeconds?: number;
  cause?: unknown;
};

/** A failed provider call, normalised so the route can answer the same way for every provider. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The part of a successful decision a provider supplies. The route adds what it
 * measures itself: `ok`, `primitive`, `latencyMs`, `connection`, and `keepAliveSeconds`.
 */
export type ProviderDecision = Pick<DecisionSuccess, "model" | "usage" | "answers">;

/** The `fetch` a host hands to an adapter: the Worker's, Node's, or a test stub. */
export type Fetch = typeof fetch;

export type ProviderAdapter = {
  /** The catalog entry the adapter implements: its display name, pinned model, and limits. */
  descriptor: ProviderDescriptor;
  /** Pure. The provider's request body for a validated neutral request, model pinned. */
  toWire(request: ValidDecisionRequest): object;
  /**
   * Pure. The neutral decision read from the provider's parsed success body.
   * Throws a `ProviderError` of kind `upstream` when the body is not the shape
   * the provider's schema describes, or answers a primitive the request did not ask.
   */
  fromWire(request: ValidDecisionRequest, body: unknown): ProviderDecision;
  /**
   * Sends the request with the given `fetch` and `signal` and returns the
   * decision. Every failure is thrown as a `ProviderError`.
   */
  decide(
    request: ValidDecisionRequest,
    apiKey: string,
    signal: AbortSignal,
    fetch: Fetch,
  ): Promise<ProviderDecision>;
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** A reply from the provider, with its body already parsed. */
export type UpstreamReply = {
  status: number;
  headers: Headers;
  /**
   * The body parsed as JSON, or `undefined` when it was empty or not JSON.
   * JSON cannot encode `undefined`, so the two never collide. A success is
   * always JSON, so `fetchJson` throws before returning one without; a failure
   * is mapped by its status and may carry any body, an HTML error page included.
   */
  body: unknown;
};

/**
 * Fetches `url` and parses the reply as JSON. The signal is applied to the
 * request, and the body is read as text before parsing, so a body that is not
 * JSON is reported for what it is rather than as a parse exception.
 *
 * Throws a `ProviderError`: `timeout` when the signal aborted the exchange,
 * `unreachable` when `fetch` rejected for another reason (DNS, TLS, a dropped
 * connection), and `upstream` when a successful status carries a body that is
 * not JSON. A failed status is returned, not thrown, so the caller can map it.
 */
export async function fetchJson(
  fetch: Fetch,
  signal: AbortSignal,
  provider: ProviderDescriptor,
  url: string,
  init: RequestInit,
): Promise<UpstreamReply> {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, { ...init, signal });
    text = await response.text();
  } catch (cause) {
    if (signal.aborted) {
      throw new ProviderError(
        "timeout",
        `${provider.displayName} took too long to answer. Try again, or ask fewer questions at once.`,
        { cause },
      );
    }
    throw new ProviderError(
      "unreachable",
      `Could not reach ${provider.displayName}. Check the connection and try again.`,
      { detail: cause instanceof Error ? cause.message : undefined, cause },
    );
  }

  const body = parseJson(text);
  if (response.ok && body === undefined) {
    throw new ProviderError(
      "upstream",
      `${provider.displayName} answered with a body that is not JSON.`,
      {
        detail: `${response.status}: ${text === "" ? "the body is empty" : "the body is not JSON"}`,
      },
    );
  }
  return { status: response.status, headers: response.headers, body };
}

/** `JSON.parse`, with `undefined` for text that is empty or not JSON. */
function parseJson(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Failed replies
// ---------------------------------------------------------------------------

/** The error kind for a failed HTTP status. 404, 5xx, 529, and anything unexpected are `upstream`. */
export function errorKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_request";
  return "upstream";
}

/**
 * `Retry-After` in whole seconds, rounded up, or `undefined` when the header is
 * absent or unreadable. The header is either a number of seconds or an HTTP
 * date (RFC 9110, section 10.2.3); a date is measured from `now`.
 */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds) : undefined;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * The `ProviderError` for a failed reply, mapped by status. `described` is the
 * adapter's reading of the provider's error envelope, such as
 * `authentication_error: Cannot authenticate with the server.`; the detail is
 * the status followed by it, so a detail always starts with the status code.
 */
export function failureFromStatus(
  provider: ProviderDescriptor,
  reply: UpstreamReply,
  described?: string,
): ProviderError {
  const name = provider.displayName;
  const detail = described === undefined ? `${reply.status}` : `${reply.status} ${described}`;
  const kind = errorKindForStatus(reply.status);
  switch (kind) {
    case "auth":
      return new ProviderError(kind, `${name} rejected the API key.`, { detail });
    case "rate_limited": {
      const seconds = retryAfterSeconds(reply.headers);
      const wait = seconds === undefined ? "a moment" : `${seconds} seconds`;
      return new ProviderError(
        kind,
        `${name} is rate limiting requests. Wait ${wait} and try again.`,
        { detail, retryAfterSeconds: seconds },
      );
    }
    case "invalid_request":
      return new ProviderError(
        kind,
        `${name} could not process this request. Check the questions and criteria against the detail.`,
        { detail },
      );
    default:
      return new ProviderError(kind, `${name} returned an error. Try again in a moment.`, {
        detail,
      });
  }
}

// ---------------------------------------------------------------------------
// Replies the schema rejects
// ---------------------------------------------------------------------------

/** Plain name for a value's kind, in the words Zod's own messages use ("received string"). */
function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * `answers.q.noul: expected number, received string`: where the first problem
 * is, as a dot path, then what it is. Zod Mini ships no locale, so its own
 * message is always "Invalid input" and the words come from the issue's code
 * instead. The path is joined by hand, as the validator does, because
 * `z.core.toDotPath` writes a list index as `[0]` and paths here read `answers.0`.
 * A problem with the body as a whole is placed at `body`.
 */
export function describeIssue(issue: z.core.$ZodIssue): string {
  const place = issue.path.length === 0 ? "body" : issue.path.map(String).join(".");
  switch (issue.code) {
    case "invalid_type":
      return `${place}: expected ${issue.expected}, received ${kindOf(issue.input)}`;
    case "invalid_union":
      return `${place}: matches none of the expected shapes`;
    default:
      return `${place}: ${issue.code.replaceAll("_", " ")}`;
  }
}

/** The `upstream` error for a reply whose shape the adapter's schema rejects; `detail` names the place. */
export function unreadableReply(provider: ProviderDescriptor, detail: string): ProviderError {
  return new ProviderError(
    "upstream",
    `${provider.displayName} answered in a shape this app cannot read.`,
    { detail },
  );
}
