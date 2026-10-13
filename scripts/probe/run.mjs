/**
 * Live probe of the three decision providers (TypeSafe Jev, SubQ Snap, OpenAI
 * Decisions). It sends a small, fixed set of requests, saves each exchange as a
 * sanitised fixture under `worker/providers/fixtures/<provider>/<case>.json`,
 * and finishes by reading the fixture files back from disk to check that no key
 * value appears in any of them. Each fixture is also checked just before it is
 * written, and a fixture that fails is not written. Every key present in the
 * environment is checked, even when the run is limited to one provider.
 *
 * Requires Node 22.2 or later, because the PNG builder uses `zlib.crc32`.
 *
 * This is a development tool for the provider spike (GitHub issue 2). Nothing in
 * `src`, `server`, or the build imports it.
 *
 * Usage, with the keys passed as environment variables for this process only:
 *
 *   TYPESAFE_API_KEY=... OPENAI_API_KEY=... SUBQ_API_KEY=... node scripts/probe/run.mjs [typesafe] [subq] [openai]
 *
 * Name one or more providers to probe only those; with none named, all three run.
 * Write `provider:case,case` (for example `subq:bad-key,invalid-body`) to run only
 * those cases of a provider.
 * The run exits with code 1 if a named case does not exist, if a request fails before a
 * response arrives (the fixture is then left as it was), or if the redaction check fails.
 * The script prints status, latency, and size for every call, and never prints a
 * key or a response body. Calls are sent one at a time and never retried.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, fetch } from "undici";
import { createExchange } from "./exchange.mjs";
import { parseCaseFilter, unmatchedCases } from "./filter.mjs";
import { findLeaks } from "./fixtures.mjs";
import { buildRedPng, buildRedJpeg } from "./images.mjs";

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../worker/providers/fixtures",
);

const STATE =
  "Patient with asthma reports a sore throat, fever since yesterday, and shortness of breath walking to the kitchen this morning.";

const PROVIDERS = {
  typesafe: { envName: "TYPESAFE_API_KEY", origin: "https://api.typesafe.ai" },
  subq: { envName: "SUBQ_API_KEY", origin: "https://api.subq.ai" },
  openai: { envName: "OPENAI_API_KEY", origin: "https://api.openai.com" },
};

const keys = {};
for (const [provider, { envName }] of Object.entries(PROVIDERS)) {
  keys[provider] = process.env[envName]?.trim() ?? "";
}
const secrets = Object.values(keys).filter((key) => key !== "");

const caseFilter = parseCaseFilter(process.argv.slice(2));

const { exchange, results, failures, ran } = createExchange({
  keys,
  secrets,
  fixtureRoot: FIXTURE_ROOT,
  fetchImpl: fetch,
  caseFilter,
});

/** A connection pool that keeps idle sockets for 30 s, so a "warm" call really reuses one. */
function newAgent() {
  return new Agent({ keepAliveTimeout: 30_000, keepAliveMaxTimeout: 30_000 });
}

// ---------------------------------------------------------------------------
// TypeSafe Jev. The request shape is the one the existing server sends through
// the SDK: `{ state, questions, model }` to POST /v1/systemone.
// ---------------------------------------------------------------------------

async function probeTypeSafe() {
  const origin = PROVIDERS.typesafe.origin;
  const url = `${origin}/v1/systemone`;
  const model = "jev-latest";
  const agent = newAgent();

  // A cold connection to the models list first, because it is the warm-path call.
  await exchange("typesafe", "models-list", {
    method: "GET",
    url: `${origin}/v1/models`,
    agent,
    trim: true,
  });

  await exchange("typesafe", "noul", {
    url,
    agent,
    body: {
      state: STATE,
      model,
      questions: {
        escalate: {
          type: "noul",
          instructions: "Should a nurse see this chat before the patient books anything?",
          criteria: {
            true: "Breathing trouble, chest pain, or a flare of a known condition",
            false: "Stable symptoms the patient can book for themselves",
          },
        },
      },
    },
  });

  await exchange("typesafe", "choice", {
    url,
    agent,
    body: {
      state: STATE,
      model,
      questions: {
        queue: {
          type: "choice",
          instructions: "Which team should own this chat?",
          criteria: {
            nurse_line: "Needs a nurse to assess symptoms today",
            primary_care: "Book with the patient's own doctor",
            pharmacy: "Refill or medication question only",
            front_desk: null,
          },
        },
      },
    },
  });

  await exchange("typesafe", "score", {
    url,
    agent,
    body: {
      state: STATE,
      model,
      questions: {
        acuity: {
          type: "score",
          instructions: "How soon should someone respond?",
          criteria: ["Within a week", "Within a day", "Within an hour"],
        },
      },
    },
  });

  await exchange("typesafe", "bad-key", {
    url,
    agent,
    auth: "bad",
    body: {
      state: STATE,
      model,
      questions: { escalate: { type: "noul", instructions: "Is this urgent?" } },
    },
  });

  await agent.close();
}

