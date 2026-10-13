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

  Scenario: The SDK is a type dependency only
    Given the source of worker/providers/typesafe.ts
    When it is searched for imports from "@typesafe-ai/sdk"
    Then every one is an "import type"

  Scenario: The adapter type is a type alias and the adapter satisfies it
    Given the sources of worker/providers/adapter.ts and typesafe.ts
    When they are read
    Then ProviderAdapter is declared with "type", no "interface" is declared
    And the TypeSafe adapter object ends with "satisfies ProviderAdapter"

  Scenario: Checks pass
    When vp check, vp test, and vp run build run
    Then all three pass
