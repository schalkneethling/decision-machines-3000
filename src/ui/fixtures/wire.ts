import type { DecisionRequest, DecisionSuccess, JsonValue } from "../../decision/contract.ts";
import { typesafe } from "../../providers/catalog.ts";

/**
 * The wire request TypeSafe's adapter builds for a request: the pinned model,
 * the state, and each question typed as the request's primitive, with its
 * criteria taken from itself or the request default. It is written out here
 * so the browser's fixtures need no Worker code, and
 * `worker/providers/typesafe.test.ts` checks it against the adapter's own `toWire`.
 */
export function typesafeWireRequest(request: DecisionRequest): Record<string, JsonValue> {
  const questions: Record<string, JsonValue> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const criteria = question.criteria ?? request.criteria;
    questions[id] =
      criteria === undefined
        ? { type: request.primitive, instructions: question.instructions }
        : { type: request.primitive, instructions: question.instructions, criteria };
  }
  return { model: typesafe.model, state: request.state, questions };
}

/**
 * The reply body TypeSafe sends for a success: the model, the answers, and the
 * usage. It is built from the fixture's own values, so `typesafe.test.ts` compares
 * its fields with the recorded replies and reads it back through `fromWire`.
 */
export function typesafeWireResponse(
  reading: Pick<DecisionSuccess, "model" | "answers" | "usage">,
): Record<string, JsonValue> {
  const { model, answers, usage } = reading;
  return { model, answers, usage };
}
