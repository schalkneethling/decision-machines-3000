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
 * Everything a provider does not decide lives here: how the API key is checked
 * and sent, how the HTTP status of a failed reply becomes an error kind and a
 * message, how `Retry-After` is read, how a transport failure is reported, and
 * how a reply the schema rejects is described. An adapter supplies only its
 * wire shapes and its own reading of the provider's error envelope.
 *
 * The API key never appears in a message, a detail, or a log. `fetchJson` is
 * the only code that touches it: it refuses a key `fetch` would reject (such a
 * rejection quotes the whole header, key included), puts the key in the
 * `authorization` header and nowhere else, and describes a transport failure
 * by its class name and code, never by its message. Provider-supplied text is
 * cut to 300 characters before it enters a detail.
 *
 * Standard types used: `fetch`, `Response`, `Headers`, and `AbortSignal`,
 * which Node's `@types/node` and Cloudflare's Workers types both declare as
 * globals. Nothing here needs the DOM library. Zod Mini APIs used, read from
 * node_modules/zod/v4/mini/schemas.d.ts (`ZodMiniType`, `safeParse`),
 * node_modules/zod/v4/core/schemas.d.ts (`ParseContext.reportInput`), and
 * node_modules/zod/v4/core/errors.d.ts (the `$ZodIssue` union and the
 * `expected` and `input` fields of `$ZodIssueInvalidType`).
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
 * - `auth`: the provider rejected the API key (401 or 403), or the key holds characters that cannot be sent.
 * - `rate_limited`: the provider asked us to slow down (429); `retryAfterSeconds` carries its `Retry-After` when it sent one.
 * - `no_credits`: the account behind the key has no credit left (402).
 * - `invalid_request`: the provider refused the request itself (400 or 422).
 * - `upstream`: the provider failed (404, 5xx, 529) or answered in a shape this app cannot read.
 * - `timeout`: the abort signal fired before the reply arrived.
 * - `unreachable`: `fetch` itself rejected, so no reply arrived at all.
 */
export type ProviderErrorKind =
  | "auth"
  | "rate_limited"
  | "no_credits"
  | "invalid_request"
  | "upstream"
  | "timeout"
  | "unreachable";

/**
 * What is kept of a transport failure: the error's class name and, when it has
 * one, a short code such as `ECONNREFUSED`. Never its message, which can quote
 * the request headers.
 */
export type TransportCause = { name: string; code: string | undefined };

export type ProviderErrorOptions = {
  /** Developer-facing detail: an upstream status, a dot path into the reply, or a transport error's name. Never the API key. */
  detail?: string;
  /** For `rate_limited`: the seconds the provider asked us to wait, when it said. */
  retryAfterSeconds?: number;
  /** Only ever a `TransportCause`, never the original error. */
  cause?: TransportCause;
  /**
   * For a reply the schema rejected: Zod's own message for the first problem,
   * for the server log only. It reads "Invalid input" unless the host has
   * turned on Zod's English locale (`worker/zod-locale.ts`), and then
   * "Invalid input: expected number, received string".
   */
  schemaMessage?: string;
};

/** A failed provider call, normalised so the route can answer the same way for every provider. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly schemaMessage: string | undefined;

  constructor(kind: ProviderErrorKind, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.detail = options.detail;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.schemaMessage = options.schemaMessage;
  }
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * The part of a successful decision a provider supplies. The route adds what it
 * knows or measures itself: `ok`, `primitive`, `provider`, `latencyMs`, and `wire`.
 */
export type ProviderDecision = Pick<DecisionSuccess, "model" | "usage" | "answers">;

/**
 * What `decide` returns: the provider's part of the decision, plus
 * `wire.response`, the provider's reply body exactly as `fetchJson` returned it,
 * so with the API key already redacted. `fromWire` stays pure and returns the
 * decision without `wire`.
 */
export type AdapterResult = ProviderDecision & { wire: { response: unknown } };

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
   * the provider's schema describes, answers a primitive the request did not
   * ask, or answers a different set of questions than the request asked.
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
  ): Promise<AdapterResult>;
};

// ---------------------------------------------------------------------------
// Provider text in details
// ---------------------------------------------------------------------------

/** The most characters of provider-supplied text a detail may carry. */
const MAX_DETAIL_TEXT = 300;

/**
 * Provider-supplied text, cut to 300 characters with an ellipsis, so an
 * envelope message or a record key can never flood a log or a response. Cut
 * by code point, so a character outside the basic plane is kept whole.
 */
