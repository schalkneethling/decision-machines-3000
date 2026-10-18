/**
 * How every `/api` route answers. Shared by the router (`handler.ts`), the
 * decide and warm routes (`decide.ts`, `warm.ts`), and the Node dev host, which answers a request
 * with a malformed Host header itself, because no `Request` can be built from it.
 *
 * Every answer is uncacheable, because it depends on the deployment's secrets,
 * and carries `nosniff`, so a browser never reads it as anything but JSON. No
 * answer carries CORS headers, because the browser only calls the API from the
 * same origin.
 */

import type { DecisionFailure, WarmSuccess } from "../src/decision/contract.ts";
import type { ProvidersResponse } from "../src/providers/contract.ts";
import type { DecisionSuccessBody } from "./decide.ts";

/** Every body an `/api` route answers with. */
type ApiBody = ProvidersResponse | DecisionSuccessBody | WarmSuccess | DecisionFailure;

export function json(
  body: ApiBody,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });
}

export type FailureOptions = {
  /** Developer-facing detail, such as a validation path or an upstream status. */
  detail?: string | undefined;
  /** Extra response headers, such as `Allow` or `Retry-After`. */
  headers?: Record<string, string> | undefined;
};

/** A failure in the shape every `/api` route uses: `{ ok: false, error, detail? }`. */
export function failure(status: number, error: string, options: FailureOptions = {}): Response {
  const body: DecisionFailure =
    options.detail === undefined
      ? { ok: false, error }
      : { ok: false, error, detail: options.detail };
  return json(body, status, options.headers);
}
