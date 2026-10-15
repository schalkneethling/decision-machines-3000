Feature: The SubQ Snap adapter translates the neutral request to SubQ's wire and back, and the route uses it

  Background:
    Given worker/providers/subq.ts exports toWire, fromWire, decide, and an adapter object that ends with "satisfies ProviderAdapter"
    And worker/providers/subq-schema.ts holds Zod Mini schemas for the decision reply, the error envelope, and the warm reply
    And the SubQ catalog descriptor pins the model "subq-snap-preview" and names the provider "SubQ Snap"
    And the adapter shares no code with the TypeSafe adapter beyond worker/providers/adapter.ts

  Scenario: The three-type request becomes SubQ's wire request
    Given a neutral request for each of the primitives noul, choice, and score
    When toWire runs on each
    Then the body holds exactly model, state, and questions
    And model is "subq-snap-preview", taken from the catalog descriptor
    And each question is keyed by its id with type, instructions, and criteria as the neutral request had them
    And a question without its own criteria inherits the request default

  Scenario: A request with images copies them without a data prefix
    Given a request with images of the shape { mediaType, base64, byteLength }
    When toWire runs
    Then images is copied as { mediaType, base64 } and nothing else
    And base64 is passed as it came, with no "data:" prefix added
    And a request without images has no images field

  Scenario: Checking the base64 rule belongs to image validation, not to toWire
    Given SubQ accepts only base64 matching ^[A-Za-z0-9+/]+={0,2}$
    Then rejecting a data URL or wrapped base64 is request validation, which issue #15 owns
    And toWire does not check or rewrite the string

  Scenario Outline: A recorded success reply becomes a neutral decision
    Given the recorded reply body in fixtures/subq/three-types.json
    When fromWire runs with the matching three-type request
    Then answers.<id> is the wire answer with its numbers passed straight through
    And the Yes/no answer is { type: "noul", noul } with no confidence
    And usage.output_tokens is 0, as the spike recorded

    Examples:
      | id       |
      | escalate |
      | queue    |
      | acuity   |

  Scenario: Every recorded fixture parses with its schema
    Given every file in worker/providers/fixtures/subq/
    When the file is matched to a schema by its request URL and status
    Then a 2xx systemone reply parses as a decision reply
    And a 2xx models reply parses as a warm reply
    And a failed reply parses as the error envelope { detail: { error_type, message } }

  Scenario: A deliberately broken copy fails at its dot path
    Given the three-types fixture body with answers.escalate.noul changed to a string
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail is "answers.escalate.noul: expected number, received string"

  Scenario: SubQ cannot refuse, so a refusal is an unreadable reply
    Given a wire reply whose answer is { type: "refusal" }
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail starts with "answers.<id>.type"

  Scenario: An answer for the wrong primitive, an extra answer, or a missing answer is an error
    Given a Noul request and a wire reply with a choice answer, an unasked id, or no answer
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown that names the place

  Scenario Outline: A failed status maps to an error kind and keeps SubQ's message in the detail
    Given a stubbed SubQ reply with status <status> and { detail: { error_type, message } }
    When decide runs
    Then a ProviderError of kind "<kind>" is thrown
    And its detail is the status followed by "error_type: message"
    And its message names "SubQ Snap"

    Examples:
      | status | kind            |
      | 401    | auth            |
      | 403    | auth            |
      | 402    | no_credits      |
      | 422    | invalid_request |
      | 429    | rate_limited    |
      | 500    | upstream        |

  Scenario: The route returns 422 with SubQ's message in the detail
    Given SUBQ_API_KEY is set and a stubbed SubQ reply of 422 with error_type "validation_error"
    When POST /api/decide/subq runs with a valid request
    Then the response status is 422
    And the response detail contains SubQ's message

  Scenario: The route returns 402 and names the provider
    Given SUBQ_API_KEY is set and a stubbed SubQ reply of 402
    When POST /api/decide/subq runs with a valid request
    Then the response status is 402
    And the response error says "SubQ Snap has no credit left on this account"

  Scenario: A configured SubQ no longer answers 501
    Given SUBQ_API_KEY is set
    When POST /api/decide/subq runs with a valid request and a stubbed success
    Then the response status is 200
    And the provider is "subq" and the model is "subq-snap-preview"
    And a provider with a key but no adapter, OpenAI until issue #11, still answers 501

  Scenario: The key never appears in an error
    Given a stubbed SubQ reply that quotes the API key in its error message
    When decide runs
    Then the detail holds "[redacted]" and not the key

  Scenario: Live check against the real SubQ (manual, run by the coordinator)
    Given the owner's SUBQ_API_KEY is available through 1Password and Varlock
    And "vp dev --port 5199 --strictPort" is running and the 1Password prompt is approved
    When the loaded example is run on each of the Noul, Choice, and Score panels with SubQ Snap selected
    Then each request logs "[api] decide provider="subq"" with status=200 and a latencyMs
    And the readouts show a verdict for each panel, for example "Choice: …, with confidence …"
    And the Noul answer carries no confidence
    And the raw response of each panel shows usage.output_tokens as 0
    And the visible page names no provider except through the display name "SubQ Snap" and the model id
    And each panel's JSON view still shows its primitive
    And the panels are switched back to the view they started in
    And the results are recorded in a pull request comment: log line, status, latency, and verdicts
