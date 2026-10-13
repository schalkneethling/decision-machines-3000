/**
 * Spike Worker for the workerd check: runs schema 1 and schema 2 (Zod Mini) inside
 * the Workers runtime and reports the results as JSON. Local only:
 *
 *   vp exec wrangler dev -c spikes/schema-library/worker/wrangler.zod-mini.jsonc --port 8792
 *   curl -s http://localhost:8792/
 *
 * The two Worker entries in this folder differ only in their import paths.
 */

import { examples } from "../../../src/decision/examples.ts";
import openaiThree from "../../../worker/providers/fixtures/openai/three-types.json";
import subqThree from "../../../worker/providers/fixtures/subq/three-types.json";
import typesafeChoice from "../../../worker/providers/fixtures/typesafe/choice.json";
import { typesafe } from "../../../src/providers/catalog.ts";
import * as provider from "../zod-mini/provider.ts";
import { validateDecisionRequest } from "../zod-mini/request.ts";

export default {
  fetch(): Response {
    const { capabilities } = typesafe;
    return Response.json({
      library: "zod-mini",
      runtime: navigator.userAgent,
      schema1: {
        accepts: Object.fromEntries(
          Object.entries(examples).map(([name, example]) => [
            name,
            validateDecisionRequest(example, capabilities).ok,
          ]),
        ),
        rejects: validateDecisionRequest({ ...examples.noul, primitive: "rank" }, capabilities),
      },
      schema2: {
        typesafeChoice: provider.describeParse(provider.jevDecision, typesafeChoice.body),
        subqThreeTypes: provider.describeParse(provider.jevDecision, subqThree.body),
        openaiThreeTypes: provider.describeParse(provider.openaiDecision, openaiThree.body),
        broken: provider.describeParse(provider.jevDecision, {
          ...typesafeChoice.body,
          usage: "none",
        }),
      },
    });
  },
};
