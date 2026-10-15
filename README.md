# DecisionMachines3000

A small demo of [TypeSafe's](https://typesafe.ai) Jev decision model and its three primitives: Noul, Choice, and Score.

Each primitive gets its own panel with a tree-based "branch composer" for building up questions and state, plus a JSON editor for editing the same request by hand. A readout renders the model's answers, including probabilities drawn as bars. A separate warm-connection demo shows the latency difference between a cold TypeSafe connection and one that has already been warmed up. The demo is hidden for now, because the endpoint it used went with the old `/api/jev` middleware; issue #9 brings it back on the Node dev host.

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

## How the key stays server-side

The browser never sees a provider key. The UI posts each run to `POST /api/decide/{provider}`, which [`worker/decide.ts`](./worker/decide.ts) answers on the server: it reads the provider's key from the environment and hands it to that provider's adapter in [`worker/providers/`](./worker/providers/), whose `fetchJson` is the only code that puts it in a request. Each provider call gets one 25-second budget and is never retried. Error messages name the environment variable to set, never its value. TypeSafe is only ever called from the server.

## The Worker

The app is moving onto a Cloudflare Worker named `decisionmachines3000`, configured in [`wrangler.jsonc`](./wrangler.jsonc), which serves the built app as static assets and answers `/api` requests itself (see [ADR-0001](./docs/adr/0001-worker-hosting.md)). Every API route is answered by `handle` in [`worker/handler.ts`](./worker/handler.ts), a plain function that the Worker calls in production and that [`server/vite-host.ts`](./server/vite-host.ts) calls in Node during `vp dev`. It answers two routes. `GET /api/providers` lists the providers this instance has a key for: `TYPESAFE_API_KEY`, `SUBQ_API_KEY`, or `OPENAI_API_KEY`. At least one key is required; a blank value or `unset` counts as not set, and with no key the route answers 503. `POST /api/decide/{provider}` runs a decision on one provider, TypeSafe Jev, SubQ Snap, or OpenAI Decisions, and takes the request as `application/json`, or as `multipart/form-data` with a `request` part. It answers 404 for an unknown provider, 409 when the provider's key is not set, 405 for any method but POST, 415 for another content type, 413 for a body over 2.25 MB (256 KB of text plus 2 MB of images), 400 for an invalid request, and 422, 429, 402, 502, or 504 when the provider refuses the request, rate limits it, has no credit, fails, or takes longer than 25 seconds. Any other `/api` path answers a JSON 404, and anything that goes wrong on the server answers a JSON 500. A deployed instance refuses every decision with a JSON 503 until it is protected: put it behind Cloudflare Access and set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, or set `ALLOW_UNPROTECTED_INSTANCE` to the exact sentence the guide gives ([`docs/deploy.md`](./docs/deploy.md), [ADR-0003](./docs/adr/0003-fail-closed-access.md)). Only the Node host inside `vp dev` is exempt. `vp run build` writes the Worker to `dist/`, and `vp exec wrangler dev` serves that build locally, with the same protection variables a deployment needs. After changing `wrangler.jsonc`, regenerate the Worker's types with `vp exec wrangler types -c wrangler.jsonc worker/worker-configuration.d.ts`.

## Built with Claude Code

This project was built with [Claude Code](https://claude.com/claude-code).
