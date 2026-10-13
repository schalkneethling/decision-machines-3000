import type { DecisionSuccess } from "../../decision/contract.ts";

/** Real `/api/jev` response to `noulExample` from src/decision/examples.ts. */
export const noulResponse: DecisionSuccess<"noul"> = {
  ok: true,
  primitive: "noul",
  model: "jev-1.13.0",
  usage: {
    input_tokens: 452,
    output_tokens: 80,
  },
  latencyMs: 474,
  connection: "reused",
  keepAliveSeconds: 4,
  answers: {
    recommends: {
      type: "noul",
      noul: 0.93,
    },
    reveals_ending: {
      type: "noul",
      noul: 0.97,
    },
    saw_in_theater: {
      type: "noul",
      noul: 0.98,
    },
    complains_about_music: {
      type: "noul",
      noul: 0.98,
    },
  },
};
