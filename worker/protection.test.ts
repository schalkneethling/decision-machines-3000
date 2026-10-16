import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import type { DecisionRequest } from "../src/decision/contract.ts";
import { ACCESS_JWT_HEADER, TOKEN_PROBLEM_SENTENCES, certsUrl } from "./access.ts";
import type { AccessApplication } from "./access.ts";
import {
  accessClaims,
  createSigner,
  keySetBody,
  nowSeconds,
  signToken,
  toBase64Url,
} from "./fixtures/access-tokens.ts";
import type { Signer } from "./fixtures/access-tokens.ts";
import { UNGATED_ROUTES, handle, handleRoutes } from "./handler.ts";
import type { HandlerDeps, HandlerEnv } from "./handler.ts";
import {
  OPT_OUT_VALUE,
  PROTECTION_VARS,
  UNCONFIGURED_MESSAGE,
  configuredProtection,
  issuerOf,
} from "./protection.ts";
import type { Host } from "./protection.ts";

/*
 * The fail-closed gate, driven through `handle` as the Worker would: `deps.host`
 * is `"worker"` unless a test says otherwise, so every request here is a
 * deployed one until proven local.
 */

const ORIGIN = "https://decisionmachines3000.example";

/** Shaped like a real key, never a real one. It must appear in no response or log. */
const TYPESAFE_KEY = "sk-protection-test-0123456789abcdef";
const AUD = "0123456789abcdef".repeat(4);
const APPLICATION: AccessApplication = {
  issuer: "https://myteam.cloudflareaccess.com",
  audience: AUD,
};

const keyOnly: HandlerEnv = { TYPESAFE_API_KEY: TYPESAFE_KEY };
const withAccess: HandlerEnv = { ...keyOnly, ACCESS_TEAM_DOMAIN: "myteam", ACCESS_AUD: AUD };
const optedOut: HandlerEnv = { ...keyOnly, ALLOW_UNPROTECTED_INSTANCE: OPT_OUT_VALUE };

const yesNo: DecisionRequest<"noul"> = {
  primitive: "noul",
  state: "Patient with asthma reports a sore throat and shortness of breath.",
  questions: {
    escalate: {
      instructions: "Should a nurse see this chat before the patient books anything?",
      criteria: { true: "Breathing trouble", false: "Stable symptoms" },
    },
  },
};

/** The success body of `providers/fixtures/typesafe/noul.json`. */
const recordedNoulReply = {
  model: "jev-1.13.0",
  answers: { escalate: { type: "noul", noul: 0.92 } },
  usage: { input_tokens: 343, output_tokens: 22 },
};

let signer: Signer;
let stranger: Signer;

beforeAll(async () => {
  [signer, stranger] = await Promise.all([createSigner("team-key"), createSigner("stranger-key")]);
});

type StubDeps = HandlerDeps & { fetch: Mock<typeof fetch>; log: Mock<(line: string) => void> };

/**
 * Dependencies for one request. `fetch` answers the certs URL with the team's
 * key set and every other URL, the provider's, with the recorded reply, so a
 * test can tell the two calls apart by URL.
 */
function stubDeps(host: Host = "worker", certs: () => Promise<Response> = teamKeys): StubDeps {
  return {
    host,
    fetch: vi.fn((input: RequestInfo | URL) =>
      urlOf(input) === certsUrl(APPLICATION.issuer)
        ? certs()
        : Promise.resolve(Response.json(recordedNoulReply)),
    ),
    timeoutSignal: vi.fn((_ms: number) => new AbortController().signal),
    log: vi.fn((_line: string) => {}),
  };
}

/** The URL a `fetch` call was made with, whatever form the caller used. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function teamKeys(): Promise<Response> {
  return Promise.resolve(Response.json(keySetBody(signer)));
}

/** The calls `deps.fetch` made, by what they were: the certs fetch or the provider call. */
function fetched(deps: StubDeps): { certs: number; provider: number } {
  const urls = deps.fetch.mock.calls.map(([input]) => urlOf(input));
  const certs = urls.filter((url) => url === certsUrl(APPLICATION.issuer)).length;
  return { certs, provider: urls.length - certs };
}

function decideRequest(token?: string, body: BodyInit = JSON.stringify(yesNo)): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers[ACCESS_JWT_HEADER] = token;
  return new Request(`${ORIGIN}/api/decide/typesafe`, { method: "POST", headers, body });
}

