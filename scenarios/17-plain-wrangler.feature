Feature: Plain Wrangler is the default deploy path, with a key check and a Deploy to Cloudflare button

  Background:
    Given the provider keys are TYPESAFE_API_KEY, SUBQ_API_KEY, and OPENAI_API_KEY, taken from the catalog's keyName
    And the Deploy button refuses blank inputs, and accepts the word "unset" as a value that becomes a live secret
    And the Worker treats a key as absent when its value, trimmed and lower-cased, is empty or equals "unset"
    And the deploy-time check reads secret names only, through `wrangler secret list --format json`

  # Automated: worker/env.test.ts, scripts/check-provider-keys.test.ts

  Scenario: The placeholder is absent and a real key is present, on both sides of the rule
    Given isKeySet is called with "unset", "UNSET", " unset ", "", and "   "
    Then it returns false for each
    When it is called with "x", "none", "unsetx", "un set", and "sk-short"
    Then it returns true for each

  Scenario: A deploy with a key set passes the check
    Given `wrangler secret list --format json` prints a JSON array that includes the name SUBQ_API_KEY
    When the check runs
    Then it exits 0 and the deploy proceeds

  Scenario: A deploy with no key stops before wrangler deploy
    Given the listing holds no provider key name, or is an empty array
    When the check runs
    Then it exits 1 with a message naming TYPESAFE_API_KEY, SUBQ_API_KEY, and OPENAI_API_KEY
    And the message contains no secret value
    And `wrangler deploy` does not run, because the script joins the two commands with `&&`

  Scenario: A Worker that does not exist yet counts as having no keys
    Given `wrangler secret list` exits 1 and says `Worker "<name>" not found`
    When the check runs
    Then it stops with the same message as for an empty list
    And it does not report a failed listing

  Scenario: Any other listing failure is reported as such
    Given `wrangler secret list` exits 1 with an authentication error, or prints text that is not a JSON array
    When the check runs
    Then it exits 1 and says it could not read the secret names

  # Static checks

  Scenario: .dev.vars.example lists the keys with comments and no values
    When .dev.vars.example is read
    Then it contains TYPESAFE_API_KEY, SUBQ_API_KEY, and OPENAI_API_KEY, each with a comment
    And each assignment has nothing after the equals sign
    And its header says at least one key must be set, and tells button users to enter the word unset

  Scenario: git ignores .dev.vars but not .dev.vars.example
    When `git check-ignore -q .dev.vars` runs
    Then it exits 0, because the file is ignored
    When `git check-ignore -q .dev.vars.example` runs
    Then it exits 1, because the file is not ignored

  Scenario: The deploy script is the key check followed by a plain wrangler deploy
    When the "deploy" script in package.json is read
    Then it is `node scripts/check-provider-keys.ts && wrangler deploy`
    And it passes no --var, --secrets-file, or secret value

  Scenario: The guide states the one-writer rule before any command
    When docs/deploy.md is read from the top
    Then the one-writer rule appears before the first code block
    And it names `varlock-wrangler deploy` against a plain-Wrangler Worker as forbidden
    And it names `wrangler secret put` and `wrangler secret bulk` against a Varlock-managed Worker as forbidden

  Scenario: The first step after the button is protecting the instance
    When docs/deploy.md is read
    Then the button section says the first step after the deploy is section 2, protecting the instance
    And the button section tells people to enter "unset" for each provider they do not have, and says at least one must be real
    And it warns about the failed first build and about a taken repository name

  Scenario: The guide documents the secret commands
    When docs/deploy.md section 3 is read
    Then it covers `wrangler secret put`, `secret list`, `secret delete`, `secret bulk`, `versions secret put` with `versions deploy`, `wrangler deploy`, and the `op read -n ... | wrangler secret put` pipeline

  # Manual checks, run by the owner. None of these were run by the implementer, because they change a Cloudflare account.
  # Use a throwaway Worker name (never decisionmachines3000), pass it with --name, and delete the Worker afterwards.

  Scenario: Manual, local run reads .dev.vars
    Given a .dev.vars copied from .dev.vars.example with one real key and ALLOW_UNPROTECTED_INSTANCE=I accept the bill
    When `vp run build` and `vp exec wrangler dev` run
    Then GET /api/providers lists only that provider
    And deleting .dev.vars afterwards lets `vp dev` start again

  Scenario: Manual, first deploy by hand
    Given a throwaway Worker name that does not exist
    When `vp exec wrangler secret list --name <name>` runs
    Then it exits 1 with `Worker "<name>" not found`
    When `vp exec wrangler secret put TYPESAFE_API_KEY --name <name>` runs
    Then a placeholder Worker is created with that secret
    And `wrangler secret list --name <name>` shows the name and no value

  Scenario: Manual, the deploy script with a key
    Given the throwaway Worker holds one key
    When `vp run build`, then the deploy script runs with the Worker name overridden in a scratch wrangler.jsonc
    Then the check passes and the deploy proceeds
    And `wrangler secret list` still shows the key afterwards

  Scenario: Manual, the deploy script with no key
    Given a throwaway Worker with a secret that is not a provider key, or a name that does not exist
    When the deploy script runs
    Then it stops before wrangler deploy with the message naming the three variables

  Scenario: Manual, the button on a fork
    Given the repository is public and the button is clicked with a changed project name
    Then the form shows three required inputs with the descriptions from package.json
    And the first build fails on the "Uploading template." commit, and a later build succeeds
    And the deploy field is pre-filled from the deploy script, and the build log shows the check passing and no secret value
    And with no Access configuration or opt-out, POST /api/decide/typesafe answers a JSON 503 before any provider call
    And with TYPESAFE_API_KEY real and the other two "unset", GET /api/providers lists only TypeSafe
