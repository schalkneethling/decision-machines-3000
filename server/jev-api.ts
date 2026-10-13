/**
 * `POST /api/jev` and `POST /api/jev/warm`: the only place the TypeSafe API key is used.
 *
 * Registered as middleware on both the dev server and the preview server, so
 * the browser talks to these endpoints and never sees the key.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AuthenticationError,
  BadRequestError,
  PermissionDeniedError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
  choice,
  noul,
  score,
} from "@typesafe-ai/sdk";
import type { Questions } from "@typesafe-ai/sdk";
import { ENV } from "varlock/env";
import type { Connect, Plugin } from "vite-plus";
import { DECISION_ENDPOINT, WARM_ENDPOINT } from "../src/decision/contract.ts";
import type {
  AnswerByPrimitive,
  RefusalAnswer,
  ConnectionKind,
  DecisionFailure,
  DecisionSuccess,
  Primitive,
  WarmSuccess,
} from "../src/decision/contract.ts";
import { validateDecisionRequest, validateWarmRequest } from "../src/decision/validate.ts";
import { DEFAULT_PROVIDER } from "../src/providers/catalog.ts";
import type { ValidDecisionRequest } from "../src/decision/validate.ts";
import { TypeSafeConnection } from "./connection.ts";

/** Largest request body accepted, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;

const LOG_PREFIX = "[jev]";

type Reply = {
  status: number;
  body: DecisionSuccess | WarmSuccess | DecisionFailure;
};

/** Error with a ready-made reply, thrown while reading or handling a request. */
class ReplyError extends Error {
  readonly reply: Reply;

  constructor(status: number, failure: Omit<DecisionFailure, "ok">) {
    super(failure.error);
    this.name = "ReplyError";
    this.reply = { status, body: { ok: false, ...failure } };
  }
}

/** Every TypeSafe call, from runs and from warming, shares this one connection pool. */
let connection: TypeSafeConnection | undefined;

function getConnection(): TypeSafeConnection {
  connection ??= new TypeSafeConnection();
  return connection;
}

let client: TypeSafeClient | undefined;

/** Create the client on first use so a missing key only fails requests, not server start-up. */
function getClient(): TypeSafeClient {
  if (client) return client;

  const apiKey = ENV.TYPESAFE_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    throw new ReplyError(500, {
      error:
        "The TypeSafe API key is not available. Check TYPESAFE_API_KEY in .env.schema and make sure the 1Password desktop app is unlocked, then restart the dev server.",
    });
  }
  client = new TypeSafeClient({ apiKey, fetch: getConnection().fetch });
  return client;
}

