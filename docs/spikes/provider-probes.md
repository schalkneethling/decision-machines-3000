# Provider probes: what SubQ Snap, OpenAI Decisions, and TypeSafe Jev really do

This note records the results of GitHub issue #2. On 2026-10-12 a script sent 34 live requests to the three providers, and every question the docs left open now has a measured answer. Each answer names the fixture file that proves it. All fixtures are under `worker/providers/fixtures/<provider>/<case>.json`, so a path such as `subq/three-types` means `worker/providers/fixtures/subq/three-types.json`.

The probe script is `scripts/probe/run.mjs`. Nothing in `src`, `server`, or the build imports it. Each fixture holds `request`, `status`, `headers`, `body`, and `latencyMs`, plus one extra field, `responseBytes`, which the warm-path comparison needed because the long OpenAI model list is trimmed. Keys never reach a fixture: the request records `Bearer <redacted>`, response headers are limited to a short allow-list, request and organisation identifiers are masked, and the script ends by checking in memory that no key value appears in any fixture file (it printed `redaction check passed`).

## Answers at a glance

| Question                                  | Answer                                                                                                                                                                   | Proof                                                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Is SubQ wire-compatible with Jev?         | Yes for text requests with all three question types. Same path, same request fields, same answer shapes, same error envelope. Four differences are listed below.         | `subq/three-types`, `typesafe/noul`, `typesafe/choice`, `typesafe/score`                                                  |
| What does the SubQ base64 wording mean?   | The `base64` field takes plain base64 on one line. A `data:` URL and a line-wrapped string both fail with 422.                                                           | `subq/image-png-plain-base64`, `subq/image-png-data-url`, `subq/image-png-wrapped-base64`, `subq/image-jpeg-plain-base64` |
| What is OpenAI's error envelope?          | The standard `{ "error": { message, type, param, code } }`, with 400 for a bad body and 401 for a bad key.                                                               | `openai/invalid-body`, `openai/score-11-levels`, `openai/bad-key`, `openai/models-list-no-auth`                           |
| How many score levels does OpenAI accept? | Between 2 and 10. Two and ten are accepted, and eleven returns 400.                                                                                                      | `openai/score-2-levels`, `openai/score-10-levels`, `openai/score-11-levels`                                               |
| Are output tokens reported?               | The field is always present, but SubQ and OpenAI always report 0. TypeSafe reports real output tokens.                                                                   | `subq/three-types`, `openai/three-types`, `typesafe/choice`                                                               |
| Is SubQ's `confidence` present?           | Yes on choice and score answers, and never on a Yes/no (`noul`) answer.                                                                                                  | `subq/three-types`                                                                                                        |
| Which warm paths exist?                   | SubQ: `GET /v1/models`, with no auth needed. OpenAI: `GET /v1/models/gpt-6-luna` (not the full list). TypeSafe: `GET /v1/models`.                                        | `subq/models-list`, `openai/models-retrieve`, `typesafe/models-list`                                                      |
| What are the latencies?                   | See the table near the end. A three-question call takes about 0.5 to 1.0 s on SubQ and about 2.0 s on OpenAI, with TypeSafe single-question calls at about 0.4 to 0.5 s. | The `latencyMs` field in every fixture                                                                                    |

## 1. Is SubQ wire-compatible with Jev?

Yes, for everything this project sends. The evidence is a side-by-side read of the SubQ and TypeSafe fixtures.

- Both providers use `POST /v1/systemone` with `Authorization: Bearer`. The request has `model`, `state`, and a `questions` map keyed by question id. Each question has `type`, `instructions`, and `criteria` of the same shapes (a true/false object for `noul`, an option map for `choice`, an ordered array for `score`).
- The answers match field for field: `{ type: "noul", noul }`, `{ type: "choice", choice, probabilities, confidence }`, and `{ type: "score", score, legend, probabilities, confidence }`. Compare `subq/three-types` with `typesafe/noul`, `typesafe/choice`, and `typesafe/score`.
- The error envelope is the same: `{ "detail": { "error_type", "message" } }`. Compare `subq/bad-key-sk-prefix` with `typesafe/bad-key`: both are 401 with `error_type: "authentication_error"`.
- Score levels top out at 10 on SubQ (`subq/score-11-levels` returns 422 saying "must NOT have more than 10 items"), the same limit TypeSafe documents.

