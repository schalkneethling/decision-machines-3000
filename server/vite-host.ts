/**
 * The Node dev host: serves `/api` requests during `vp dev` by calling the same
 * `handle` function the Worker uses (ADR-0001).
 *
 * It converts each Node request into a `Request`, passes it to `handle` with the
 * provider keys and Node's global `fetch`, and writes the `Response` back. The
 * legacy `/api/jev` middleware is registered before this plugin, so it answers
 * its own paths first and only the rest reach `handle`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Connect, Plugin } from "vite-plus";
import { MISSING_KEYS_MESSAGE, PROVIDER_KEY_NAMES, configuredProviders } from "../worker/env.ts";
import type { ProviderKeys } from "../worker/env.ts";
import { handle } from "../worker/handler.ts";

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

/** Middleware that answers `/api` requests with `handle`, reading the keys per request. */
export function apiMiddleware(readKeys: () => ProviderKeys): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!isApiPath(url.pathname)) {
      next();
      return;
    }

    toRequest(req, url)
      .then((request) => handle(request, readKeys(), { fetch: globalThis.fetch }))
      .then((response) => writeResponse(response, res))
      .catch((error: unknown) => {
        next(error);
      });
  };
}

/**
 * Vite plugin for `vp dev` that serves `/api` through the Worker's handler. It
 * warns at start-up when no provider key is set, with the same message the
 * handler's 503 carries.
 */
export function viteHostPlugin(readKeys: () => ProviderKeys = providerKeysFromProcessEnv): Plugin {
  return {
    name: "decisionmachines3000:vite-host",
    configureServer(server) {
      if (configuredProviders(readKeys()).length === 0) {
        server.config.logger.warn(`${LOG_PREFIX} ${MISSING_KEYS_MESSAGE}`);
      }
      server.middlewares.use(apiMiddleware(readKeys));
    },
  };
}