function sendJson(res: ServerResponse, { status, body }: Reply): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("content-length", Buffer.byteLength(payload));
  res.setHeader("cache-control", "no-store");
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw bodyTooLarge();
  }

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    received += buffer.byteLength;
    if (received > MAX_BODY_BYTES) {
      throw bodyTooLarge();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function bodyTooLarge(): ReplyError {
  return new ReplyError(413, {
    error: `The request is too large. Keep it under ${MAX_BODY_BYTES / 1024} KB by trimming "state" or asking fewer questions.`,
  });
}

function parseJson(text: string): unknown {
  if (text.trim() === "") {
    throw new ReplyError(400, {
      error: "The request body is empty. Send the panel's JSON as the body.",
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ReplyError(400, {
      error: "The request body is not valid JSON. Check for missing quotes, commas, or brackets.",
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}

function isJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"] ?? "";
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

/** Build SDK questions, resolving each question's criteria from itself or the request default. */
function buildQuestions(request: ValidDecisionRequest): Questions {
  const questions: Questions = {};
  switch (request.primitive) {
    case "noul":
      for (const [id, question] of Object.entries(request.questions)) {
        questions[id] = noul(question.instructions, question.criteria ?? request.criteria);
      }
      break;
    case "choice":
      for (const [id, question] of Object.entries(request.questions)) {
        const criteria = question.criteria ?? request.criteria;
        if (!criteria) throw missingCriteria(id);
        questions[id] = choice(question.instructions, criteria);
      }
      break;
    case "score":
      for (const [id, question] of Object.entries(request.questions)) {
        const criteria = question.criteria ?? request.criteria;
        if (!criteria) throw missingCriteria(id);
        questions[id] = score(question.instructions, criteria);
      }
      break;
  }
  return questions;
}

/** Unreachable after validation; kept so a validator regression fails loudly instead of sending bad input. */
function missingCriteria(questionId: string): ReplyError {
  return new ReplyError(400, {
    error: `Question "${questionId}" has no criteria. Add "criteria" to the question or a default "criteria" at the top of the request.`,
    detail: `questions.${questionId}.criteria`,
  });
}

function upstreamDetail(error: APIError): string {
  const requestId = error.requestId ? ` (request ${error.requestId})` : "";
  return `TypeSafe responded ${error.status}${requestId}: ${error.message}`;
}

/** Translate SDK errors into readable failures with a matching status code. */
function toReply(error: unknown): Reply {
  if (error instanceof ReplyError) return error.reply;

  const fail = (status: number, message: string, detail?: string): Reply => ({
    status,
    body:
      detail === undefined ? { ok: false, error: message } : { ok: false, error: message, detail },
  });

  if (error instanceof AuthenticationError || error instanceof PermissionDeniedError) {
    return fail(
      502,
      "TypeSafe rejected the API key. Check that TYPESAFE_API_KEY in 1Password is current, then restart the dev server.",
      upstreamDetail(error),
    );
  }
  if (error instanceof RateLimitError) {
    const wait =
      error.retryAfterMs === undefined
        ? "a moment"
        : `${Math.ceil(error.retryAfterMs / 1000)} seconds`;
    return fail(
      429,
      `TypeSafe is rate limiting requests. Wait ${wait} and try again.`,
      upstreamDetail(error),
    );
  }
  if (error instanceof BadRequestError || error instanceof UnprocessableEntityError) {
    return fail(
      422,
      "TypeSafe could not process this request. Check the questions and criteria against the detail below.",
      upstreamDetail(error),
    );
  }
  if (error instanceof APIError) {
    return fail(502, "TypeSafe returned an error. Try again in a moment.", upstreamDetail(error));
  }
  if (error instanceof APITimeoutError) {
    return fail(
      504,
      "TypeSafe took too long to answer. Try again, or ask fewer questions at once.",
      `No response within ${error.timeoutMs} ms.`,
    );
  }
  if (error instanceof APIConnectionError) {
    return fail(
      502,
      "Could not reach TypeSafe. Check your internet connection and try again.",
      error.message,
    );
  }
  if (error instanceof TypeSafeError) {
    return fail(400, "The TypeSafe SDK rejected this request.", error.message);
  }
  return fail(
    500,
    "Something went wrong on the server. Check the dev server console for details.",
    error instanceof Error ? error.message : undefined,
  );
}

type HandledRequest = {
  reply: Reply;
  /** What the log line names the request by: a primitive, or "warm". */
  label?: Primitive | "warm";
  questionCount?: number;
  latencyMs?: number;
  connection?: ConnectionKind;
};

/** Checks the method and content type, then reads and parses the JSON body. */
async function readJsonRequest(req: IncomingMessage, endpoint: string): Promise<unknown> {
  if (req.method !== "POST") {
    throw new ReplyError(405, {
      error: `Send a POST request to ${endpoint}.`,
      detail: `Received ${req.method ?? "an unknown method"}.`,
    });
  }
  if (!isJsonContentType(req)) {
    throw new ReplyError(415, {
      error: 'Send the request body as JSON with the "content-type: application/json" header.',
      detail: `Received content-type: ${req.headers["content-type"] ?? "none"}.`,
    });
  }
  return parseJson(await readBody(req));
}

async function handleDecisionRequest(req: IncomingMessage): Promise<HandledRequest> {
  const validation = validateDecisionRequest(
    await readJsonRequest(req, DECISION_ENDPOINT),
    DEFAULT_PROVIDER.capabilities,
  );
  if (!validation.ok) {
    throw new ReplyError(400, { error: validation.error, detail: validation.detail });
  }

  const request = validation.value;
  const questionCount = Object.keys(request.questions).length;
  const questions = buildQuestions(request);
  const typesafe = getClient();
  const pool = getConnection();

  const startedAt = performance.now();
  try {
    const {
      value: result,
      latencyMs,
      connection,
    } = await pool.measure(typesafe.baseURL, () =>
      typesafe.systemOne({ state: request.state, questions }),
    );
    const success: DecisionSuccess = {
      ok: true,
      primitive: request.primitive,
      model: result.model,
      usage: { input_tokens: result.usage.input_tokens, output_tokens: result.usage.output_tokens },
      latencyMs,
      connection,
      keepAliveSeconds: pool.keepAliveSeconds,
      answers: toContractAnswers(result.answers),
    };
    return {
      reply: { status: 200, body: success },
      label: request.primitive,
      questionCount,
      latencyMs,
      connection,
    };
  } catch (error) {
    return {
      reply: toReply(error),
      label: request.primitive,
      questionCount,
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

/**
 * Sets the keep-alive, then lists the models: a call that costs no tokens and
 * leaves a connection to TypeSafe open for the next run.
 */
async function handleWarmRequest(req: IncomingMessage): Promise<HandledRequest> {
  const validation = validateWarmRequest(await readJsonRequest(req, WARM_ENDPOINT));
  if (!validation.ok) {
    throw new ReplyError(400, { error: validation.error, detail: validation.detail });
  }

  const typesafe = getClient();
  const pool = getConnection();
  pool.setKeepAlive(validation.value.keepAliveSeconds);

  const startedAt = performance.now();
  try {
    const { latencyMs, connection } = await pool.measure(typesafe.baseURL, () =>
      typesafe.models.list(),
    );
    const success: WarmSuccess = {
      ok: true,
      latencyMs,
      connection,
      keepAliveSeconds: pool.keepAliveSeconds,
    };
    return { reply: { status: 200, body: success }, label: "warm", latencyMs, connection };
  } catch (error) {
    return {
      reply: toReply(error),
      label: "warm",
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

type ContractAnswer = AnswerByPrimitive[Primitive] | RefusalAnswer;

/**
 * The SDK answer shapes already match the contract field for field; copy them
 * into plain objects so the response is exactly the contract and nothing more.
 */
export function toContractAnswers(
  answers: Readonly<Record<string, Readonly<ContractAnswer>>>,
): Record<string, ContractAnswer> {
  const mapped: Record<string, ContractAnswer> = {};
  for (const [id, answer] of Object.entries(answers)) {
    switch (answer.type) {
      case "noul":
        mapped[id] = { type: "noul", noul: answer.noul };
        break;
      case "choice":
        mapped[id] = {
          type: "choice",
          choice: answer.choice,
          confidence: answer.confidence,
          probabilities: { ...answer.probabilities },
        };
        break;
      case "score":
        mapped[id] = {
          type: "score",
          score: answer.score,
          confidence: answer.confidence,
          legend: { ...answer.legend },
          probabilities: { ...answer.probabilities },
        };
        break;
      case "refusal":
        mapped[id] = { type: "refusal" };
        break;
      default: {
        // Fails the type check when a new answer type is added to the contract without a case.
        const unknown: never = answer;
        throw new Error(`The provider returned an unknown answer type for question "${id}".`, {
          cause: unknown,
        });
      }
    }
  }
  return mapped;
}

function logRequest(outcome: HandledRequest): void {
  const parts = [
    LOG_PREFIX,
    outcome.label ?? "-",
    `questions=${outcome.questionCount ?? 0}`,
    `status=${outcome.reply.status}`,
    `latency=${outcome.latencyMs === undefined ? "-" : `${outcome.latencyMs}ms`}`,
    `connection=${outcome.connection ?? "-"}`,
  ];
  if (!outcome.reply.body.ok) {
    parts.push(`error="${outcome.reply.body.error}"`);
  }
  console.info(parts.join(" "));
}

const handlers: Record<string, (req: IncomingMessage) => Promise<HandledRequest>> = {
  [DECISION_ENDPOINT]: handleDecisionRequest,
  [WARM_ENDPOINT]: handleWarmRequest,
};

const jevMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const handle = Object.hasOwn(handlers, pathname) ? handlers[pathname] : undefined;
  if (handle === undefined) {
    next();
    return;
  }

  handle(req)
    .catch((error: unknown): HandledRequest => ({ reply: toReply(error) }))
    .then((outcome) => {
      logRequest(outcome);
      sendJson(res, outcome.reply);
    })
    .catch((error: unknown) => {
      // Only reachable if writing the response itself failed.
      next(error);
    });
};

/**
 * Closes the connection pool and its channel subscription when the server stops,
 * so a dev-server restart (which loads this module afresh) leaves nothing behind.
 */
function closeConnectionWith(
  httpServer: { once(event: "close", listener: () => void): unknown } | null,
): void {
  httpServer?.once("close", () => {
    const closing = connection;
    connection = undefined;
    client = undefined;
    closing?.close().catch((error: unknown) => {
      console.warn(`${LOG_PREFIX} closing the TypeSafe connection failed`, error);
    });
  });
}

/** Vite plugin that serves `POST /api/jev` and `POST /api/jev/warm` from the dev and preview servers. */
export function jevApiPlugin(): Plugin {
  return {
    name: "decisionmachines3000:api",
    configureServer(server) {
      server.middlewares.use(jevMiddleware);
      closeConnectionWith(server.httpServer);
    },
    configurePreviewServer(server) {
      server.middlewares.use(jevMiddleware);
      closeConnectionWith(server.httpServer);
    },
  };
}
