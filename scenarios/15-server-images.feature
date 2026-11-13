Feature: The Worker accepts images as base64 in the request's JSON, checks their real format, and forwards them unchanged

  Background:
    Given POST /api/decide/{provider} accepts application/json only
    And a request may carry an "images" list, one { "name": …, "base64": … } entry per picture, with "name" optional
    # Images first arrived as binary multipart parts that the Worker encoded itself. A CPU measurement then showed that
    # reading the multipart body cost more than the encoding, so the browser now encodes each picture and the Worker
    # reads one JSON body. The Worker never scans the base64 text: a pass over it would cost more than the rest of the route.
    And the limits come from each provider's capabilities.images in src/providers/catalog.ts, never from new constants:
      | provider | maxCount | maxBytesPerImage | maxBytesPerRequest | mediaTypes                       |
      | typesafe | (none: text only)                                                                            |
      | subq     | 4        | 64 KiB           | 64 KiB             | image/png, image/jpeg, image/webp |
      | openai   | 8        | 64 KiB           | 64 KiB             | image/png, image/jpeg, image/webp |
    # The owner first chose 2 MiB per image and 2 MiB per request on issue #15, instead of the Workers Paid plan,
    # which overrode the 4 MiB and 8 MiB figures the issue body gave for these scenarios.
    # A CPU measurement on Cloudflare then showed 2 MiB costs 35 to 107 ms per request against the Free plan's 10 ms,
    # so the owner lowered both caps to 96 KiB, and to 64 KiB (65,536 bytes) after 96 KiB measured a p95 of 11 ms.
    # Base64 in JSON was measured next and costs about 28 ms per MiB, so the owner kept 64 KiB and the Free plan.
    # The two caps are equal, but they are separate constants and the scenarios below keep a case for each.
    And the limits are on decoded bytes, worked out from the length of the base64 text and its "=" padding
    And no message names an image's name or quotes its base64, because the client controls both (Varlock's leak scanner)
    And the fail-closed gate from #14 runs before the body is read, so none of this happens for a refused request

  Scenario: A text-only provider refuses images before any upstream call
    Given POST /api/decide/typesafe with a valid request and one image in "images"
    When it is handled
    Then the response is 400
    And the error says TypeSafe Jev evaluates text only
    And no upstream call is made

  Scenario: An empty images list is the same as no images
    Given a request with "images": []
    When the images are taken out
    Then the request goes on to validation without images

  Scenario: Too many images are refused with the limit named
    Given POST /api/decide/subq with five images
    When it is handled
    Then the response is 400
    And the error says the request has 5 images and SubQ Snap takes at most 4
    And no upstream call is made

  Scenario: OpenAI's own count is its limit
    Given POST /api/decide/openai with nine images
    When it is handled
    Then the response is 400
    And the error says OpenAI Decisions takes at most 8

  Scenario: One image over the per-image limit is refused before any provider call
    Given POST /api/decide/subq with a second image that decodes to 64 KiB + 1 byte
    When it is handled
    Then the response is 400
    And the error names "Image 2" and the limit of 64 KB per image
    And no upstream call is made
    And an image of exactly 64 KiB is accepted

  Scenario: Images that together pass the per-request limit are refused
    # The unit test gives a provider equal 2 KiB caps, so each image is within the per-image cap and only the
    # per-request check can refuse the pair: 1 KiB and 1 KiB + 1 byte.
    Given a provider whose per-image and per-request caps are both 2 KiB
    When a request carries images of 1 KiB and 1 KiB + 1 byte
    Then the response is a 400 that names the limit of 2 KB per request

  Scenario: The per-request limit still applies when it is below twice the per-image limit
    # Not reachable through the catalog today, where the two caps are equal.
    Given a provider whose per-image cap is 1 KiB and whose per-request cap is 1.5 KiB
    When a request carries images of 1 KiB and 513 bytes
    Then each image is within the per-image cap
    And the response is a 400 that names the limit of 1.5 KB per request

  Scenario: The media type comes from the bytes, not from the name
    Given an image named "photo.png" whose bytes are JPEG
    When POST /api/decide/subq is handled with a stubbed upstream
    Then the upstream body declares "image/jpeg"

  Scenario Outline: Each accepted format is recognised from its first bytes
    Given an image whose first 16 base64 characters decode to bytes that start with <signature>
    When POST /api/decide/subq is handled with a stubbed upstream
    Then the upstream body declares "<mediaType>"

    Examples:
      | signature                                       | mediaType  |
      | 89 50 4E 47 0D 0A 1A 0A (PNG)                   | image/png  |
      | FF D8 FF (JPEG)                                 | image/jpeg |
      | "RIFF", four size bytes, "WEBP"                 | image/webp |

  Scenario Outline: Text of no accepted format is refused with the accepted formats named
    Given an image whose "base64" is <text>
    When POST /api/decide/subq is handled
    Then the response is 400
    And the error says "Image 1 is not image/png, image/jpeg, or image/webp, judging by its first bytes."
    And the response does not contain the image's name
    And no upstream call is made

    Examples:
      | text                                   |
      | a GIF                                  |
      | empty                                  |
      | plain text, encoded                    |
      | characters that are not base64         |
      | a data: URL instead of plain base64    |

  Scenario: Text after the first 16 characters is not examined
    Given an image whose base64 starts with a PNG signature and then holds anything
    When POST /api/decide/subq is handled
    Then the image is accepted and forwarded unchanged
    # The format check only stops a wrong format from being forwarded. It is not content validation; the provider
    # decodes the picture and refuses bad base64. JSON.stringify escapes the text on the way out, so it cannot change
    # the shape of the provider's request.

  Scenario Outline: An images list of the wrong shape is refused with a message of its own
    Given POST /api/decide/subq whose "images" is <shape>
    When it is handled
    Then the response is 400 with "<error>"
    And no upstream call is made

    Examples:
      | shape                              | error                                                                     |
      | an object, not a list              | "images" must be a list of images.                                        |
      | a list holding text                | Image 1 must be an object with "base64" and an optional "name".           |
      | an entry without "base64"          | Image 1 needs "base64": the picture's bytes as base64 text.               |
      | an entry whose "name" is a number  | The "name" of Image 1 must be text.                                       |
      | an entry with a "mediaType" field  | Image 1 may hold only "name" and "base64".                                |

  Scenario: A name longer than the route reads is refused without echoing it
    Given an image whose name is longer than 1,024 characters
    When POST /api/decide/subq is handled
    Then the response is 400 naming the image by position and the 1,024-character limit
    And the response does not contain the name
    # Cleaning a name runs a regular expression over it, so a longer name is refused before that work.

  Scenario: The images list is taken out before the request is validated
    Given a request with an invalid "primitive" and a valid images list
    When it is handled
    Then the response is the validator's 400 about "primitive"
    And "images" is not reported as an unknown field

  Scenario: The text allowance does not count the images' base64
    Given a request without images of 256 KiB + 1 byte
    When it is handled
    Then the response is 413
    And a request of exactly 256 KiB is accepted
    And the text is measured in bytes, not characters
    And with images, the body minus their base64 may hold the 256 KiB text allowance plus the 64 KiB framing allowance

  Scenario: The body is not read before the gate, the 404, or the 409
    Given a body stream that records each pull
    When the gate refuses (unconfigured Worker, or no Access token), or the provider is unknown, or its key is not set
    Then the stream was pulled zero times

  Scenario: A Content-Length over the body limit is refused before the body is read
    Given a Content-Length larger than MAX_BODY_BYTES
    When it is handled
    Then the response is 413 and the body stream is never read

  Scenario: A body over the limit with no Content-Length stops at the limit
    Given a streamed body larger than MAX_BODY_BYTES and no Content-Length header
    When it is handled
    Then reading stops once the count passes the limit
    And the response is 413

  Scenario: The body limit is derived from the catalog, with room for the framing
    Then MAX_BODY_BYTES is the 256 KiB text allowance, plus the base64 length of the largest maxBytesPerRequest in the catalog, plus a 64 KiB framing allowance
    And a request with the most images, the longest names, and the most text the limits allow is not refused for its wrapping

  Scenario: Two images reach the upstream as the base64 that arrived, and the response holds placeholders
    Given POST /api/decide/subq with two valid images and a stubbed upstream
    When it is handled
    Then the upstream JSON carries both images with the base64 text that arrived, in order
    And wire.request.images holds two placeholders such as "<image 1: image/png, 300 bytes>"
    And the response body is under 64 KiB and contains no base64 of the images

  Scenario: Three images are all checked and forwarded in order
    Given POST /api/decide/openai with three valid images and a stubbed upstream
    When it is handled
    Then the upstream input holds the text part and three input_image data URLs, in order

  Scenario: The log counts the images and never names them
    Given a request with two images
    When it is handled
    Then the log line holds images=2
    And it holds no name and no base64

  # Manual checks. They need a running host, so the owner runs them.

  Scenario: Manual, in the dev host
    Given "vp dev --port 5199 --strictPort" is running with SUBQ_API_KEY set
    When the owner sends a request with an image, for example:
      """
      curl -sS -H 'content-type: application/json' --data "{\"primitive\":\"noul\",\"state\":\"\",\"questions\":{\"red\":{\"instructions\":\"Is image 1 mostly red?\"}},\"images\":[{\"name\":\"photo.jpg\",\"base64\":\"$(base64 -i photo.jpg)\"}]}" http://localhost:5199/api/decide/subq
      """
    Then the answer is 200, and wire.request.images[0] shows an image/jpeg placeholder

  Scenario: Manual, in the built Worker
    Given "vp run build" has run and "vp exec wrangler dev" serves the build with a provider key set
    When the owner sends the same curl request
    Then the answer is the same as in the dev host

  Scenario: Manual, measuring the CPU cost of a cap (acceptance criterion added on issue #15)
    # Multipart, 2026-10-16: a 2 MiB image cost 35 to 107 ms of CPU (SubQ median 74 ms, OpenAI median 50 ms), and a 2 MiB body
    # refused before any encoding still used up to 59 ms. 96 KiB measured a p95 of 11 ms, and 64 KiB a p95 of 9 ms.
    # Details: https://github.com/schalkneethling/decision-machines-3000/pull/53#issuecomment-6221879089
    # Base64 in JSON, 2026-10-25, on a scratch Worker with the caps raised to 4 MiB per image and 8 MiB per request, 53 requests
    # with one Choice question each (medians, then the slowest): text only 3 and 15 ms; SubQ with one image of 256 KiB 10 and 17,
    # 512 KiB 14 and 19, 1 MiB 31 and 39, 2 MiB 58 and 81, 4 MiB 110 and 134; SubQ with four 1 MiB images 119 and 134; OpenAI with
    # one 1 MiB image 29 and 45, one 2 MiB image 55 and 80, eight 256 KiB images 55 and 76. One request, the last of the eight
    # 256 KiB OpenAI runs, ended with "Worker exceeded CPU time limit", so the account's Free plan enforces the limit. About 28 ms per
    # MiB leaves no room above 64 KiB within 10 ms, so the owner kept the 64 KiB caps and the Free plan.
    Given the real decide path is deployed to a scratch Worker (not the production one)
    And "wrangler tail --format json" is running against it
    When the owner sends about 30 requests at the cap: SubQ with one 64 KiB image, SubQ with four 16 KiB images, and OpenAI with eight 8 KiB images
    # Timers inside a Worker read 0 on Cloudflare, so only the tail's cpuTime (or the dashboard) is usable.
    Then the 95th percentile of the tail events' cpuTime is at most 10 ms
    # If it is not, lower MAX_IMAGE_BYTES and MAX_IMAGE_REQUEST_BYTES in src/providers/catalog.ts and record the measurement in the PR.
