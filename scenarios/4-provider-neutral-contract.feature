Feature: The contract is provider-neutral and keeps the shared vocabulary

  Scenario: The Yes/no panel's JSON keeps its primitive
    Given the Yes/no panel's JSON view
    When it renders the example
    Then the document still has "primitive": "noul"

  Scenario: A successful answer renders as before
    Given a successful answer { type: "noul", noul: 0.9 }
    When the readout renders it
    Then the bar shows 0.90 with its existing hidden label

  Scenario: No rendered string names a provider
    Given any string rendered in the UI
    When it is searched for "Jev" or "TypeSafe"
    Then no match is found in the page, the readout, the composer, or validation messages

  Scenario: Existing examples validate unchanged
    Given the three example requests
    When they are validated
    Then all of them validate, with no edit to their primitive or noul fields

  Scenario: The old identifiers are gone
    Given a search of src and server
    When it runs for JevRequest, JevSuccess, JevFailure, validateJevRequest, ValidJevRequest, and JEV_ENDPOINT
    Then nothing is found
    And nothing imports from src/jev/

  # Superseded by #8, which removed /api/jev.
  Scenario: The server compiles against src/decision
    Given server/jev-api.ts after the move
    When it is type-checked
    Then it compiles against src/decision/ with no import of src/jev/

  # Superseded by #8, which removed /api/jev.
  Scenario: All three panels still answer through the server
    Given the middleware with a stubbed SDK call
    When a noul, choice, and score example are each posted to /api/jev
    Then each gets a 200 response in the contract shape
    And running vp dev and pressing run on each panel remains a manual check for the owner

  Scenario: No interface declaration remains in the contract files
    Given src/decision/contract.ts and src/decision/validate.ts
    When they are searched for "interface "
    Then nothing is found
