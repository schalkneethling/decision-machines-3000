/**
 * Spike Worker for issue #1: the smallest Worker that proves the toolchain.
 *
 * It answers `GET /api/providers` and returns a JSON 404 for every other path it
 * receives. Static assets and the single-page-app fallback are served by the
 * assets layer configured in `wrangler.jsonc`, which sends only `/api/*` here.
 */

/** A model provider the UI can offer, and the secret that enables it. */
type Provider = {
  id: string;
  name: string;
  secret: "TYPESAFE_API_KEY";
};

/**
 * The fixed list of known providers. A provider is listed in the response only
 * when its secret is set, so a fork with one key sees one provider.
 */
const PROVIDERS: readonly Provider[] = [
  { id: "typesafe", name: "TypeSafe", secret: "TYPESAFE_API_KEY" },
];

/**
 * The bindings this Worker reads. Secrets are optional because a deployment may
 * set any subset of them. `wrangler types` cannot infer them, because this project
 * keeps no `.dev.vars` file, so they are declared here.
 */
export type WorkerEnv = Env & Partial<Record<Provider["secret"], string>>;

type ProviderSummary = Pick<Provider, "id" | "name">;

/** API responses are never cached, because the provider list depends on the deployment's secrets. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

/** Lists the providers whose secret is set, without ever reading the value into the body. */
function listProviders(env: WorkerEnv): ProviderSummary[] {
  return PROVIDERS.filter((provider) => {
    const value = env[provider.secret];
    return typeof value === "string" && value.trim() !== "";
  }).map(({ id, name }) => ({ id, name }));
}

/** Routes one request. Exported separately so a Node host can call it in tests or dev. */
export function handle(request: Request, env: WorkerEnv): Response {
  const { pathname } = new URL(request.url);

  if (pathname === "/api/providers") {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed." }, 405, { allow: "GET" });
    }
    return json({ providers: listProviders(env) });
  }

  return json({ error: `No API route matches ${pathname}.` }, 404);
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
} satisfies ExportedHandler<WorkerEnv>;
