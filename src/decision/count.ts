/** "1 option", "2 options": a count with its noun in the right number. */
export function countOf(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
