/**
 * The DecisionMachines3000 Worker.
 *
 * The assets layer configured in `wrangler.jsonc` serves the single-page app
 * and sends only `/api` requests here, which `handle` answers. The Worker
 * injects the global `fetch`, `AbortSignal.timeout`, and `console.info` as the
 * handler's dependencies, names itself as the `"worker"` host, so the
 * protection gate applies (ADR-0003), and turns on Zod's English messages once,
 * when this module loads, so a provider reply that fails its schema is logged
 * in words.
 */

import { defaultDeps, handle } from "./handler.ts";
import type { HandlerEnv } from "./handler.ts";
import { useEnglishZodMessages } from "./zod-locale.ts";

/**
 * The generated bindings from `wrangler types`, plus the provider keys and
 * protection variables it cannot infer, because they are secrets or set in the
 * dashboard rather than in `wrangler.jsonc`.
 */
type WorkerEnv = Env & HandlerEnv;

useEnglishZodMessages();

export default {
  fetch(request, env) {
    return handle(request, env, defaultDeps("worker"));
  },
} satisfies ExportedHandler<WorkerEnv>;
