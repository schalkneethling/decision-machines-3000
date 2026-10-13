/**
 * The request handler for every `/api` route, shared by the Worker
 * (`worker/index.ts`) and the Node dev host (`server/vite-host.ts`).
 *
 * `handle` is a plain function of its arguments and keeps no state between
 * requests, so tests call it directly instead of starting workerd. It sends no
 * CORS headers, because the browser only ever calls it from the same origin, and
 * every answer carries `Cache-Control: no-store`, because what it says depends on
 * the deployment's secrets.
 */

import type { DecisionFailure } from "../src/decision/contract.ts";
import { PROVIDERS } from "../src/providers/catalog.ts";
import { PROVIDERS_ENDPOINT, toProviderSummary } from "../src/providers/contract.ts";
import type { ProvidersResponse } from "../src/providers/contract.ts";
import { MISSING_KEYS_MESSAGE, configuredProviders } from "./env.ts";
import type { ProviderKeys } from "./env.ts";

/**
 * What the handler takes from its host instead of from globals. `fetch` is the
 * function provider calls go through, so tests can pass a stub; the Worker
 * passes the global `fetch`.
 */
export type HandlerDeps = {
  fetch: typeof fetch;
};

/** Every body an `/api` route answers with. */
type ApiBody = ProvidersResponse | DecisionFailure;

type Route = (request: Request, env: ProviderKeys, deps: HandlerDeps) => Promise<Response>;

/** The routes, by path and then by method. */
const ROUTES: Readonly<Record<string, Readonly<Record<string, Route>>>> = {
  [PROVIDERS_ENDPOINT]: { GET: listProviders },
};

/**
 * Every answer is uncacheable, because it depends on the deployment's secrets,
 * and carries `nosniff`, so a browser never reads it as anything but JSON.
 */
function json(body: ApiBody, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

/**
 * A failure in the shape every `/api` route uses. Exported for the Node dev
 * host, which answers a request with a malformed Host header itself, because
 * no `Request` can be built from it.
 */
export function failure(status: number, error: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error }, status, headers);
}

/** The methods a route answers: its own, plus HEAD wherever it answers GET. */
function allowedMethods(methods: Readonly<Record<string, Route>>): string[] {
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

function routesFor(pathname: string): Readonly<Record<string, Route>> | undefined {
  return Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
}

function notFound(pathname: string): Response {
  return failure(404, `No API route matches ${pathname}.`);
}

function methodNotAllowed(
  pathname: string,
  method: string,
  methods: Readonly<Record<string, Route>>,
): Response {
  const allowed = allowedMethods(methods);
  return failure(405, `${pathname} answers only ${allowed.join(" and ")}, not ${method}.`, {
    allow: allowed.join(", "),
  });
}

/**
 * What the handler answers for a method it never receives as a `Request`: a 404
 * for an unknown path, otherwise a 405 that lists the methods the path allows.
 * The Node dev host uses it for TRACE and TRACK, which the Fetch API forbids.
 */
export function rejectMethod(pathname: string, method: string): Response {
  const methods = routesFor(pathname);
  return methods === undefined ? notFound(pathname) : methodNotAllowed(pathname, method, methods);
}

/** Answers one `/api` request. */
export async function handle(
  request: Request,
  env: ProviderKeys,
  deps: HandlerDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const methods = routesFor(pathname);
  if (methods === undefined) {
    return notFound(pathname);
  }

  const { method } = request;
  const route = Object.hasOwn(methods, method) ? methods[method] : undefined;
  if (route !== undefined) {
    return route(request, env, deps);
  }
  if (method === "HEAD" && Object.hasOwn(methods, "GET")) {
    return headOf(methods.GET(request, env, deps));
  }
  return methodNotAllowed(pathname, method, methods);
}
