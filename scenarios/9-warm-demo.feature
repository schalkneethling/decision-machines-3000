Feature: The warm-connection demo runs on the Node dev host and follows the selected provider

  ADR-0002 keeps the demo on the Node dev host (`vp dev`), because only Node can
  observe and control connection reuse. Both hosts call the same
  `handle(request, env, deps)`. The Node dev host passes a `fetch` from the shared
  undici pool in `server/connection.ts` and the pool itself as `deps.connections`;
  the Worker passes the global `fetch` and no `connections`, so it reports no
  connection metrics.

  Background:
    Given every provider descriptor in the catalog may declare a lightweight warm path
    And TypeSafe Jev warms with GET /v1/models
    And SubQ Snap warms with GET /v1/models
    And OpenAI Decisions warms with GET /v1/models/gpt-6-luna

  Scenario: The Worker host reports no connection metrics and hides the warm form
    Given the Worker host, whose dependencies carry no connection pool
    When GET /api/providers runs
    Then the body's "host.connectionMetrics" is false
    And the warm form is hidden

  Scenario: The Node dev host reports connection metrics and shows the warm form
    Given the Node dev host, whose dependencies carry the shared undici pool
    When GET /api/providers runs
    Then the body's "host.connectionMetrics" is true
    And the warm form is visible for a provider that declares a warm path

  Scenario: A run on the Node dev host says which connection it used
    Given the Node dev host and a completed run
    When the readout renders
    Then the metadata sentence ends with "over a new connection." or "over the warm connection."
    And the success body carries "connection" and "keepAliveSeconds"

  Scenario: A run through the Worker host says nothing about connections
    Given a run through the Worker host
    When the success body is read
    Then it has no "connection" field and no "keepAliveSeconds" field
    And the metadata sentence mentions neither

  Scenario: Warming TypeSafe goes through its warm route and the shared pool
    Given the warm form on the Node dev host with TypeSafe Jev selected
    When Warm is pressed
    Then the browser POSTs {"keepAliveSeconds": 4} to /api/warm/typesafe
    And the server calls GET https://api.typesafe.ai/v1/models through the shared undici pool
    And the status line says how long warming took and counts the keep-alive down

  Scenario: The Worker host refuses the warm route
    Given the Worker host
    When POST /api/warm/typesafe runs
    Then it answers 501 and says warming is only available on the Node dev host

  Scenario: A provider without a warm path hides the warm form
    Given a provider whose descriptor declares no warm path
    When it is selected
    Then its summary's "canWarm" is false
    And the warm form is hidden
    And the warm route answers 404 for it without calling the provider

  Scenario: The warm form follows the selected provider
    Given the warm form on the Node dev host
    When the selected provider changes from TypeSafe Jev to SubQ Snap
    Then the warm button's label names SubQ Snap
    And a countdown for TypeSafe Jev is cleared
    And pressing Warm POSTs to /api/warm/subq

  Scenario: The keep-alive options come from the contract alone
    Given a search of index.html, src, and server
    When it runs for the keep-alive values 4, 30, and 60 as option values
    Then they appear only in KEEP_ALIVE_SECONDS in src/decision/contract.ts, and in tests
    And index.html holds an empty keep-alive select that the UI fills

  Scenario: Checks, tests, and the build never load Varlock
    Given vite.config.ts loads the Varlock plugin only for vp dev and vp preview
    When vp check, vp test, and vp run build run
    Then none of them loads the Varlock plugin or waits on a 1Password prompt

  Scenario: The README teaches the cold-versus-warm lesson
    Given the README
    When it is read
    Then it explains, as prose, the 330 ms round trip, about 1.3 s cold, about 0.4 s warm, and Node's 4 s default keep-alive

  # Manual live check, run by the coordinator in Chrome. It needs 1Password.
  #
  # On the Node dev host:
  #  1. Run `vp dev --port 5199 --strictPort` and open http://localhost:5199/.
  #  2. In DevTools > Network, check that GET /api/providers answers
  #     "host": { "connectionMetrics": true } and each provider has "canWarm": true.
  #  3. With TypeSafe Jev selected, the form above the readout reads "Keep warm for"
  #     with the options "4 s, Node default", "30 s", and "60 s", and the button
  #     reads "Warm the TypeSafe Jev connection".
  #  4. Choose 30 s and press the button. Check that POST /api/warm/typesafe answers
  #     200 with "connection": "new" and "keepAliveSeconds": 30, and that the status
  #     line reads "Connection warmed in N ms. Warm for 30 s." and counts down.
  #  5. Within 30 s, press Run on the Noul panel. The readout's sentence ends with
  #     "over the warm connection." and the countdown restarts at 30 s.
  #  6. Wait until the status line reads "Connection is cold again.", run again, and
  #     check the sentence now ends with "over a new connection."
  #  7. Select SubQ Snap. The button reads "Warm the SubQ Snap connection" and the status line is
  #     empty. Press it and check that POST /api/warm/subq answers 200. Repeat for
  #     OpenAI Decisions (POST /api/warm/openai).
  #  8. In the terminal, each warm logs one line such as
  #     `[api] warm provider="subq" status=200 latencyMs=412 connection="new"`, and
  #     no line or response holds a key.
  #
  # On the Worker host:
  #  9. Run `vp run build`, then `vp preview`, and open the URL it prints.
  # 10. Check that GET /api/providers answers "host": { "connectionMetrics": false },
  #     that the warm form is not shown, and that a Run's sentence has no
  #     "connection" in it.
