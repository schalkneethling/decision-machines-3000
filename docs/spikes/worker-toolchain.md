# Spike: run a Cloudflare Worker from this Vite+ project

This records the result of issue #1. It answers whether `@cloudflare/vite-plugin` and `@varlock/cloudflare-integration` work under Vite+ 0.2.8 well enough to serve, build, and deploy a Worker from this repository.

**Short answer.** Everything that can run without a Cloudflare account works. `vp dev` runs the Worker inside workerd through `@cloudflare/vite-plugin` (path A). `vp run build` produces the output that Wrangler reads, and `vp exec wrangler dev` serves it with the Worker answering `/api/*` and the single-page app answering everything else. The steps that need an account, a public repository, or 1Password are still pending. Each one is listed at the end with the exact command to run and what it settles.

All local work ran on an Apple M3 Pro with Node 24.21.0, so the timings below are indicative only. Cloudflare's machines and plan limits decide the real numbers.

## Installed versions

| Package                           | Version                              | Notes                                                                                                       |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `wrangler`                        | 4.149.0                              | Added with `vp add -D`.                                                                                     |
| `@cloudflare/vite-plugin`         | 1.63.1                               | Added with `vp add -D`. Its peer range is `vite ^6.1.0 \|\| ^7.0.0 \|\| ^8.0.0`.                            |
| `@varlock/cloudflare-integration` | 1.6.1                                | Added with `vp add -D`. Its peer range needs `varlock ^1.22.0`, so `varlock` moved from ^1.20.0 to ^1.22.0. |
| `workerd`                         | 1.20261006.1                         | Pulled in by Wrangler. `vp exec workerd --version` prints `workerd 2026-10-06`.                             |
| `miniflare`                       | 5.20261006.1-alpha                   | Pulled in by Wrangler.                                                                                      |
| `vite` (alias)                    | `@voidzero-dev/vite-plus-core` 0.2.8 | `npm ls` shows both plugins resolve to this alias, deduplicated.                                            |

npm 12 blocked the install scripts of `workerd` and `esbuild` (`npm warn install-scripts ... workerd@1.20261006.1 (postinstall: node install.js)`). Both binaries still work, because the platform packages (`@cloudflare/workerd-darwin-arm64`) arrive as optional dependencies, and `vp exec wrangler --version` and `vp exec workerd --version` both run.

## What is on the branch

- `worker/index.ts` is the spike Worker. `export default { fetch }` sends `GET /api/providers` to a fixed provider list and answers every other path it receives with a JSON 404. A provider appears in the list only when its secret is a non-empty string, and the response never contains the value. It also exports `handle(request, env)`, so the planned Node host in `server/vite-host.ts` can call the same code.
- `worker/spike/encode-bench.ts` is a measurement Worker for the multipart and base64 questions. It is never deployed with the app.
- `worker/tsconfig.json` and the generated `worker/worker-configuration.d.ts` type the Worker code separately from the root project.
- `wrangler.jsonc` configures the Worker. Every key was checked in `node_modules/wrangler/config-schema.json`.
- `vite.config.ts` adds the two plugins inside `lazyPlugins`, behind the existing Varlock gate (see path A below).
- `.gitignore` now ignores `.wrangler` (local Wrangler and plugin state) and `.dev.vars` files, except `.dev.vars.example`.

## Findings

Each row is one item from the issue's scope. "Pending" means it needs a step the owner has not authorised yet. The commands for those steps are in [Pending steps](#pending-steps-for-the-owner).

