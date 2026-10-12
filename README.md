# DecisionMachines3000

A small demo of [TypeSafe's](https://typesafe.ai) Jev decision model and its three primitives: Noul, Choice, and Score.

Each primitive gets its own panel with a tree-based "branch composer" for building up questions and state, plus a JSON editor for editing the same request by hand. A readout renders the model's answers, including probabilities drawn as bars. A separate warm-connection demo shows the latency difference between a cold TypeSafe connection and one that has already been warmed up.

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

The browser never sees `TYPESAFE_API_KEY`. It's read only inside the `/api/jev` middleware in [`server/jev-api.ts`](./server/jev-api.ts), which the dev and preview servers register as a Vite+ plugin. The UI talks to `/api/jev` and `/api/jev/warm` over HTTP; TypeSafe is only ever called from the server.

## Built with Claude Code

This project was built with [Claude Code](https://claude.com/claude-code).
