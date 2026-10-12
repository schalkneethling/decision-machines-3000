import type { DecisionSuccess } from "../../decision/contract.ts";

/** Real `/api/jev` response to `scoreExample` from src/decision/examples.ts. */
export const scoreResponse: DecisionSuccess<"score"> = {
  ok: true,
  primitive: "score",
  model: "jev-1.13.0",
  usage: {
    input_tokens: 898,
    output_tokens: 64,
  },
  latencyMs: 511,
  connection: "reused",
  keepAliveSeconds: 4,
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