function providersRequest(token?: string): Request {
  return new Request(`${ORIGIN}/api/providers`, {
    headers: token === undefined ? {} : { [ACCESS_JWT_HEADER]: token },
  });
}

async function run(request: Request, env: HandlerEnv, deps: StubDeps) {
  const response = await handle(request, env, deps);
  const text = await response.text();
  const headers = [...response.headers].flat().join("\n");
  const log = deps.log.mock.calls.map(([line]) => line).join("\n");
  return { response, text, headers, log, body: JSON.parse(text) as Record<string, unknown> };
}

function validToken(): Promise<string> {
  return signToken(signer, accessClaims(APPLICATION));
}

/** Asserts that neither the key nor the token, nor any dot-separated part of the token, leaked. */
function expectNoSecret(
  answer: { text: string; headers: string; log: string },
  token?: string,
): void {
  const secrets = [TYPESAFE_KEY, ...(token === undefined ? [] : [token, ...token.split(".")])];
  for (const where of [answer.text, answer.headers, answer.log]) {
    for (const secret of secrets) expect(where).not.toContain(secret);
  }
}

const { teamDomain, audience, optOut } = PROTECTION_VARS;

describe("configuredProtection", () => {
  it("is local for the Node dev host whatever the variables say", () => {
    expect(configuredProtection({}, "node-dev")).toEqual({ mode: "local" });
    expect(configuredProtection(withAccess, "node-dev")).toEqual({ mode: "local" });
  });

  it("is unconfigured for the Worker when nothing is set, naming all three variables", () => {
    const state = configuredProtection({}, "worker");

    expect(state.mode).toBe("unconfigured");
    const detail = (state as { detail: string }).detail;
    expect(detail).toContain(teamDomain);
    expect(detail).toContain(audience);
    expect(detail).toContain(optOut);
  });

  it.each([
    ["the team domain", { ACCESS_TEAM_DOMAIN: "myteam" }, audience],
    ["the audience", { ACCESS_AUD: AUD }, teamDomain],
  ])("is unconfigured with only %s set, naming the one that is missing", (_name, env, missing) => {
    expect(configuredProtection(env, "worker")).toEqual({
      mode: "unconfigured",
      detail: expect.stringContaining(`${missing} is not`) as string,
    });
  });

  it.each([
    "myteam",
    "MyTeam",
    "myteam.cloudflareaccess.com",
    "https://myteam.cloudflareaccess.com",
    "https://myteam.cloudflareaccess.com/",
    " myteam ",
  ])("reads the team domain %j as the issuer https://myteam.cloudflareaccess.com", (value) => {
    expect(issuerOf(value)).toBe("https://myteam.cloudflareaccess.com");
    expect(
      configuredProtection({ ACCESS_TEAM_DOMAIN: value, ACCESS_AUD: ` ${AUD} ` }, "worker"),
    ).toEqual({
      mode: "access",
      application: APPLICATION,
    });
  });

  it.each([
    "https://evil.example/",
    "myteam.example.com",
    "my team",
    "https://myteam.cloudflareaccess.com/cdn-cgi",
    "myteam.cloudflareaccess.com.evil.example",
    "-myteam",
    "",
    "http://myteam.cloudflareaccess.com",
  ])("refuses the team domain %j and names the variable, not the value", (value) => {
    expect(issuerOf(value)).toBeUndefined();
    const state = configuredProtection({ ACCESS_TEAM_DOMAIN: value, ACCESS_AUD: AUD }, "worker");

    expect(state.mode).toBe("unconfigured");
    const detail = (state as { detail: string }).detail;
    expect(detail).toContain(teamDomain);
    if (value.trim() !== "") expect(detail).not.toContain(value.trim());
  });

  it.each(["unset", " UNSET ", "", "  "])(
    "treats %j as an absent variable, like a provider key",
    (value) => {
      expect(
        configuredProtection({ ACCESS_TEAM_DOMAIN: value, ACCESS_AUD: value }, "worker"),
      ).toEqual(configuredProtection({}, "worker"));
      expect(configuredProtection({ ALLOW_UNPROTECTED_INSTANCE: value }, "worker")).toEqual(
        configuredProtection({}, "worker"),
      );
    },
  );

  it("is opted out only for the exact sentence, after trimming", () => {
    expect(configuredProtection({ ALLOW_UNPROTECTED_INSTANCE: OPT_OUT_VALUE }, "worker")).toEqual({
      mode: "opted_out",
    });
    expect(
      configuredProtection({ ALLOW_UNPROTECTED_INSTANCE: ` ${OPT_OUT_VALUE}\n` }, "worker"),
    ).toEqual({
      mode: "opted_out",
    });
  });

  it.each(["yes", "true", "1", "i accept the bill", "I accept the bill."])(
    "is unconfigured for the opt-out value %j, saying the sentence is not exact",
    (value) => {
      expect(configuredProtection({ ALLOW_UNPROTECTED_INSTANCE: value }, "worker")).toEqual({
        mode: "unconfigured",
        detail: expect.stringContaining(
          `${optOut} is set, but not to the exact sentence`,
        ) as string,
      });
    },
  );

  it("lets Access win when both Access and the opt-out are set", () => {
    expect(configuredProtection({ ...withAccess, ...optedOut }, "worker")).toEqual({
      mode: "access",
      application: APPLICATION,
    });
  });

  it("treats a value that is not a string as absent", () => {
    const env = { ACCESS_TEAM_DOMAIN: 42, ACCESS_AUD: true } as unknown as HandlerEnv;

    expect(configuredProtection(env, "worker")).toEqual(configuredProtection({}, "worker"));
  });
});