export function clip(text: string): string {
  const characters = Array.from(text);
  return characters.length <= MAX_DETAIL_TEXT
    ? text
    : `${characters.slice(0, MAX_DETAIL_TEXT).join("")}…`;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** True for a 2xx status. The one place the success range is spelled out. */
export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The visible ASCII a header value may hold. A key with anything else, such as
 * a line break pasted in with it, makes `fetch` reject with a message that
 * quotes the whole header, so it is refused before any header is built.
 */
const SENDABLE_KEY = /^[\x21-\x7e]+$/;

/** Throws an `auth` error, naming no part of the key, when the key cannot travel in a header. */
export function assertSendableKey(provider: ProviderDescriptor, apiKey: string): void {
  if (SENDABLE_KEY.test(apiKey)) return;
  throw new ProviderError(
    "auth",
    `The ${provider.displayName} API key contains characters that can't be sent. Check the key for line breaks or spaces.`,
  );
}

/** What an adapter asks `fetchJson` to send. The `authorization` header is added by `fetchJson`. */
export type UpstreamRequest = {
  method: "GET" | "POST";
  headers?: Record<string, string>;
  /** The JSON text of the body, for a POST. */
  body?: string;
};

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

/** The class name of an error, or the type of a rejection that is not one. Letters only, so it can be nothing else. */
function nameOf(thrown: unknown): string {
  if (!(thrown instanceof Error)) return typeof thrown;
  return /^[A-Za-z]{1,40}$/.test(thrown.name) ? thrown.name : "Error";
}

/** A short upper-case code such as `ECONNREFUSED` or `UND_ERR_CONNECT_TIMEOUT`, when `value` carries one. */
function codeOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) return undefined;
  const { code } = value;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : undefined;
}

/**
 * What is kept of a `fetch` rejection: its name and a code, read from the
 * error or from its own `cause` (Node wraps the system error that way).
 */
function transportCause(thrown: unknown): TransportCause {
  const inner = thrown instanceof Error ? thrown.cause : undefined;
  return { name: nameOf(thrown), code: codeOf(inner) ?? codeOf(thrown) };
}

/**
 * Sends `request` to `url` with the key in the `authorization` header and
 * parses the reply as JSON. The signal is applied to the exchange, no redirect
 * is followed (a redirect would carry the key header to another host) and a
 * redirect reply is refused, and the
 * body is read as text before parsing, so a body that is not JSON is reported
 * for what it is rather than as a parse exception. Any copy of the key in that
 * text is replaced before parsing, so a provider that quotes the key in an error
 * message cannot carry it into a detail.
 *
 * Throws a `ProviderError`: `auth` when the key cannot be sent, `timeout` when
 * the signal aborted the exchange, `unreachable` when `fetch` rejected for
 * another reason (DNS, TLS, a dropped connection), and `upstream` when the
 * reply is a redirect or a successful status carries a body that is not JSON. A failed status is
 * returned, not thrown, so the caller can map it.
 */
export async function fetchJson(
  fetch: Fetch,
  signal: AbortSignal,
  provider: ProviderDescriptor,
  apiKey: string,
  url: string,
  request: UpstreamRequest,
): Promise<UpstreamReply> {
  assertSendableKey(provider, apiKey);
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: request.method,
      headers: { ...request.headers, authorization: `Bearer ${apiKey}` },
      body: request.body,
      signal,
      // "manual", not "error": workerd rejects "error" with a TypeError, which
      // made every provider call fail on a deployed Worker (#48). "manual" hands
      // back the redirect itself, unfollowed, and `refuseRedirect` rejects it.
      redirect: "manual",
    });
    await refuseRedirect(provider, response);
    text = await response.text();
  } catch (thrown) {
    // The redirect refusal is already a `ProviderError`, not a transport failure.
    if (thrown instanceof ProviderError) throw thrown;
    const cause = transportCause(thrown);
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
      { detail: cause.code === undefined ? cause.name : `${cause.name} (${cause.code})`, cause },
    );
  }

  const body = parseJson(redactKey(text, apiKey));
  if (isSuccess(response.status) && body === undefined) {
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

/**
 * Throws an `upstream` `ProviderError` when `response` is a redirect, the 3xx
 * status that workerd and Node both hand back for `redirect: "manual"`. The
 * body is cancelled unread, and the `Location` header is never read, so
 * nothing the redirect names reaches a message or a log.
 */
async function refuseRedirect(provider: ProviderDescriptor, response: Response): Promise<void> {
  if (response.status < 300 || response.status >= 400) return;
  await response.body?.cancel().catch(() => undefined);
  throw new ProviderError(
    "upstream",
    `${provider.displayName} answered with a redirect, which this app does not follow.`,
    { detail: `${response.status} redirect` },
  );
}

/** What replaces the key in a reply. It needs no escaping inside a JSON string. */
const REDACTED = "[redacted]";

/**
 * `text` with every copy of `apiKey` replaced, both as written and as a JSON
 * string escapes it, because a key holding `"` or `\` appears escaped inside a
 * JSON reply.
 */
function redactKey(text: string, apiKey: string): string {
  const escaped = JSON.stringify(apiKey).slice(1, -1);
  return text.replaceAll(escaped, REDACTED).replaceAll(apiKey, REDACTED);
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
  if (status === 402) return "no_credits";
  if (status === 400 || status === 422) return "invalid_request";
  return "upstream";
}

/** The least and the most a provider can make us wait, in seconds. */
const MIN_RETRY_SECONDS = 1;
const MAX_RETRY_SECONDS = 3600;

/** A delay in seconds: digits and nothing else, so `1e3`, `0x10`, `+5`, and `-0` are not delays. */
const DELAY_SECONDS = /^\d+$/;

/** An IMF-fixdate (RFC 9110, section 5.6.7), the only date form `Retry-After` is read in: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

function clampSeconds(seconds: number): number {
  return Math.min(MAX_RETRY_SECONDS, Math.max(MIN_RETRY_SECONDS, seconds));
}

/**
 * `Retry-After` as whole seconds between 1 and 3600, or `undefined` when the
 * header is absent or is neither a plain number of seconds nor an IMF-fixdate
 * (RFC 9110, section 10.2.3). A date is measured from `now` and rounded up;
 * one in the past gives the minimum wait.
 */
export function retryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  if (DELAY_SECONDS.test(raw)) return clampSeconds(Number(raw));
  if (!IMF_FIXDATE.test(raw)) return undefined;
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return clampSeconds(Math.ceil((date - now) / 1000));
}

