/**
 * The provider keys a deployment may set, and the rule for when a key counts as set.
 *
 * This module is shared by the Worker and the Node dev host, so it names no
 * Workers-only type. `worker/index.ts` joins these keys with the generated
 * `Env` from `wrangler types`.
 */

import { PROVIDER_ORDER } from "../src/providers/catalog.ts";
import type { ProviderId } from "../src/providers/catalog.ts";

/** The secret that enables each provider. */
export const PROVIDER_KEY_NAMES = {
  typesafe: "TYPESAFE_API_KEY",
  subq: "SUBQ_API_KEY",
  openai: "OPENAI_API_KEY",
} as const satisfies Record<ProviderId, string>;

export type ProviderKeyName = (typeof PROVIDER_KEY_NAMES)[ProviderId];

/**
 * The provider keys, each optional because a deployment may set any subset of
 * them. `wrangler types` cannot infer secrets, because the project keeps no
 * `.dev.vars` file, so they are declared here.
 */
export type ProviderKeys = Partial<Record<ProviderKeyName, string>>;

/**
 * The value the Deploy to Cloudflare button needs for a key the deployer leaves
 * out, because the button refuses blank secrets (docs/spikes/worker-toolchain.md,
 * step 9). It arrives as a live secret, so it has to read as "no key".
 */
const PLACEHOLDER = "unset";

/**
 * Whether a key value enables its provider. A missing value, a blank one, and the
 * placeholder `unset` (after trimming, in any case) all count as absent. So does
 * a value that is not a string, which a Worker `vars` entry can be, because
 * `wrangler.jsonc` accepts any JSON there.
 */
export function isKeySet(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed !== "" && trimmed.toLowerCase() !== PLACEHOLDER;
}

/** The providers whose key is set, in catalog order. */
export function configuredProviders(env: ProviderKeys): ProviderId[] {
  return PROVIDER_ORDER.filter((id) => isKeySet(env[PROVIDER_KEY_NAMES[id]]));
}

/**
 * What an instance with no provider key reports, both in the 503 from
 * `GET /api/providers` and when the Node dev host starts.
 */
export const MISSING_KEYS_MESSAGE = missingKeysMessage(
  PROVIDER_ORDER.map((id) => PROVIDER_KEY_NAMES[id]),
);

function missingKeysMessage(names: readonly string[]): string {
  const listed = `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
  return (
    `No provider key is set, and at least one is required. Set ${listed}. ` +
    `A blank value or "${PLACEHOLDER}" counts as not set.`
  );
}
