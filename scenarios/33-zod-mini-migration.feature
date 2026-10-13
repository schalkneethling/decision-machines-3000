Feature: The contract, the request validator, and the browser's response checks run on Zod Mini schemas

  Background:
    Given the request schema is built from a provider's capabilities with Zod Mini
    And the contract's types are inferred from the schemas

  Scenario: The existing validator tests pass unchanged
    Given src/decision/validate.test.ts as it was before the migration
    When it runs against the migrated validateDecisionRequest
    Then every test passes

  Scenario Outline: Every message and path of the spike's comparison set is kept
    Given the request case "<case>" from the spike's comparison tests
    When the migrated validator checks it
    Then the result has the message and the dotted path the hand-written validator returned

    Examples:
      | case                                   |
      | a request that is not an object        |
      | an unknown question key                |
      | a choice question without criteria     |
      | a 150-character question id, truncated |
      | a numeric level description            |

  Scenario: Valid requests come back unchanged
    Given a valid request from the spike's comparison tests
    When the migrated validator checks it
    Then the result is { ok: true, value } with the request unchanged

  Scenario: One schema is built per capabilities object
    Given a capabilities object
    When two requests are validated with it
    Then the request schema is built once and reused

  Scenario: The inferred types equal the hand-written contract
    Given the spike's compile-time assertions
    When they are applied to the inferred request and response types
    Then every assertion holds and the type check passes

  Scenario Outline: An array where an object is expected is rejected with today's message
    Given a request with a list at <position>
    When the migrated validator checks it
    Then validation fails with "<message start>"
    And the detail is "<path>"

    Examples:
      | position                    | message start                                                          | path                 |
      | the request                 | The request must be a JSON object                                      |                      |
      | the questions record        | Add a "questions" object with at least one question                    | questions            |
      | one question                | Question "q" must be an object with "instructions"                     | questions.q          |
      | default Noul criteria       | The default "criteria" must be an object with optional "true"          | criteria             |
      | a question's Noul criteria  | The "criteria" of question "q" must be an object with optional "true"  | questions.q.criteria |
      | default Choice criteria     | The default "criteria" must be an object that maps each option name    | criteria             |
      | a question's Choice criteria | The "criteria" of question "q" must be an object that maps each option | questions.q.criteria |

  Scenario Outline: An array where a response object is expected is rejected
    Given a decision response with a list at <position>
    When the browser checks it
    Then it is rejected

    Examples:
      | position         |
      | the response     |
      | usage            |
      | answers          |
      | one answer       |
      | probabilities    |
      | the score legend |
      | the warm response |

  Scenario: A response with a refusal answer is accepted
    Given a successful response whose answers include { type: "refusal" }
    When the browser checks it
    Then it is accepted

  Scenario: A malformed answer is rejected
    Given a successful response with an answer of an unknown type
    When the browser checks it
    Then it is rejected and the first issue is at answers.<id>.type

  Scenario: The provider-neutral guards still pass
    Given src/decision/neutral.test.ts and the rendered-text provider-name guard
    When they run
    Then they pass, and no interface is declared in the contract files