/**
 * An adapter's say over a failed status: another `kind` than the status
 * implies (OpenAI answers a spent quota with 429, and a region block with 403),
 * other wording, or both. The wording default is kept for whatever is omitted.
 */
export type FailureOverride = {
  kind?: ProviderErrorKind;
  message?: string;
};

function defaultMessage(
  name: string,
  kind: ProviderErrorKind,
  retryAfter: number | undefined,
): string {
  switch (kind) {
    case "auth":
      return `${name} rejected the API key.`;
    case "rate_limited": {
      const wait = retryAfter === undefined ? "a moment" : `${retryAfter} seconds`;
      return `${name} is rate limiting requests. Wait ${wait} and try again.`;
    }
    case "no_credits":
      return `${name} has no credit left on this account. Add credit, then try again.`;
    case "invalid_request":
      return `${name} could not process this request. Check the questions and criteria against the detail.`;
    default:
      return `${name} returned an error. Try again in a moment.`;
  }
}

/**
 * The `ProviderError` for a failed reply, mapped by status unless `override`
 * says otherwise. `described` is the adapter's reading of the provider's error
 * envelope, such as `authentication_error: Cannot authenticate with the
 * server.`, cut to 300 characters; the detail is the status followed by it, so
 * a detail always starts with the status code.
 */
export function failureFromStatus(
  provider: ProviderDescriptor,
  reply: UpstreamReply,
  described?: string,
  override?: FailureOverride,
): ProviderError {
  const detail = described === undefined ? `${reply.status}` : `${reply.status} ${clip(described)}`;
  const kind = override?.kind ?? errorKindForStatus(reply.status);
  const retryAfter = kind === "rate_limited" ? retryAfterSeconds(reply.headers) : undefined;
  const message = override?.message ?? defaultMessage(provider.displayName, kind, retryAfter);
  return new ProviderError(kind, message, { detail, retryAfterSeconds: retryAfter });
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
 * Record keys in the path are provider text, so the path is cut to 300
 * characters. A problem with the body as a whole is placed at `body`.
 */
export function describeIssue(issue: z.core.$ZodIssue): string {
  const place = issue.path.length === 0 ? "body" : clip(issue.path.map(String).join("."));
  switch (issue.code) {
    case "invalid_type":
      return `${place}: expected ${issue.expected}, received ${kindOf(issue.input)}`;
    case "invalid_union":
      return `${place}: matches none of the expected shapes`;
    default:
      return `${place}: ${issue.code.replaceAll("_", " ")}`;
  }
}

/**
 * The `upstream` error for a reply whose shape the adapter's schema rejects;
 * `detail` names the place, and `schemaMessage`, when given, is Zod's own
 * message for the server log.
 */
export function unreadableReply(
  provider: ProviderDescriptor,
  detail: string,
  schemaMessage?: string,
): ProviderError {
  return new ProviderError(
    "upstream",
    `${provider.displayName} answered in a shape this app cannot read.`,
    { detail, schemaMessage },
  );
}

/**
 * Parses a provider body with its schema, or throws an `upstream` error whose
 * detail starts with the dot path of the first problem. Zod checks nested JSON
 * by recursion, so a body nested thousands of levels deep exhausts the call
 * stack with a `RangeError`; that is a reply this app cannot read, not a
 * crash, and is reported like any other. Neither the body nor the parse error
 * is kept on the thrown error, only Zod's message for the first problem, cut
 * to 300 characters. That message names at most a key of the reply, never a value.
 */
export function parseReply<T>(
  provider: ProviderDescriptor,
  schema: z.ZodMiniType<T>,
  body: unknown,
): T {
  let result: ReturnType<z.ZodMiniType<T>["safeParse"]>;
  try {
    result = schema.safeParse(body, { reportInput: true });
  } catch (thrown) {
    throw unreadableReply(
      provider,
      thrown instanceof RangeError ? "body: nested too deeply" : "body: could not be checked",
    );
  }
  if (result.success) return result.data;
  const [issue] = result.error.issues;
  throw unreadableReply(provider, describeIssue(issue), clip(issue.message));
}
