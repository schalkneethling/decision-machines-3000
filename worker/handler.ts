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
 * - `GET /api/providers` lists the providers whose key is set, and reports how
 *   the instance is protected.
 * - `POST /api/decide/{provider}` runs a decision on one provider (`decide.ts`),
 *   once the protection gate (`protection.ts`) lets the request through.
 * - Any other `/api` path answers a JSON 404.
 */

import { DECIDE_PATH_PREFIX } from "../src/decision/contract.ts";
import { PROVIDERS } from "../src/providers/catalog.ts";
import { PROVIDERS_ENDPOINT, toProviderSummary } from "../src/providers/contract.ts";
import { decide } from "./decide.ts";
import { MISSING_KEYS_MESSAGE, configuredProviders } from "./env.ts";
import type { ProviderKeys } from "./env.ts";
import { configuredProtection, refuseUnprotected, reportProtection } from "./protection.ts";
import type { Host, ProtectionVars } from "./protection.ts";
import { failure, json } from "./respond.ts";

/** Everything the handler reads from the environment: the provider keys and the protection variables. */
export type HandlerEnv = ProviderKeys & ProtectionVars;

/**
 * What the handler takes from its host instead of from globals, so tests can
 * pass doubles for each:
 * - `host`: which host is calling. Only `"node-dev"`, the Vite dev server in
 *   Node, counts as local and skips the protection gate; it is a fact about the
 *   calling code, never read from the request, so no request can claim it.
 * - `fetch`: the function provider calls and the Access key fetch go through.
 * - `timeoutSignal`: an abort signal that fires after `ms` milliseconds; the
 *   hosts pass `AbortSignal.timeout`. Injected because Vitest's fake timers do
 *   not advance `AbortSignal.timeout`, so a test of the 25-second budget passes
 *   one built on `setTimeout` instead.
 * - `log`: where the decide route writes one line per provider call, and the
 *   gate one line per refusal.
 */
export type HandlerDeps = {
  host: Host;
  fetch: typeof fetch;
  timeoutSignal: (ms: number) => AbortSignal;
  log: (line: string) => void;
};

/**
 * The dependencies a host gives the handler, with `host` naming the caller.
 * `fetch` is bound to `globalThis`, because the handler calls it as
 * `deps.fetch(...)` and workerd rejects a `fetch` called with any other `this`
 * ("Illegal invocation").
 */
export function defaultDeps(host: Host): HandlerDeps {
  return {
    host,
    fetch: globalThis.fetch.bind(globalThis),
    timeoutSignal: (ms) => AbortSignal.timeout(ms),
    log: (line) => {
      console.info(line);
    },
  };
}

type Route = (request: Request, env: HandlerEnv, deps: HandlerDeps) => Promise<Response>;

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
 * Lists the providers whose key is set, with the instance's protection state.
 * It reads each key only to decide whether it is set, so no value, length, or
 * prefix can reach the body. The list itself needs no token: it is the public
 * catalog filtered, and the UI needs the protection state to explain a refusal.
 */
async function listProviders(
  request: Request,
  env: HandlerEnv,
  deps: HandlerDeps,
): Promise<Response> {
  const ids = configuredProviders(env);
  if (ids.length === 0) {
    return failure(503, MISSING_KEYS_MESSAGE);
  }
  const protection = await reportProtection(request, configuredProtection(env, deps.host), deps);
  return json(
    { ok: true, providers: ids.map((id) => toProviderSummary(PROVIDERS[id])), protection },
    200,
  );
}

/**
 * A route that calls a provider, behind the protection gate: the gate's
 * refusal, or the route's own answer. It runs before the route reads anything,
 * so a refused request is never parsed.
 */
function protectedRoute(route: Route): Route {
  return async (request, env, deps) => {
    const refusal = await refuseUnprotected(request, configuredProtection(env, deps.host), deps);
    return refusal ?? route(request, env, deps);
  };
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
    return { POST: protectedRoute((request, env, deps) => decide(providerId, request, env, deps)) };
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
async function dispatch(request: Request, env: HandlerEnv, deps: HandlerDeps): Promise<Response> {
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
  env: HandlerEnv,
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