The differences an adapter has to know about:

1. SubQ takes an `images` array (`{ mediaType, base64 }`). Jev is text only.
2. SubQ always reports `output_tokens: 0`, while TypeSafe reports real values (22, 55, and 18 in `typesafe/noul`, `typesafe/choice`, and `typesafe/score`).
3. SubQ returns unrounded probabilities such as `0.9565181732177734`, while TypeSafe rounds to two decimals.
4. The model list has a different shape. TypeSafe returns `{ models: [{ name, description, release_date }] }` and SubQ returns an OpenAI-style `{ object: "list", data: [{ id, name, object, created, owned_by }] }`. This matters only if code reads the warm response, which the warm path does not.

This probe did not send the exact same request to both providers with only the host changed, and it did not test whether TypeSafe rejects `images`. "Compatible" therefore means the shapes this project uses, which is what the adapters need.

## 2. What does the SubQ base64 wording mean?

The docs say "URLs, `data:` URLs, and bare base64 strings fail the request", which reads as if plain base64 fails. It does not. The wording is a docs mistake. The `base64` field takes plain base64 on a single line, and every other form is refused by a pattern check.

| Input                                                   | Result                                 | Fixture                         |
| ------------------------------------------------------- | -------------------------------------- | ------------------------------- |
| Plain one-line base64 of a 2x2 PNG                      | 200, answer returned, 163 input tokens | `subq/image-png-plain-base64`   |
| Plain one-line base64 of a 2x2 JPEG                     | 200, answer returned                   | `subq/image-jpeg-plain-base64`  |
| `data:image/png;base64,...`                             | 422                                    | `subq/image-png-data-url`       |
| Base64 wrapped at 76 characters with a trailing newline | 422                                    | `subq/image-png-wrapped-base64` |

The 422 message for both failures is `images/0/base64: must match pattern "^[A-Za-z0-9+/]+={0,2}$"`. So the adapter must send standard base64 (not base64url), with padding at most at the end, and with no newline anywhere, including at the end. `Buffer.toString("base64")` and the Workers `Uint8Array.toBase64()` both produce this form.

A first attempt used a hand-trimmed 134-byte JPEG, which SubQ rejected with 400 and `an image could not be loaded: image file is truncated`. That was a fault in the test image, not in SubQ, so the probe now embeds a 776-byte JPEG made by converting the PNG with macOS `sips`, and that one is accepted. The failed attempt was not kept as a fixture.

## 3. What is OpenAI's error envelope?

The standard OpenAI envelope, as the general error guide describes, and now confirmed against the Decisions endpoint:

```json
{
  "error": {
    "message": "...",
    "type": "invalid_request_error",
    "param": "questions",
    "code": "missing_required_parameter"
  }
}
```

| Case                       | Status | `type`                  | `code`                       | `param`                         | Fixture                      |
| -------------------------- | ------ | ----------------------- | ---------------------------- | ------------------------------- | ---------------------------- |
| Missing `questions`        | 400    | `invalid_request_error` | `missing_required_parameter` | `questions`                     | `openai/invalid-body`        |
| 11 score levels            | 400    | `invalid_request_error` | `array_above_max_length`     | `questions[0].levels`           | `openai/score-11-levels`     |
| Bad key                    | 401    | `invalid_request_error` | `null`                       | `null`                          | `openai/bad-key`             |
| No `Authorization` header  | 401    | `invalid_request_error` | `null`                       | `null`                          | `openai/models-list-no-auth` |
| Image URL that returns 404 | 400    | `invalid_request_error` | `invalid_value`              | `input[0].content[1].image_url` | `openai/image-http-url`      |

