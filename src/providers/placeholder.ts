/**
 * The value the Deploy to Cloudflare button needs for a key the deployer leaves
 * out, because the button refuses blank secrets (docs/spikes/worker-toolchain.md,
 * step 9). It arrives as a live secret, so it has to read as "no key".
 *
 * Under Varlock in `vp dev`, a key set to the placeholder is a sensitive value,
 * and any response that contains it is replaced with a 500. So no answer may
 * echo user text that is the placeholder: not a provider id (`worker/`) and not
 * a field name (`src/decision/validate.ts`). It lives here, outside `worker/`,
 * so the browser's validator can share it.
 */
const PLACEHOLDER = "unset";

/** Whether `value` is the Deploy button's placeholder, after trimming, in any case. */
export function isPlaceholder(value: string): boolean {
  return value.trim().toLowerCase() === PLACEHOLDER;
}
