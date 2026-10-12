/**
 * Whether `value` is a JSON object: not null, and not an array. Request bodies, parsed
 * editor text, and server replies all need this same check before reading keys from them.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