Two points matter for the adapter. First, a bad key has `code: null`, so the 401 must be recognised by HTTP status, not by `error.code`. Second, the bad-key message is "A valid API key is required.", which is not any of the messages the error guide lists. A missing header gives "Missing bearer authentication in header" and a `www-authenticate: Bearer realm="OpenAI API"` header.

## 4. How many score levels does OpenAI accept?

At most 10, and at least 2. The 2-level and 10-level requests succeeded (`openai/score-2-levels`, `openai/score-10-levels`). The 11-level request failed with `Invalid 'questions[0].levels': array too long. Expected an array with maximum length 10, but got an array with length 11 instead.` (`openai/score-11-levels`). Because 11 was refused, the optional 50-level probe was not sent. One level was not probed, so "minimum 2" means only that 2 works; the project's own floor of 2 is safe.

This matches SubQ and TypeSafe, so all three providers share a 2-to-10 range.

## 5. Are output tokens reported, and what are the usage fields?

| Provider | Fields                                                                                                                                                      | Output tokens           | Fixture                                              |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------- |
| TypeSafe | `input_tokens`, `output_tokens`                                                                                                                             | Real values: 22, 55, 18 | `typesafe/noul`, `typesafe/choice`, `typesafe/score` |
| SubQ     | `input_tokens`, `output_tokens`                                                                                                                             | Always 0                | `subq/three-types`                                   |
| OpenAI   | `input_tokens`, `input_tokens_details { cached_tokens, cache_write_tokens }`, `output_tokens`, `output_tokens_details { reasoning_tokens }`, `total_tokens` | Always 0                | `openai/three-types`                                 |

The fixtures confirm the research. An image adds little input: the 2x2 test images produced 163 input tokens on SubQ and 164 on OpenAI for a one-line question.

## 6. Is SubQ's `confidence` field present?

On choice and score answers, yes (`0.942...` and `0.319...` in `subq/three-types`). On a Yes/no (`noul`) answer it is absent, which matches the docs and TypeSafe. OpenAI behaves the same way: `predicate` answers have no `confidence`, and `choice` and `score` answers do (`openai/three-types`).

## 7. Which warm paths exist?

A warm path is a call that costs no tokens and leaves an open connection for the next request.

| Provider | Candidate                   | Auth needed                                                    | Status | Latency                                                    | Size                  | Verdict                                |
| -------- | --------------------------- | -------------------------------------------------------------- | ------ | ---------------------------------------------------------- | --------------------- | -------------------------------------- |
| TypeSafe | `GET /v1/models`            | Not tested without a key; the existing server always sends one | 200    | 382 ms, new connection                                     | 311 B                 | Works (already in use)                 |
| SubQ     | `GET /v1/models`            | No: `subq/models-list-no-auth` returns 200                     | 200    | 838 to 1044 ms on a new connection, 267 ms on a reused one | 135 B                 | Works                                  |
| OpenAI   | `GET /v1/models`            | Yes: no header gives 401                                       | 200    | 2343 ms, new connection                                    | 21,507 B (135 models) | Too heavy: the server alone took 1.6 s |
| OpenAI   | `GET /v1/models/gpt-6-luna` | Yes                                                            | 200    | 1023 ms on a new connection, 692 ms on a reused one        | 119 B                 | Works, but slower than the others      |

Fixtures: `typesafe/models-list`, `subq/models-list`, `subq/models-list-second-cold`, `subq/models-list-no-auth`, `openai/models-list`, `openai/models-list-no-auth`, `openai/models-retrieve`, `openai/models-retrieve-second-cold`. The `models-list` bodies for SubQ and OpenAI are the real responses; the OpenAI one is trimmed to four entries with a `trimmed.originalCount` marker, and `responseBytes` holds the real size.

Does warming help the next request? One sample each, so treat this as a direction only:

- SubQ: the three-question request took 969 ms on a new connection and 514 ms right after the model list on the same connection (`subq/three-types`, `subq/three-types-after-models-list`). The handshake costs about 570 ms (838 ms new against 267 ms reused for the same GET). Warming is clearly worth showing.
- OpenAI: 2088 ms against 1929 ms (`openai/three-types`, `openai/three-types-after-models-list`). The `openai-processing-ms` header says the server took 1022 ms and 891 ms, so the connection setup differs by only about 30 ms in that pair and by roughly 100 ms in the retrieve pair. OpenAI's latency is dominated by the model, not the handshake, so the warm demo teaches little there.

