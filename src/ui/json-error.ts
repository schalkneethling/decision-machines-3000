/**
 * Turns a `JSON.parse` failure into one readable sentence with a line and column
 * when the engine reports a position.
 *
 * Engines word these errors differently:
 * - V8: `Expected ',' or '}' after property value in JSON at position 45 (line 3 column 5)`
 * - SpiderMonkey: `JSON.parse: expected ',' or '}' after property value in object at line 3 column 5 of the JSON data`
 * - JavaScriptCore: `JSON Parse error: Expected '}'` (no position)
 */
export function describeJsonError(source: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const location = findLocation(source, raw);
  const message = lowercaseFirst(cleanMessage(raw));

  if (location) {
    return `Line ${location.line}, column ${location.column}: ${message}.`;
  }

  return `This is not valid JSON: ${message}.`;
}

type Location = {
  line: number;
  column: number;
};

function findLocation(source: string, message: string): Location | undefined {
  const lineColumn = /line (\d+) column (\d+)/i.exec(message);
  if (lineColumn) {
    return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) };
  }

  const position = /at position (\d+)/i.exec(message);
  if (position) {
    return locationFromOffset(source, Number(position[1]));
  }

  return undefined;
}

function locationFromOffset(source: string, offset: number): Location {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  const current = lines.at(-1) ?? "";
  return { line: lines.length, column: current.length + 1 };
}

function cleanMessage(message: string): string {
  return message
    .replace(/^JSON\.parse:\s*/i, "")
    .replace(/^JSON Parse error:\s*/i, "")
    .replace(/\s+in JSON at position \d+.*$/i, "")
    .replace(/\s+at line \d+ column \d+ of the JSON data$/i, "")
    .replace(/\.$/, "")
    .trim();
}

function lowercaseFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
