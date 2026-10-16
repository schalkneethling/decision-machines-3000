// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { Protection } from "../providers/contract.ts";
import { DEPLOYMENT_GUIDE_URL, renderProtectionNotice } from "./protection-notice.ts";

let notice: HTMLElement;

beforeEach(() => {
  // As index.html has it: in the page from the start, empty, and never `hidden`.
  document.body.innerHTML =
    '<p id="protection-notice" class="protection-notice" role="status"></p>';
  notice = document.querySelector("#protection-notice") as HTMLElement;
});

/** The element's attributes, so a test can show that filling it touched nothing else. */
function attributesOf(element: HTMLElement): Record<string, string> {
  return Object.fromEntries([...element.attributes].map((attr) => [attr.name, attr.value]));
}

describe("renderProtectionNotice", () => {
  it("says runs are refused on an unconfigured instance, with the server's detail and the guide", () => {
    const protection: Protection = {
      mode: "unconfigured",
      detail: "Neither Cloudflare Access (A and B) nor the opt-out (C) is set.",
    };

    renderProtectionNotice(notice, protection);

    expect(notice.textContent).toBe(
      "This instance is not protected, so provider calls are refused. Neither Cloudflare Access (A and B) nor the opt-out (C) is set. See the deployment guide.",
    );
    const link = notice.querySelector("a");
    expect(link?.textContent).toBe("deployment guide");
    expect(link?.getAttribute("href")).toBe(DEPLOYMENT_GUIDE_URL);
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("warns that an opted-out instance runs for anyone", () => {
    renderProtectionNotice(notice, { mode: "opted_out" });

    expect(notice.textContent).toContain("unprotected on purpose");
    expect(notice.textContent).toContain("run up the provider bill");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(DEPLOYMENT_GUIDE_URL);
  });

  it("explains an Access request whose token did not validate, repeating the server's problem", () => {
    renderProtectionNotice(notice, {
      mode: "access",
      validated: false,
      reason: "token",
      problem: "This request carried no Cloudflare Access token.",
    });

    expect(notice.textContent).toBe(
      "Cloudflare Access is configured, but this request did not carry a valid Access token, so provider calls will be refused. This request carried no Cloudflare Access token. See the deployment guide.",
    );
  });

  it("blames the keys, not the token, when the signing keys could not be fetched", () => {
    renderProtectionNotice(notice, {
      mode: "access",
      validated: false,
      reason: "keys",
      problem: "The Cloudflare Access signing keys could not be fetched. Check ACCESS_TEAM_DOMAIN.",
    });

    expect(notice.textContent).toBe(
      "Cloudflare Access is configured, but its signing keys could not be fetched, so provider calls will be refused until they can. Try again in a moment. The Cloudflare Access signing keys could not be fetched. Check ACCESS_TEAM_DOMAIN. See the deployment guide.",
    );
    expect(notice.textContent).not.toContain("did not carry a valid Access token");
  });

  it.each<[string, Protection | undefined]>([
    ["a local instance", { mode: "local" }],
    ["a validated Access request", { mode: "access", validated: true }],
    ["no list at all", undefined],
  ])("is emptied, and stays in the accessibility tree, for %s", (_name, protection) => {
    renderProtectionNotice(notice, { mode: "opted_out" });

    renderProtectionNotice(notice, protection);

    expect(notice.textContent).toBe("");
    expect(notice.hidden).toBe(false);
    expect(notice.hasAttribute("hidden")).toBe(false);
  });

  it("is in the accessibility tree while empty, before anything fills it", () => {
    expect(notice.hidden).toBe(false);
    expect(notice.hasAttribute("hidden")).toBe(false);
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe("");
  });

  it("changes only the element's content when it fills it, so the live region is the same node", () => {
    const before = attributesOf(notice);

    renderProtectionNotice(notice, { mode: "opted_out" });

    expect(document.querySelector("#protection-notice")).toBe(notice);
    expect(attributesOf(notice)).toEqual(before);
    expect(notice.hidden).toBe(false);
  });
});