// ---------------------------------------------------------------------------
// SubQ Snap. Request shape: docs.subq.ai/endpoints/decisions-api/ (also saved in
// the research notes). Images are `{ mediaType, base64 }` objects.
// ---------------------------------------------------------------------------

const SUBQ_MODEL = "subq-snap-preview";

function subqThreeTypes() {
  return {
    model: SUBQ_MODEL,
    state: STATE,
    questions: {
      escalate: {
        type: "noul",
        instructions: "Should a nurse see this chat before the patient books anything?",
        criteria: {
          true: "Breathing trouble, chest pain, or a flare of a known condition",
          false: "Stable symptoms the patient can book for themselves",
        },
      },
      queue: {
        type: "choice",
        instructions: "Which team should own this chat?",
        criteria: {
          nurse_line: "Needs a nurse to assess symptoms today",
          primary_care: "Book with the patient's own doctor",
          pharmacy: "Refill or medication question only",
          front_desk: null,
        },
      },
      acuity: {
        type: "score",
        instructions: "How soon should someone respond?",
        criteria: ["Within a week", "Within a day", "Within an hour"],
      },
    },
  };
}

function subqImageRequest(images) {
  return {
    model: SUBQ_MODEL,
    state: "The attached image is the only evidence.",
    images,
    questions: {
      red: {
        type: "noul",
        instructions: "Is the image mostly red?",
        criteria: { true: "The image is mostly red", false: "The image is another colour" },
      },
    },
  };
}

async function probeSubq() {
  const origin = PROVIDERS.subq.origin;
  const url = `${origin}/v1/systemone`;
  const png = buildRedPng().toString("base64");
  const jpeg = buildRedJpeg().toString("base64");

  // 1. The warm-path candidate on a brand-new connection, then the same
  //    request that follows it on that connection.
  const warmedAgent = newAgent();
  await exchange("subq", "models-list", {
    method: "GET",
    url: `${origin}/v1/models`,
    agent: warmedAgent,
    trim: true,
  });
  await exchange("subq", "three-types-after-models-list", {
    url,
    agent: warmedAgent,
    body: subqThreeTypes(),
  });
  await warmedAgent.close();

  // 2. Everything else, starting with the cold-connection baseline.
  const agent = newAgent();
  await exchange("subq", "three-types", { url, agent, body: subqThreeTypes() });
  await exchange("subq", "models-list-no-auth", {
    method: "GET",
    url: `${origin}/v1/models`,
    agent,
    auth: "none",
    trim: true,
  });
  await exchange("subq", "image-png-plain-base64", {
    url,
    agent,
    body: subqImageRequest([{ mediaType: "image/png", base64: png }]),
  });
  await exchange("subq", "image-png-data-url", {
    url,
    agent,
    body: subqImageRequest([{ mediaType: "image/png", base64: `data:image/png;base64,${png}` }]),
  });
  await exchange("subq", "image-png-wrapped-base64", {
    url,
    agent,
    body: subqImageRequest([
      { mediaType: "image/png", base64: png.replace(/(.{76})/g, "$1\n") + "\n" },
    ]),
  });
  await exchange("subq", "image-jpeg-plain-base64", {
    url,
    agent,
    body: subqImageRequest([{ mediaType: "image/jpeg", base64: jpeg }]),
  });

  const elevenLevels = Array.from({ length: 11 }, (_, index) => `Level ${index}`);
  await exchange("subq", "score-11-levels", {
    url,
    agent,
    body: {
      model: SUBQ_MODEL,
      state: STATE,
      questions: {
        acuity: {
          type: "score",
          instructions: "How soon should someone respond?",
          criteria: elevenLevels,
        },
      },
    },
  });

  await exchange("subq", "bad-key", {
    url,
    agent,
    auth: "bad",
    body: {
      model: SUBQ_MODEL,
      state: STATE,
      questions: { escalate: { type: "noul", instructions: "Is this urgent?" } },
    },
  });

  // The docs promise 401 for bad credentials, but the first bad-key probe returned 403.
  // These two probes check whether a key with the usual prefix, or no key, gives 401.
  await exchange("subq", "bad-key-sk-prefix", {
    url,
    agent,
    auth: "bad-sk",
    body: {
      model: SUBQ_MODEL,
      state: STATE,
      questions: { escalate: { type: "noul", instructions: "Is this urgent?" } },
    },
  });
  await exchange("subq", "missing-key", {
    url,
    agent,
    auth: "none",
    body: {
      model: SUBQ_MODEL,
      state: STATE,
      questions: { escalate: { type: "noul", instructions: "Is this urgent?" } },
    },
  });

  // A choice question with no criteria, the failure the docs use as their example.
  await exchange("subq", "invalid-body", {
    url,
    agent,
    body: {
      model: SUBQ_MODEL,
      state: STATE,
      questions: { queue: { type: "choice", instructions: "Which team should own this chat?" } },
    },
  });

  await agent.close();

  // A second brand-new connection, after DNS is cached, to separate the handshake cost
  // from the one-off cost of the very first lookup.
  const secondColdAgent = newAgent();
  await exchange("subq", "models-list-second-cold", {
    method: "GET",
    url: `${origin}/v1/models`,
    agent: secondColdAgent,
    trim: true,
  });
  await secondColdAgent.close();
}

