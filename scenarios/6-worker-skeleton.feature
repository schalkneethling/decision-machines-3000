Feature: Worker skeleton, Node dev host, and GET /api/providers
  The app gains a same-origin backend named decisionmachines3000. Its request
  handler is a plain function, handle(request, env, deps), which both the Worker
  and the Node dev host call. GET /api/providers reports the configured
  providers by name and capabilities only, and never a key.

  Background:
    Given the catalog descriptors for TypeSafe, SubQ, and OpenAI

  Scenario: One configured provider is listed without its key
    Given env is { OPENAI_API_KEY: "x" }
    When handle(new Request("/api/providers")) runs
    Then the status is 200
    And the body is { ok: true, providers: [the OpenAI summary] }
    And the OpenAI summary carries exactly the catalog's id, displayName, model, and capabilities
    And it never carries the warm path or any server-only field added to the catalog later
    And the string "x" appears nowhere in the body or the headers

  Scenario: Configured providers are listed in catalog order
    Given env sets OPENAI_API_KEY and TYPESAFE_API_KEY
    When GET /api/providers is handled
    Then the providers are TypeSafe, then OpenAI

  Scenario Outline: A key that is blank or the placeholder counts as absent
    Given env is { OPENAI_API_KEY: <value> }
    When GET /api/providers is handled
    Then the response is the same 503 as with no key at all

    Examples:
      | value     |
      | ""        |
      | "   "     |
      | "unset"   |
      | " UNSET " |
      | "Unset"   |

  Scenario: A key that merely contains "unset" is a real key
    Given env is { SUBQ_API_KEY: "unset-but-real" }
    When GET /api/providers is handled
    Then SubQ is listed

  Scenario: An instance with no key is misconfigured, not empty
    Given env is {}
    When GET /api/providers is handled
    Then the status is 503
    And Cache-Control is no-store
    And the body is { ok: false, error }
    And the error names TYPESAFE_API_KEY, SUBQ_API_KEY, and OPENAI_API_KEY
    And the error says at least one is required

  Scenario: The 503 never repeats the placeholder
    Given env is { TYPESAFE_API_KEY: "unset" }
    When GET /api/providers is handled
    Then the status is 503
    And the body does not contain "unset"
    # Varlock treats the placeholder as a sensitive value and would replace the 503 with a 500.

  Scenario: An unknown API path gets a JSON 404
    When GET /api/unknown is handled
    Then the status is 404
    And the body is JSON { ok: false, error }, not the single-page-app HTML

  Scenario: A wrong method gets a 405
    When POST /api/providers is handled
    Then the status is 405
    And the Allow header is "GET, HEAD"

  Scenario: HEAD is answered wherever GET is
    When HEAD /api/providers is handled
    Then the status and headers equal those of GET
    And there is no body

  Scenario: A key value that is not a string counts as absent
    Given env is { OPENAI_API_KEY: 42 }, as a Worker var holding JSON
    When GET /api/providers is handled
    Then the response is the 503, not an exception

  Scenario: Every answer forbids content sniffing
    When any /api request is handled
    Then X-Content-Type-Options is nosniff

  Scenario: A cross-origin preflight gets no CORS headers
    When an OPTIONS request with Origin and Access-Control-Request-Method arrives at /api/providers
    Then the response carries no Access-Control-Allow-Origin header

  Scenario: Every answer is uncacheable
    When any /api request is handled
    Then Cache-Control is no-store

  Scenario: The handler keeps no state between requests
    Given one request with a key and one without
    When both are handled in turn
    Then each answer depends only on its own env

  Scenario: Provider calls go through deps.fetch
    # No route in this issue calls a provider; the decide route (#8) and the
    # warm route (#9) will. Until then, the handler must not call fetch at all.
    Given handle is called with deps.fetch set to a stub and the global fetch replaced by a spy
    When GET /api/providers is handled
    Then neither the stub nor the global fetch is called

  Scenario: The Worker is named decisionmachines3000
    When wrangler.jsonc is read
    Then the Worker name is decisionmachines3000

  Scenario: The Node dev host answers with the same handle
    Given the dev host middleware with OPENAI_API_KEY set
    When GET /api/providers reaches it
    Then it answers with the body handle produces
    And a path outside /api is passed on to the next middleware

  Scenario: The dev host passes requests to the handler unchanged
    When a POST with a JSON content type and a non-ASCII body reaches the dev host
    Then the handler receives the same method, content type, and body bytes

  Scenario: The dev host refuses odd requests the way the Worker would
    When a request target starts with "//", the Host header is malformed, or the method is TRACE
    Then the target is passed on, the Host gets a JSON 400, and TRACE gets a JSON 405

  Scenario: The dev host warns when it starts with no key
    Given no provider key is set
    When the dev host plugin starts
    Then it prints which variables to set and that at least one is required

  # Superseded by #8, which removed /api/jev.
  Scenario: The legacy /api/jev middleware still answers under vp dev
    Given vp dev with jevApiPlugin listed before the dev host
    When POST /api/jev is sent
    Then the legacy middleware answers it, and GET /api/providers is answered by the dev host

  Scenario: The built Worker serves the UI and the API
    Given vp run build and vp exec wrangler dev
    When the browser loads /
    Then the UI renders
    And GET /api/providers answers
    And GET /api/unknown answers a JSON 404

  Scenario: The browser checks the providers response
    When getProviders() receives a body
    Then it is accepted only when it matches the Zod Mini providers schema
    And a success must list at least one provider, with whole-number limits
    And an unknown top-level field is tolerated

  Scenario: Checks and tests never touch 1Password
    When vp check, vp test, and vp run build run
    Then they pass without a 1Password prompt
