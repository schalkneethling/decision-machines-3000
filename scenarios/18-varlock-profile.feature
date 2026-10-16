Feature: Varlock and 1Password profile: three optional keys and deploy:varlock

  Background:
    Given the provider keys are TYPESAFE_API_KEY, SUBQ_API_KEY, and OPENAI_API_KEY, taken from the catalog's keyName
    And .env.schema reads all three from the 1Password item "nocajwa573emc6ko6sv5bkn6y4" in the "dev" vault, one field per key
    And each key is `@optional @sensitive`, and its `op()` call has `allowMissing=true`
    And AT_LEAST_ONE_PROVIDER_KEY is a `@required @sensitive=false` item that resolves to the word `ok` when any key has a value, and to an empty string otherwise
    And "scratch Worker" below means a throwaway Worker named dm3000-scratch-check, never the Worker named decisionmachines3000

  # Automated: scripts/varlock-profile.test.ts

  Scenario: The schema declares exactly the catalog's keys, each optional and sensitive
    Given the text of .env.schema
    Then it has one item per name in PROVIDER_KEY_NAMES
    And each of those items is preceded by `@optional` and `@sensitive`
    And each reads its own field of the vault item with `allowMissing=true`

  Scenario: The check item covers every key and holds no secret
    Given the text of .env.schema
    Then AT_LEAST_ONE_PROVIDER_KEY is `@required` and `@sensitive=false`
    And its value refers to every name in PROVIDER_KEY_NAMES

  Scenario: deploy:varlock is varlock-wrangler and nothing else
    Given the scripts in package.json
    Then `deploy:varlock` is exactly `varlock-wrangler deploy`
    And it does not run the `deploy` script or the Worker key check, because the key check reads secrets that a Varlock deploy has not uploaded yet
    And `deploy` still runs `node scripts/deploy.ts`

  Scenario: The Varlock plugin is never imported at the top level of vite.config.ts
    Given the text of vite.config.ts
    Then `@varlock/cloudflare-integration` is only reached through a dynamic import
    And `vp check`, `vp test`, and `vp run build` load no Varlock module

  Scenario: The README quotes no copy of the schema
    Given the text of README.md
    Then it contains no `op(op://` reference and no `@initOp` line
    And it does not name `@varlock/vite-integration`
    And it links to docs/deploy.md for the Varlock profile

  Scenario: The deploy guide's Varlock commands put no secret on a command line
    Given the text of docs/deploy.md
    Then no command line in it carries a provider key value, whether as `--var KEY:value` or as `KEY=value`

  # Read-only Varlock commands (they ask the 1Password app but change nothing)

  Scenario: Only TypeSafe is present in the vault
    Given a temporary copy of .env.schema in which SUBQ_API_KEY and OPENAI_API_KEY point at fields that do not exist
    When `vp exec varlock load -p <that directory>` runs
    Then it exits 0
    And TYPESAFE_API_KEY is shown redacted
    And SUBQ_API_KEY and OPENAI_API_KEY are shown as undefined
    And AT_LEAST_ONE_PROVIDER_KEY is shown as "ok"

  Scenario: No provider key is present
    Given a temporary copy of .env.schema in which all three keys point at fields that do not exist
    When `vp exec varlock load -p <that directory>` runs
    Then it exits 1
    And the error names AT_LEAST_ONE_PROVIDER_KEY ("Value is required but is currently empty")

  Scenario: A missing vault field fails the load unless allowMissing is set
    Given a temporary copy of .env.schema in which SUBQ_API_KEY and OPENAI_API_KEY point at missing fields and carry no allowMissing
    When `vp exec varlock load -p <that directory>` runs
    Then it exits 1
    And the error says the item "does not have field" for each, because `@optional` does not cover a missing field
    # This is why every op() call in .env.schema carries allowMissing=true.

  Scenario: The full vault item resolves
    When `vp exec varlock load` runs against the real .env.schema
    Then it exits 0, shows each present key redacted, and shows AT_LEAST_ONE_PROVIDER_KEY as "ok"

  Scenario: The generated types match the schema
    When `vp run codegen` runs
    Then env.d.ts declares the three keys as optional strings and AT_LEAST_ONE_PROVIDER_KEY as a string

  # Checks that need no Cloudflare account

  Scenario: Builds, checks, and tests never touch 1Password
    Given a machine with no 1Password app, or one where the app is locked
    When `vp run build`, `vp check`, and `vp test` run
    Then each succeeds without a 1Password prompt

  # Manual, on a scratch Worker named dm3000-scratch-check
  # Run `vp run build` first, and log in with `vp exec wrangler login`. Every command below passes
  # `--name dm3000-scratch-check` (to `wrangler secret list`, `wrangler delete`, and to `vp run deploy:varlock`).

  Scenario: A Varlock dry run resolves the schema and uploads nothing
    Given `vp run build` has run
    When `vp run deploy:varlock --dry-run --name dm3000-scratch-check --outdir <directory>` runs
    # Not yet observed: confirm the dry-run output shows no key value.
    Then Varlock resolves the schema through 1Password
    And Wrangler reports the Worker's size and uploads nothing
    And the output names AT_LEAST_ONE_PROVIDER_KEY and the provider keys without their values

  Scenario: Only TypeSafe present in the vault, deployed
    Given the vault item holds a value for TYPESAFE_API_KEY and none for SUBQ_API_KEY and OPENAI_API_KEY
    # Without changing the vault item: copy .env.schema over
    # itself with the SUBQ and OPENAI field names changed to ones that do not exist, run the deploy, then restore the file.
    When `vp run deploy:varlock --name dm3000-scratch-check` runs
    Then the output says "Deploying with varlock: 1 var, 1 secret"
    And `vp exec wrangler secret list --name dm3000-scratch-check` shows TYPESAFE_API_KEY and __VARLOCK_ENV, and no other provider key
    And `GET /api/providers` on the deployed URL lists only TypeSafe (after Access or the opt-out is set up, see docs/deploy.md section 2)

  Scenario: A key added to the vault and a redeploy
    Given the Worker from the previous scenario
    When the schema (or the vault item) gains a value for SUBQ_API_KEY and `vp run deploy:varlock --name dm3000-scratch-check` runs again
    Then `GET /api/providers` lists TypeSafe and SubQ

  Scenario: No provider key stops the deploy before anything is uploaded
    Given a schema in which all three keys point at missing fields
    When `vp run deploy:varlock --name dm3000-scratch-check` runs
    Then it exits 1 with a message that names AT_LEAST_ONE_PROVIDER_KEY and "Failed to resolve environment variables"
    And Wrangler never starts, so `wrangler secret list` and `wrangler versions list` for the Worker are unchanged

  Scenario: The check item arrives as a plain variable and no key does
    Given a Varlock deploy to the scratch Worker succeeded
    When the Worker's bindings are listed (for example in the deploy output or the dashboard's Variables and Secrets tab)
    Then AT_LEAST_ONE_PROVIDER_KEY is present with the value `ok`
    And no provider key appears as a plain variable
    And Wrangler labels the Varlock-uploaded secrets "Environment Variable" although `wrangler secret list` shows them as secret_text

  Scenario: A secret removed from the vault stays on the Worker
    Given a deployed key that was then removed from the vault item
    When `vp run deploy:varlock --name dm3000-scratch-check` runs again
    Then `wrangler secret list` still shows the removed key (dmno-dev/varlock#1212)
    And `vp exec wrangler secret delete SUBQ_API_KEY --name dm3000-scratch-check` removes it

  Scenario: A hand-set protection secret survives a Varlock deploy
    Given ALLOW_UNPROTECTED_INSTANCE was set with `wrangler secret put` and is not in .env.schema
    When `vp run deploy:varlock --name dm3000-scratch-check` runs
    Then `wrangler secret list` still shows ALLOW_UNPROTECTED_INSTANCE

  # Manual, with the dev server (Chrome)

  Scenario: vp dev gets its keys from Varlock
    Given the real .env.schema and the 1Password app unlocked
    When `vp dev --port 5199 --strictPort` starts
    Then 1Password is asked once, `GET /api/providers` lists every provider whose field holds a value, and a run on a listed provider succeeds

  Scenario: vp dev with no provider key shows Varlock's validation error
    Given a schema in which all three keys point at missing fields
    When `vp dev --port 5199 --strictPort` starts
    Then the terminal prints Varlock's "Configuration is currently invalid" error naming AT_LEAST_ONE_PROVIDER_KEY
    And the page answers with Varlock's error page, not a working app
    # The Varlock plugin logs this and serves an error page for non-API paths; it does not exit the process (dist/dist-*.mjs reloadConfig).