// ---------------------------------------------------------------------------
// OpenAI Decisions. Request shape: the SDK typings in `resources/decisions.d.ts`
// of openai@7.30.0 and the API reference (also saved in the research notes).
// ---------------------------------------------------------------------------

const OPENAI_MODEL = "gpt-6-luna";

function openaiThreeTypes() {
  return {
    model: OPENAI_MODEL,
    input: STATE,
    questions: [
      {
        type: "predicate",
        name: "escalate",
        instructions: "Should a nurse see this chat before the patient books anything?",
      },
      {
        type: "choice",
        name: "queue",
        instructions: "Which team should own this chat?",
        choices: [
          { value: "nurse_line", description: "Needs a nurse to assess symptoms today" },
          { value: "primary_care", description: "Book with the patient's own doctor" },
          { value: "pharmacy", description: "Refill or medication question only" },
          { value: "front_desk" },
        ],
      },
      {
        type: "score",
        name: "acuity",
        instructions: "How soon should someone respond?",
        levels: [
          { label: "Within a week" },
          { label: "Within a day" },
          { label: "Within an hour" },
        ],
      },
    ],
  };
}

function openaiImageRequest(imageUrl) {
  return {
    model: OPENAI_MODEL,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: "The attached image is the only evidence." },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
    questions: [{ type: "predicate", name: "red", instructions: "Is the image mostly red?" }],
  };
}

function openaiScoreRequest(levelCount) {
  return {
    model: OPENAI_MODEL,
    input: STATE,
    questions: [
      {
        type: "score",
        name: "acuity",
        instructions: "How soon should someone respond? Level 0 is the least urgent.",
        levels: Array.from({ length: levelCount }, (_, index) => ({ label: `Level ${index}` })),
      },
    ],
  };
}

