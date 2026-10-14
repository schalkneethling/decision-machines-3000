// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import type { DecisionSuccess } from "../decision/contract.ts";
import { noulResponse } from "./fixtures/noul.ts";
import { renderResponse } from "./readout.ts";
import { renderWireView } from "./wire-view.ts";

function blocks(response: DecisionSuccess): Record<string, string> {
  const readout = renderResponse({}, response);
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
  },
};

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
    expect(received.primitive).toBe("noul");
  });

  it("leaves the wire record out of the received block and never mentions Authorization", () => {
    const shown = blocks(noulResponse);
    expect(JSON.parse(shown["Received from TypeSafe Jev"] ?? "")).not.toHaveProperty("wire");
    for (const text of Object.values(shown)) {
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
