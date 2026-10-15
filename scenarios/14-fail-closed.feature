Feature: A deployed instance refuses provider calls until it is protected or the owner opts out

  Background:
    Given the Worker's handle(request, env, deps) serves both the Worker and the Node dev host
    And deps.host says which host is calling: "worker" (workerd, deployed or local) or "node-dev" (the Vite dev server in Node)
    And only the Node dev host counts as local, because workerd cannot tell `wrangler dev` from Cloudflare and no request header is trusted for the distinction
    And protection is configured through three environment variables, named in docs/deploy.md:
      | variable                   | meaning                                                                                  |
      | ACCESS_TEAM_DOMAIN         | the Cloudflare Access team, as `team`, `team.cloudflareaccess.com`, or the https:// URL   |
      | ACCESS_AUD                 | the Application Audience tag of the Access application in front of the instance          |
      | ALLOW_UNPROTECTED_INSTANCE | the explicit opt-out; it counts only when set to the exact sentence "I accept the bill"  |
    And an Access token is the Cf-Access-Jwt-Assertion header, verified with the team's keys from https://<team>.cloudflareaccess.com/cdn-cgi/access/certs

  Scenario: An unconfigured deployed instance refuses a decision and says how to fix it
    Given deps.host is "worker" and TYPESAFE_API_KEY is set
    And none of the three protection variables is set
    When POST /api/decide/typesafe is called with a valid request
    Then the response is a JSON 503 failure
    And its error names ACCESS_TEAM_DOMAIN, ACCESS_AUD, and ALLOW_UNPROTECTED_INSTANCE
    And deps.fetch is never called, so no provider call is made

  Scenario: Half an Access configuration still fails closed
    Given deps.host is "worker" and only ACCESS_TEAM_DOMAIN is set
    When POST /api/decide/typesafe is called
    Then the response is a JSON 503 failure whose detail says ACCESS_AUD is not set
    And no provider call is made

  Scenario: An opt-out with the wrong value does not count
    Given deps.host is "worker" and ALLOW_UNPROTECTED_INSTANCE is "yes"
    When POST /api/decide/typesafe is called
    Then the response is a JSON 503 failure whose detail says the variable is not set to the exact sentence
    And no provider call is made

  Scenario: A missing token on an Access-protected instance is refused with a 403
    Given deps.host is "worker", ACCESS_TEAM_DOMAIN and ACCESS_AUD are set, and the request has no Cf-Access-Jwt-Assertion header
    When POST /api/decide/typesafe is called
    Then the response is a JSON 403 failure saying the request carried no Cloudflare Access token
    And no provider call is made
    And the certs endpoint is not fetched, because there is nothing to verify

  Scenario Outline: A token that fails one check is refused with a 403 and no provider call
    Given deps.host is "worker", ACCESS_TEAM_DOMAIN and ACCESS_AUD are set
    And the certs endpoint is stubbed with the test key pair's public key
    And the request carries a token that is <token>
    When POST /api/decide/typesafe is called
    Then the response is a JSON 403 failure whose error says <problem>
    And no provider call is made
    And neither the token nor any part of it appears in the body, the headers, or the log

    Examples:
      | token                                         | problem                                        |
      | not three base64url parts                     | the token is malformed                         |
      | signed with HS256 using the public key as HMAC | the signing algorithm is not RS256             |
      | signed with a key whose kid the team does not list | the signing key is not one of the team's keys |
      | signed by another key pair with a listed kid  | the signature does not match                   |
      | expired a minute ago                          | the token has expired                          |
      | not valid until an hour from now              | the token is not valid yet                     |
      | issued for another audience                   | the token is for another application           |
      | issued by another team                        | the token is from another team                 |
      | an `alg: none` token                          | the signing algorithm is not RS256             |

  Scenario: A valid token lets the provider call proceed
    Given deps.host is "worker", ACCESS_TEAM_DOMAIN and ACCESS_AUD are set
    And the certs endpoint is stubbed with the test key pair's public key
    And the request carries a token signed by that key for the configured audience and issuer, unexpired
    When POST /api/decide/typesafe is called
    Then the certs endpoint is fetched through deps.fetch with redirect "manual" (workerd rejects "error") and a timeout signal
    And the provider is called once and the response is the DecisionSuccess

  Scenario: A redirect from the certs endpoint is refused without being followed
    Given the certs endpoint answers 302 with a Location header
    When a well-formed token is verified
    Then the result is keys_unavailable with detail "status 302", the fetch happens once, and the body is cancelled unread

  Scenario: Claims that already fail cost no key fetch
    Given a well-formed token for another audience, from another team, expired, or not yet valid
    When it is verified
    Then it is refused with that problem and the certs endpoint is never fetched
    But the same claims are checked again after the signature, because unverified claims prove nothing

  Scenario: A key of another type in the set does not hide the RSA key
    Given the certs endpoint publishes an EC key before the team's RSA key
    When a token signed by the RSA key is verified
    Then it is accepted

  Scenario: The issuer and the audience are compared whole
    Given a correctly signed token whose iss is "https://myteam.cloudflareaccess.com.evil.com" or "https://myteam.cloudflareaccess.com/"
    Then it is refused with "issuer"
    Given a correctly signed token whose aud is the tag with a suffix, with a prefix, or a prefix of the tag, as a string or in a list
    Then it is refused with "audience"

  Scenario: Every non-GET route is gated by default
    Given a route table with a GET and a POST route at /api/example, and no per-route wrapping
    When POST /api/example is called on an unconfigured worker instance
    Then the answer is the gate's 503
    And GET and HEAD are answered without the gate
    And UNGATED_ROUTES, the commented allow-list of exemptions, is empty

  Scenario: Keys that cannot be fetched fail closed with a 503
    Given deps.host is "worker", ACCESS_TEAM_DOMAIN and ACCESS_AUD are set
    And the certs endpoint answers 500, or the fetch rejects, or the body is not a key set
    When POST /api/decide/typesafe is called with a well-formed token
    Then the response is a JSON 503 failure saying the signing keys could not be fetched
    And no provider call is made

  Scenario: The explicit opt-out lets the provider call proceed without a token
    Given deps.host is "worker" and ALLOW_UNPROTECTED_INSTANCE is exactly "I accept the bill"
    When POST /api/decide/typesafe is called with no token
    Then the provider is called once and the response is the DecisionSuccess

  Scenario: Access wins over the opt-out when both are set
    Given deps.host is "worker", ACCESS_TEAM_DOMAIN, ACCESS_AUD, and the exact opt-out are all set
    When POST /api/decide/typesafe is called with no token
    Then the response is a 403 and no provider call is made

  Scenario: Local development proceeds without any configuration
    Given deps.host is "node-dev" and no protection variable is set
    When POST /api/decide/typesafe is called with no token
    Then the provider is called once and the response is the DecisionSuccess

  Scenario Outline: GET /api/providers reports the protection state
    Given deps.host is <host> and the variables are <variables>
    When GET /api/providers is called <request>
    Then the 200 body has protection equal to <protection>

    Examples:
      | host     | variables                           | request                | protection                                                           |
      | node-dev | none                                | without a token        | { "mode": "local" }                                                  |
      | worker   | none                                | without a token        | { "mode": "unconfigured", "detail": "<which variables are not set>" } |
      | worker   | the exact opt-out                   | without a token        | { "mode": "opted_out" }                                              |
      | worker   | ACCESS_TEAM_DOMAIN and ACCESS_AUD   | with a valid token     | { "mode": "access", "validated": true }                              |
      | worker   | ACCESS_TEAM_DOMAIN and ACCESS_AUD   | without a token        | { "mode": "access", "validated": false, "problem": "<sentence>" }    |

  Scenario: The 403 and 503 refusals come before the body is read
    Given deps.host is "worker" and nothing is configured
    When POST /api/decide/typesafe is called with a body that is not JSON
    Then the response is the protection 503, not a 400, because the gate runs first

  Scenario: Neither the key nor the token appears anywhere
    Given a key shaped like a real one and a token shaped like a real one
    When every refusal, success, and error path of POST /api/decide/typesafe runs
    Then the response body, the response headers, and every logged line contain neither the key nor the token nor any segment of the token

  Scenario: The team domain is accepted in three spellings and nothing else
    Given ACCESS_TEAM_DOMAIN is "myteam", "myteam.cloudflareaccess.com", or "https://myteam.cloudflareaccess.com/"
    Then the issuer is "https://myteam.cloudflareaccess.com" and the certs URL is that issuer plus /cdn-cgi/access/certs
    But "https://evil.example/", "my team", and "myteam.example.com" leave the instance unconfigured with a detail that names ACCESS_TEAM_DOMAIN and not the value

  Scenario: The UI shows a banner on an unprotected deployed instance
    Given GET /api/providers answers { "mode": "unconfigured", ... }
    When the page loads
    Then #protection-notice is visible, has role "status", and says provider calls are refused until protection is configured
    And it links the deployment guide
    Given GET /api/providers answers { "mode": "opted_out" }
    Then the notice says the instance is unprotected and anyone who reaches it can run up the bill
    Given GET /api/providers answers { "mode": "access", "validated": false, "reason": "token", "problem": "..." }
    Then the notice says Access is configured but this request carried no valid token, and repeats the problem
    Given GET /api/providers answers { "mode": "access", "validated": false, "reason": "keys", "problem": "..." }
    Then the notice says the signing keys could not be fetched and to try again, and does not blame the token
    Given GET /api/providers answers { "mode": "local" } or { "mode": "access", "validated": true }
    Then the notice is empty
    And the role="status" element is in the page, empty and never hidden, from the first paint, so filling it is announced; CSS collapses it with :empty

  Scenario: wrangler.jsonc decides the public hostnames explicitly
    Given the spike found that Wrangler enables workers_dev and preview_urls when neither is set
    Then wrangler.jsonc sets workers_dev to true, because a fork deployed with the button has no other hostname
    And sets preview_urls to false, so no version gets a second public hostname
    And the Worker's check does not depend on the hostname, so a hostname added later is covered too

  Scenario: Documentation
    Then docs/adr/0003-fail-closed-access.md records the default, the host rule, and each Cloudflare fact with its page and date
    And docs/deploy.md's first step after the Deploy button is protecting the instance, with the opt-out and the bill warning

  # Manual steps, run by the coordinator with the owner (they need a deployed scratch Worker, never one named decisionmachines3000).
  Scenario: Live check of the fail-closed default on a scratch deploy
    Given `vp run build` and `vp exec wrangler deploy --name decisionmachines3000-scratch` with one provider key set and no protection variable
    When the scratch URL is opened in Chrome
    Then the page shows the "not protected" banner and GET /api/providers has protection.mode "unconfigured"
    And pressing Run on any panel shows the 503 refusal in the readout, and `wrangler tail` shows no provider call
    When `wrangler secret put ALLOW_UNPROTECTED_INSTANCE` is set to "I accept the bill" and the page is reloaded
    Then the banner says the instance is unprotected on purpose and Run succeeds

  Scenario: Live check of Cloudflare Access on a scratch deploy
    Given the scratch Worker is protected in Workers & Pages > the Worker > Access > "Protect this Worker behind Access", "All traffic", with a policy allowing the owner's email
    And ACCESS_TEAM_DOMAIN and ACCESS_AUD are set from Zero Trust > Access controls > Applications > the created application
    When the owner signs in through Access and opens the page
    Then GET /api/providers has protection { "mode": "access", "validated": true } and Run succeeds
    And a `curl` to POST /api/decide/typesafe from outside the session gets Access's own login redirect, or the Worker's 403 if the hostname is reached without Access
    And no request body, header, or `wrangler tail` line contains the key or the token
    And the scratch Worker is deleted afterwards
