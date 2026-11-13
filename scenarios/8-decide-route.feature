Feature: POST /api/decide/{provider} runs a provider end to end through its adapter

  Background:
    Given worker/handler.ts answers every /api request for both the Worker and the Node dev host
    And the TypeSafe adapter from #7 is the only adapter so far
    And the catalog pins TypeSafe Jev to the model "jev-1.13.0" and gives it a base URL
    And deps.fetch is a stub, so no test reaches a provider

  Scenario: A Yes/no request is answered by TypeSafe
    Given a valid Yes/no request with a question "q"
    And the stubbed fetch returns the recorded Jev noul reply
    When POST /api/decide/typesafe is handled
    Then the response is 200 with a DecisionSuccess
    And answers.q.type is "noul"
    And provider is "typesafe"
    And wire.request.questions.q.type is "noul"
    And wire.request.model is "jev-1.13.0", taken from the catalog
    And the body has no connection or keepAliveSeconds field
    And exactly one upstream call was made

  Scenario: An unknown provider is a 404 naming the id
    When POST /api/decide/nope is handled
    Then the response is 404
    And the error names "nope"
    And no upstream call was made

  Scenario: A provider id that equals the key placeholder is not echoed
    Given a key is set to the placeholder that Varlock treats as a sensitive value
    When POST /api/decide/unset is handled
    Then the response is 404
    And the body does not contain the placeholder

  Scenario: A known provider without a key is a 409 naming the variable
    Given no OPENAI_API_KEY
    When POST /api/decide/openai is handled
    Then the response is 409
    And the error names OPENAI_API_KEY
    And no upstream call was made

  Scenario: The upstream rejects the key
    Given the stubbed upstream returns 401 with TypeSafe's error envelope
    When POST /api/decide/typesafe is handled
    Then the response is 502
    And the error says "TypeSafe Jev rejected the API key"
    And detail contains "401" and not the key

  Scenario: The upstream rate limits the request
    Given the stubbed upstream returns 429 with Retry-After: 7
    When POST /api/decide/typesafe is handled
    Then the response is 429
    And the error says to wait 7 seconds
    And the response carries Retry-After: 7

  Scenario Outline: Every provider error kind has one status
    Given the adapter fails with a ProviderError of kind <kind>
    When POST /api/decide/typesafe is handled
    Then the response status is <status>

    Examples:
      | kind            | status |
      | invalid_request | 422    |
      | rate_limited    | 429    |
      | no_credits      | 402    |
      | auth            | 502    |
      | upstream        | 502    |
      | unreachable     | 502    |
      | timeout         | 504    |

  Scenario: One timeout budget and no retries
    Given the stubbed upstream never resolves
    When 25 seconds elapse on a fake clock
    Then the response is 504
    And exactly one upstream call was made

  # Review of #8: the limit is what one request needs, 64 KiB of images plus 256 KiB of
  # text, not the 100 MB Cloudflare accepts, which a 128 MB isolate cannot hold.
  Scenario: A body over the limit is refused before any upstream call
    Given a body larger than 64 KiB of images plus 256 KiB of text
    When POST /api/decide/typesafe is handled
    Then the response is 413 with a message that states the limit in plain words
    And reading stopped once the limit was passed
    And no upstream call was made

  Scenario Outline: The limit is exact
    Given a body of <size>, sent with <how>
    When POST /api/decide/typesafe is handled
    Then the response is <status>

    Examples:
      | size                     | how                   | status |
      | one byte under the limit | a declared length     | 200    |
      | exactly the limit        | a declared length     | 200    |
      | one byte over the limit  | a declared length     | 413    |
      | one byte under the limit | a stream and no length | 200   |
      | exactly the limit        | a stream and no length | 200   |
      | one byte over the limit  | a stream and no length | 413   |

  Scenario: The dev host stops reading at the same limit
    Given the Node dev host
    When a body one byte over the limit arrives, with or without a declared length
    Then it answers the Worker's own JSON 413 without calling the handler
    And it drains the rest, so the next request on the server is answered

  Scenario: A body that is not valid UTF-8 is refused
    Given a JSON body with an invalid byte inside a string
    When POST /api/decide/typesafe is handled
    Then the response is 400 saying the body is not valid UTF-8

  Scenario: An error no route answers is still a JSON 500
    Given a body stream that fails mid-read, or a dependency that throws
    When the request is handled
    Then the response is a JSON 500
    And the log names only the error's class

  Scenario: No answer quotes the request's path or an unknown method
    Given a key set to the placeholder that Varlock treats as sensitive
    When GET /api/unset or GET /api/decide/unset is handled
    Then the 404 or 405 body does not contain the placeholder
    And a 405 names the method only when it is a standard one

  Scenario: Images are replaced by placeholders in the wire record
    Given a request carrying a fake image with a large base64 value
    When the route builds wire.request
    Then it calls the adapter's toWire a second time on a copy of the request
    And the image field holds a placeholder like "<image 1: image/png, 230 KB>"
    And the request sent upstream still holds the real base64 value
    And no adapter source contains image redaction code

  Scenario: Text that is not JSON is refused
    # multipart/form-data was accepted until images moved into the JSON (scenarios/15-server-images.feature).
    When a text/plain or multipart/form-data body is posted
    Then the response is 415
    And the error names application/json and says images go as base64 in its "images" list

  Scenario: Invalid input is a 400 with the validator's own message and path
    When a request that fails validation is posted
    Then the response is 400
    And error and detail are exactly what validateDecisionRequest returns

  Scenario: A reply the schema rejects is logged in English
    Given the Worker module has loaded, turning on Zod's English locale
    And the stubbed upstream returns a reply whose usage.output_tokens is a string
    When POST /api/decide/typesafe is handled
    Then the response is 502 with the dot path in detail
    And the log line contains "Invalid input: expected number, received string"

  Scenario: Other /api paths stay JSON 404s
    When GET /api/decide or POST /api/decide/typesafe/extra is handled
    Then the response is a JSON 404 with no CORS headers

  Scenario: The browser tells a non-JSON answer from an unreachable endpoint
    Given the browser receives a 502 HTML page
    When the readout renders
    Then it says the endpoint answered with a body that is not JSON
    And it does not say "could not reach"
    And no readout message mentions vp dev

  Scenario: The browser asks the provider by id
    When a panel runs
    Then askProvider("typesafe", body) posts the JSON unchanged to /api/decide/typesafe

  Scenario: The old /api/jev middleware is gone
    Then server/jev-api.ts no longer exists
    And no plugin or middleware mounts /api/jev
    And server/connection.ts and its tests still exist

  # Manual check, run by the coordinator, because vp dev may prompt 1Password.
  Scenario: The dev host answers a run end to end
    Given vp dev --port 5199 --strictPort with TYPESAFE_API_KEY resolved
    When Run is pressed on the Yes/no panel
    Then server/vite-host.ts serves POST /api/decide/typesafe through handle
    And the readout shows "Answered by TypeSafe Jev (jev-1.13.0) in N ms using N input tokens."
    And the warm form is hidden until #9 brings the warm route back
