Feature: A provider catalog drives validation limits, and refusals render

  Scenario: A refusal answer renders as a sentence
    Given an answer { type: "refusal" }
    When the readout renders it
    Then the question shows "The model declined to answer this question."
    And no bars are shown

  Scenario: A response with a refusal answer is recognised
    Given a successful response whose only answer is { type: "refusal" }
    When the client checks its shape
    Then it is accepted as a decision response

  Scenario: A score limit comes from the capabilities
    Given capabilities with scoreLevels.max = 10
    When a request has 11 levels
    Then validation fails with a message naming 10

  Scenario: No score limit means no failure
    Given capabilities with scoreLevels.max undefined
    When a request has 11 levels
    Then validation passes

  Scenario: The question-name limit comes from the capabilities
    Given a question id of 101 characters
    When it is validated with the SubQ capabilities
    Then validation fails naming the 100-character limit

  Scenario: A provider with no question-name limit accepts the same id
    Given the same question id of 101 characters
    When it is validated with the TypeSafe capabilities
    Then validation passes

  Scenario: Provider names appear only in the catalog
    Given any rendered string in the UI
    When it is searched for "Jev" or "TypeSafe"
    Then only the provider display names in src/providers/catalog.ts contain them

  Scenario: Warm paths are declared per provider and are optional
    Given the TypeSafe descriptor
    When it is read
    Then it declares "/v1/models" as its warm path
    And SubQ declares "/v1/models" and OpenAI declares "/v1/models/gpt-6-luna"
    And a descriptor with no warmPath field is valid

  Scenario: The catalog records the spike findings
    Given the three descriptors
    When their capabilities are read
    Then every provider allows 255 choice options and score levels from 2 to 10
    And TypeSafe accepts no images
    And SubQ and OpenAI cap an image and a request at 64 KiB each
    And the pinned models are jev-1.13.0, subq-snap-preview, and gpt-6-luna
