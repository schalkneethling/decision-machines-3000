/**
 * The fail-closed gate in front of every route that spends the owner's provider
 * credit (issue #14, ADR-0003).
 *
 * A deployed instance refuses to call a provider until the owner has either put
 * it behind Cloudflare Access and told the Worker which application to expect,
 * or opted out explicitly. The three variables:
 *
 * - `ACCESS_TEAM_DOMAIN`: the Access team, as `team`, `team.cloudflareaccess.com`,
 *   or `https://team.cloudflareaccess.com`.
 * - `ACCESS_AUD`: the Application Audience (AUD) tag of the Access application.
 * - `ALLOW_UNPROTECTED_INSTANCE`: the opt-out. It counts only when set to the
 *   exact sentence `OPT_OUT_VALUE`, so it cannot be set by accident, and Access
 *   wins when both are configured.
 *
 * Which host is calling decides whether the gate applies at all. The Node dev
 * host (`server/vite-host.ts`) exists only inside `vp dev` on the developer's
 * machine, so it says `host: "node-dev"` and is local. workerd says
 * `host: "worker"` and is treated as deployed, because nothing inside workerd
 * tells `wrangler dev` or `vp preview` from Cloudflare, and no request header
 * or hostname may decide it: a stranger controls both. So a local run of the
 * built Worker needs the same configuration a deployment does.
 *
 * Every message names variables, never their values, and never the token.
 */

import type { Protection } from "../src/providers/contract.ts";
import { TOKEN_PROBLEM_SENTENCES, verifyAccessToken, ACCESS_JWT_HEADER } from "./access.ts";
import type { AccessApplication, Verification } from "./access.ts";
import { isKeySet } from "./env.ts";
import type { HandlerDeps } from "./handler.ts";
import { failure } from "./respond.ts";

/** The variables, by role. */
export const PROTECTION_VARS = {
  teamDomain: "ACCESS_TEAM_DOMAIN",
  audience: "ACCESS_AUD",
  optOut: "ALLOW_UNPROTECTED_INSTANCE",
} as const;

export type ProtectionVarName = (typeof PROTECTION_VARS)[keyof typeof PROTECTION_VARS];

/** The protection variables, each optional, as the Worker's `env` carries them. */
export type ProtectionVars = Partial<Record<ProtectionVarName, string>>;

/** The one value that makes the opt-out count, after trimming. */
export const OPT_OUT_VALUE = "I accept the bill";

/** Who is calling `handle`: workerd (deployed or local) or the Node dev host inside `vp dev`. */
export type Host = "worker" | "node-dev";

/** What the environment says, before any request is looked at. */
export type ConfiguredProtection =
  | { mode: "local" }
  | { mode: "access"; application: AccessApplication }
  | { mode: "opted_out" }
  | { mode: "unconfigured"; detail: string };

// ---------------------------------------------------------------------------
// Reading the configuration
// ---------------------------------------------------------------------------

const TEAM_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const ACCESS_SUFFIX = ".cloudflareaccess.com";

/**
 * The issuer for a team domain written as the team name, the host, or the
 * https URL (with or without a trailing slash), or undefined for anything else.
 * A value that is not a Cloudflare Access domain is refused rather than used,
 * so the key fetch can never go to a host the owner did not mean.
 */
export function issuerOf(teamDomain: string): string | undefined {
  let name = teamDomain.trim().toLowerCase();
  if (name.startsWith("https://")) name = name.slice("https://".length).replace(/\/$/, "");
  if (name.endsWith(ACCESS_SUFFIX)) name = name.slice(0, -ACCESS_SUFFIX.length);
  return TEAM_NAME.test(name) ? `https://${name}${ACCESS_SUFFIX}` : undefined;
}

const { teamDomain, audience, optOut } = PROTECTION_VARS;

const NOTHING_SET = `Neither Cloudflare Access (${teamDomain} and ${audience}) nor the opt-out (${optOut}) is set.`;

