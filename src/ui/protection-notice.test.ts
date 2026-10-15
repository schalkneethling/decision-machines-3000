// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import type { Protection } from "../providers/contract.ts";
import { DEPLOYMENT_GUIDE_URL, renderProtectionNotice } from "./protection-notice.ts";

let notice: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '<p id="protection-notice" role="status" hidden></p>';
  notice = document.querySelector("#protection-notice") as HTMLElement;
});

describe("renderProtectionNotice", () => {
  it("says runs are refused on an unconfigured instance, with the server's detail and the guide", () => {
    const protection: Protection = {
      mode: "unconfigured",
      detail: "Neither Cloudflare Access (A and B) nor the opt-out (C) is set.",
    };

    renderProtectionNotice(notice, protection);

    expect(notice.hidden).toBe(false);
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

    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("unprotected on purpose");
    expect(notice.textContent).toContain("run up the provider bill");
    expect(notice.querySelector("a")?.getAttribute("href")).toBe(DEPLOYMENT_GUIDE_URL);
  });

  it("explains an Access request that did not validate, repeating the server's problem", () => {
    renderProtectionNotice(notice, {
      mode: "access",
      validated: false,
      problem: "This request carried no Cloudflare Access token.",
    });

    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toBe(
      "Cloudflare Access is configured, but this request did not carry a valid Access token, so provider calls will be refused. This request carried no Cloudflare Access token. See the deployment guide.",
    );
  });

  it.each<[string, Protection | undefined]>([
    ["a local instance", { mode: "local" }],
    ["a validated Access request", { mode: "access", validated: true }],
    ["no list at all", undefined],
  ])("stays hidden and empty for %s", (_name, protection) => {
    renderProtectionNotice(notice, { mode: "opted_out" });

    renderProtectionNotice(notice, protection);

    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe("");
  });

  it("keeps the role=status element itself, so a later change is announced", () => {
    renderProtectionNotice(notice, { mode: "opted_out" });

    expect(document.querySelector("#protection-notice")).toBe(notice);
    expect(notice.getAttribute("role")).toBe("status");
  });
});
