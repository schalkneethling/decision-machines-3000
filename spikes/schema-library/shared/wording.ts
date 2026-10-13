/**
 * Wording helpers both schema implementations share, copied from the reference
 * validator (`src/decision/validate.ts`) so the two libraries are compared on
 * how they carry the messages, not on how the messages are phrased. A
 * migration would keep these next to the schemas in the same way.
 */

export const REQUEST_KEYS = ["primitive", "state", "criteria", "questions"] as const;
export const QUESTION_KEYS = ["instructions", "criteria"] as const;
export const NOUL_CRITERIA_KEYS = ["true", "false"] as const;
export const PRIMITIVES = ["noul", "choice", "score"] as const;

/** Plain-language name for a value's kind, for "…, not a number" style messages. */
export function describeKind(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "missing";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "string") return "text";
  if (typeof value === "number") return "a number";
  if (typeof value === "boolean") return `${value}`;
  if (typeof value === "object") return "an object";
  return `a ${typeof value}`;
}

/** `"a", "b", and "c"`: how the validator lists the fields an object may contain. */
export function quoteList(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
}

/** `"a", "b", or "c"`: how the validator lists the values a field may take. */
export function quoteChoices(items: readonly string[]): string {
  const quoted = items.map((item) => `"${item}"`);
  if (quoted.length <= 1) return quoted.join("");
  return `${quoted.slice(0, -1).join(", ")}, or ${quoted.at(-1)}`;
}

/** The message for an unknown field, with the hint the validator adds when the field is `type`. */
export function unknownFieldMessage(
  where: string,
  key: string,
  allowed: readonly string[],
): string {
  const hint =
    key === "type" ? ` The primitive is set once, with "primitive" at the top of the request.` : "";
  return `${where} has an unknown field "${key}". It can only contain ${quoteList(allowed)}.${hint}`;
}

/** A non-empty string that is not only whitespace. Objects and lists always pass. */
export function isNotBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() !== "";
}

/** The result shape both implementations return, identical to the reference validator's. */
export type ValidationFailure = {
  ok: false;
  error: string;
  detail?: string;
};
