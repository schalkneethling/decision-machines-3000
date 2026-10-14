Feature: The TypeSafe adapter translates the neutral request to the wire and back as pure functions

  Background:
    Given worker/providers/adapter.ts exports the ProviderAdapter type, ProviderError, and fetchJson
    And worker/providers/typesafe.ts exports toWire, fromWire, decide, and an adapter object
    And worker/providers/typesafe-schema.ts holds Zod Mini schemas for the decision reply, the error envelope, and the warm reply
    And the TypeSafe catalog descriptor pins the model "jev-1.13.0" and names the provider "TypeSafe Jev"

  Scenario: A Yes/no request becomes a wire request with the pinned model
    Given a neutral request with primitive "noul" and a question "escalate"
    When toWire runs
    Then questions.escalate.type is "noul"
    And questions.escalate.instructions and criteria are unchanged
    And model is "jev-1.13.0", taken from the catalog descriptor
    And model is never the "jev-latest" the fixtures were recorded with

  Scenario: A question without its own criteria inherits the request default
    Given a Choice request with a default "criteria" and a question that omits its own
    When toWire runs
    Then the wire question carries the default criteria
    And a question with its own criteria keeps them

  Scenario: Choice and Score pass straight through
    Given a Choice request and a Score request
    When toWire runs on each
    Then every wire question's type is the request's primitive
    And its instructions and criteria are the neutral ones unchanged

  Scenario Outline: A recorded success reply becomes a neutral decision
    Given the recorded reply body in fixtures/typesafe/<fixture>.json
    When fromWire runs with a request of the same primitive
    Then answers.<id> is the wire answer with its numbers passed straight through
    And model and usage are the recorded ones

    Examples:
      | fixture | id       |
      | noul    | escalate |
      | choice  | queue    |
      | score   | acuity   |

  Scenario: Every recorded fixture parses with its schema
    Given every file in worker/providers/fixtures/typesafe/
    When the file is matched to a schema by its request URL and status
    Then a 2xx systemone reply parses as a decision reply
    And a 2xx models reply parses as a warm reply
    And a failed reply parses as the error envelope { detail: { error_type, message } }

  Scenario: A deliberately broken copy fails at its dot path
    Given the noul fixture body with answers.escalate.noul changed to a string
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail starts with "answers.escalate.noul"

  Scenario: An unknown answer type is an error, never a silent drop
    Given a wire answer whose type is "mystery"
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail names "answers.<id>.type"

  Scenario: An answer for the wrong primitive is an error
    Given a Noul request and a wire reply whose answer has type "choice"
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail names "answers.<id>.type"

  Scenario: A refusal passes through
    Given a wire reply whose answer is { type: "refusal" }
    When fromWire runs
    Then answers.<id> is { type: "refusal" }

  Scenario: Unknown fields on the reply are stripped
    Given a wire reply with an extra top-level field and an extra field on an answer
    When fromWire runs
    Then neither field is present in the decision

  Scenario: decide sends the wire request with the injected fetch
    Given a stubbed fetch that answers the recorded noul reply
    When decide runs with a request, an API key, a signal, and that fetch
    Then the stub was called once with POST https://api.typesafe.ai/v1/systemone
    And the authorization header is "Bearer <key>" and the body is the toWire request
    And the signal passed to fetch is the one decide received
    And the result is the fromWire decision

  Scenario: A 401 is an auth error that names the provider and hides the key
    Given a stubbed upstream 401 with the recorded bad-key body
    When decide runs
    Then the error is a ProviderError of kind "auth"
    And its message contains "TypeSafe Jev rejected the API key"
    And its detail contains "401" and the envelope's error_type
    And neither the message nor the detail contains the key

  Scenario: A 429 carries Retry-After in seconds
    Given a stubbed upstream 429 with the header Retry-After: 7
    When decide runs
    Then the error is a ProviderError of kind "rate_limited"
    And its retryAfterSeconds is 7
    And its message says to wait 7 seconds

  Scenario Outline: Each failed status maps to its kind
    Given a stubbed upstream <status>
    When decide runs
    Then the error is a ProviderError of kind "<kind>"
    And its detail starts with "<status>"

    Examples:
      | status | kind            |
      | 403    | auth            |
      | 400    | invalid_request |
      | 422    | invalid_request |
      | 404    | upstream        |
      | 500    | upstream        |
      | 529    | upstream        |

  Scenario: An aborted exchange is a timeout
    Given a signal that aborts before fetch answers
    When decide runs
    Then the error is a ProviderError of kind "timeout"

  Scenario: A rejected fetch is unreachable
    Given a stubbed fetch that rejects with a network error while the signal is not aborted
    When decide runs
    Then the error is a ProviderError of kind "unreachable"
    And its detail is the network error's message

  Scenario: A success with a body that is not JSON is an upstream error
    Given a stubbed upstream 200 whose body is HTML
    When decide runs
    Then the error is a ProviderError of kind "upstream"

  Scenario Outline: A key that cannot travel in a header is refused before fetch is called
    Given an API key with <defect>
    When decide runs
    Then fetch is never called
    And the error is a ProviderError of kind "auth" that says the key contains characters that can't be sent
    And no part of the key appears in the message, the detail, or the cause

    Examples:
      | defect                 |
      | an interior line break |
      | a control character    |
      | a space                |

  Scenario: A transport failure is described by name and code, never by its message
    Given a stubbed fetch that rejects with a TypeError whose message quotes the key
    When decide runs
    Then the error is a ProviderError of kind "unreachable"
    And its detail is "TypeError", or "TypeError (ECONNREFUSED)" when the cause carries that code
    And its cause is only { name, code }
    And the key appears nowhere in the error

  Scenario: A rejection that is not an Error is described by its type
    Given a stubbed fetch that rejects with a string
    When decide runs
    Then the error is a ProviderError of kind "unreachable" with detail "string"

  Scenario: No redirect is followed
    Given any provider request
    When fetchJson sends it
    Then the request carries redirect: "error", so the key header never follows a redirect to another host

  Scenario Outline: Retry-After is read strictly and clamped
    Given a 429 whose Retry-After header is <value>
    When the error is built
    Then retryAfterSeconds is <seconds>

    Examples:
      | value                             | seconds   |
      | "7"                               | 7         |
      | "0"                               | 1         |
      | "99999999"                        | 3600      |
      | an IMF-fixdate 90 seconds ahead   | 90        |
      | an IMF-fixdate in the past        | 1         |
      | an IMF-fixdate a day ahead        | 3600      |
      | "" or "   " or "garbage 5"        | undefined |
      | "12,5" or "0x10" or "1e3" or "-0" | undefined |
      | "2026-10-14" (not an IMF-fixdate) | undefined |

  Scenario: A reply nested too deeply is an upstream error, not a crash
    Given the score fixture with a legend value nested 10,000 lists deep
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown with detail "body: nested too deeply"

  Scenario: The answers must be exactly the questions asked
    Given a reply with an answer for an id the request did not ask
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown with detail "answers.<id>: no question with this id"
    And a reply that leaves a question unanswered gives 'answers: no answer for question "<id>"'

  Scenario: Provider text in a detail is cut to about 300 characters
    Given an error envelope message, or an answer id, of 1,000 characters
    When it enters an error detail
    Then the detail holds at most 300 of its characters followed by an ellipsis

  Scenario: An adapter can override the kind and wording for a status
    Given a 429 reply and an override of kind "auth" with its own message
    When failureFromStatus runs
    Then the error has that kind and that message, and its detail still starts with "429"
    And an override to "rate_limited" still reads Retry-After

  Scenario Outline: Untested reply shapes are upstream errors
    Given a 2xx reply whose body is <body>
    When decide runs
    Then the error is a ProviderError of kind "upstream" with detail <detail>

    Examples:
      | body       | detail                                 |
      | empty      | "200: the body is empty"               |
      | JSON null  | "body: expected object, received null" |

  Scenario: An abort while the body is read is a timeout
    Given a stubbed fetch whose response body stream fails after the signal aborts
    When decide runs
    Then the error is a ProviderError of kind "timeout"

  Scenario: The SDK is a type dependency only
    Given a vi.mock of "@typesafe-ai/sdk" that records when it is loaded
    When the adapter module is imported and exercised
    Then the mock was never loaded
    And loading the SDK directly does trigger the mock, so the check is live

  Scenario: The adapter satisfies the adapter type
    Given the source of worker/providers/typesafe.ts
    When it is read
    Then the TypeSafe adapter object ends with "satisfies ProviderAdapter"
    And the lint rule typescript/consistent-type-definitions forbids any interface

  Scenario: Checks pass
    When vp check, vp test, and vp run build run
    Then all three pass
