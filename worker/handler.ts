/**
 * The request handler for every `/api` route, shared by the Worker
 * (`worker/index.ts`) and the Node dev host (`server/vite-host.ts`).
 *
 * `handle` is a plain function of its arguments and keeps no state between
 * requests, so tests call it directly instead of starting workerd. It sends no
 * CORS headers, because the browser only ever calls it from the same origin, and
 * every answer carries `Cache-Control: no-store`, because what it says depends on
 * the deployment's secrets.
 *
 * The routes:
 * - `GET /api/providers` lists the providers whose key is set.
 * - `POST /api/decide/{provider}` runs a decision on one provider (`decide.ts`).
 * - Any other `/api` path answers a JSON 404.
 */

import { DECIDE_PATH_PREFIX } from "../src/decision/contract.ts";
import { PROVIDERS } from "../src/providers/catalog.ts";
import { PROVIDERS_ENDPOINT, toProviderSummary } from "../src/providers/contract.ts";
import { decide } from "./decide.ts";
import { MISSING_KEYS_MESSAGE, configuredProviders } from "./env.ts";
import type { ProviderKeys } from "./env.ts";
import { failure, json } from "./respond.ts";

/**
 * What the handler takes from its host instead of from globals, so tests can
 * pass doubles for each:
 * - `fetch`: the function provider calls go through.
 * - `timeoutSignal`: an abort signal that fires after `ms` milliseconds; the
 *   hosts pass `AbortSignal.timeout`. Injected because Vitest's fake timers do
 *   not advance `AbortSignal.timeout`, so a test of the 25-second budget passes
 *   one built on `setTimeout` instead.
 * - `log`: where the decide route writes one line per provider call.
 */
export type HandlerDeps = {
  fetch: typeof fetch;
  timeoutSignal: (ms: number) => AbortSignal;
  log: (line: string) => void;
};

/**
 * The dependencies both hosts give the handler. `fetch` is bound to
 * `globalThis`, because the handler calls it as `deps.fetch(...)` and workerd
 * rejects a `fetch` called with any other `this` ("Illegal invocation").
 */
export function defaultDeps(): HandlerDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    log: (line) => {
      console.info(line);
    },
  };
}

type Route = (request: Request, env: ProviderKeys, deps: HandlerDeps) => Promise<Response>;

type Methods = Readonly<Record<string, Route>>;

/** The routes with a fixed path, by path and then by method. */
const ROUTES: Readonly<Record<string, Methods>> = {
  [PROVIDERS_ENDPOINT]: { GET: listProviders },
};

/** The methods a route answers: its own, plus HEAD wherever it answers GET. */
function allowedMethods(methods: Methods): string[] {
  const own = Object.keys(methods);
  return own.includes("GET") && !own.includes("HEAD") ? [...own, "HEAD"] : own;
}

/** A HEAD answer: the GET route's status and headers, without its body. */
async function headOf(response: Promise<Response>): Promise<Response> {
  const { status, statusText, headers } = await response;
  return new Response(null, { status, statusText, headers });
}

/**
 * Lists the providers whose key is set. It reads each key only to decide whether
 * it is set, so no value, length, or prefix can reach the body.
 */
async function listProviders(_request: Request, env: ProviderKeys): Promise<Response> {
  const ids = configuredProviders(env);
  if (ids.length === 0) {
    return failure(503, MISSING_KEYS_MESSAGE);
  }
  return json({ ok: true, providers: ids.map((id) => toProviderSummary(PROVIDERS[id])) }, 200);
}

/**
 * The provider id in `/api/decide/{id}`: one non-empty path segment, or
 * undefined for any other path. It is the raw segment, still percent-encoded,
 * and the route itself decides whether a provider has that id.
 */
function decideTarget(pathname: string): string | undefined {
  if (!pathname.startsWith(DECIDE_PATH_PREFIX)) return undefined;
  const id = pathname.slice(DECIDE_PATH_PREFIX.length);
  return id === "" || id.includes("/") ? undefined : id;
}

function routesFor(pathname: string): Methods | undefined {
  const providerId = decideTarget(pathname);
  if (providerId !== undefined) {
    return { POST: (request, env, deps) => decide(providerId, request, env, deps) };
  }
  return Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
}

/*
 * No answer quotes the request's path or an unknown method. Under Varlock in
 * `vp dev`, a key set to the placeholder is a sensitive value, and any response
 * that contains it is replaced with a 500, so `GET /api/unset` would otherwise
 * break the very 404 that explains it.
 */

/** The methods RFC 9110 defines, plus PATCH: the only ones an answer names. */
const STANDARD_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "DELETE",
  "CONNECT",
  "OPTIONS",
  "TRACE",
  "PATCH",
]);

function notFound(): Response {
  return failure(404, "No API route matches this path.");
}

function methodNotAllowed(method: string, methods: Methods): Response {
  const allowed = allowedMethods(methods);
  const named = STANDARD_METHODS.has(method) ? method : "this method";
  return failure(405, `This route answers only ${allowed.join(" and ")}, not ${named}.`, {
    headers: { allow: allowed.join(", ") },
  });
}

/**
 * What the handler answers for a method it never receives as a `Request`: a 404
 * for an unknown path, otherwise a 405 that lists the methods the path allows.
 * The Node dev host uses it for TRACE and TRACK, which the Fetch API forbids.
 */
export function rejectMethod(pathname: string, method: string): Response {
  const methods = routesFor(pathname);
  return methods === undefined ? notFound() : methodNotAllowed(method, methods);
}

/** Routes one `/api` request to its answer. */
async function dispatch(request: Request, env: ProviderKeys, deps: HandlerDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  const methods = routesFor(pathname);
  if (methods === undefined) {
    return notFound();
  }

  const { method } = request;
  const answer = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (answer !== undefined) {
    return answer(request, env, deps);
  }
  if (method === "HEAD" && Object.hasOwn(methods, "GET")) {
    return headOf(methods.GET(request, env, deps));
  }
  return methodNotAllowed(method, methods);
}

/**
 * Answers one `/api` request. Anything a route throws instead of answering,
 * such as a body stream that fails because the client went away, becomes a
 * JSON 500 rather than the host's own error page. Only the error's class name
 * is logged, never its message, which could quote the request.
 */
export async function handle(
  request: Request,
  env: ProviderKeys,
  deps: HandlerDeps,
): Promise<Response> {
  try {
    return await dispatch(request, env, deps);
  } catch (thrown) {
    const name = thrown instanceof Error ? thrown.name : typeof thrown;
    deps.log(`[api] status=500 unexpected=${JSON.stringify(name)}`);
    return failure(500, "Something went wrong on the server. Check the server log.");
  }
}
