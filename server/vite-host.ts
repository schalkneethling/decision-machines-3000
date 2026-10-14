/**
 * The Node dev host: serves `/api` requests during `vp dev` by calling the same
 * `handle` function the Worker uses (ADR-0001).
 *
 * It converts each Node request into a `Request`, passes it to `handle` with the
 * provider keys and the same dependencies the Worker passes (Node's global
 * `fetch`, `AbortSignal.timeout`, and `console.info`), and writes the
 * `Response` back. Every `/api` path reaches `handle`, including the old
 * `/api/jev` paths, which now answer a JSON 404.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite-plus";
import { MISSING_KEYS_MESSAGE, PROVIDER_KEY_NAMES, configuredProviders } from "../worker/env.ts";
import type { ProviderKeys } from "../worker/env.ts";
import { defaultDeps, handle, rejectMethod } from "../worker/handler.ts";
import { failure } from "../worker/respond.ts";
import { useEnglishZodMessages } from "../worker/zod-locale.ts";

const LOG_PREFIX = "[api]";

/**
 * Reads the provider keys from `process.env`. Under `vp dev`, the Varlock plugin
 * resolves the schema (1Password included) and injects the result there before
 * any request arrives. `varlock/env`'s `ENV` is not used, because it throws for a
 * key the schema does not declare yet.
 */
export function providerKeysFromProcessEnv(): ProviderKeys {
  const keys: ProviderKeys = {};
  for (const name of Object.values(PROVIDER_KEY_NAMES)) {
    keys[name] = process.env[name];
  }
  return keys;
}

/** Whether the Worker owns this path, matching `run_worker_first` in `wrangler.jsonc`. */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Converts a Node request into the `Request` the handler takes. */
async function toRequest(req: IncomingMessage, url: URL): Promise<Request> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(url, {
    method,
    headers,
    body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
  });
}

/** Writes a `Response` from the handler to the Node response. */
async function writeResponse(response: Response, res: ServerResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });
  res.end(Buffer.from(await response.arrayBuffer()));
}

/**
 * The origin a Host header names, or undefined when the header is not a plain
 * host and optional port. Anything more (a path, a query, credentials) would
 * let the header change which URL the handler sees, so it is refused.
 */
function originOf(host: string): string | undefined {
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  const plain =
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "" &&
    !host.includes("/");
  return plain ? url.origin : undefined;
}

/**
 * Methods Node accepts but the Fetch API forbids, so no `Request` can carry
 * them (https://fetch.spec.whatwg.org/#forbidden-method lists CONNECT, TRACE,
 * and TRACK). Node's server never hands CONNECT to request listeners, and its
 * parser refuses TRACK with a 400, so only TRACE reaches this middleware.
 */
const FORBIDDEN_METHODS: ReadonlySet<string> = new Set(["TRACE"]);

/** What the dev host calls for each `/api` request: the Worker's `handle`, or a test double. */
export type Handler = typeof handle;

/**
 * Middleware that answers `/api` requests with `handler`, reading the keys per
 * request. A request target that is not a plain path (for example `//host/...`,
 * which a URL parser would read as another host) is passed on untouched, as the
 * Worker's assets layer would treat it.
 */
export function apiMiddleware(
  readKeys: () => ProviderKeys,
  handler: Handler = handle,
): Connect.NextHandleFunction {
  return (req, res, next) => {
    const target = req.url ?? "/";
    if (!target.startsWith("/") || target.startsWith("//")) {
      next();
      return;
    }
    // The base only lets the parser read the path; the real origin is checked below.
    const { pathname } = new URL(target, "http://localhost");
    if (!isApiPath(pathname)) {
      next();
      return;
    }

    const answered = (response: Response) => writeResponse(response, res);
    const failed = (error: unknown) => {
      next(error);
    };

    const origin = originOf(req.headers.host ?? "localhost");
    if (origin === undefined) {
      answered(failure(400, "The Host header is not a valid host and port.")).catch(failed);
      return;
    }
    const method = req.method ?? "GET";
    if (FORBIDDEN_METHODS.has(method)) {
      answered(rejectMethod(pathname, method)).catch(failed);
      return;
    }

    toRequest(req, new URL(`${origin}${target}`))
      .then((request) => handler(request, readKeys(), defaultDeps()))
      .then(answered)
      .catch(failed);
  };
}

/**
 * Vite plugin for `vp dev` that serves `/api` through the Worker's handler. It
 * warns at start-up when no provider key is set, with the same message the
 * handler's 503 carries, and turns on Zod's English messages, as the Worker
 * does when it loads, so both hosts log a rejected provider reply alike.
 */
export function viteHostPlugin(readKeys: () => ProviderKeys = providerKeysFromProcessEnv): Plugin {
  return {
    name: "decisionmachines3000:vite-host",
    configureServer(server) {
      useEnglishZodMessages();
      if (configuredProviders(readKeys()).length === 0) {
        server.config.logger.warn(`${LOG_PREFIX} ${MISSING_KEYS_MESSAGE}`);
      }
      server.middlewares.use(apiMiddleware(readKeys));
    },
  };
}
