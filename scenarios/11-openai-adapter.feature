Feature: The OpenAI Decisions adapter translates the neutral map of questions to OpenAI's array of named questions and back

  Background:
    Given worker/providers/openai.ts exports toWire, fromWire, decide, and an adapter object that ends with "satisfies ProviderAdapter"
    And worker/providers/openai-schema.ts holds Zod Mini schemas for the decision reply, the error envelope, and the warm reply
    And the OpenAI catalog descriptor pins the model "gpt-6-luna", names the provider "OpenAI Decisions", and has the base URL https://api.openai.com
    And the fixtures in worker/providers/fixtures/openai/ were recorded by spike #2

  # --- toWire -------------------------------------------------------------

  Scenario: A Yes/no request becomes a predicate question with its meanings appended
    Given a neutral request with primitive "noul" and a question "escalate" with criteria { true: "A", false: "B" }
    When toWire runs
    Then questions is an array with one item { type: "predicate", name: "escalate", instructions: "<instructions>\n\nYes means: A\nNo means: B" }
    And "No means" is on its own line
    And model is "gpt-6-luna", taken from the catalog descriptor

  Scenario Outline: A Yes/no question appends only the meanings it has
    Given a Yes/no question whose criteria are <criteria>
    When toWire runs
    Then its instructions are <instructions>

    Examples:
      | criteria                 | instructions                          |
      | { true: "A" }            | "<instructions>\n\nYes means: A"      |
      | { false: "B" }           | "<instructions>\n\nNo means: B"       |
      | absent                   | "<instructions>" unchanged            |
      | the request default      | the default's meanings appended       |

  Scenario: A blank meaning is skipped
    Given a Yes/no question whose criteria are { true: "", false: "B" }
    When toWire runs
    Then its instructions are "<instructions>\n\nNo means: B"
    And criteria whose meanings are both blank leave the instructions unchanged

  Scenario: A score request's string levels become labels, and anything else becomes a numbered level
    Given a score request whose levels are ["Low", { tier: "mid" }, null]
    When toWire runs
    Then levels is [{ label: "Low" }, { label: "Level 1", description: "{\"tier\":\"mid\"}" }, { label: "Level 2" }]
    And the number in the label is the level's index, which is the key the neutral legend uses and the value OpenAI reports

  Scenario: Every level label is unique and non-blank
    Given a score request whose levels are ["Level 1", { x: 1 }, "Low", "Low", "", "   ", "Low"]
    When toWire runs
    Then the labels are "Level 1", "Level 1 (1)", "Low", "Low (3)", "Level 4", "Level 5", "Low (6)"
    And a blank string level is labelled by its index
    And a label that repeats an earlier one gets " (<index>)" appended
    And fromWire still reads the levels by index, so the legend is unchanged

  Scenario: A choice request's criteria map becomes choices, with null descriptions omitted
    Given a choice request with criteria { nurse_line: "Needs a nurse today", front_desk: null }
    When toWire runs
    Then choices is [{ value: "nurse_line", description: "Needs a nurse today" }, { value: "front_desk" }]
    And a question without its own criteria uses the request default

  Scenario: Text OpenAI needs as a string is sent as a string
    Given a request whose state, instructions, or description is an object or a list
    When toWire runs
    Then the field holds the value's JSON text
    And a string stays as it is

  Scenario: toWire rebuilds the recorded requests
    Given the three neutral requests that match the three questions in fixtures/openai/three-types.json
    When toWire runs on each
    Then each wire question equals the recorded question at the same position, and input equals the recorded input

  Scenario: Two images make input one user message
    Given a request with a text state and two PNG images
    When toWire runs
    Then input is one user message whose content is [input_text, input_image, input_image]
    And each image_url starts with "data:image/png;base64,"
    And a request without images sends input as a string

  Scenario: The wire request has only model, input, and questions
    When toWire runs on any request
    Then the keys of the result are model, input, and questions

  # --- fromWire -----------------------------------------------------------

  Scenario: The recorded choice answer becomes a record of probabilities
    Given the recorded choice answer "queue" from fixtures/openai/three-types.json, whose probabilities are [{ value, probability }]
    When fromWire runs with a choice request asking "queue"
    Then answers.queue is { type: "choice", choice: "nurse_line", confidence: 1, probabilities: { nurse_line: 1, primary_care: 0, pharmacy: 0, front_desk: 0 } }

  Scenario: The recorded score answer gets its legend from the request
    Given the recorded score answer "acuity" from fixtures/openai/three-types.json
    When fromWire runs with a score request whose levels are ["Within a week", "Within a day", "Within an hour"]
    Then answers.acuity.legend is { "0": "Within a week", "1": "Within a day", "2": "Within an hour" }
    And answers.acuity.probabilities is { "0": 0, "1": 0.1, "2": 0.9 }, keyed by String(value)

  Scenario: The recorded predicate answer becomes a Noul answer
    Given the recorded predicate answer "escalate" with probability 0.98
    When fromWire runs with a Yes/no request asking "escalate"
    Then answers.escalate is { type: "noul", noul: 0.98 }
    And usage is { input_tokens: 436, output_tokens: 0 }, the two fields the contract carries

  Scenario: A refusal passes through and the other answers stay intact
    Given a reply whose answers are [{ type: "refusal", name: "q1" }, { type: "predicate", name: "q2", probability: 0.5 }]
    When fromWire runs with a Yes/no request asking q1 and q2
    Then answers.q1 is { type: "refusal" } and answers.q2 is { type: "noul", noul: 0.5 }
    And the refusal is synthetic, because no recorded fixture holds one
    And a refusal on a Choice question and on a Score question passes through the same way

  Scenario: The answers come back in the request's order
    Given a Yes/no request asking "escalate", "urgent", and "later"
    And a reply whose answers are ordered "later", "escalate", "urgent"
    When fromWire runs
    Then Object.keys(answers) is ["escalate", "urgent", "later"], because the UI renders the record in order

  Scenario: Every recorded 2xx decision reply reads through fromWire
    Given fixtures/openai/three-types, three-types-after-models-list, score-2-levels, score-10-levels, image-png-data-url, and image-jpeg-data-url
    When fromWire runs on each with the neutral request behind it
    Then each answer comes back typed as the request's primitive, with the pinned model and output_tokens 0
    And toWire rebuilds the recorded request of score-2-levels, score-10-levels, and both image fixtures

  Scenario: An answer whose name is not in the request is an upstream error naming it
    Given a reply with an answer named "stray"
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail is 'answers.0.name: no question named "stray"'

  Scenario Outline: The answers must be exactly the questions asked
    Given a reply that <defect>
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown with detail <detail>

    Examples:
      | defect                                  | detail                                             |
      | answers one question twice              | 'answers.1.name: a second answer for question "q"' |
      | leaves a question unanswered            | 'answers: no answer for question "q"'              |
      | answers a Yes/no question with a choice | 'answers.0.type: expected "predicate" or "refusal", received "choice"' |

  Scenario: A choice or score answer without confidence cannot fill the contract
    Given a recorded choice answer with its confidence removed
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown with detail "answers.0.confidence: expected number, received undefined"

  Scenario: Every recorded fixture parses with its schema
    Given every file in worker/providers/fixtures/openai/
    When the file is matched to a schema by its status and request URL, and exactly one selector claims each file
    Then a 2xx decisions reply parses as a decision reply
    And a 2xx models reply, the list and the single model alike, parses as a warm reply
    And a failed reply parses as the error envelope { error: { message, type, param, code } }

  Scenario: A deliberately broken copy fails at its dot path
    Given the three-types body with answers[2].probabilities[1].probability changed to a string
    When fromWire runs
    Then a ProviderError of kind "upstream" is thrown
    And its detail is "answers.2.probabilities.1.probability: expected number, received string"

  Scenario: Unknown fields on the reply are stripped
    Given a reply with usage.total_tokens, usage.input_tokens_details, and an extra field on an answer
    When fromWire runs
    Then none of them is present in the decision

  # --- decide ---------------------------------------------------------------

  Scenario: decide posts the wire request to /v1/decisions with the injected fetch
    Given a stubbed fetch that answers a recorded reply
    When decide runs with a request, an API key, a signal, and that fetch
    Then the stub was called once with POST https://api.openai.com/v1/decisions
    And the authorization header is "Bearer <key>", the body is the toWire request, and redirect is "error"
    And the result is the fromWire decision

  Scenario: A bad key is recognised from the 401 status, because OpenAI sends code null
    Given a stubbed upstream 401 with the recorded bad-key body
    When decide runs
    Then the error is a ProviderError of kind "auth"
    And its detail is "401 invalid_request_error: A valid API key is required."
    And the key appears nowhere in the error

  Scenario: A refused request carries OpenAI's type, code, and param in the detail
    Given a stubbed upstream 400 with the recorded score-11-levels body
    When decide runs
    Then the error is a ProviderError of kind "invalid_request"
    And its detail starts with "400 invalid_request_error array_above_max_length at questions[0].levels: "

  Scenario Outline: A spent balance answered with 429 is no_credits, which the route answers with 402
    Given a stubbed upstream 429 whose envelope has <field>
    When decide runs
    Then the error is a ProviderError of kind "no_credits"
    And through POST /api/decide/openai the response is 402

    Examples:
      | field                             |
      | code "insufficient_quota"         |
      | type "insufficient_quota"         |
      | code "credit_balance_exhausted"   |

  Scenario: A 429 with code slow_down stays rate_limited
    Given a stubbed upstream 429 with code "slow_down" and Retry-After: 7
    When decide runs
    Then the error is a ProviderError of kind "rate_limited" with retryAfterSeconds 7
    And through POST /api/decide/openai the response is 429 with Retry-After: 7

  Scenario: A 402 is no_credits
    Given a stubbed upstream 402
    When decide runs
    Then the error is a ProviderError of kind "no_credits"

  Scenario: A 403 whose envelope names the region block is worded as such, not as a rejected key
    Given a stubbed upstream 403 whose envelope message says "Country, region, or territory not supported"
    When decide runs
    Then the error is a ProviderError of kind "upstream"
    And its message says OpenAI Decisions does not serve the region this server runs in
    And its detail starts with "403"
    And the envelope is synthetic, because the error guide lists this 403 without a code and no fixture holds one

  Scenario Outline: Any other 403 keeps the shared default, which is auth
    Given a stubbed upstream 403 whose body is <body>
    When decide runs
    Then the error is a ProviderError of kind "auth" with the message "OpenAI Decisions rejected the API key."
    And its detail starts with "403"

    Examples:
      | body                                                   |
      | an envelope for a key missing a scope                  |
      | HTML that is not the envelope                          |

  Scenario Outline: A reached spend or usage limit answered with 429 is no_credits, worded as a limit
    Given a stubbed upstream 429 whose envelope code is <code>
    When decide runs
    Then the error is a ProviderError of kind "no_credits"
    And its message says the project or organisation reached its spend limit
    And through POST /api/decide/openai the response is 402

    Examples:
      | code                                |
      | organization_spend_limit_exceeded   |
      | project_spend_limit_exceeded        |
      | organization_usage_limit_exceeded   |

  Scenario: A 429 with code rate_limit_exceeded stays rate_limited
    Given a stubbed upstream 429 with code "rate_limit_exceeded" and Retry-After: 12
    When decide runs
    Then the error is a ProviderError of kind "rate_limited" with retryAfterSeconds 12

  Scenario: Provider text in a detail is cut to about 300 characters
    Given an envelope message of 1,000 characters
    When it enters an error detail
    Then the detail holds at most 300 of its characters followed by an ellipsis

  Scenario: A 413 is a request OpenAI found too large
    Given a stubbed upstream 413
    When decide runs
    Then the error is a ProviderError of kind "invalid_request"
    And its message says to remove or shrink the images

  Scenario Outline: Other failed statuses map by status alone
    Given a stubbed upstream <status>
    When decide runs
    Then the error is a ProviderError of kind "<kind>"

    Examples:
      | status | kind            |
      | 400    | invalid_request |
      | 404    | upstream        |
      | 500    | upstream        |
      | 503    | upstream        |

  Scenario: A failed reply whose body is not the envelope is described by its status alone
    Given a stubbed upstream 502 whose body is HTML
    When decide runs
    Then the error detail is "502"

  # --- the route ------------------------------------------------------------

  Scenario: A configured OpenAI no longer answers 501
    Given OPENAI_API_KEY is set and the stubbed upstream answers a recorded reply
    When POST /api/decide/openai is handled
    Then the response is 200 with provider "openai", model "gpt-6-luna", and wire.request.questions[0].type "predicate"

  Scenario: The browser examples translate
    Given the Noul, Choice, and Score examples from src/decision/examples.ts
    When each is validated with OpenAI's capabilities and passed to toWire
    Then each produces one wire question per example question, typed predicate, choice, or score

  Scenario: Checks pass
    When vp check, vp test, and vp run build run
    Then all three pass

  # Manual check, run by the coordinator, because vp dev may prompt 1Password.
  Scenario: Live check against OpenAI Decisions
    Given vp dev --port 5199 --strictPort with OPENAI_API_KEY resolved and the 1Password prompt approved
    And the browser points at OpenAI Decisions
    When Run is pressed on each of the Noul, Choice, and Score panels with the loaded example
    Then each request's server log line reads status=200, and its latency is recorded
    And the readout reads "Answered by OpenAI Decisions (gpt-6-luna) in N ms using N input tokens."
    And the rendered verdicts are recorded, for example "Choice: …, with confidence …" and "Score: … on a scale of … to …"
    And the visible page names no provider except through the display name and the model id
    And each panel's JSON view still shows its primitive
    And the wire view of the Noul panel shows "Yes means:" and "No means:" inside the instructions of saw_in_theater
    And the Score panel's four levels are accepted, within OpenAI's maximum of 10
    And a refusal, if one appears, renders as "The model declined to answer this question."
    And the panels are switched back to the view they started in afterwards
