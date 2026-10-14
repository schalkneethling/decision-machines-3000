/**
 * The DecisionMachines3000 Worker.
 *
 * The assets layer configured in `wrangler.jsonc` serves the single-page app
 * and sends only `/api` requests here, which `handle` answers. The Worker
 * injects the global `fetch` as the function provider calls go through.
 */

import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";

/** The generated bindings from `wrangler types`, plus the provider keys it cannot infer. */
type WorkerEnv = Env & ProviderKeys;

/**
 * The dependencies the Worker gives the handler. `fetch` is bound to
 * `globalThis`, because the handler calls it as `deps.fetch(...)` and workerd
 * rejects a `fetch` called with any other `this` ("Illegal invocation").
 */
export function defaultDeps(): HandlerDeps {
  return { fetch: globalThis.fetch.bind(globalThis) };
}

export default {
  fetch(request, env) {
    return handle(request, env, defaultDeps());
  },
} satisfies ExportedHandler<WorkerEnv>;
