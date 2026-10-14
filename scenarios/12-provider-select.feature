Feature: A provider select picks which configured provider Run asks

  Background:
    Given GET /api/providers lists the providers this instance has a key for
    And the select is a real <select> with a <label for>, filled from that list
    And browsers that support appearance: base-select style it, and every other browser shows the native select

  Scenario: The select lists exactly the configured providers, in catalog order
    Given /api/providers returns TypeSafe Jev and SubQ Snap
    When the page loads
    Then the select has exactly two options, in that order
    And each option shows the provider's name and model

  Scenario: A stored provider that is configured is selected
    Given localStorage holds the id "subq" under "decisionmachines3000:provider"
    And /api/providers returns TypeSafe Jev and SubQ Snap
    When the page loads
    Then SubQ Snap is selected

  Scenario: A stored provider that is not configured falls back to the first option
    Given localStorage holds the id "openai"
    And /api/providers returns TypeSafe Jev and SubQ Snap
    When the page loads
    Then TypeSafe Jev is selected
    And localStorage now holds "typesafe"

  Scenario: Storage that throws never breaks the select
    Given every localStorage read and write throws
    When the page loads and the user picks a provider
    Then the select still works and nothing throws

  Scenario: Run goes to the selected provider
    Given the user selects SubQ Snap
    When Run is pressed on the Score panel
    Then the POST goes to /api/decide/subq
    And the loading text says "Asking SubQ Snap…"

  Scenario: A provider change re-checks a panel's alert against the new limits
    Given a Score request with 11 levels
    And the selected provider's scoreLevels.max is 10
    And the panel shows an alert about the number of levels
    When the provider changes to one with no scoreLevels.max
    Then the panel's alert clears
    And Run is enabled

  Scenario: An instance with no provider key shows a setup notice
    Given /api/providers answers 503 because no provider key is set
    When the page loads
    Then a notice says the instance needs at least one of TYPESAFE_API_KEY, SUBQ_API_KEY, or OPENAI_API_KEY
    And the notice links the deployment guide
    And the notice is announced to assistive technology as an alert
    And the select is disabled
    And every Run button is disabled

  Scenario: A failed fetch can be retried
    Given the fetch for /api/providers fails
    When the page loads
    Then a note says the list of providers could not be loaded
    And the select and every Run button are disabled
    When the user presses Retry and the list loads
    Then the select is enabled with the providers and the Run buttons are enabled

  Scenario: Retry that fails again keeps the note and the focus on Retry
    Given the fetch for /api/providers fails
    When the user presses Retry and it fails again
    Then the note is shown again and Retry has focus

  Scenario: Without customizable-select support the control is still a plain select
    Given a browser without appearance: base-select support
    When the page renders
    Then the control is a <select> labelled by a <label for>
    And the options' text content reads "OpenAI Decisions gpt-6-luna", with a space between name and model

  Scenario: The status line is silent on page load
    When the page load completes without user action
    Then the role="status" line is empty

  Scenario: A user change is announced
    When the user changes the provider to SubQ Snap
    Then the role="status" line reads "Provider set to SubQ Snap." followed by the image capability sentence
    And the choice is stored

  Scenario: The vocabulary legend follows the selected provider
    When the user changes the provider to OpenAI Decisions
    Then the vocabulary legend lists the words OpenAI Decisions uses, such as predicate for a yes/no question

  Scenario: The notice names the same keys the Worker reports
    Given the Worker names three provider keys in its 503 message
    Then the setup notice names the same three keys

  # Manual step, run by the coordinator with all three keys set (needs `vp dev`, which needs 1Password).
  Scenario: Live check across all three providers in Chrome or Edge, then in Firefox
    Given all three provider keys are configured
    When, in Chrome or Edge, the user chooses TypeSafe Jev, SubQ Snap, and OpenAI Decisions in turn
    And presses Run on the Noul, Choice, and Score panels for each one (nine runs in all)
    Then each request's server log line shows /api/decide/{provider} for the selected provider with status 200
    And each result sentence names the selected provider
    And the selection persists across a reload
    And the picker is styled, and the keyboard opens it and moves through the options
    When the same is done in Firefox
    Then the native select shows each option as "name model" in plain text and works with the keyboard
    And in Safari 27 the picker is styled and the keyboard opens it and moves through the options
