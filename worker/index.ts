/**
 * The DecisionMachines3000 Worker.
 *
 * The assets layer configured in `wrangler.jsonc` serves the single-page app
 * and sends only `/api` requests here, which `handle` answers. The Worker
 * injects the global `fetch` as the function provider calls go through.
 */

import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";

/** The generated bindings from `wrangler types`, plus the provider keys it cannot infer. */
type WorkerEnv = Env & ProviderKeys;

export default {
  fetch(request, env) {
    // Bound, because workerd rejects a `fetch` called with any other `this`.
    return handle(request, env, { fetch: fetch.bind(globalThis) });
  },
} satisfies ExportedHandler<WorkerEnv>;
