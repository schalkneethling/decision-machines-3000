Feature: A read-only wire view shows what was sent to the provider and what came back

  Background:
    Given the readout renders a successful DecisionSuccess
    And wire.request is the provider's own request body, built by its adapter's toWire
    And wire.response is the provider's reply body as the Worker read it, with the API key redacted by fetchJson

  Scenario: A Yes/no run on TypeSafe shows the TypeSafe body
    Given a successful Yes/no run on TypeSafe
    When the readout renders
    Then a details block "Sent to TypeSafe Jev" is open
    And it shows "type": "noul" and "model": "jev-1.13.0"
    And the block "Received from TypeSafe Jev" shows TypeSafe's own reply body, with "model" and "answers"

  Scenario: A Yes/no run on OpenAI shows the provider's own vocabulary
    Given a successful Yes/no run on OpenAI
    When the readout renders
    Then "Sent to OpenAI Decisions" shows the question as "type": "predicate"
    And it shows the "Yes means" and "No means" instructions
    And the panel JSON still shows "primitive": "noul"

  Scenario: An OpenAI body has input and named questions
    Given a successful run on OpenAI
    When the readout renders
    Then "Sent to OpenAI Decisions" shows "input" and a "questions" array whose items have "name" fields

  Scenario: A reply that quotes the API key arrives redacted
    Given a provider reply body that contains the API key
    When decide returns
    Then wire.response holds "[redacted]" in place of the key

  Scenario: The live region does not announce the JSON
    Given a run has finished, as a success or as a failure
    Then no details or pre element is inside the aria-live element
    And the wire view, or the failure's "Raw response" block, is in the sibling container

  Scenario: A provider reply that is too deep or too large is not shown
    Given a provider reply with a field nested more than 64 levels deep, or over 256 KiB of text
    When decide returns
    Then the answers are correct and the response is 200
    And wire.response is a placeholder that names the limit that was hit

  Scenario: The Authorization header never appears
    Given any successful response
    When the wire view renders
    Then neither block contains "Authorization"

  Scenario: The blocks are read-only and reachable
    Given the wire view is rendered
    Then each block is a details element with a summary and its text in pre and code
    And the live region announces the result, and the wire view sits beside it in its own container, silent

  # Manual step, run by the coordinator (needs vp dev, which needs 1Password).
  Scenario: Live check in Chrome
    Given vp dev --port 5199 --strictPort is running
    When I press Run on the Yes/no example
    Then "Sent to TypeSafe Jev" and "Received from TypeSafe Jev" both show, open
    And the Sent block shows "model": "jev-1.13.0" and no Authorization
    And Tab reaches each summary, and Enter or Space collapses and reopens it
    And a screen reader announces each summary as a collapsible, expanded control
