# DecisionMachines3000

A small demo of [TypeSafe's](https://typesafe.ai) Jev decision model and its three primitives: Noul, Choice, and Score.

Each primitive gets its own panel with a tree-based "branch composer" for building up questions and state, plus a JSON editor for editing the same request by hand. Every panel starts empty, and two buttons at its top load an example into it (see [The example sets](#the-example-sets)). When the selected provider takes images, each panel also shows an Images control: choose files, drop them on it, or paste one, and the browser checks each file's real format and the provider's limits (read from `GET /api/providers`) before sending the files as multipart parts beside the request JSON. A readout renders the model's answers, including probabilities drawn as bars. A separate warm-connection demo, available under `vp dev`, shows the latency difference between a cold connection to a provider and one that has already been warmed up (see [The warm-connection demo](#the-warm-connection-demo)).

## The example sets

A panel opens with an empty request, `{ "primitive": …, "state": "", "questions": {} }`, and Run stays off until the panel holds one. Each panel has two buttons, "Load film example" and "Load image example", and loading an example that would replace your edits asks first.

- **Film reviews** are the original examples: a few fictional films, which Noul, Choice, and Score each ask about in their own way. The set needs no images, so it loads on any provider.
- **Images** attaches four small drawings this project made, a red square, a blue circle, a green triangle, and a busy scene of overlapping shapes, and asks about them as "image 1" to "image 4" in the order they are listed. The set needs a provider that takes images, and a panel whose image list is empty.

The requests are JSON files under [`src/decision/examples/`](./src/decision/examples/), checked against the request validator when the page loads. The pictures sit beside the image set with their licence ([`src/decision/examples/images/README.md`](./src/decision/examples/images/README.md)) and are drawn by `vp run sample-images` ([`scripts/sample-images.ts`](./scripts/sample-images.ts)), so they can be redrawn at any time.

## Deploy your own

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/schalkneethling/jev-3000)

The button needs at least one real provider key. It makes all three keys required inputs, so enter the word `unset` for each provider you do not have. A fresh instance then refuses every run until you put it behind Cloudflare Access, which is the first step after the deploy. [`docs/deploy.md`](./docs/deploy.md) walks through the button, the protection step, and deploying by hand with plain Wrangler.

## Requirements

- Node 24
- [Vite+](https://viteplus.dev) (`vp`)
- For `vp dev` and `vp preview`, and for the Varlock deploy profile: the [1Password desktop app](https://1password.com/downloads/) with its CLI integration turned on, and the [`op` CLI](https://developer.1password.com/docs/cli/). Building, checking, testing, and deploying with plain Wrangler need no 1Password.

## Setup

Install dependencies:

```sh
vp install
```

## Provider keys

The app has three providers, and an instance needs at least one key: `TYPESAFE_API_KEY` for TypeSafe Jev, `SUBQ_API_KEY` for SubQ Snap, and `OPENAI_API_KEY` for OpenAI Decisions. A provider whose key is not set does not appear in the app. No key is stored in this repository. How you supply them depends on where the app runs:

- **A deployed Worker:** set the keys as Worker secrets with plain Wrangler, or let Varlock upload them from 1Password. [`docs/deploy.md`](./docs/deploy.md) covers both, with the commands.
- **`vp dev` and `vp preview`:** the keys come from 1Password through [Varlock](https://varlock.dev), described below.

## Varlock

Varlock replaces `.env` files with a committed [`.env.schema`](./.env.schema) that declares every variable, validates it at start-up, redacts sensitive values in output, and loads secrets from external providers. This project uses its [1Password plugin](https://varlock.dev/plugins/1password/), so the keys live in a vault. Read `.env.schema` for the exact declarations: it is the one source, and this README does not copy it.

- Each of the three keys is optional and sensitive. A key whose field is missing from the vault item is left unset, which is how an instance runs with only some providers.
- `AT_LEAST_ONE_PROVIDER_KEY` is a check item: it fails the load when none of the three keys has a value. Each key also rejects `unset` and whitespace-only values, which the Worker treats as no key, so such a setup fails with a clear error instead of starting an app with no provider.
- `vp exec varlock load` resolves the schema and prints every value redacted. `vp run codegen` regenerates [`env.d.ts`](./env.d.ts) after a schema change.

To use your own vault, change the `account` and the three `op://` references in `.env.schema`; [`docs/deploy.md`](./docs/deploy.md#4-deploy-with-varlock-and-1password) lists the steps.

Start the dev server with `vp dev`. Varlock's Vite plugin is registered only for the dev and preview servers (see [`vite.config.ts`](./vite.config.ts)): it resolves the schema once at start-up, asks 1Password for approval, and puts the keys into the dev server's environment, which [`server/vite-host.ts`](./server/vite-host.ts) reads. So `vp check`, `vp test`, and `vp run build` never wait on a 1Password prompt. Without 1Password, put the keys you have in a gitignored `.env.local` and set the others to `KEY=""` ([details and trade-offs](./docs/deploy.md#vp-dev-in-this-profile): the keys sit unencrypted on disk, so prefer 1Password where you have it). To deploy with Varlock, follow [section 4 of the deploy guide](./docs/deploy.md#4-deploy-with-varlock-and-1password).

## Commands

- `vp dev`: start the dev server (asks 1Password for the keys)
- `vp check`: format, lint, and type check
- `vp test`: run the test suite
- `vp run build`: type check and build for production
- `vp run deploy`: check that the Worker has a provider key, then run a plain `wrangler deploy` (see [`docs/deploy.md`](./docs/deploy.md)); run `vp run build` first
- `vp run deploy:varlock`: resolve `.env.schema` through 1Password and deploy with `varlock-wrangler deploy`, which uploads the keys as secrets (see [`docs/deploy.md`](./docs/deploy.md#4-deploy-with-varlock-and-1password)); run `vp run build` first
- `vp run codegen`: regenerate `env.d.ts` from `.env.schema`

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
