Feature: The Worker accepts images as binary multipart parts, checks their real bytes, and encodes them once

  Background:
    Given POST /api/decide/{provider} accepts multipart/form-data with one "request" text part and one "image" file part per picture
    And the limits come from each provider's capabilities.images in src/providers/catalog.ts, never from new constants:
      | provider | maxCount | maxBytesPerImage | maxBytesPerRequest | mediaTypes                       |
      | typesafe | (none: text only)                                                                            |
      | subq     | 4        | 2 MiB            | 2 MiB              | image/png, image/jpeg, image/webp |
      | openai   | 8        | 2 MiB            | 2 MiB              | image/png, image/jpeg, image/webp |
    # The owner chose 2 MiB per image and 2 MiB per request on issue #15, instead of the Workers Paid plan.
    # That overrides the 4 MiB and 8 MiB figures the issue body gave for these scenarios.
    And no message names a part, a file name, or a declared type, because the client controls them (Varlock's leak scanner)
    And the fail-closed gate from #14 runs before the body is read, so none of this happens for a refused request

  Scenario: A text-only provider refuses images before any upstream call
    Given POST /api/decide/typesafe with a valid "request" part and one image part
    When it is handled
    Then the response is 400
    And the error says TypeSafe Jev evaluates text only
    And no upstream call is made

  Scenario: Too many images are refused with the limit named
    Given POST /api/decide/subq with five image parts
    When it is handled
    Then the response is 400
    And the error says the request has 5 images and SubQ Snap takes at most 4
    And no upstream call is made

  Scenario: OpenAI's own count is its limit
    Given POST /api/decide/openai with nine image parts
    When it is handled
    Then the response is 400
    And the error says OpenAI Decisions takes at most 8

  Scenario: One image over the per-image limit is refused before any provider call
    Given POST /api/decide/subq with one image part of 2 MiB + 1 byte
    When it is handled
    Then the response is 400
    And the error names "Image 1" and the limit of 2 MB per image
    And no upstream call is made

  Scenario: Images that together pass the per-request limit are refused
    Given POST /api/decide/openai with two image parts of 1 MiB + 1 byte each
    When it is handled
    Then the response is 400
    And the error names the limit of 2 MB per request
    And no upstream call is made

  Scenario: The media type comes from the bytes, not from the part
    Given an image part named "photo.png", declared as image/png, whose bytes are JPEG
    When POST /api/decide/subq is handled with a stubbed upstream
    Then the upstream body declares "image/jpeg"

  Scenario Outline: Each accepted format is recognised from its first bytes
    Given an image part whose bytes start with <signature>
    When POST /api/decide/subq is handled with a stubbed upstream
    Then the upstream body declares "<mediaType>"

    Examples:
      | signature                                       | mediaType  |
      | 89 50 4E 47 0D 0A 1A 0A (PNG)                   | image/png  |
      | FF D8 FF (JPEG)                                 | image/jpeg |
      | "RIFF", four size bytes, "WEBP"                 | image/webp |

  Scenario: Bytes of no accepted format are refused with the accepted formats named
    Given an image part whose bytes match none of PNG, JPEG, or WebP, including an empty file
    When POST /api/decide/subq is handled
    Then the response is 400
    And the error names "Image 1" and says it is not image/png, image/jpeg, or image/webp
    And no upstream call is made

  Scenario: A multipart body without a request part is refused
    Given a multipart body with image parts and no "request" part
    When it is handled
    Then the response is 400 saying the "request" part is required

  Scenario: Two request parts are refused
    Given a multipart body with two "request" parts
    When it is handled
    Then the response is 400 asking for exactly one "request" part

  Scenario: A request part that is a file is refused
    Given a multipart body whose "request" part is a file
    When it is handled
    Then the response is 400 saying the "request" part must be text

  Scenario: A part named anything else is refused without echoing the name
    Given a multipart body with a part named "notes"
    When it is handled
    Then the response is 400
    And the error does not contain "notes"

  Scenario: An image part that is text instead of a file is refused
    Given a multipart body whose "image" part is a plain string
    When it is handled
    Then the response is 400 saying each "image" part must be a file

  Scenario: A Content-Type without a boundary is refused, not a 500
    Given a body sent with a hand-set "Content-Type: multipart/form-data" and no boundary parameter
    When it is handled
    Then the response is 400 saying the boundary is missing
    And no 500 or uncaught TypeError occurs

  Scenario: A Content-Length over the body limit is refused before the body is read
    Given a Content-Length larger than MAX_BODY_BYTES
    When it is handled
    Then the response is 413 and the body stream is never read

  Scenario: A body over the limit with no Content-Length stops at the limit
    Given a streamed body larger than MAX_BODY_BYTES and no Content-Length header
    When it is handled
    Then reading stops once the count passes the limit
    And the response is 413
    And the body stream was read once, by the counting reader and by nothing else

  Scenario: The body limit is derived from the catalog, with room for the framing
    Then MAX_BODY_BYTES is the 256 KiB text allowance, plus the largest maxBytesPerRequest in the catalog, plus a 16 KiB framing allowance
    And a request with the most images and the most text the limits allow is not refused for its wrapping

  Scenario: Two images reach the upstream as base64 and the response holds placeholders
    Given POST /api/decide/subq with two valid image parts and a stubbed upstream
    When it is handled
    Then the upstream JSON carries both images as base64 that decodes back to the uploaded bytes, in order
    And wire.request.images holds two placeholders such as "<image 1: image/png, 230 KB>"
    And the response body is under 64 KiB and contains no base64 of the images

  Scenario: Three images are all validated and forwarded in order
    Given POST /api/decide/openai with three valid image parts and a stubbed upstream
    When it is handled
    Then the upstream input holds the text part and three input_image data URLs, in order

  Scenario: A request part with no images behaves as before
    Given a multipart body with only a "request" part
    When it is handled
    Then the response equals the answer to the same request as JSON

  Scenario: The log counts the images and never names them
    Given a request with two images
    When it is handled
    Then the log line holds images=2
    And it holds no file name, base64, or declared type

  # Manual checks. They need a running host, so the owner runs them.

  Scenario: Manual, in the dev host
    Given "vp dev --port 5199 --strictPort" is running with SUBQ_API_KEY set
    When the owner sends a multipart request with curl, for example:
      """
      curl -sS -H "Expect:" -F 'request=<request.json;type=application/json' -F 'image=@photo.jpg;type=image/png' http://localhost:5199/api/decide/subq
      """
    Then the answer is 200, and wire.request.images[0] shows an image/jpeg placeholder
    # Node 24 has no Uint8Array.prototype.toBase64, so the dev host uses the btoa fallback in worker/multipart.ts.

  Scenario: Manual, in the built Worker
    Given "vp run build" has run and "vp exec wrangler dev" serves the build with a provider key set
    When the owner sends the same curl request
    Then the answer is the same as in the dev host
    And the encoder is the native Uint8Array.prototype.toBase64

  Scenario: Manual, confirming the 2 MiB cap by CPU time (acceptance criterion added on issue #15)
    Given the real decide path is deployed to a scratch Worker (not the production one)
    And "wrangler tail --format json" is running against it
    When the owner sends about 30 requests at the cap: SubQ with one 2 MiB image, SubQ with four 512 KiB images, and OpenAI with eight 256 KiB images
    # Timers inside a Worker read 0 on Cloudflare, so only the tail's cpuTime (or the dashboard) is usable.
    Then the 95th percentile of the tail events' cpuTime is at most 10 ms
    # If it is not, lower MAX_IMAGE_BYTES and MAX_IMAGE_REQUEST_BYTES in src/providers/catalog.ts and record the measurement in the PR.
