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

function json(body: ApiBody, status: number, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function failure(status: number, error: string, headers?: Record<string, string>): Response {
  return json({ ok: false, error }, status, headers);
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

/** Answers one `/api` request. */
export async function handle(
  request: Request,
  env: ProviderKeys,
  deps: HandlerDeps,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const methods = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (methods === undefined) {
    return failure(404, `No API route matches ${pathname}.`);
  }

  const route = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
  if (route === undefined) {
    const allowed = Object.keys(methods).join(", ");
    return failure(405, `${pathname} answers only ${allowed}, not ${request.method}.`, {
      allow: allowed,
    });
  }

  return route(request, env, deps);
}
