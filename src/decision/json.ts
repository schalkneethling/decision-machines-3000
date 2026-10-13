/**
 * Whether `value` is a JSON object: not null, and not an array. The warm request body and
 * parsed editor text need this check before reading keys from them; the schemas in
 * `contract.ts` and `validate.ts` make the same distinction on their own.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
