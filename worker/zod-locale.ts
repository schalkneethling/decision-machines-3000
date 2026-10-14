/**
 * Turns on Zod's English messages for the server, so a provider reply that a
 * schema rejects is logged as "Invalid input: expected number, received
 * string" rather than Zod Mini's bare "Invalid input".
 *
 * Zod keeps this setting in one configuration object per JavaScript realm
 * (`globalThis.__zod_globalConfig`), so each host calls this once when it
 * starts: the Worker when its module loads (`worker/index.ts`), and the Node
 * dev host when its plugin configures the server (`server/vite-host.ts`). The
 * browser never imports this file, so its bundle carries no locale.
 *
 * It changes no message this app returns to the browser: every schema in
 * `src/decision/validate.ts` words its own messages, and the locale is the
 * lowest-priority source Zod consults
 * (`finalizeIssue` in node_modules/zod/v4/core/util.js).
 *
 * APIs used, read from the installed zod 4.6.7: `config` from
 * node_modules/zod/v4/mini/external.d.ts (re-exported by `zod/mini`), and
 * `en` from node_modules/zod/v4/locales/index.d.ts (re-exported by
 * `zod/locales`), which returns `{ localeError }`.
 */

import * as z from "zod/mini";
import { en } from "zod/locales";

export function useEnglishZodMessages(): void {
  z.config(en());
}
