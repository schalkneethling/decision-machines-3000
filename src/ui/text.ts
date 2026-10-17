/** "question" to "Question": the first character in upper case, for the start of a sentence. */
export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
