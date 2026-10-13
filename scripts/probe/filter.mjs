/**
 * The command-line case filter for the probe: which cases of which provider to run.
 */

/**
 * Parses arguments such as `subq` or `subq:bad-key,invalid-body`. A provider mapped to
 * `null` runs every case; a set limits it to the cases named.
 */
export function parseCaseFilter(args) {
  const filter = new Map();
  for (const argument of args) {
    const [provider, cases] = argument.split(":");
    filter.set(provider, cases === undefined ? null : new Set(cases.split(",")));
  }
  return filter;
}

/** True when the filter allows this case. An empty filter allows everything. */
export function isSelected(filter, provider, name) {
  const cases = filter.get(provider);
  return cases === undefined || cases === null || cases.has(name);
}

/**
 * Cases the filter named that never ran, as `provider:case` strings. A misspelled name such
 * as `subq:three-type` shows up here, so the run can fail instead of quietly sending nothing.
 * `ran` is the set of `provider:case` strings that did run.
 */
export function unmatchedCases(filter, ran) {
  const unmatched = [];
  for (const [provider, cases] of filter) {
    if (cases === null) continue;
    for (const name of cases) {
      if (!ran.has(`${provider}:${name}`)) unmatched.push(`${provider}:${name}`);
    }
  }
  return unmatched;
}
