# Manual QA guide for spike #1. These scenarios are not automated: most of them
# deploy to a real Cloudflare account, read secrets from 1Password, or press the
# Deploy to Cloudflare button in a browser, so a person runs them by hand.
# The commands and the recorded results are in docs/spikes/worker-toolchain.md.
# The spike's code, including worker/spike/encode-bench.ts, is on the branch
# issue-1-worker-toolchain-spike, not on main.
# Deploy only to scratch Worker names, never to "decisionmachines3000", and delete
# the scratch Workers afterwards.

Feature: Run a Cloudflare Worker from the Vite+ project
  The spike checks that @cloudflare/vite-plugin and @varlock/cloudflare-integration
  can serve, build, and deploy the Worker in worker/ from this repository.

  Scenario: vp dev runs the Worker runtime or records why it cannot
    Given the spike branch
    When "vp dev --port 5199 --strictPort" runs
    Then either @cloudflare/vite-plugin runs the Worker runtime inside the dev server (path A), or the failure is recorded with its error text (path B, where only server/vite-host.ts serves /api/*)

  Scenario: The build deploys and serves the UI and the provider list
    Given the spike branch
    When "vp run build" and "vp exec wrangler deploy --name <scratch name>" run
    Then the deployed URL serves the UI
    And "GET /api/providers" on the deployed URL answers with JSON

  Scenario: One secret lists one provider and never leaks its value
    Given one secret set on the scratch Worker
    When "GET /api/providers" is called
    Then the response lists that provider
    And no secret value appears in the response, the deploy output, or "wrangler tail" logs

  Scenario: A 1Password-resolved value reaches the local Worker
    Given varlockCloudflareVitePlugin() is configured in vite.config.ts
    When "vp dev" runs and 1Password resolves the key
    Then "GET /api/providers" on the dev server lists the provider for that key, or the failure is recorded

  Scenario: The Deploy button with one key blank
    Given a public throwaway clone with a .dev.vars.example listing three keys
    When the Deploy button form is submitted with one key filled and the others blank
    Then the outcome, accepted or refused, is recorded
    And if it is refused, whether a placeholder value is accepted instead is recorded

  Scenario: Sensitive items are readable without the init import
    Given a Worker deployed with "varlock-wrangler deploy"
    When the Worker reads env.TYPESAFE_API_KEY without importing @varlock/cloudflare-integration/init
    Then the value is present, or the required import is recorded

  Scenario: Unknown API paths get the Worker's JSON 404
    Given assets.run_worker_first is ["/api/*"]
    When "GET /api/x" is requested
    Then the Worker answers with status 404 and a JSON body
    And the single-page-app fallback is not served

  Scenario: The result document records the toolchain facts
    Given docs/spikes/worker-toolchain.md
    When it is read
    Then it records the import path of varlockCloudflareVitePlugin
    And it records the inbound request body limit from the Workers limits page
    And it records the chosen Worker types package and the worker/tsconfig.json settings

  Scenario: Check and test never wait on 1Password
    Given the spike branch
    When "vp check" and "vp test" run
    Then neither waits on a 1Password prompt

  Scenario: The result document records the hosting choice
    Given docs/spikes/worker-toolchain.md and docs/adr/0001-worker-hosting.md
    When they are read
    Then they name the chosen path, A or B
    And they state that dev serving uses server/vite-host.ts in both cases
    And they record whether nodejs_compat was needed

  Scenario: An 8 MiB multipart body with two images fits a recorded plan
    Given the bench Worker in worker/spike/encode-bench.ts is deployed to a scratch name
    When it receives an 8 MiB multipart body with two images and encodes them with the native encoder
    Then the CPU time and peak memory are recorded in the result document
    And they fit within the Free plan's limits, or the document states which plan is required

  Scenario: The result document names the encoder and the limits source
    Given docs/spikes/worker-toolchain.md
    When it is read
    Then it names the native base64 encoder used
    And it links the Cloudflare limits page it read

  Scenario: The result document records the secret facts for the deploy-time key check
    Given docs/spikes/worker-toolchain.md
    When it is read
    Then it records whether "wrangler secret put" works before the first deploy
    And it records the exact "wrangler secret list" invocation a script can parse
    And it records whether a Deploy-button build can list its secrets

  Scenario: An extra secret and varlock-wrangler deploy
    Given an extra secret set with "wrangler secret put" on the scratch Worker
    When "varlock-wrangler deploy" runs
    Then the result document records whether that secret still exists afterwards