/** Reads the variables and the host into one state. Non-string values count as not set. */
export function configuredProtection(env: ProtectionVars, host: Host): ConfiguredProtection {
  if (host === "node-dev") return { mode: "local" };

  const team = env[teamDomain];
  const aud = env[audience];
  if (isKeySet(team) || isKeySet(aud)) {
    if (!isKeySet(team)) {
      return { mode: "unconfigured", detail: `${audience} is set, but ${teamDomain} is not.` };
    }
    if (!isKeySet(aud)) {
      return { mode: "unconfigured", detail: `${teamDomain} is set, but ${audience} is not.` };
    }
    const issuer = issuerOf(team);
    if (issuer === undefined) {
      return {
        mode: "unconfigured",
        detail: `${teamDomain} is not a Cloudflare Access team name or team domain.`,
      };
    }
    return { mode: "access", application: { issuer, audience: aud.trim() } };
  }

  const accepted = env[optOut];
  if (isKeySet(accepted)) {
    return accepted.trim() === OPT_OUT_VALUE
      ? { mode: "opted_out" }
      : {
          mode: "unconfigured",
          detail: `${optOut} is set, but not to the exact sentence the deployment guide gives, so it does not count.`,
        };
  }
  return { mode: "unconfigured", detail: NOTHING_SET };
}

// ---------------------------------------------------------------------------
// Applying it to a request
// ---------------------------------------------------------------------------

/** What a refused decision says, besides which variable is wrong. */
export const UNCONFIGURED_MESSAGE =
  "Provider calls are refused until this instance is protected. Put it behind Cloudflare Access and set " +
  `${teamDomain} and ${audience}, or set ${optOut} to accept an unprotected instance. docs/deploy.md explains both.`;

const KEYS_UNAVAILABLE_MESSAGE =
  "The Cloudflare Access signing keys could not be fetched, so no request can be verified right now. " +
  `Check ${teamDomain} and try again.`;

const HOW_TO_GET_A_TOKEN =
  " Open the instance through its Cloudflare Access application; if Access does not cover this hostname, use one it does.";

/** Verifies the request's token against the configured application. */
function verify(
  request: Request,
  application: AccessApplication,
  deps: HandlerDeps,
): Promise<Verification> {
  return verifyAccessToken(request.headers.get(ACCESS_JWT_HEADER), application, deps);
}

/** One log line for a refusal: the status and a problem category, nothing from the request. */
function logRefusal(deps: HandlerDeps, status: number, problem: string): void {
  deps.log(`[api] protection status=${status} problem=${JSON.stringify(problem)}`);
}

/**
 * The refusal for a route that would call a provider, or undefined when the
 * call may proceed. Runs before the body is read, so a refused request costs
 * nothing but this check.
 */
export async function refuseUnprotected(
  request: Request,
  configured: ConfiguredProtection,
  deps: HandlerDeps,
): Promise<Response | undefined> {
  switch (configured.mode) {
    case "local":
    case "opted_out":
      return undefined;
    case "unconfigured":
      logRefusal(deps, 503, "unconfigured");
      return failure(503, UNCONFIGURED_MESSAGE, { detail: configured.detail });
    case "access": {
      const verified = await verify(request, configured.application, deps);
      if (verified.ok) return undefined;
      if (verified.problem === "keys_unavailable") {
        logRefusal(deps, 503, verified.problem);
        return failure(503, KEYS_UNAVAILABLE_MESSAGE, { detail: verified.detail });
      }
      logRefusal(deps, 403, verified.problem);
      const sentence = TOKEN_PROBLEM_SENTENCES[verified.problem];
      return failure(
        403,
        verified.problem === "missing" ? `${sentence}${HOW_TO_GET_A_TOKEN}` : sentence,
      );
    }
  }
}

/**
 * The state `GET /api/providers` reports. In Access mode it says whether this
 * request's own token verified, so the UI can warn when Access is configured
 * but the hostname the viewer used is not behind it.
 */
export async function reportProtection(
  request: Request,
  configured: ConfiguredProtection,
  deps: HandlerDeps,
): Promise<Protection> {
  switch (configured.mode) {
    case "local":
      return { mode: "local" };
    case "opted_out":
      return { mode: "opted_out" };
    case "unconfigured":
      return { mode: "unconfigured", detail: configured.detail };
    case "access": {
      const verified = await verify(request, configured.application, deps);
      if (verified.ok) return { mode: "access", validated: true };
      const problem =
        verified.problem === "keys_unavailable"
          ? KEYS_UNAVAILABLE_MESSAGE
          : TOKEN_PROBLEM_SENTENCES[verified.problem];
      return { mode: "access", validated: false, problem };
    }
  }
}
