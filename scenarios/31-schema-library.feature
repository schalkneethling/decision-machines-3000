# The comparison code these scenarios run (spikes/schema-library/) is on the branch
# issue-31-schema-library-spike, not on main.
# Manual QA guide for spike #31. The repository has no Cucumber runner; a person
# follows these scenarios by hand. Every command runs from the repository root of
# the branch issue-31-schema-library-spike. The comparison code is in
# spikes/schema-library/ and the recorded results are in
# docs/spikes/schema-library.md and docs/adr/0004-schema-library.md.
# No scenario deploys anything, logs in anywhere, or needs 1Password.

Feature: Compare Valibot and Zod Mini on the project's real data shapes and choose one

  Background:
    Given the branch issue-31-schema-library-spike is checked out
    And "vp install" has run

  Scenario: The document records the exact versions and that they are the latest stable releases
    When "jq '.devDependencies.valibot, .devDependencies.zod' package.json" runs
    Then it prints "^1.5.0" and "^4.6.7"
    And "npm view valibot dist-tags" shows latest as 1.5.0
    And "npm view zod dist-tags" shows latest as 4.6.7
    And docs/spikes/schema-library.md records both versions, the Zod Mini import path "zod/mini", and the commands above

  Scenario: Schema 1 reproduces today's messages and paths in both libraries
    When "node spikes/schema-library/report.ts" runs
    Then the first table lists 39 invalid request cases: 16 from validate.test.ts before PR #30, 8 that PR #30 added, and 15 additional
    And every row reads "exact" for Valibot and for Zod Mini
    And the line below the table reads "Exact: Valibot 39/39, Zod Mini 39/39."
    And the expected message and path of every case come from src/decision/validate.ts at run time, not from a copy
    And docs/spikes/schema-library.md lists the workarounds each library needed, with code

  Scenario: Schema 2 parses every recorded fixture and a broken copy names its path
    When "vp test spikes/schema-library" runs
    Then "schema 2 in Valibot parses the recorded fixtures" and "schema 2 in Zod Mini parses the recorded fixtures" each pass 33 fixture tests and one synthetic refusal test
    And each library rejects the four broken copies with the paths
      | answers.queue.probabilities.nurse_line  |
      | answers.2.probabilities.1.probability   |
      | answers.acuity.type                     |
      | error.message                           |

  Scenario: Default wording for a broken provider response is recorded for both libraries
    When "node spikes/schema-library/report.ts" runs
    Then the second table shows Valibot's message as 'Invalid type: Expected number but received "1"' for the TypeSafe probability case
    And Zod Mini's message as "Invalid input" without a locale and "Invalid input: expected number, received string" with the English locale

  Scenario: Schema 3 checks the browser's DecisionResponse, including the refusal answer
    When "vp test spikes/schema-library" runs
    Then both "schema 3" describe blocks accept the noul, choice, and score fixtures, a response with a refusal answer, and a failure
    And both reject a keep-alive of 5 at "keepAliveSeconds", an unknown answer type at "answers.recommends.type", choice answers under the score primitive at "answers.film_0.type", and a failure without an error at "error"

  Scenario: Bundle cost is measured on one identical browser entry per library
    When these commands run in order
      | vp build spikes/schema-library/bundle --mode valibot      |
      | vp build spikes/schema-library/bundle --mode zod-mini     |
      | vp build spikes/schema-library/bundle --mode zod-mini-en  |
      | vp build spikes/schema-library/bundle --mode hand-written |
      | node spikes/schema-library/bundle/measure.ts              |
    Then the table shows gzip bytes close to 2,510 for hand-written, 5,123 for valibot, 10,884 for zod-mini, and 11,940 for zod-mini-en
    And docs/spikes/schema-library.md records these numbers and the commands

  Scenario: Both libraries run in workerd without a deploy or a login
    When "vp exec wrangler dev -c spikes/schema-library/worker/wrangler.valibot.jsonc --port 8791 --show-interactive-dev-session false" runs
    And "curl -s http://localhost:8791/" is called
    Then the JSON body has "runtime" equal to "Cloudflare-Workers", every "schema1.accepts" value true, "schema1.rejects.detail" equal to "primitive", and every "schema2" fixture with "success" true
    And the same holds for wrangler.zod-mini.jsonc on port 8792, run after the first session has stopped
    And no "wrangler deploy" or "wrangler login" was run

  Scenario: Inferred types equal the hand-written contract
    When "vp exec tsc -p spikes/schema-library/tsconfig.json" runs
    Then it prints nothing and exits 0
    And spikes/schema-library/types.ts contains 16 "Equal" assertions covering the request union, DecisionRequest<P> by Extract, Content, JsonValue, the response union, and the answer-by-primitive mapping

  Scenario: Parse speed and ecosystem facts have a source
    When "node spikes/schema-library/bench.ts" runs
    Then it prints a table with the hand-written validator and both libraries on the choice example and three provider answers
    And docs/spikes/schema-library.md names the command, machine, Node version, and method for every speed figure
    And every ecosystem figure in docs/spikes/schema-library.md has a command or URL beside it

  Scenario: The ADR chooses one library and says what would make us revisit
    Given docs/adr/0004-schema-library.md
    When it is read
    Then it chooses Zod Mini
    And it lists the reasons in order of weight
    And it names what Valibot does better, including bundle size
    And it lists the conditions that would reopen the decision

  Scenario: Follow-up work is filed after the decision
    Given docs/spikes/schema-library.md
    When its last section is read
    Then it contains the drafts for migrating contract.ts and validate.ts and for the new boundaries
    And "gh issue list --state all --search 'Migrate the contract, validator, and response checks to Zod Mini in:title'" finds the migration issue, open or closed
    And issues #7, #8, #10, #11, and #15 each have a comment headed "Schemas at this boundary (ADR-0004, Zod Mini)"

  Scenario: The comparison code stays out of src and the app build, and the checks pass
    When "vp check", "vp test", and "vp run build" run
    Then all three pass
    And, on the spike branch, "git diff --stat $(git merge-base origin/main HEAD) -- src server" shows no changes
    And the built dist/assets/index-*.js contains neither "valibot" nor "zod"
