import type { Protection } from "../providers/contract.ts";
import { create } from "./dom.ts";

/**
 * The protection notice: what a viewer of a deployed instance needs to know
 * about the fail-closed default (ADR-0003). It fills `#protection-notice`, a
 * `role="status"` element that stays in the page, when the instance refuses
 * runs, runs them for anyone, or has Access configured but not on the hostname
 * the viewer used. It stays hidden for a local instance and for a request that
 * Access validated.
 */

/** Where the notices send the owner: the deployment guide, which covers keys and protection. */
export const DEPLOYMENT_GUIDE_URL =
  "https://github.com/schalkneethling/jev-3000/blob/main/docs/deploy.md";

/** The sentences for a state that needs a notice, or undefined when none does. */
function sentencesFor(protection: Protection | undefined): string | undefined {
  switch (protection?.mode) {
    case "unconfigured":
      return `This instance is not protected, so provider calls are refused. ${protection.detail}`;
    case "opted_out":
      return "This instance is unprotected on purpose: anyone who can reach it can run up the provider bill.";
    case "access":
      return protection.validated
        ? undefined
        : `Cloudflare Access is configured, but this request did not carry a valid Access token, so provider calls will be refused. ${protection.problem ?? ""}`.trimEnd();
    default:
      return undefined;
  }
}

/** Fills or hides `notice` for `protection`. `undefined` means no list arrived, so there is nothing to say. */
export function renderProtectionNotice(
  notice: HTMLElement,
  protection: Protection | undefined,
): void {
  const sentences = sentencesFor(protection);
  notice.replaceChildren();
  notice.hidden = sentences === undefined;
  if (sentences === undefined) return;
  notice.append(
    `${sentences} See the `,
    create("a", {
      text: "deployment guide",
      attributes: { href: DEPLOYMENT_GUIDE_URL, rel: "noreferrer" },
    }),
    ".",
  );
}
