/**
 * The DecisionMachines3000 Worker.
 *
 * The assets layer configured in `wrangler.jsonc` serves the single-page app
 * and sends only `/api` requests here, which `handle` answers. The Worker
 * injects the global `fetch`, `AbortSignal.timeout`, and `console.info` as the
 * handler's dependencies, and turns on Zod's English messages once, when this
 * module loads, so a provider reply that fails its schema is logged in words.
 */

import type { ProviderKeys } from "./env.ts";
import { defaultDeps, handle } from "./handler.ts";
import { useEnglishZodMessages } from "./zod-locale.ts";

/** The generated bindings from `wrangler types`, plus the provider keys it cannot infer. */
type WorkerEnv = Env & ProviderKeys;

useEnglishZodMessages();

export default {
  fetch(request, env) {
    return handle(request, env, defaultDeps());
  },
} satisfies ExportedHandler<WorkerEnv>;