Both OpenAI and SubQ do have a usable path, so neither descriptor needs to hide the warm form. OpenAI's path embeds the model id, so the descriptor's `warmPath` should be built from the model name, or declared as the literal `/v1/models/gpt-6-luna`.

## 8. Measured latencies

All times are wall-clock milliseconds from the probe script, measured once per case from one machine, covering the request, the response headers, and the body. "New" means a connection opened for that call, and "reused" means an earlier call on the same connection. The first call of each provider also included the DNS lookup, which makes it slower than a later "new" call. Single samples are noisy, so differences under about 100 ms are not meaningful.

| Case                                                                                    | Status        | Connection      | Latency (ms) | Fixture                                |
| --------------------------------------------------------------------------------------- | ------------- | --------------- | ------------ | -------------------------------------- |
| TypeSafe models list                                                                    | 200           | new             | 382          | `typesafe/models-list`                 |
| TypeSafe Yes/no                                                                         | 200           | reused          | 392          | `typesafe/noul`                        |
| TypeSafe choice                                                                         | 200           | reused          | 539          | `typesafe/choice`                      |
| TypeSafe score                                                                          | 200           | reused          | 507          | `typesafe/score`                       |
| TypeSafe bad key                                                                        | 401           | reused          | 316          | `typesafe/bad-key`                     |
| SubQ models list                                                                        | 200           | new, first call | 1044         | `subq/models-list`                     |
| SubQ three questions, after the list                                                    | 200           | reused          | 514          | `subq/three-types-after-models-list`   |
| SubQ three questions                                                                    | 200           | new             | 969          | `subq/three-types`                     |
| SubQ models list, no auth                                                               | 200           | reused          | 267          | `subq/models-list-no-auth`             |
| SubQ image, PNG                                                                         | 200           | reused          | 389          | `subq/image-png-plain-base64`          |
| SubQ image, JPEG                                                                        | 200           | new             | 1017         | `subq/image-jpeg-plain-base64`         |
| SubQ models list, second new connection                                                 | 200           | new             | 838          | `subq/models-list-second-cold`         |
| SubQ rejected requests (data URL, wrapped, 11 levels, invalid body, bad or missing key) | 401, 403, 422 | reused          | 258 to 416   | the matching `subq/*` files            |
| OpenAI models list                                                                      | 200           | new, first call | 2343         | `openai/models-list`                   |
| OpenAI three questions, after the list                                                  | 200           | reused          | 1929         | `openai/three-types-after-models-list` |
| OpenAI three questions                                                                  | 200           | new             | 2088         | `openai/three-types`                   |
| OpenAI model retrieve                                                                   | 200           | reused          | 692          | `openai/models-retrieve`               |
| OpenAI model retrieve, second new connection                                            | 200           | new             | 1023         | `openai/models-retrieve-second-cold`   |
| OpenAI image, PNG                                                                       | 200           | reused          | 1047         | `openai/image-png-data-url`            |
| OpenAI image, JPEG                                                                      | 200           | reused          | 526          | `openai/image-jpeg-data-url`           |
| OpenAI score, 2 levels                                                                  | 200           | reused          | 368          | `openai/score-2-levels`                |
| OpenAI score, 10 levels                                                                 | 200           | reused          | 281          | `openai/score-10-levels`               |
| OpenAI rejected requests (11 levels, invalid body, bad key, no auth, URL image)         | 400, 401      | reused          | 220 to 707   | the matching `openai/*` files          |

The earlier project measurement was 330 ms round trip, about 1.3 s cold, and about 0.4 s warm for TypeSafe. This session's TypeSafe numbers (382 ms for a new-connection GET and 390 to 540 ms for reused calls) show a much smaller cold penalty, probably because of a different network path. That prose in the README should be re-measured before it is reused for other providers.

