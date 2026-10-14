import type { DecisionSuccess } from "../../decision/contract.ts";
import { noulExample } from "../../decision/examples.ts";
import { typesafeWireRequest, typesafeWireResponse } from "./wire.ts";

/**
 * A real TypeSafe Jev answer to `noulExample` from src/decision/examples.ts,
 * recorded from the old `/api/jev` endpoint and reshaped to the
 * `/api/decide/typesafe` success: `provider` and `wire` added, and the
 * connection fields that success no longer carries removed.
 */
const reading: Omit<DecisionSuccess<"noul">, "wire"> = {
  ok: true,
  primitive: "noul",
  provider: "typesafe",
  model: "jev-1.13.0",
  usage: {
    input_tokens: 452,
    output_tokens: 80,
  },
  latencyMs: 474,
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

export const noulResponse: DecisionSuccess<"noul"> = {
  ...reading,
  wire: { request: typesafeWireRequest(noulExample), response: typesafeWireResponse(reading) },
};
