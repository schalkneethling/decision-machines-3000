// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import type { DecisionFailure, DecisionSuccess } from "../decision/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { renderWire, renderWireView } from "./wire-view.ts";

function blocks(response: DecisionSuccess): Record<string, string> {
  const readout = renderWire(response);
  return Object.fromEntries(
    [...readout.querySelectorAll("details")].map((details) => [
      details.querySelector("summary")?.textContent ?? "",
      details.querySelector("pre code")?.textContent ?? "",
    ]),
  );
}

// OpenAI has no adapter yet, so this is a hand-written stand-in shaped like the
// issue describes: `input` plus a `questions` array of named predicates.
const openaiResponse: DecisionSuccess = {
  ...noulResponse,
  provider: "openai",
  wire: {
    request: {
      input: "The ticket text.",
      questions: [
        {
          name: "escalate",
          type: "predicate",
          instructions: "Should this escalate?",
          yes_means: "Escalate it.",
          no_means: "Leave it.",
        },
      ],
    },
    response: { output: [{ name: "escalate", answer: true }] },
  },
};

describe("renderWire", () => {
  it("shows a failure as one open Raw response block with its JSON", () => {
    const failure: DecisionFailure = { ok: false, error: "Nope.", detail: "HTTP 401" };
    const view = renderWire(failure);
    const [details, ...rest] = view.querySelectorAll("details");
    expect(rest).toHaveLength(0);
    expect(details?.open).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("Raw response");
    expect(JSON.parse(details?.querySelector("pre code")?.textContent ?? "")).toEqual(failure);
  });

  it("shows a success as the sent and received blocks, both open", () => {
    const summaries = [...renderWire(noulResponse).querySelectorAll("details")].map((details) => [
      details.open,
      details.querySelector("summary")?.textContent,
    ]);
    expect(summaries).toEqual([
      [true, "Sent to TypeSafe Jev"],
      [true, "Received from TypeSafe Jev"],
    ]);
  });
});

describe("renderWireView", () => {
  it("shows the TypeSafe body with its type and pinned model", () => {
    const sent = JSON.parse(blocks(noulResponse)["Sent to TypeSafe Jev"] ?? "");
    expect(sent.model).toBe("jev-1.13.0");
    expect(
      Object.values(sent.questions).every((q) => (q as { type: string }).type === "noul"),
    ).toBe(true);
    expect(noulResponse.primitive).toBe("noul");
  });

  it("keeps the panel's primitive on a provider whose own vocabulary differs", () => {
    const sent = JSON.parse(blocks(openaiResponse)["Sent to OpenAI Decisions"] ?? "");
    expect(sent.questions[0].type).toBe("predicate");
    expect(sent.questions[0].yes_means).toBe("Escalate it.");
    expect(sent.questions[0].no_means).toBe("Leave it.");
    expect(sent.input).toBe("The ticket text.");
    expect(Array.isArray(sent.questions)).toBe(true);
    expect(sent.questions[0].name).toBe("escalate");
    const received = JSON.parse(blocks(openaiResponse)["Received from OpenAI Decisions"] ?? "");
    expect(received).toEqual({ output: [{ name: "escalate", answer: true }] });
    expect(openaiResponse.primitive).toBe("noul");
  });

  it("shows the provider's own reply body in the received block, not the Worker's reply", () => {
    const received = JSON.parse(blocks(noulResponse)["Received from TypeSafe Jev"] ?? "");
    expect(received).toEqual(noulResponse.wire.response);
    expect(received).not.toHaveProperty("wire");
    expect(received).not.toHaveProperty("ok");
  });

  it("never mentions Authorization in either block", () => {
    for (const text of Object.values(blocks(noulResponse))) {
      expect(text.toLowerCase()).not.toContain("authorization");
    }
  });

  it("renders both blocks open, as read-only text in pre and code", () => {
    const views = renderWireView(noulResponse);
    expect(views).toHaveLength(2);
    for (const details of views) {
      expect(details.open).toBe(true);
      expect(details.querySelector("summary")).not.toBeNull();
      expect(details.querySelector("pre > code")).not.toBeNull();
      expect(details.querySelector("input, textarea, [contenteditable]")).toBeNull();
    }
  });
});
