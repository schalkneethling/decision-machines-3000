import type { DecisionSuccess } from "../../decision/contract.ts";
import { scoreExample } from "../../decision/examples.ts";
import { typesafeWireRequest, typesafeWireResponse } from "./wire.ts";

/**
 * A real TypeSafe Jev answer to `scoreExample` from src/decision/examples.ts,
 * recorded from the old `/api/jev` endpoint and reshaped to the
 * `/api/decide/typesafe` success: `provider` and `wire` added, and the
 * connection fields, which only the Node dev host sends, left out. Its `wire.response`
 * is rebuilt from those values, not recorded again; `typesafe.test.ts` checks it
 * has the fields of the recordings in `worker/providers/fixtures/typesafe/`.
 */
const reading: Omit<DecisionSuccess<"score">, "wire"> = {
  ok: true,
  primitive: "score",
  provider: "typesafe",
  model: "jev-1.13.0",
  usage: {
    input_tokens: 898,
    output_tokens: 64,
  },
  latencyMs: 511,
  answers: {
    film_0: {
      type: "score",
      score: 0.89,
      confidence: 0.89,
      legend: {
        "0": "Gentle throughout: nothing frightening, violent, or upsetting.",
        "1": "Brief mild peril, slapstick, or a single tense moment that resolves quickly.",
        "2": "Sustained tension, several frightening scenes, or moderate violence without gore.",
        "3": "Graphic violence, gore, or disturbing themes shown in detail.",
      },
      probabilities: {
        "0": 0.11,
        "1": 0.89,
        "2": 0,
        "3": 0,
      },
    },
    film_1: {
      type: "score",
      score: 0.99,
      confidence: 0.96,
      legend: {
        "0": "Gentle throughout: nothing frightening, violent, or upsetting.",
        "1": "Brief mild peril, slapstick, or a single tense moment that resolves quickly.",
        "2": "Sustained tension, several frightening scenes, or moderate violence without gore.",
        "3": "Graphic violence, gore, or disturbing themes shown in detail.",
      },
      probabilities: {
        "0": 0.02,
        "1": 0.97,
        "2": 0.01,
        "3": 0,
      },
    },
    film_2: {
      type: "score",
      score: 2,
      confidence: 1,
      legend: {
        "0": "Gentle throughout: nothing frightening, violent, or upsetting.",
        "1": "Brief mild peril, slapstick, or a single tense moment that resolves quickly.",
        "2": "Sustained tension, several frightening scenes, or moderate violence without gore.",
        "3": "Graphic violence, gore, or disturbing themes shown in detail.",
      },
      probabilities: {
        "0": 0,
        "1": 0,
        "2": 1,
        "3": 0,
      },
    },
    film_3: {
      type: "score",
      score: 3,
      confidence: 1,
      legend: {
        "0": "Gentle throughout: nothing frightening, violent, or upsetting.",
        "1": "Brief mild peril, slapstick, or a single tense moment that resolves quickly.",
        "2": "Sustained tension, several frightening scenes, or moderate violence without gore.",
        "3": "Graphic violence, gore, or disturbing themes shown in detail.",
      },
      probabilities: {
        "0": 0,
        "1": 0,
        "2": 0,
        "3": 1,
      },
    },
  },
};

export const scoreResponse: DecisionSuccess<"score"> = {
  ...reading,
  wire: { request: typesafeWireRequest(scoreExample), response: typesafeWireResponse(reading) },
};
