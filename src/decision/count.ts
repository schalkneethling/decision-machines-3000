/** "1 option", "2 options": a count with its noun in the right number. */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** The first `max` characters of `text`, with an ellipsis when something was cut. */
function truncate(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max).join("")}…`;
}

/** Characters in `text`, counting an emoji as one. */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

/** The sentence both the validator and the composer use for a question id over a provider's limit. */
export function idTooLongMessage(id: string, max: number): string {
  return `Question id "${truncate(id, 40)}" is ${characterCount(id)} characters long. Use at most ${max}.`;
}
