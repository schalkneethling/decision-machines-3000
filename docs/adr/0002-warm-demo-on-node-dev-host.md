# ADR-0002: Keep the warm-connection demo on the Node dev host

- **Status:** Accepted. The owner decided on 2026-10-12, while reviewing the multi-provider plan, to keep the demo rather than retire it. Issue #9 implements it.
- **Date:** 2026-10-15
- **Spike:** issue #2 confirmed a lightweight warm call for each provider (results on issue #9 and in [`docs/spikes/provider-probes.md`](../spikes/provider-probes.md)).

## Context

The warm-connection demo teaches one lesson: a request on a new connection pays for the TCP and TLS handshakes, and a request on a connection that is still open does not. Measured in September 2026, a run to TypeSafe took about 1.3 s on a new connection and about 0.4 s on a reused one, with a round trip of about 330 ms, and Node drops an idle connection after 4 seconds by default. To teach this honestly, the server has to do two things: tell, for each call, whether a connection was opened for it, and let the viewer set how long an idle connection stays open.

The app is moving onto a Cloudflare Worker (ADR-0001). Both hosts call one handler, `handle(request, env, deps)` in `worker/handler.ts`: the Worker in production, and the Node dev host (`server/vite-host.ts`) during `vp dev`. A Worker cannot do either of the two things. Its outbound `fetch` goes through Cloudflare's own connection handling, which the Worker can neither observe nor configure, and an isolate may serve the next request from another machine.

The options were:

- **Retire the demo**, and with it the connection fields of the success.
- **Fake it on the Worker**, for example by timing two calls and guessing. The numbers would not mean what the demo says they mean.
- **Keep it on the Node dev host only**, where undici's connection pool and its diagnostics channel can see every connection and set the keep-alive.

## Decision

Keep the demo, and run it only on the Node dev host.

1. `HandlerDeps` gains an optional `connections` (`ConnectionMetrics` in `worker/handler.ts`): the pool's keep-alive, a way to change it, and `track(origin)`, which reports whether a call opened a connection. The type lives in the worker folder and imports nothing from Node.
2. The Node dev host creates one `ConnectionPool` (`server/connection.ts`) per dev server, passes it as `connections`, and passes its undici-based `fetch` as `deps.fetch`, so every provider call goes through the pool. The Worker passes the global `fetch` and no `connections`. Nothing under `worker/` imports `server/`, so the Worker bundle holds no undici code and no `node:` import; `tsc -p worker/tsconfig.json`, which `vp run build` runs, has no Node types and fails if one appears.
3. `GET /api/providers` reports `host: { connectionMetrics }`, true only when `connections` is present, and says per provider whether it can warm (`canWarm`), without sending the warm path itself.
4. A decision success carries `connection` and `keepAliveSeconds` only when `connections` is present. The readout's sentence then ends "over a new connection." or "over the warm connection."
5. `POST /api/warm/{provider}` sets the keep-alive and sends one GET to the provider's warm path, through `fetchJson`, so the key is handled as it is for a decision. The Worker answers it with 501.
6. Each catalog descriptor may declare a `warmPath`. Spike #2 confirmed one for every provider: `GET /v1/models` for TypeSafe Jev and SubQ Snap, and `GET /v1/models/gpt-6-luna` for OpenAI Decisions, never the full model list. A provider without one shows no warm form.

## Why

- The lesson is about connections, and only the Node host can see them. A demo that shows numbers it cannot measure would teach the wrong thing.
- Keeping one handler means the decide route is the same code on both hosts; the Node host only adds what it alone can provide. There is no second implementation to drift.
- Putting the pool behind an injected dependency keeps the Node-only code out of the Worker bundle without a build-time switch.

## Consequences

- The warm form is hidden on a deployed instance and under `vp preview`, which serves `/api` from workerd. Only `vp dev` shows it.
- One undici `Agent` serves all three providers, so one keep-alive applies to all of them. Changing it replaces the agent, so the next call to every provider opens a new connection.
- Connection attribution is exact for one call at a time, which is how the demo is used, and a best guess for overlapping calls to the same host (see `ConnectionDetector` in `server/connection.ts`).
- The decide and warm routes share their checks and failure answers through `worker/provider-route.ts`.
- Warming the SubQ Snap connection sends its key, although its models list needs none, because `fetchJson` is the only code that sends a provider request and it always sends the key. SubQ is the same host as the decision calls, so the key goes nowhere new.
- Warming on the Worker host and production connection tuning stay out of scope.