| Scope item                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-route Worker, `wrangler.jsonc`, both plugins inside `lazyPlugins`                 | **Done.**                                                                                                                                                                                                                                                                                                                                                                                                                          | Files listed above. `vp check`, `vp test`, and `vp run build` pass.                                                                                                                                                                                                                                                                 |
| `vp dev` runs the Worker runtime (path A or B)                                        | **Path A works** with the plain `@cloudflare/vite-plugin`. The Varlock-wrapped plugin under `vp dev` is **pending**, because it starts a 1Password prompt.                                                                                                                                                                                                                                                                         | See [Path A under `vp dev`](#path-a-under-vp-dev).                                                                                                                                                                                                                                                                                  |
| `vp run build` produces what `wrangler deploy` needs                                  | **Yes.** The build writes the client to `dist/client`, the Worker to `dist/decisionmachines3000/` with its own `wrangler.json`, and a redirect file `.wrangler/deploy/config.json`. `wrangler dev` follows that redirect and serves the built Worker. An actual `wrangler deploy` is **pending**.                                                                                                                                  | See [Build output](#build-output).                                                                                                                                                                                                                                                                                                  |
| `vp exec wrangler dev`                                                                | **Works** locally, both on the source config and on the built output.                                                                                                                                                                                                                                                                                                                                                              | See [Routing](#routing-and-the-json-404).                                                                                                                                                                                                                                                                                           |
| `wrangler deploy` to a scratch Worker with one secret                                 | **Pending.**                                                                                                                                                                                                                                                                                                                                                                                                                       | Steps 3 to 6 below.                                                                                                                                                                                                                                                                                                                 |
| Deploy button on a public fork with one key blank                                     | **Pending.** The docs say the button clones the repository into the user's account, reads secrets from `.dev.vars.example` or `.env.example`, and runs the `build` script from `package.json`, with `npx wrangler deploy` as the default deploy command. They do not say whether a blank secret is accepted.                                                                                                                       | https://developers.cloudflare.com/workers/platform/deploy-buttons/ : "Repositories must be public in order for others to successfully use your Deploy to Cloudflare button."                                                                                                                                                        |
| Import path of `varlockCloudflareVitePlugin`                                          | `import { varlockCloudflareVitePlugin } from "@varlock/cloudflare-integration";` (the package's `.` export). **Importing it runs `varlock load` immediately**, so it must stay behind a dynamic import and the serve-only gate.                                                                                                                                                                                                    | `node_modules/@varlock/cloudflare-integration/package.json` maps `.` to `./dist/index.mjs`, which ends with `export { varlockCloudflareVitePlugin };`. That file imports `./dist-B9aOE838.mjs`, whose line 1570 is a top-level `reloadConfig();` that calls `execSyncVarlock("load --format json-full --compact", ...)`.            |
| `@sensitive` items readable as plain `env.TYPESAFE_API_KEY` without importing `/init` | **Supported by the source; deployed confirmation pending.** `varlock-wrangler deploy` puts each `@sensitive` item that has a value into the `--secrets-file` under its schema name, so it arrives as an ordinary secret binding. `worker/index.ts` does not import `/init`.                                                                                                                                                        | `dist/varlock-wrangler.mjs`, `handleDeploy`: `if (item.isSensitive) secretsObj[key] = strValue; else varFlags.push("--var", ...)`. Items with `value === undefined` are skipped.                                                                                                                                                    |
| Inbound request body limit                                                            | Set by the **account** plan, not the Workers plan: 100 MB on Free and Pro, 200 MB on Business, up to 5 GB (self-serve) on Enterprise.                                                                                                                                                                                                                                                                                              | https://developers.cloudflare.com/workers/platform/limits/ : "Request body size limits depend on your Cloudflare account plan, not your Workers plan."                                                                                                                                                                              |
| Worker types package and `worker/tsconfig.json`                                       | **Generated runtime types from `wrangler types`**, not `@cloudflare/workers-types`. See [Worker types](#worker-types).                                                                                                                                                                                                                                                                                                             | https://developers.cloudflare.com/workers/languages/typescript/ : "We recommend you use `wrangler types` to generate runtime types, rather than using the `@cloudflare/workers-types` package".                                                                                                                                     |
| `run_worker_first: ["/api/*"]` sends an unknown `/api/x` to the Worker                | **Confirmed locally** under both `wrangler dev` and `vp dev`: `GET /api/x` returns `404` with `application/json` and `{"error":"No API route matches /api/x."}`. Note that `/api` without a trailing slash does not match the pattern and gets the single-page app.                                                                                                                                                                | See [Routing](#routing-and-the-json-404).                                                                                                                                                                                                                                                                                           |
| What path A and path B mean for dev serving                                           | Dev serving goes through `server/vite-host.ts` (the planned Node host that calls the Worker's `handle`) in **both** cases. Path A adds the Worker runtime inside `vp dev` through `@cloudflare/vite-plugin`. Path B keeps only the Node host.                                                                                                                                                                                      | See [Path A and path B](#path-a-and-path-b).                                                                                                                                                                                                                                                                                        |
| Workers limits the image path depends on                                              | Memory: 128 MB per isolate on Free and Paid. CPU time per HTTP request: 10 ms on Free; 30 seconds by default on Paid, configurable up to 5 minutes.                                                                                                                                                                                                                                                                                | https://developers.cloudflare.com/workers/platform/limits/ : "Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations." and "On the Workers Paid plan, you can increase the maximum CPU time from the default 30 seconds to 5 minutes (300,000 ms)."                             |
| Native base64 encoder in workerd                                                      | **`Uint8Array.prototype.toBase64()`** exists in workerd 2026-10-06 with or without Node compatibility. `Buffer` exists only because compatibility dates from 2026-08-04 turn `nodejs_compat` on by default. **`nodejs_compat` is not needed**, and `wrangler.jsonc` sets no compatibility flags.                                                                                                                                   | See [Base64 and multipart](#base64-and-multipart).                                                                                                                                                                                                                                                                                  |
| CPU time to encode 8 MiB                                                              | About **3 to 4 ms** with `toBase64()` and 4 to 8 ms with `Buffer`, measured locally. The CPU time on Cloudflare is **pending**.                                                                                                                                                                                                                                                                                                    | See [Base64 and multipart](#base64-and-multipart).                                                                                                                                                                                                                                                                                  |
| `request.formData()` returns `File` parts readable with `arrayBuffer()`               | **Confirmed locally.** Both image parts are `File` instances with the right `type` and 4,194,304 bytes each; a text field arrives as a string.                                                                                                                                                                                                                                                                                     | See [Base64 and multipart](#base64-and-multipart).                                                                                                                                                                                                                                                                                  |
| Memory used to parse an 8 MiB multipart body                                          | **Indicative only:** the workerd process grew by 45 to 59 MiB for one request that parsed the body, copied both parts, and ran both encoders. That is under 128 MB but is process memory, not the isolate's heap. A deployed check is **pending**.                                                                                                                                                                                 | See [Base64 and multipart](#base64-and-multipart).                                                                                                                                                                                                                                                                                  |
| Does the 8 MiB path fit the Free plan?                                                | **Unknown until measured on Cloudflare.** Encoding alone fits in 10 ms locally, but parsing the body costs CPU too, and the local clock cannot separate that from waiting for bytes.                                                                                                                                                                                                                                               | Step 7 below settles it.                                                                                                                                                                                                                                                                                                            |
| `wrangler secret put` before the first deploy                                         | **The source says yes:** when the Worker does not exist, Wrangler asks "Do you want to create a new Worker with that name and add secrets to it?", defaults to yes in non-interactive runs, and uploads a placeholder script first. Live confirmation is **pending**.                                                                                                                                                              | `node_modules/wrangler/wrangler-dist/cli.js`, `createDraftWorker` (line 310580): `confirm2(..., { defaultValue: true, fallbackValue: true })`, then a `PUT /accounts/${accountId}/workers/scripts/${scriptName}` with `export default { fetch() {} }`.                                                                              |
| Which `wrangler secret list` output a script can parse                                | `wrangler secret list --format json`. JSON is the default, but pass it explicitly. In JSON mode Wrangler prints no banner, and the output is `JSON.stringify(secrets, null, "  ")`, an array of objects with `name` and `type`. Before the first deploy the command fails with "Worker ... not found".                                                                                                                             | `vp exec wrangler secret list --help`: `--format  The format to print the secrets in  [choices: "json", "pretty"] [default: "json"]`. Source: `printBanner: (args) => args.format === "pretty"`.                                                                                                                                    |
| Can a Deploy-button build run `wrangler secret list` and see the prompted secrets?    | **Pending.**                                                                                                                                                                                                                                                                                                                                                                                                                       | Step 9 below.                                                                                                                                                                                                                                                                                                                       |
| Does `varlock-wrangler deploy` delete secrets that are not in the schema?             | **The evidence says it should not, but the test is pending.** `varlock-wrangler` passes `--secrets-file` plus, for a plain deploy, `--keep-vars=false`. Wrangler's help says the secrets file is additive and `--keep-vars` affects only vars.                                                                                                                                                                                     | `vp exec wrangler deploy --help`: `--secrets-file ... Applies additively with secrets from previous deployments - omitted secrets will not be deleted.` The deploy docs say "Secrets are never deleted by a deployment whether this flag is true or false." (https://developers.cloudflare.com/workers/wrangler/commands/workers/). |
| Why the project does not use `secrets.required`                                       | **Confirmed from the source.** At deploy, every listed secret that has no value becomes an `inherit` binding, and a missing one fails the deploy with "The following required secrets have not been set". In local dev, defining `secrets` limits the loaded keys to those listed, and the schema says it "Replaces .dev.vars/.env/process.env inference for type generation". A fork with one of three keys would fail to deploy. | `cli.js`, `addRequiredSecretsInheritBindings` (line 176159) and the dev loader near line 191116; `config-schema.json`, `secrets.required`.                                                                                                                                                                                          |
| `vp check` and `vp test` never wait on 1Password                                      | **Confirmed.** Both finish without a prompt. `vp run build` also never imports Varlock, because the build loads only the plain Cloudflare plugin.                                                                                                                                                                                                                                                                                  | `vp check`: "All 36 files are correctly formatted" and "Found no warnings, lint errors, or type errors in 29 files". `vp test`: "Tests 156 passed (156)".                                                                                                                                                                           |

## Path A under `vp dev`

`@cloudflare/vite-plugin` 1.63.1 runs under Vite+ 0.2.8 without changes. The Worker answers `/api/*` from workerd, the Vite client is injected into the HTML, and the existing `/api/jev` middleware keeps working.

To run it without 1Password, I used a temporary config that was not committed, and set `VITEST=1` so that, if `vp dev` had ignored `--config`, the existing gate in `vite.config.ts` would still have skipped Varlock:

```ts
// vite.spike-dev.config.ts (temporary, deleted afterwards)
import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import { jevApiPlugin } from "./server/jev-api.ts";

export default defineConfig({
  plugins: [jevApiPlugin(), cloudflare()],
});
```

```text
$ VITEST=1 vp dev --config vite.spike-dev.config.ts --port 5199 --strictPort
  VITE+ v0.2.8
  ➜  Local:   http://localhost:5199/
The Cloudflare Vite plugin detected this dev session is running in an AI agent.
The Local Explorer API is available at http://localhost:5199/cdn-cgi/local/explorer/api
```

| Request                   | Response                                                                                                                                                                    |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/providers`      | `200 application/json` `{"providers":[]}` (no key in this session)                                                                                                          |
| `GET /api/x`              | `404 application/json` `{"error":"No API route matches /api/x."}`                                                                                                           |
| `POST /api/providers`     | `405`, `allow: GET`                                                                                                                                                         |
| `GET /some/spa/route`     | `200 text/html`, the app's `index.html` with `<script type="module" src="/@vite/client">`                                                                                   |
| `POST /api/jev` with `{}` | The Node middleware's own validation error: `{"ok":false,"error":"Set \"primitive\" to \"noul\", \"choice\", or \"score\". It is currently missing.","detail":"primitive"}` |

Plugin order matters. Both plugins add their middleware in `configureServer`, so the one listed first sees a request first. With `jevApiPlugin()` first, `/api/jev` stays in Node and every other `/api/*` path goes to the Worker. The Cloudflare side is `cloudflarePreMiddleware` in `node_modules/@cloudflare/vite-plugin/dist/index.mjs` (around line 95993), which sends paths that match `run_worker_first` to the Worker.

The committed `vite.config.ts` uses the same order. For `vp dev` and `vp preview` it loads `varlockCloudflareVitePlugin()`, which wraps the Cloudflare plugin and injects the resolved environment into the Worker. For `vp build` it loads the plain `cloudflare()` plugin. For tests and metadata reads it loads neither. I could not run the Varlock-wrapped variant, because importing it runs `varlock load` against `.env.schema`, which asks 1Password for the key. Step 1 below covers it.

## Build output

```text
$ vp run build
dist/decisionmachines3000/.vite/manifest.json  0.15 kB
dist/decisionmachines3000/wrangler.json        1.46 kB
dist/decisionmachines3000/index.js             1.47 kB
dist/client/.assetsignore               0.02 kB
dist/client/index.html                  7.50 kB
dist/client/assets/index-owmmYtdq.css  12.15 kB
dist/client/assets/index-xtmEA-hq.js   45.11 kB

$ cat .wrangler/deploy/config.json
{"configPath":"../../dist/decisionmachines3000/wrangler.json","auxiliaryWorkers":[]}
```

The built `wrangler.json` keeps `run_worker_first` and `not_found_handling`, and points `assets.directory` at `../client`. `vp exec wrangler dev` (and therefore `wrangler deploy`) picks the redirect up:

```text
Using redirected Wrangler configuration.
 - Configuration being used: "dist/decisionmachines3000/wrangler.json"
 - Original user's configuration: "wrangler.jsonc"
 - Deploy configuration file: ".wrangler/deploy/config.json"
```

Two consequences follow from this:

- The Worker bundle is not served as a static file. `GET /decisionmachines3000/index.js` returns the single-page app, because only `dist/client` is the assets directory. That is why `wrangler.jsonc` points `assets.directory` at `./dist/client` rather than `./dist`.
- After a build, `wrangler dev worker/spike/encode-bench.ts` uses the redirected config, which has `no_bundle: true`, so it loads the TypeScript file unbundled and fails with `Uncaught SyntaxError: Unexpected identifier 'PartReport'`. Passing `-c wrangler.jsonc` fixes it.

## Routing and the JSON 404

`vp exec wrangler dev --local --port 8799 --var TYPESAFE_API_KEY:spike-dummy-value-123`, run on the built output:

| Request               | Response                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `GET /api/providers`  | `200 application/json` `{"providers":[{"id":"typesafe","name":"TypeSafe"}]}`                                    |
| `GET /api/x`          | `404 application/json` `{"error":"No API route matches /api/x."}`                                               |
| `GET /api/`           | `404 application/json`                                                                                          |
| `GET /api`            | `200 text/html`, the single-page app, because `/api/*` does not match `/api`                                    |
| `GET /some/spa/route` | `200 text/html`; the log says "`Sec-Fetch-Mode: navigate` header present - using `not_found_handling` behavior" |
| `POST /api/providers` | `405`, `Allow: GET`                                                                                             |
| `POST /some/route`    | `405` with an empty body, from the assets layer                                                                 |

The dummy value appears in neither the responses nor the Wrangler log: `grep -c spike-dummy-value-123` on both returned 0, and the bindings table shows `env.TYPESAFE_API_KEY ("(hidden)")`.

## Worker types

Cloudflare recommends `wrangler types` for Workers, so the Worker uses generated runtime types that match its compatibility date and flags. `@cloudflare/workers-types` stays the recommendation only for libraries ("There are no plans to stop publishing the `@cloudflare/workers-types` package, which will still be the recommended way to type libraries and shared packages in the workers environment.").

Regenerate the file after changing `wrangler.jsonc`:

```sh
vp exec wrangler types worker/worker-configuration.d.ts
```

`worker/tsconfig.json` settings:

| Setting                                | Value                                                                                   | Why                                                                                                                                                         |
| -------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib`                                  | `["ES2024", "ESNext.TypedArrays"]`                                                      | No `DOM`, because the generated file declares the Workers globals. `ESNext.TypedArrays` declares `Uint8Array.prototype.toBase64`, which workerd implements. |
| `types`                                | `["./worker-configuration.d.ts"]`                                                       | The generated runtime types, as the Cloudflare TypeScript page shows. No `node`, because the Worker uses no Node APIs.                                      |
| `target`, `module`, `moduleResolution` | `es2024`, `esnext`, `bundler`                                                           | Matches how Wrangler and the Vite plugin bundle the Worker.                                                                                                 |
| `strict` and the linting options       | `true`, plus the root's `noUnused*`, `erasableSyntaxOnly`, `noFallthroughCasesInSwitch` | Same standard as the root project.                                                                                                                          |

`vp check` type-checks `worker/` with this file, not the root one. Adding `export const spikeProbe = document.title;` to `worker/index.ts` made `vp check` fail with `typescript(TS2584): Cannot find name 'document'`, and removing it made it pass again. The root `tsconfig.json` does not include `worker/`, so `tsc` in `vp run build` does not check the Worker; `vp check` does.

`wrangler types` cannot infer `TYPESAFE_API_KEY`, because the project keeps no `.dev.vars` file, so the generated `Env` is empty. `worker/index.ts` declares the secrets itself as optional strings, which is accurate because a deployment may set any subset of them. `varlock-wrangler types` could add the schema's keys, but it runs `varlock load` first, which needs 1Password.

## Base64 and multipart

Probe Worker run with `wrangler dev` under different compatibility settings. It reports `typeof` for each candidate:

| Compatibility setting                                      | `Uint8Array.prototype.toBase64` | `Buffer`  | `process` |
| ---------------------------------------------------------- | ------------------------------- | --------- | --------- |
| `2026-10-06`, no flags (what `wrangler.jsonc` uses)        | function                        | function  | object    |
| `2026-10-06`, `nodejs_compat`                              | function                        | function  | object    |
| `2026-10-06`, `no_nodejs_compat` only                      | function                        | function  | object    |
| `2026-10-06`, `no_nodejs_compat` and `no_nodejs_compat_v2` | function                        | undefined | undefined |
| `2024-09-23`, no flags                                     | function                        | undefined | undefined |

The compatibility flags page explains the rows: Node.js compatibility is on by default from 2026-08-04, and turning it off needs both `no_nodejs_compat` and `no_nodejs_compat_v2` (https://developers.cloudflare.com/workers/configuration/compatibility-flags/). `toBase64()` does not depend on any of it, so it is the encoder to use.

`worker/spike/encode-bench.ts` posted two 4 MiB random files (`image/png` and `image/jpeg`) and a text field, 8,389,052 bytes in total, with `curl -H "Expect:"`. Without `-H "Expect:"`, curl waits one second for a `100 Continue` reply that never comes, which inflates the parse time to about 1,040 ms. Typical result:

```json
{
  "parts": [
    { "field": "first", "isFile": true, "type": "image/png", "bytes": 4194304 },
    { "field": "second", "isFile": true, "type": "image/jpeg", "bytes": 4194304 },
    { "field": "note", "isFile": false, "type": "string", "bytes": 0 }
  ],
  "parseAndReadMs": 21,
  "encoders": {
    "Uint8Array.prototype.toBase64": {
      "available": true,
      "ms": 3,
      "frozenClockMs": 2,
      "outputChars": 11184816
    },
    "Buffer (globalThis)": {
      "available": true,
      "ms": 4,
      "frozenClockMs": 3,
      "outputChars": 11184816
    }
  }
}
```

Over six requests, `toBase64()` took 3 to 4 ms for both parts and `Buffer` took 4 to 8 ms. `parseAndReadMs` was 20 to 23 ms, but that is wall time and includes receiving 8 MiB through Wrangler's local proxy, so it is not CPU time. Locally the clock runs freely (`frozenClockMs` is not 0). On Cloudflare's network, `performance.now()` advances only after I/O, which the bench works around with a zero-delay timer after each step (https://developers.cloudflare.com/workers/runtime-apis/performance/: "In local development, however, timers will increment regardless of whether I/O happens or not.").

Memory, sampled every 20 ms with `ps -o rss=` on the workerd process that runs the Worker:

| Run                               | Before      | Peak sampled | After       |
| --------------------------------- | ----------- | ------------ | ----------- |
| Fresh process, 1 request          | 103,248 KiB | 148,480 KiB  | 162,304 KiB |
| Warm process, 5 requests in a row | 105,184 KiB | 229,008 KiB  | 256,528 KiB |

One request grew the process by 45 to 59 MiB. That request held the 8 MiB body, an 8 MiB copy of the parts, and two rounds of 11 MB base64 strings, because the bench runs both encoders. A real handler that runs one encoder should need less. These numbers are process memory, not the isolate's heap, so they are only an upper-bound hint. I tried to read the heap through the inspector (`Runtime.getHeapUsage`), but could not get a working connection to Wrangler's inspector proxy in the time I gave it.

## Path A and path B

- **Path A.** `vp dev` runs the Worker inside workerd through `@cloudflare/vite-plugin` (wrapped by `varlockCloudflareVitePlugin` so it gets the 1Password key). Dev serving still goes through `server/vite-host.ts`, the Node host that calls the Worker's `handle`, for whatever it registers first. Path A adds runtime parity for the routes the Worker owns.
- **Path B.** `@cloudflare/vite-plugin` is not used in `vp dev`. Only `server/vite-host.ts` serves `/api/*`, in Node, and the Worker runtime is exercised only by `wrangler dev` and deploys.

The local evidence supports path A. The one open risk is the Varlock-wrapped plugin under `vp dev`, which step 1 settles. ADR-0001 records the choice.

## Pending steps for the owner

Run these from the repository root on this branch, in order, after `vp install` and `vp run build`. Replace `<subdomain>` with your `workers.dev` subdomain, which `wrangler deploy` prints. The scratch Worker is named `decisionmachines3000-scratch` so the real name stays free.

1. **Varlock under `vp dev` (needs 1Password).**
   ```sh
   vp dev --port 5199 --strictPort
   curl -s http://localhost:5199/api/providers
   ```
   Settles whether a 1Password-resolved value reaches the local Worker's `env`. Expect `{"providers":[{"id":"typesafe","name":"TypeSafe"}]}`, which shows the key is set without printing it. Also check that the app's `/api/jev` calls still work in the browser. If it fails, record the error text; that would mean path B.
2. **Log in (needs the account).**
   ```sh
   vp exec wrangler login
   ```
3. **Secrets before the first deploy.**
   ```sh
   vp exec wrangler secret list --name decisionmachines3000-scratch --format json
   printf '%s' 'spike-extra' | vp exec wrangler secret put SPIKE_EXTRA_SECRET --name decisionmachines3000-scratch
   vp exec wrangler secret list --name decisionmachines3000-scratch --format json
   ```
   Settles whether `secret put` works on a Worker that has never been deployed. The source predicts that the first `list` fails with "not found", `put` offers to create the Worker and succeeds, and the second `list` prints a JSON array with `SPIKE_EXTRA_SECRET`.
4. **Plain deploy.**
   ```sh
   vp exec wrangler deploy --name decisionmachines3000-scratch
   curl -s https://decisionmachines3000-scratch.<subdomain>.workers.dev/api/providers
   curl -s -o /dev/null -w "%{http_code} %{content_type}\n" https://decisionmachines3000-scratch.<subdomain>.workers.dev/api/x
   ```
   Settles whether `vp run build` plus `wrangler deploy` serves the UI and `GET /api/providers` (expect `{"providers":[]}`, because `TYPESAFE_API_KEY` is not set yet), and confirms the JSON 404 on Cloudflare. Open the root URL in a browser to check the UI.
5. **Deploy through Varlock (needs 1Password).**
   ```sh
   vp exec wrangler tail decisionmachines3000-scratch --format json > tail.json &
   vp exec varlock-wrangler deploy --name decisionmachines3000-scratch
   curl -s https://decisionmachines3000-scratch.<subdomain>.workers.dev/api/providers
   vp exec wrangler secret list --name decisionmachines3000-scratch --format json
   ```
   Settles three things. The provider list should now include TypeSafe, which shows `env.TYPESAFE_API_KEY` is readable without importing `@varlock/cloudflare-integration/init`. The secret list shows whether `SPIKE_EXTRA_SECRET` survived `varlock-wrangler deploy`. Searching `tail.json` for the key's value shows whether it appears in the logs. Stop the tail and delete `tail.json` afterwards.
6. **Script-readable secret list.** Save the output of the last command in step 5 and check that `JSON.parse` reads it with no other text around it. That confirms the invocation the deploy-time key check in #17 should use.
7. **CPU and memory on Cloudflare.**
   ```sh
   vp exec wrangler deploy -c wrangler.jsonc worker/spike/encode-bench.ts --name decisionmachines3000-bench
   curl -s -H "Expect:" -F "first=@a.png;type=image/png" -F "second=@b.jpg;type=image/jpeg" https://decisionmachines3000-bench.<subdomain>.workers.dev/api/bench
   ```
   Use two 4 MiB files (for example `head -c 4194304 /dev/urandom > a.png`). Settles whether the 8 MiB path fits the Free plan: on Free, a request over 10 ms of CPU fails instead of returning the JSON report, and one over 128 MB fails with a memory error. Read the CPU time per request in the Worker's metrics in the dashboard.
8. **Clean up.**
   ```sh
   vp exec wrangler delete decisionmachines3000-scratch
   vp exec wrangler delete decisionmachines3000-bench
   ```
9. **Deploy button (needs a public repository).** Push this branch to a throwaway public repository, add a `.dev.vars.example` that lists three keys with empty values (`TYPESAFE_API_KEY=` and the two other provider keys from the plan), and add this to its README:
   ```md
   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<repository URL>)
   ```
   Press the button and fill in only one key. Settles whether a blank secret is accepted, and if not, whether a placeholder value such as `unset` is. Then, in the new project's Workers Builds settings, add `npx wrangler secret list --format json` before the deploy command and run a build. That settles whether a Deploy-button build can list its secrets and sees the ones the button asked for. The snippet comes from https://developers.cloudflare.com/workers/platform/deploy-buttons/.

## Sources checked for syntax

- `wrangler.jsonc` keys: `node_modules/wrangler/config-schema.json` (`RawConfig` and the `Assets` definition, which allows `directory`, `binding`, `html_handling`, `not_found_handling`, `base_path`, and `run_worker_first`).
- Wrangler commands and flags: `--help` for `types`, `dev`, `deploy`, `secret put`, `secret list`, `secret delete`, `tail`, and `delete`.
- `cloudflare()` options and the middleware order: `node_modules/@cloudflare/vite-plugin/dist/index.d.mts` and `dist/index.mjs`.
- `varlockCloudflareVitePlugin` and `varlock-wrangler`: `node_modules/@varlock/cloudflare-integration/dist/index.mjs`, `dist/dist-B9aOE838.mjs`, `dist/varlock-wrangler.mjs`.
- `lazyPlugins` and `lint.ignorePatterns`: `node_modules/vite-plus/docs/guide/troubleshooting.md` and `lint.md`.
- `toBase64` types: `node_modules/typescript/lib/lib.esnext.typedarrays.d.ts`.
