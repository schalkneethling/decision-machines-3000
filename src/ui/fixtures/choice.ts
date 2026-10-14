import type { DecisionSuccess } from "../../decision/contract.ts";
import { choiceExample } from "../../decision/examples.ts";
import { typesafeWireRequest, typesafeWireResponse } from "./wire.ts";

/**
 * A real TypeSafe Jev answer to `choiceExample` from src/decision/examples.ts,
 * recorded from the old `/api/jev` endpoint and reshaped to the
 * `/api/decide/typesafe` success: `provider` and `wire` added, and the
 * connection fields that success no longer carries removed.
 */
const reading: Omit<DecisionSuccess<"choice">, "wire"> = {
  ok: true,
  primitive: "choice",
  provider: "typesafe",
  model: "jev-1.13.0",
  usage: {
    input_tokens: 1944,
    output_tokens: 487,
  },
  latencyMs: 525,
  answers: {
    film_0: {
      type: "choice",
      choice: "science_fiction",
      confidence: 1,
      probabilities: {
        horror: 0,
        romantic_comedy: 0,
        other: 0,
        crime_mystery: 0,
        science_fiction: 1,
        animation: 0,
        documentary: 0,
      },
    },
    film_1: {
      type: "choice",
      choice: "other",
      confidence: 0.68,
      probabilities: {
        horror: 0,
        romantic_comedy: 0.26,
        other: 0.73,
        crime_mystery: 0,
        science_fiction: 0,
        animation: 0,
        documentary: 0.01,
      },
    },
    film_2: {
      type: "choice",
      choice: "horror",
      confidence: 1,
      probabilities: {
        horror: 1,
        romantic_comedy: 0,
        other: 0,
        crime_mystery: 0,
        science_fiction: 0,
        animation: 0,
        documentary: 0,
      },
    },
    film_3: {
      type: "choice",
      choice: "documentary",
      confidence: 1,
      probabilities: {
        horror: 0,
        romantic_comedy: 0,
        other: 0,
        crime_mystery: 0,
        science_fiction: 0,
        animation: 0,
        documentary: 1,
      },
    },
    film_4: {
      type: "choice",
      choice: "animation",
      confidence: 1,
      probabilities: {
        horror: 0,
        romantic_comedy: 0,
        other: 0,
        crime_mystery: 0,
        science_fiction: 0,
        animation: 1,
        documentary: 0,
      },
    },
    film_5: {
      type: "choice",
      choice: "crime_mystery",
      confidence: 1,
      probabilities: {
        horror: 0,
        romantic_comedy: 0,
        other: 0,
        science_fiction: 0,
        crime_mystery: 1,
        animation: 0,
        documentary: 0,
      },
    },
  },
};

export const choiceResponse: DecisionSuccess<"choice"> = {
  ...reading,
  wire: { request: typesafeWireRequest(choiceExample), response: typesafeWireResponse(reading) },
};
