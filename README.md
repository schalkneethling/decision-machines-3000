# DecisionMachines3000

A small demo of [TypeSafe's](https://typesafe.ai) Jev decision model and its three primitives: Noul, Choice, and Score.

Each primitive gets its own panel with a tree-based "branch composer" for building up questions and state, plus a JSON editor for editing the same request by hand. When the selected provider takes images, each panel also shows an Images control: choose files, drop them on it, or paste one, and the browser checks each file's real format and the provider's limits (read from `GET /api/providers`) before sending the files as multipart parts beside the request JSON. A readout renders the model's answers, including probabilities drawn as bars. A separate warm-connection demo, available under `vp dev`, shows the latency difference between a cold connection to a provider and one that has already been warmed up (see [The warm-connection demo](#the-warm-connection-demo)).

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/schalkneethling/jev-3000)

The button needs at least one real provider key. It makes all three keys required inputs, so enter the word `unset` for each provider you do not have. A fresh instance then refuses every run until you put it behind Cloudflare Access, which is the first step after the deploy. [`docs/deploy.md`](./docs/deploy.md) walks through the button, the protection step, and deploying by hand with plain Wrangler.

## Requirements

- Node 24
- [Vite+](https://viteplus.dev) (`vp`)
- The [`op` 1Password CLI](https://developer.1password.com/docs/cli/) with desktop-app integration enabled

## Setup

Install dependencies:

```sh
vp install
```

The TypeSafe API key is never stored in this repo. It's read from 1Password through [Varlock](https://varlock.dev), using the reference in [`.env.schema`](./.env.schema). See [Varlock](#varlock) below for how to point it at your own key.

Start the dev server:

```sh
vp dev
```

## Varlock

[Varlock](https://varlock.dev) replaces `.env` files with a committed `.env.schema` that declares every variable, validates it at startup, redacts sensitive values in output, and can load secrets from external providers. This project uses its [1Password plugin](https://varlock.dev/plugins/1password/) so the key lives in a vault, not on disk.

The schema has one item:

```env-spec
# @plugin(@varlock/1password-plugin)
# @initOp(allowAppAuth=true, account=my.1password.com)
# @generateTsTypes(path=env.d.ts, importMetaEnv=none)
# ---

# @required @sensitive
TYPESAFE_API_KEY=op(op://dev/nocajwa573emc6ko6sv5bkn6y4/TYPESAFE_API_KEY)
```

- `@initOp(allowAppAuth=true, ...)` authenticates through the 1Password desktop app, so no service account token is needed locally. Biometric unlock works.
- `op(op://vault/item/field)` resolves the value at load time. The item can be a name or an id.
- `@sensitive` keeps the value out of logs and out of the browser bundle. `@required` fails the load if it is missing.
- `@generateTsTypes` writes `env.d.ts`, which types `import { ENV } from "varlock/env"` on the server.

To use your own key, change `account` to your sign-in address and the `op://` reference to your vault and item, then run `vp exec varlock load` to confirm it resolves (the value is shown redacted). For CI or a server, add a `@type=opServiceAccountToken` item and pass it as `token=` to `@initOp`; the plugin docs show the pattern.

The Varlock Vite plugin is registered only for the dev and preview servers (see [`vite.config.ts`](./vite.config.ts)), so `vp check`, `vp test`, and `vp run build` never wait on a 1Password prompt.

## Commands

- `vp check`: format, lint, and type check
- `vp test`: run the test suite
- `vp run build`: type check and build for production
- `vp run deploy`: check that the Worker has a provider key, then run a plain `wrangler deploy` (see [`docs/deploy.md`](./docs/deploy.md)); run `vp run build` first

## How the key stays server-side

The browser never sees a provider key. The UI posts each run to `POST /api/decide/{provider}`, which [`worker/decide.ts`](./worker/decide.ts) answers on the server: it reads the provider's key from the environment and hands it to that provider's adapter in [`worker/providers/`](./worker/providers/), whose `fetchJson` is the only code that puts it in a request. Each provider call gets one 25-second budget and is never retried. Error messages name the environment variable to set, never its value. TypeSafe is only ever called from the server.

## The Worker

The app is moving onto a Cloudflare Worker named `decisionmachines3000`, configured in [`wrangler.jsonc`](./wrangler.jsonc), which serves the built app as static assets and answers `/api` requests itself (see [ADR-0001](./docs/adr/0001-worker-hosting.md)). Every API route is answered by `handle` in [`worker/handler.ts`](./worker/handler.ts), a plain function that the Worker calls in production and that [`server/vite-host.ts`](./server/vite-host.ts) calls in Node during `vp dev`. It answers three routes. `GET /api/providers` lists the providers this instance has a key for: `TYPESAFE_API_KEY`, `SUBQ_API_KEY`, or `OPENAI_API_KEY`. At least one key is required; a blank value or `unset` counts as not set, and with no key the route answers 503. `POST /api/decide/{provider}` runs a decision on one provider, TypeSafe Jev, SubQ Snap, or OpenAI Decisions, and takes the request as `application/json`, or as `multipart/form-data` with a `request` text part and up to a provider's limit of `image` file parts (PNG, JPEG, or WebP, found from the file's first bytes, at most 64 KB per image and 64 KB per request; TypeSafe Jev takes none), which the Worker encodes to base64 once. It answers 404 for an unknown provider, 409 when the provider's key is not set, 405 for any method but POST, 415 for another content type, 413 for a JSON body, or a multipart `request` part, over 256 KB, or a multipart body over 256 KB of text plus 64 KB of images plus 16 KB of framing, 400 for an invalid request, and 422, 429, 402, 502, or 504 when the provider refuses the request, rate limits it, has no credit, fails, or takes longer than 25 seconds. `POST /api/warm/{provider}` opens a connection for the warm-connection demo below; the Worker answers it with 501. Any other `/api` path answers a JSON 404, and anything that goes wrong on the server answers a JSON 500. A deployed instance refuses every decision and warm request with a JSON 503 until it is protected: put it behind Cloudflare Access and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, or set `ALLOW_UNPROTECTED_INSTANCE` to the exact sentence the guide gives ([`docs/deploy.md`](./docs/deploy.md), [ADR-0003](./docs/adr/0003-fail-closed-access.md)). Only the Node host inside `vp dev` is exempt. `vp run build` writes the Worker to `dist/`, and `vp exec wrangler dev` serves that build locally, with the same protection variables a deployment needs. After changing `wrangler.jsonc`, regenerate the Worker's types with `vp exec wrangler types -c wrangler.jsonc worker/worker-configuration.d.ts`.

## The warm-connection demo

The first request to a provider pays for more than the question. Before any bytes of the request can travel, the server has to open a TCP connection and negotiate TLS, and each of those steps costs a round trip. Measured from the owner's machine in September 2026, a round trip to `api.typesafe.ai` took about 330 ms, so a run on a new connection took about 1.3 s, while the same run on a connection that was already open took about 0.4 s. Most of the difference is handshakes, not the model. The catch is that Node drops an idle connection after 4 seconds by default, and TypeSafe sends no keep-alive hint to extend it, so a connection that is warm now is cold again a few seconds later. The production lesson is to open the connection when the server boots, before the first user request needs it, and to set the keep-alive to outlast the usual gap between requests.

The gap is not the same for every provider, or every day. In one session of spike #2, TypeSafe showed almost no cold penalty: 382 ms on a new connection, against 390 to 540 ms on a reused one. A three-question SubQ Snap request took 969 ms cold and 514 ms warm, so warming halved it. OpenAI Decisions took 2,088 ms cold and 1,929 ms warm, so warming barely helped, because the model's own processing time dominates. Measure again before quoting any of these numbers.

The demo runs only under `vp dev` (see [ADR-0002](./docs/adr/0002-warm-demo-on-node-dev-host.md)). There, the Node dev host sends every provider call through one undici connection pool ([`server/connection.ts`](./server/connection.ts)), which can tell a new connection from a reused one and whose keep-alive can be set to 4, 30, or 60 seconds. The form above the readout warms the selected provider's connection with a call that spends no tokens (`GET /v1/models` for TypeSafe Jev and SubQ Snap, `GET /v1/models/gpt-6-luna` for OpenAI Decisions), then counts down how long it stays warm, and each run's sentence ends with "over a new connection" or "over the warm connection". A deployed Worker cannot see or control connection reuse, so `GET /api/providers` reports `"host": { "connectionMetrics": false }` there, and the form stays hidden.

## Built with Claude Code

This project was built with [Claude Code](https://claude.com/claude-code).
