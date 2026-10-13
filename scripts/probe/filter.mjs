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
 * Cases that only make sense after another case, as `provider:case` mapped to the
 * `provider:case` entries they need first. Naming the dependent case on its own would
 * otherwise filter out its prerequisite, so the dependent case could never run.
 */
const PREREQUISITES = new Map([["openai:score-50-levels", ["openai:score-11-levels"]]]);

/** Returns a copy of the filter that also selects the prerequisites of every case it names. */
export function withPrerequisites(filter) {
  const expanded = new Map();
  for (const [provider, cases] of filter) {
    expanded.set(provider, cases === null ? null : new Set(cases));
  }
  for (const [provider, cases] of filter) {
    if (cases === null) continue;
    for (const name of cases) {
      for (const prerequisite of PREREQUISITES.get(`${provider}:${name}`) ?? []) {
        const [prerequisiteProvider, prerequisiteName] = prerequisite.split(":");
        expanded.get(prerequisiteProvider)?.add(prerequisiteName);
      }
    }
  }
  return expanded;
}

/**
 * Cases the filter named that neither ran nor were deliberately skipped, as `provider:case`
 * strings. A misspelled name such as `subq:three-type` shows up here, so the run can fail
 * instead of quietly sending nothing. `ran` is the set of `provider:case` strings that did
 * run, and `skipped` maps the ones skipped on purpose to their reason.
 */
export function unmatchedCases(filter, ran, skipped = new Map()) {
  const unmatched = [];
  for (const [provider, cases] of filter) {
    if (cases === null) continue;
    for (const name of cases) {
      const key = `${provider}:${name}`;
      if (!ran.has(key) && !skipped.has(key)) unmatched.push(key);
    }
  }
  return unmatched;
}