describe("the gate applies to every spending route", () => {
  /** A table with one route of each kind, as a future change might add. */
  const routes = {
    "/api/example": {
      GET: () => Promise.resolve(Response.json({ ok: true, free: true })),
      POST: () => Promise.resolve(Response.json({ ok: true, spent: true })),
    },
  };

  function example(method: string): Request {
    return new Request(`${ORIGIN}/api/example`, { method });
  }

  it("gates a POST route in the table on an unconfigured instance, with no per-route wrapping", async () => {
    const deps = stubDeps();

    const response = await handleRoutes(routes, example("POST"), keyOnly, deps);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, error: UNCONFIGURED_MESSAGE });
  });

  it("lets the same POST route answer for the local host", async () => {
    const response = await handleRoutes(routes, example("POST"), keyOnly, stubDeps("node-dev"));

    expect(await response.json()).toEqual({ ok: true, spent: true });
  });

  it.each(["GET", "HEAD"])("does not gate %s, which spends nothing", async (method) => {
    const response = await handleRoutes(routes, example(method), keyOnly, stubDeps());

    expect(response.status).toBe(200);
  });

  it("exempts no route today", () => {
    expect(UNGATED_ROUTES.size).toBe(0);
  });
});

describe("POST /api/decide/{provider} on a deployed instance", () => {
  it("is unconfigured when the team is set and the audience is an empty string", () => {
    expect(
      configuredProtection({ ACCESS_TEAM_DOMAIN: "myteam", ACCESS_AUD: "" }, "worker"),
    ).toEqual({ mode: "unconfigured", detail: `${teamDomain} is set, but ${audience} is not.` });
  });

  it("refuses an unconfigured instance with a 503 that says how to fix it, calling no provider", async () => {
    const deps = stubDeps();

    const answer = await run(decideRequest(), keyOnly, deps);

    expect(answer.response.status).toBe(503);
    expect(answer.body).toEqual({
      ok: false,
      error: UNCONFIGURED_MESSAGE,
      detail: expect.any(String) as string,
    });
    for (const name of [teamDomain, audience, optOut]) expect(answer.body.error).toContain(name);
    expect(answer.body.error).toContain("docs/deploy.md");
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(
      '[api] protection status=503 problem="unconfigured"',
    );
    expectNoSecret(answer);
  });

  it("refuses half an Access configuration with a detail naming the missing variable", async () => {
    const deps = stubDeps();

    const answer = await run(decideRequest(), { ...keyOnly, ACCESS_TEAM_DOMAIN: "myteam" }, deps);

    expect(answer.response.status).toBe(503);
    expect(answer.body.detail).toBe(`${teamDomain} is set, but ${audience} is not.`);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses an opt-out with the wrong value", async () => {
    const deps = stubDeps();

    const answer = await run(
      decideRequest(),
      { ...keyOnly, ALLOW_UNPROTECTED_INSTANCE: "yes" },
      deps,
    );

    expect(answer.response.status).toBe(503);
    expect(answer.body.detail).toContain(optOut);
    expect(answer.text).not.toContain('"yes"');
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses before reading the body, so an unreadable body still gets the protection 503", async () => {
    const deps = stubDeps();

    const answer = await run(decideRequest(undefined, "not json"), keyOnly, deps);

    expect(answer.response.status).toBe(503);
    expect(answer.body.error).toBe(UNCONFIGURED_MESSAGE);
  });

  it("refuses a request with no Access token with a 403, fetching neither keys nor provider", async () => {
    const deps = stubDeps();

    const answer = await run(decideRequest(), withAccess, deps);

    expect(answer.response.status).toBe(403);
    expect(answer.body).toEqual({
      ok: false,
      error: expect.stringContaining(TOKEN_PROBLEM_SENTENCES.missing) as string,
    });
    expect(answer.body.error).toContain("Cloudflare Access application");
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith(
      '[api] protection status=403 problem="missing"',
    );
  });

  it("lets a valid token through: one keys fetch, one provider call, the DecisionSuccess", async () => {
    const deps = stubDeps();
    const token = await validToken();

    const answer = await run(decideRequest(token), withAccess, deps);

    expect(answer.response.status).toBe(200);
    expect(answer.body).toMatchObject({
      ok: true,
      provider: "typesafe",
      answers: { escalate: { type: "noul", noul: 0.92 } },
    });
    expect(fetched(deps)).toEqual({ certs: 1, provider: 1 });
    expectNoSecret(answer, token);
  });

  it.each([
    [
      "malformed (two parts)",
      () =>
        Promise.resolve(
          `${toBase64Url('{"alg":"RS256","kid":"team-key"}')}.${toBase64Url('{"exp":1}')}`,
        ),
      "malformed",
    ],
    [
      "unsigned (alg none)",
      () => signToken(signer, accessClaims(APPLICATION), { alg: "none", kid: signer.kid }),
      "algorithm",
    ],
    [
      "HMAC-signed (alg HS256)",
      () => signToken(signer, accessClaims(APPLICATION), { alg: "HS256", kid: signer.kid }),
      "algorithm",
    ],
    [
      "signed by an unlisted key",
      () => signToken(stranger, accessClaims(APPLICATION)),
      "unknown_key",
    ],
    [
      "signed by another key under the team's kid",
      () => signToken(stranger, accessClaims(APPLICATION), { alg: "RS256", kid: signer.kid }),
      "signature",
    ],
    [
      "expired",
      () => signToken(signer, accessClaims(APPLICATION, { exp: nowSeconds() - 1 })),
      "expired",
    ],
    [
      "not yet valid",
      () => signToken(signer, accessClaims(APPLICATION, { nbf: nowSeconds() + 600 })),
      "not_yet_valid",
    ],
    [
      "for another audience",
      () => signToken(signer, accessClaims(APPLICATION, { aud: ["f".repeat(64)] })),
      "audience",
    ],
    [
      "from another team",
      () =>
        signToken(signer, accessClaims(APPLICATION, { iss: "https://other.cloudflareaccess.com" })),
      "issuer",
    ],
  ] as const)(
    "refuses a token that is %s with a 403, no provider call, and no echo",
    async (_name, make, problem) => {
      const deps = stubDeps();
      const token = await make();

      const answer = await run(decideRequest(token), withAccess, deps);

      expect(answer.response.status).toBe(403);
      expect(answer.body).toEqual({ ok: false, error: TOKEN_PROBLEM_SENTENCES[problem] });
      expect(fetched(deps).provider).toBe(0);
      expect(deps.log).toHaveBeenCalledExactlyOnceWith(
        `[api] protection status=403 problem=${JSON.stringify(problem)}`,
      );
      expectNoSecret(answer, token);
    },
  );

  it.each([
    ["answers 500", () => Promise.resolve(new Response("busy", { status: 500 })), "status 500"],
    ["is unreachable", () => Promise.reject(new TypeError("fetch failed")), "TypeError"],
    [
      "publishes something else",
      () => Promise.resolve(Response.json({ hello: "world" })),
      "body is not a key set",
    ],
  ])("fails closed with a 503 when the certs endpoint %s", async (_name, certs, detail) => {
    const deps = stubDeps("worker", certs);
    const token = await validToken();

    const answer = await run(decideRequest(token), withAccess, deps);

    expect(answer.response.status).toBe(503);
    expect(answer.body).toEqual({
      ok: false,
      error: expect.stringContaining("signing keys could not be fetched") as string,
      detail,
    });
    expect(answer.body.error).toContain(teamDomain);
    expect(fetched(deps)).toEqual({ certs: 1, provider: 0 });
    expectNoSecret(answer, token);
  });

  it("lets the explicit opt-out through without a token", async () => {
    const deps = stubDeps();

    const answer = await run(decideRequest(), optedOut, deps);

    expect(answer.response.status).toBe(200);
    expect(fetched(deps)).toEqual({ certs: 0, provider: 1 });
    expectNoSecret(answer);
  });

  it("applies Access, not the opt-out, when both are set", async () => {
    const deps = stubDeps();

    const answer = await run(decideRequest(), { ...withAccess, ...optedOut }, deps);

    expect(answer.response.status).toBe(403);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("lets the Node dev host through with nothing configured and no token", async () => {
    const deps = stubDeps("node-dev");

    const answer = await run(decideRequest(), keyOnly, deps);

    expect(answer.response.status).toBe(200);
    expect(fetched(deps)).toEqual({ certs: 0, provider: 1 });
  });

  it("refuses even an unknown provider id on an unconfigured instance, because the gate runs first", async () => {
    const deps = stubDeps();

    const response = await handle(
      new Request(`${ORIGIN}/api/decide/nobody`, { method: "POST" }),
      keyOnly,
      deps,
    );

    // Without the gate this would be the 404; the gate answers before the route looks at the id.
    expect(response.status).toBe(503);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /api/providers reports the protection state", () => {
  it.each([
    ["node-dev", keyOnly, undefined, { mode: "local" }],
    ["worker", optedOut, undefined, { mode: "opted_out" }],
  ] as const)("for host %s", async (host, env, token, protection) => {
    const answer = await run(providersRequest(token), env, stubDeps(host));

    expect(answer.response.status).toBe(200);
    expect(answer.body.protection).toEqual(protection);
  });

  it("reports unconfigured with the detail, and still lists the providers", async () => {
    const answer = await run(providersRequest(), keyOnly, stubDeps());

    expect(answer.response.status).toBe(200);
    expect(answer.body.protection).toEqual({
      mode: "unconfigured",
      detail: expect.stringContaining(optOut) as string,
    });
    expect(answer.body.providers).toHaveLength(1);
  });

  it("reports a validated Access request", async () => {
    const deps = stubDeps();

    const answer = await run(providersRequest(await validToken()), withAccess, deps);

    expect(answer.body.protection).toEqual({ mode: "access", validated: true });
    expect(fetched(deps)).toEqual({ certs: 1, provider: 0 });
  });

  it("reports an Access request that carried no token, with the problem, and lists the providers", async () => {
    const deps = stubDeps();

    const answer = await run(providersRequest(), withAccess, deps);

    expect(answer.response.status).toBe(200);
    expect(answer.body.protection).toEqual({
      mode: "access",
      validated: false,
      reason: "token",
      problem: TOKEN_PROBLEM_SENTENCES.missing,
    });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("reports an expired token as not validated, without echoing it", async () => {
    const token = await signToken(signer, accessClaims(APPLICATION, { exp: nowSeconds() - 5 }));

    const answer = await run(providersRequest(token), withAccess, stubDeps());

    expect(answer.body.protection).toEqual({
      mode: "access",
      validated: false,
      reason: "token",
      problem: TOKEN_PROBLEM_SENTENCES.expired,
    });
    expectNoSecret(answer, token);
  });

  it("reports keys that could not be fetched apart from a token problem", async () => {
    const deps = stubDeps("worker", () => Promise.resolve(new Response("busy", { status: 503 })));

    const answer = await run(providersRequest(await validToken()), withAccess, deps);

    expect(answer.response.status).toBe(200);
    expect(answer.body.protection).toEqual({
      mode: "access",
      validated: false,
      reason: "keys",
      problem: expect.stringContaining("signing keys could not be fetched") as string,
    });
  });

  it("answers HEAD with the GET headers and no body, gate included", async () => {
    const response = await handle(
      new Request(`${ORIGIN}/api/providers`, { method: "HEAD" }),
      withAccess,
      stubDeps(),
    );

    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
  });
});