Rate-limit headers appeared on some OpenAI success responses: `x-ratelimit-limit-requests: 5000` and `x-ratelimit-limit-tokens: 2000000` for this account. Not every OpenAI response carried them. SubQ and TypeSafe sent none.

## Findings that contradict the research

1. SubQ bad-key status. The docs say a missing or invalid key returns 401. A made-up key that does not start with `sk-` returned 403 `permission_error` with the message "Access denied. Contact support if you believe this is an error." (`subq/bad-key`). The same made-up key with an `sk-` prefix returned 401 `authentication_error` "Missing or invalid API key." (`subq/bad-key-sk-prefix`), and no key returned 401 with "Missing API key. Provide it as `Authorization: Bearer sk-...` or the `X-API-Key` header." (`subq/missing-key`).
2. SubQ's model list needs no key, although the research quoted the docs saying it is "a quick way to check a key". It cannot check a key, but it can still warm the connection.
3. SubQ's "bare base64 strings fail" sentence is wrong (section 2).
4. OpenAI accepts a hosted image URL at validation time. The research found the guide and the SDK typings saying data URLs only, and the reference saying URLs also work. A URL on a server that returned 404 produced "Error while downloading file. Upstream status code: 404." (`openai/image-http-url`), which shows OpenAI tried to download it. This was not tested with a working URL, and this project always sends a data URL, so it does not matter for now.
5. OpenAI gave a 401 with `code: null` for a bad key, so the error guide's message table is not a reliable key for the adapter (section 3).

## What this changes in the other issues

- #5 (provider catalog). Set the OpenAI `scoreLevels` to `{ min: 2, max: 10 }` and remove the "provisional" marker. Give SubQ the warm path `/v1/models` and OpenAI the warm path `/v1/models/gpt-6-luna`. The descriptor must be able to say whether the warm call needs the key, because SubQ's does not, though sending the key anyway is harmless (`subq/models-list` used a valid key and returned 200).
- #7 (TypeSafe adapter). Use `typesafe/noul`, `typesafe/choice`, `typesafe/score`, and `typesafe/bad-key` as test fixtures. The raw request carries `model: "jev-latest"`, and the answers carry real `output_tokens`.
- #9 (warm demo). Both new providers have a warm path, so neither hides the warm form. Be aware the lesson is strong for SubQ (about 450 ms saved in one sample) and weak for OpenAI (server time dominates). The README's cold and warm numbers are TypeSafe-specific and should say so. Do not use the OpenAI model list as the warm call: it is 21.5 KB and took 1.6 s on the server.
- #10 (SubQ adapter). The base64 string must match `^[A-Za-z0-9+/]+={0,2}$` (no `data:` prefix, no newlines). Map 403 `permission_error` as well as 401 to "the key was rejected". The 402 "no credits" status was not probed, so that test stays a stubbed one. `usage.output_tokens` is always 0. The error envelope is identical to TypeSafe's, but the issue is right to keep the adapters separate.
- #11 (OpenAI adapter). Fill in `scoreLevels.max: 10` and `min: 2`. Recognise a bad key from the 401 status alone, because `error.code` is `null`. Map 400 `invalid_request_error` for the rest, using `error.param` for the detail (for example `questions[0].levels`). Copy `usage` as two fields and expect `output_tokens` to be 0. Answers arrive as an array that carries `name`, and `choice` values and `score` `probabilities[].value` arrive as given (`openai/three-types`).
- #4 (neutral contract). Wherever the neutral `usage` shape is defined, note that output tokens will read 0 for SubQ and OpenAI, so the readout should not present 0 as an error or as a free-of-charge claim.

## How to re-run the probe

Pass the keys as environment variables for that one process, for example `SUBQ_API_KEY="$(op read '<reference>')" node scripts/probe/run.mjs subq`. Name `provider` or `provider:case,case` to run a subset (the three providers are `typesafe`, `subq`, and `openai`). A full run sends about 34 requests, so re-running it costs a small amount and overwrites the fixtures with new probabilities. Run `vp check --fix` afterwards, because the formatter reflows the fixture JSON.
