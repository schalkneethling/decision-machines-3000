Feature: Live provider probes record sanitised fixtures and settle open questions

  These scenarios describe a spike that calls paid provider APIs. They are a manual QA guide
  for re-running `scripts/probe/run.mjs`. They are not automated, because they spend credit.
  The unit tests in `scripts/probe/probe.test.mjs` cover the probe's own logic with a fake fetch.

  Scenario: Fixtures contain real responses without secrets
    Given valid TypeSafe, SubQ, and OpenAI keys in the environment
    When the probe runs
    Then each fixture under worker/providers/fixtures/ holds the real response body
    And request ids, account ids, and every key value are removed
    And the run ends by printing "redaction check passed"

  Scenario: OpenAI's maximum number of score levels is recorded
    Given the OpenAI score probes with 2, 10, and 11 levels
    When they return
    Then the fixtures show 2 and 10 levels accepted and 11 levels rejected with status 400

  Scenario: SubQ's accepted image encoding is recorded
    Given the SubQ image probes with one-line base64, a data URL, and line-wrapped base64
    When they return
    Then the one-line base64 fixture shows an answer
    And the data URL and wrapped fixtures show the exact 422 message

  Scenario: Each provider's error envelope is recorded verbatim
    Given the bad-key and invalid-body probes for each provider
    When they return
    Then each fixture records the provider's status and error body, minus secrets

  Scenario: Warm paths are named with their status and latency
    Given the SubQ and OpenAI warm-path probes
    When they return
    Then the spike note names a lightweight GET endpoint for each provider with its status and latency
    Or it states that the provider has none

  Scenario: Latencies and token counts are reported
    Given a completed probe run
    When the spike note is read
    Then it lists the measured latency of each call per provider
    And the input and output token counts each provider reported
