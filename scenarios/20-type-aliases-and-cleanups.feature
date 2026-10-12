Feature: Type aliases over interfaces, enforced by lint, and small cleanups

  Scenario: Lint enforces type aliases
    Given "typescript/consistent-type-definitions" is set to ["error", "type"] in vite.config.ts
    When I run "vp check"
    Then it passes with no warnings, lint errors, or type errors

  Scenario: No unjustified interfaces remain
    Given a search of src and server for interface declarations
    When it runs
    Then none remain, except ones with an oxlint-disable-next-line typescript/consistent-type-definitions comment and a reason

  Scenario: The test count does not drop
    Given the suite had 156 passing tests before this change
    When I run "vp test"
    Then at least 156 tests run and all pass

  Scenario: Criteria key order does not stop a fan-out from collapsing
    Given six per-film questions whose criteria hold the same keys in different order
    When toViewModel builds the model
    Then the questions collapse into one question that fans out over "films"

  Scenario: Criteria that differ in value stay separate questions
    Given per-film questions whose criteria differ in one description
    When toViewModel builds the model
    Then the questions do not collapse

  Scenario: Non-numeric legend keys sort after numeric ones
    Given legend keys "2", "x", and "0"
    When scoreLevels sorts them
    Then the order is "0", "2", "x"

  Scenario: Loading a stored JSON preference does not write storage
    Given localStorage holds "json" for the score panel
    When the page loads and setupPanels runs
    Then localStorage.setItem was not called
    And the score panel shows the JSON view

  Scenario: Switching views still stores the preference
    Given a panel in the tree view
    When I click its JSON button
    Then localStorage holds "json" for that panel