async function probeOpenai() {
  const origin = PROVIDERS.openai.origin;
  const url = `${origin}/v1/decisions`;
  const png = buildRedPng().toString("base64");
  const jpeg = buildRedJpeg().toString("base64");

  const warmedAgent = newAgent();
  await exchange("openai", "models-list", {
    method: "GET",
    url: `${origin}/v1/models`,
    agent: warmedAgent,
    trim: true,
  });
  await exchange("openai", "three-types-after-models-list", {
    url,
    agent: warmedAgent,
    body: openaiThreeTypes(),
  });
  await warmedAgent.close();

  const agent = newAgent();
  await exchange("openai", "three-types", { url, agent, body: openaiThreeTypes() });
  await exchange("openai", "models-list-no-auth", {
    method: "GET",
    url: `${origin}/v1/models`,
    agent,
    auth: "none",
    trim: true,
  });
  await exchange("openai", "models-retrieve", {
    method: "GET",
    url: `${origin}/v1/models/${OPENAI_MODEL}`,
    agent,
  });
  await exchange("openai", "image-png-data-url", {
    url,
    agent,
    body: openaiImageRequest(`data:image/png;base64,${png}`),
  });
  await exchange("openai", "image-jpeg-data-url", {
    url,
    agent,
    body: openaiImageRequest(`data:image/jpeg;base64,${jpeg}`),
  });
  // The guide says hosted URLs are refused; the API reference says they work.
  await exchange("openai", "image-http-url", {
    url,
    agent,
    body: openaiImageRequest("https://example.com/probe-red.png"),
  });

  await exchange("openai", "score-2-levels", { url, agent, body: openaiScoreRequest(2) });
  await exchange("openai", "score-10-levels", { url, agent, body: openaiScoreRequest(10) });
  const eleven = await exchange("openai", "score-11-levels", {
    url,
    agent,
    body: openaiScoreRequest(11),
  });
  // Only when 11 is accepted is the maximum still unknown, so ask once for a much larger scale.
  if (eleven?.status === 200) {
    await exchange("openai", "score-50-levels", { url, agent, body: openaiScoreRequest(50) });
  }

  await exchange("openai", "bad-key", {
    url,
    agent,
    auth: "bad",
    body: {
      model: OPENAI_MODEL,
      input: STATE,
      questions: [{ type: "predicate", name: "urgent", instructions: "Is this urgent?" }],
    },
  });
  // The required `questions` field is missing.
  await exchange("openai", "invalid-body", {
    url,
    agent,
    body: { model: OPENAI_MODEL, input: STATE },
  });

  await agent.close();

  // A second brand-new connection, after DNS is cached, to see the handshake cost of the
  // small warm-path candidate (the full model list is too large to be one).
  const secondColdAgent = newAgent();
  await exchange("openai", "models-retrieve-second-cold", {
    method: "GET",
    url: `${origin}/v1/models/${OPENAI_MODEL}`,
    agent: secondColdAgent,
  });
  await secondColdAgent.close();
}

// ---------------------------------------------------------------------------

const probes = { typesafe: probeTypeSafe, subq: probeSubq, openai: probeOpenai };
const requested = process.argv.slice(2);
const selected = requested.length === 0 ? Object.keys(probes) : [...caseFilter.keys()];

for (const provider of selected) {
  if (!Object.hasOwn(probes, provider)) {
    console.error(
      `Unknown provider "${provider}". Choose from: ${Object.keys(probes).join(", ")}.`,
    );
    process.exit(1);
  }
  if (keys[provider] === "") {
    console.error(`${PROVIDERS[provider].envName} is not set, so ${provider} cannot be probed.`);
    process.exit(1);
  }
}

try {
  for (const provider of selected) {
    await probes[provider]();
  }
} catch (error) {
  // The only error thrown on purpose is the pre-write leak check, whose message names
  // the fixture and nothing else. Anything else is printed by name only, never in full.
  const message =
    error instanceof Error && error.message.startsWith("redaction check FAILED")
      ? error.message
      : "the probe stopped on an unexpected error";
  console.error(message);
  process.exit(1);
}

console.log(`\n${results.length} calls saved.`);

const leaks = await findLeaks(FIXTURE_ROOT, secrets);
if (leaks.length === 0) {
  console.log("redaction check passed");
} else {
  console.error(`redaction check FAILED: ${leaks.join(", ")}`);
  process.exitCode = 1;
}

if (failures.length > 0) {
  console.error(
    `These cases failed before a response arrived, so their fixtures were not replaced: ${failures.join(", ")}`,
  );
  process.exitCode = 1;
}

const unmatched = unmatchedCases(caseFilter, ran);
if (unmatched.length > 0) {
  console.error(`These named cases did not run (check the spelling): ${unmatched.join(", ")}`);
  process.exitCode = 1;
}
