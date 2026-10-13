# Spike: run a Cloudflare Worker from this Vite+ project

This records the result of issue #1. It answers whether `@cloudflare/vite-plugin` and `@varlock/cloudflare-integration` work under Vite+ 0.2.8 well enough to serve, build, and deploy a Worker from this repository.

**Short answer.** Yes. `vp dev` runs the Worker inside workerd through `@cloudflare/vite-plugin`, including the Varlock wrapper with the key resolved from 1Password, so ADR-0001 chooses path A, which runs the real Worker runtime inside `vp dev`. `vp run build` produces the output that `wrangler deploy` and `varlock-wrangler deploy` both deployed to a scratch Worker, which served the UI, `GET /api/providers`, and a JSON 404 for unknown `/api` paths. The Deploy button works with this repository, but it refuses blank secrets and stores placeholders as live secrets. Several results change other issues: an 8 MiB image request costs 19 to 43 ms of CPU, which is over the Free plan's 10 ms (#15); `varlock-wrangler deploy` keeps secrets that are not in the schema (#17, #18); and Cloudflare's build image needs a looser npm pin (#26). Every scope item is now settled.

Local timings ran on an Apple M3 Pro with Node 24.21.0 and are indicative only. The deployed runs used the owner's account on 2026-10-12.

**Where the code is.** This document, ADR-0001, and the scenarios are on `main`. The code the spike ran is not merged: the minimal Worker, the CPU benchmark, the Cloudflare plugin wiring, and the dependency changes. It is kept on the branch [`issue-1-worker-toolchain-spike`](https://github.com/schalkneethling/jev-3000/tree/issue-1-worker-toolchain-spike). Wherever this document says "the branch" or "this branch", it means that branch. #6 builds the real Worker with tests, using the spike branch as its reference.

## Installed versions

| Package                           | Version                              | Notes                                                                                                       |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `wrangler`                        | 4.149.0                              | Added with `vp add -D`.                                                                                     |
| `@cloudflare/vite-plugin`         | 1.63.1                               | Added with `vp add -D`. Its peer range is `vite ^6.1.0 \|\| ^7.0.0 \|\| ^8.0.0`.                            |
| `@varlock/cloudflare-integration` | 1.6.1                                | Added with `vp add -D`. Its peer range needs `varlock ^1.22.0`, so `varlock` moved from ^1.20.0 to ^1.22.0. |
| `workerd`                         | 1.20261006.1                         | Pulled in by Wrangler. `vp exec workerd --version` prints `workerd 2026-10-06`.                             |
| `miniflare`                       | 5.20261006.1-alpha                   | Pulled in by Wrangler.                                                                                      |
| `vite` (alias)                    | `@voidzero-dev/vite-plus-core` 0.2.8 | `npm ls` shows both plugins resolve to this alias, deduplicated.                                            |

npm 12 blocked the install scripts of `workerd` and `esbuild` (`npm warn install-scripts ... workerd@1.20261006.1 (postinstall: node install.js)`). Both binaries still work, because the platform packages (`@cloudflare/workerd-darwin-arm64`) arrive as optional dependencies.

`vp exec wrangler` sees a login made with `vpx wrangler login`: `vp exec wrangler whoami` printed "You are logged in with an OAuth Token" and the account table, so `vpx` was not needed.

## What is on the spike branch

- `worker/index.ts` is the spike Worker. `export default { fetch }` sends `GET /api/providers` to a fixed provider list and answers every other path it receives with a JSON 404. A provider appears in the list only when its secret is a non-empty string, and the response never contains the value. It also exports `handle(request, env)`, so the planned Node host in `server/vite-host.ts` can call the same code.
- `worker/spike/encode-bench.ts` is a measurement Worker for the multipart and base64 questions. It is never deployed with the app.
- `worker/tsconfig.json` and the generated `worker/worker-configuration.d.ts` type the Worker code separately from the root project.
- `wrangler.jsonc` configures the Worker. Every key was checked in `node_modules/wrangler/config-schema.json`.
- `vite.config.ts` adds the two plugins inside `lazyPlugins`, behind the existing Varlock gate (see path A below).
- `.gitignore` now ignores `.wrangler` (local Wrangler and plugin state) and `.dev.vars` files, except `.dev.vars.example`.

## Findings

Each row is one item from the issue's scope. The step numbers refer to [How each step ran](#how-each-step-ran).

| Scope item                                                                                           | Result                                                                                                                                                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One-route Worker, `wrangler.jsonc`, both plugins inside `lazyPlugins`                                | **Done.**                                                                                                                                                                                                                                                                                                                                                                                                                          | Files listed above. `vp check`, `vp test`, and `vp run build` pass.                                                                                                                                                                                                                                     |
| `vp dev` runs the Worker runtime (path A or B)                                                       | **Path A works**, both with the plain `@cloudflare/vite-plugin` and with `varlockCloudflareVitePlugin`.                                                                                                                                                                                                                                                                                                                            | Step 1, and [Path A under `vp dev`](#path-a-under-vp-dev).                                                                                                                                                                                                                                              |
| A 1Password-resolved value reaches the local Worker's `env`                                          | **Yes.** Under `vp dev`, `GET /api/providers` listed TypeSafe, which the Worker does only when `env.TYPESAFE_API_KEY` is a non-empty string.                                                                                                                                                                                                                                                                                       | Step 1: `{"providers":[{"id":"typesafe","name":"TypeSafe"}]}`.                                                                                                                                                                                                                                          |
| `vp run build` and `vp exec wrangler deploy` serve the UI and `GET /api/providers`                   | **Yes.**                                                                                                                                                                                                                                                                                                                                                                                                                           | Step 4: `GET /` returned `200 text/html`, and `GET /api/providers` returned `200 application/json` `{"providers":[]}` before any key was set.                                                                                                                                                           |
| One secret set: the response lists that provider and no secret value appears in the response or logs | **Yes.** After `varlock-wrangler deploy` uploaded the TypeSafe key, the list showed TypeSafe. A search for the real key in the tail capture, the deploy output, and the secret list found nothing.                                                                                                                                                                                                                                 | Step 5.                                                                                                                                                                                                                                                                                                 |
| `@sensitive` items readable as plain `env.TYPESAFE_API_KEY` without importing `/init`                | **Yes.** `worker/index.ts` does not import `@varlock/cloudflare-integration/init`, and the deployed Worker read the key. `varlock-wrangler` uploads each `@sensitive` item that has a value as a secret under its schema name.                                                                                                                                                                                                     | Step 5. Source: `dist/varlock-wrangler.mjs`, `handleDeploy`: `if (item.isSensitive) secretsObj[key] = strValue; else varFlags.push("--var", ...)`.                                                                                                                                                      |
| `run_worker_first: ["/api/*"]` sends an unknown `/api/x` to the Worker                               | **Yes, locally and on Cloudflare.** `GET /api/x` returned `404 application/json` `{"error":"No API route matches /api/x."}`. `/api` without a trailing slash does not match the pattern and gets the single-page app.                                                                                                                                                                                                              | Steps 1 and 4, and [Routing](#routing-and-the-json-404).                                                                                                                                                                                                                                                |
| Import path of `varlockCloudflareVitePlugin`                                                         | `import { varlockCloudflareVitePlugin } from "@varlock/cloudflare-integration";` (the package's `.` export). **Importing it runs `varlock load` immediately**, so it must stay behind a dynamic import and the serve-only gate.                                                                                                                                                                                                    | `package.json` maps `.` to `./dist/index.mjs`, which ends with `export { varlockCloudflareVitePlugin };`. It imports `./dist-B9aOE838.mjs`, whose line 1570 is a top-level `reloadConfig();` that calls `execSyncVarlock("load --format json-full --compact", ...)`.                                    |
| Inbound request body limit                                                                           | Set by the **account** plan, not the Workers plan: 100 MB on Free and Pro, 200 MB on Business, up to 5 GB (self-serve) on Enterprise.                                                                                                                                                                                                                                                                                              | https://developers.cloudflare.com/workers/platform/limits/ : "Request body size limits depend on your Cloudflare account plan, not your Workers plan."                                                                                                                                                  |
| Worker types package and `worker/tsconfig.json`                                                      | **Generated runtime types from `wrangler types`**, not `@cloudflare/workers-types`. See [Worker types](#worker-types).                                                                                                                                                                                                                                                                                                             | https://developers.cloudflare.com/workers/languages/typescript/ : "We recommend you use `wrangler types` to generate runtime types, rather than using the `@cloudflare/workers-types` package".                                                                                                         |
| What path A and path B mean for dev serving                                                          | Dev serving goes through `server/vite-host.ts` (the planned Node host that calls the Worker's `handle`) in **both** cases. Path A adds the Worker runtime inside `vp dev`. Path B keeps only the Node host. **Path A is chosen.**                                                                                                                                                                                                  | [Path A and path B](#path-a-and-path-b), and ADR-0001.                                                                                                                                                                                                                                                  |
| Was `nodejs_compat` needed?                                                                          | **No.** `wrangler.jsonc` sets no compatibility flags.                                                                                                                                                                                                                                                                                                                                                                              | [Base64 and multipart](#base64-and-multipart).                                                                                                                                                                                                                                                          |
| Workers limits the image path depends on                                                             | Memory: 128 MB per isolate on Free and Paid. CPU time per HTTP request: 10 ms on Free; 30 seconds by default on Paid, configurable up to 5 minutes. A Worker that "infrequently runs over the configured limit" is tolerated, but one that hits it "consistently" is stopped with error 1102.                                                                                                                                      | https://developers.cloudflare.com/workers/platform/limits/ : "Each isolate can consume up to 128 MB of memory, including the JavaScript heap and WebAssembly allocations." and "On the Workers Paid plan, you can increase the maximum CPU time from the default 30 seconds to 5 minutes (300,000 ms)." |
| Native base64 encoder in workerd                                                                     | **`Uint8Array.prototype.toBase64()`**, which exists with or without Node compatibility. `Buffer` exists only because compatibility dates from 2026-08-04 turn `nodejs_compat` on by default.                                                                                                                                                                                                                                       | [Base64 and multipart](#base64-and-multipart).                                                                                                                                                                                                                                                          |
| `request.formData()` returns `File` parts readable with `arrayBuffer()`                              | **Yes, locally and on Cloudflare.** Both image parts are `File` instances with the right `type` and 4,194,304 bytes each; a text field arrives as a string.                                                                                                                                                                                                                                                                        | Step 7.                                                                                                                                                                                                                                                                                                 |
| CPU time and memory for an 8 MiB multipart body with two images, encoded natively                    | **CPU: 19 to 43 ms per request on Cloudflare (median 27 ms)**, over 25 requests, all `ok`. That includes parsing, copying both parts, and running both encoders. **Memory: not measured on Cloudflare.** No request failed with a memory error, which only shows that the isolate stayed under its 128 MB limit.                                                                                                                   | Step 7: `wrangler tail --format json`, field `cpuTime`.                                                                                                                                                                                                                                                 |
| Does that fit the Free plan?                                                                         | **No.** 19 to 43 ms is two to four times the Free plan's 10 ms. All 25 requests succeeded, which matches the limits page's tolerance for infrequent overruns, but steady image traffic would be stopped with error 1102. **The image path needs the Workers Paid plan**, or a much smaller image limit.                                                                                                                            | Step 7 and the limits page. Which plan the owner's account is on was not checked.                                                                                                                                                                                                                       |
| `wrangler secret put` before the first deploy                                                        | **Works.** It creates the Worker first.                                                                                                                                                                                                                                                                                                                                                                                            | Step 3: "There doesn't seem to be a Worker called "decisionmachines3000-scratch". Do you want to create a new Worker with that name and add secrets to it?", "🤖 Using fallback value in non-interactive context: yes", "✨ Success! Uploaded secret SPIKE_EXTRA_SECRET".                               |
| Which `wrangler secret list` output a script can parse                                               | **`wrangler secret list --name <worker> --format json`.** stdout is a JSON array of `{ "name", "type" }` objects with nothing else around it. `JSON.parse` read it as an array of 1 and later 3 entries. Before the first deploy, the command exits 1 with "Worker ... not found" on stderr.                                                                                                                                       | Steps 3 and 6. `--help`: `--format ... [choices: "json", "pretty"] [default: "json"]`.                                                                                                                                                                                                                  |
| Can a Deploy-button build run `wrangler secret list` and see the prompted secrets?                   | **Yes.** With the build command `npx wrangler secret list --format json && npm run build` and no extra credentials, the build log printed the three prompted names as a bare JSON array.                                                                                                                                                                                                                                           | Step 9, result 7: `[{"name":"OPENAI_API_KEY","type":"secret_text"},{"name":"SUBQ_API_KEY","type":"secret_text"},{"name":"TYPESAFE_API_KEY","type":"secret_text"}]`.                                                                                                                                     |
| Deploy button with one key blank                                                                     | **Refused.** Every key in `.dev.vars.example` is a required input, enforced by the browser's own validation.                                                                                                                                                                                                                                                                                                                       | Step 9, result 1.                                                                                                                                                                                                                                                                                       |
| If blanks are refused, is a placeholder accepted?                                                    | **Yes, and it becomes a live secret.** `unset` was accepted, and all three keys were then listed as `secret_text`. The Worker must treat exactly `unset` as absent.                                                                                                                                                                                                                                                                | Step 9, result 4: `wrangler secret list --format json` on the button-deployed Worker listed `OPENAI_API_KEY`, `SUBQ_API_KEY`, `TYPESAFE_API_KEY`.                                                                                                                                                       |
| Other Deploy-button behaviour                                                                        | It clones the repository into the deployer's GitHub account under the project name, and fails if that name is taken. It rewrites only `name` in `wrangler.jsonc`. Its first build always fails on Cloudflare's "Uploading template." commit, and the next one succeeds. npm 11.16.0 in the build image needs the `devEngines` range from #26.                                                                                      | Step 9, results 2, 3, 5, and 6.                                                                                                                                                                                                                                                                         |
| Does an extra secret survive `varlock-wrangler deploy`?                                              | **Yes.** `SPIKE_EXTRA_SECRET`, set with `wrangler secret put` and not in the schema, was still listed after `varlock-wrangler deploy`. Varlock's "replaces all Cloudflare vars and secrets" does not hold for secrets; Wrangler's "Secrets are never deleted by a deployment" does.                                                                                                                                                | Step 5 secret list: `SPIKE_EXTRA_SECRET`, `TYPESAFE_API_KEY`, `__VARLOCK_ENV`, all `secret_text`.                                                                                                                                                                                                       |
| Why the project does not use `secrets.required`                                                      | **Confirmed from the source.** At deploy, every listed secret that has no value becomes an `inherit` binding, and a missing one fails the deploy with "The following required secrets have not been set". In local dev, defining `secrets` limits the loaded keys to those listed, and the schema says it "Replaces .dev.vars/.env/process.env inference for type generation". A fork with one of three keys would fail to deploy. | `cli.js`, `addRequiredSecretsInheritBindings` (line 176159) and the dev loader near line 191116; `config-schema.json`, `secrets.required`.                                                                                                                                                              |
| `vp check` and `vp test` never wait on 1Password                                                     | **Confirmed.** Both finish without a prompt. `vp run build` also never imports Varlock, because the build loads only the plain Cloudflare plugin.                                                                                                                                                                                                                                                                                  | `vp check`: "Found no warnings, lint errors, or type errors in 29 files". `vp test`: "Tests 156 passed (156)".                                                                                                                                                                                          |

## How each step ran

Steps 1 and 3 to 8 ran from this worktree; the owner ran step 9 in the browser. Step 2 (`wrangler login`) was skipped because the owner was already logged in. Every deploy used a scratch name: `decisionmachines3000-scratch` or `decisionmachines3000-bench`. Both were deleted in step 8. No Worker named `decisionmachines3000` was deployed. The key was never printed: a small script read it with `op read` into a shell variable and reported only "found" or "not found", after a positive control in memory that showed the search works.

### Step 1: Varlock under `vp dev`

```text
$ vp dev --port 5199 --strictPort
🔒 [varlock] injecting resolved env into the Cloudflare worker
23:46:05 [vite+] (decisionmachines3000) dependencies optimized: varlock/encrypt-env, varlock/env, varlock/patch-console, varlock/patch-response
  ➜  Local:   http://localhost:5199/

$ curl -s http://localhost:5199/api/providers
{"providers":[{"id":"typesafe","name":"TypeSafe"}]}  [200]
$ curl -s http://localhost:5199/api/x
{"error":"No API route matches /api/x."}  [404]
$ curl -s -X POST -H "content-type: application/json" \
    -d '{"primitive":"noul","state":"The sky is blue on a clear day.","questions":{"q":{"instructions":"Is the statement true?"}}}' \
    http://localhost:5199/api/jev
{"ok":true,"primitive":"noul","model":"jev-1.13.0","usage":{"input_tokens":280,"output_tokens":20},"latencyMs":460,"connection":"new","keepAliveSeconds":4,"answers":{"q":{"type":"noul","noul":0.95}}}  [200]
```

The key was not found in the dev-server log. One practical note: stopping the `vp` process left its Node child listening on port 5199, which had to be stopped separately. Ctrl+C in a terminal stops both.

### Step 3: secrets before the first deploy

```text
$ vp exec wrangler secret list --name decisionmachines3000-scratch --format json
✘ [ERROR] Worker "decisionmachines3000-scratch" not found.
  If this is a new Worker, run `wrangler deploy` first to create it.
exit=1

$ printf '%s' 'spike-extra' | vp exec wrangler secret put SPIKE_EXTRA_SECRET --name decisionmachines3000-scratch
🌀 Creating the secret for the Worker "decisionmachines3000-scratch"
? There doesn't seem to be a Worker called "decisionmachines3000-scratch". Do you want to create a new Worker with that name and add secrets to it?
🤖 Using fallback value in non-interactive context: yes
🌀 Creating new Worker "decisionmachines3000-scratch"...
✨ Success! Uploaded secret SPIKE_EXTRA_SECRET
exit=0

$ vp exec wrangler secret list --name decisionmachines3000-scratch --format json
[
  {
    "name": "SPIKE_EXTRA_SECRET",
    "type": "secret_text"
  }
]
```

### Step 4: plain deploy

```text
$ vp run build && vp exec wrangler deploy --name decisionmachines3000-scratch
Using redirected Wrangler configuration.
 - Configuration being used: "dist/decisionmachines3000/wrangler.json"
✨ Read 6 files from the assets directory .../dist/client
✨ Success! Uploaded 4 files (2.10 sec)
Uploaded decisionmachines3000-scratch (11.31 sec)
▲ [WARNING] Because 'workers_dev' is not in your Wrangler file, it will be enabled for this deployment by default.
▲ [WARNING] Because your 'workers.dev' route is enabled and your 'preview_urls' setting is not in your Wrangler file, Preview URLs will be enabled for this deployment by default.
Deployed decisionmachines3000-scratch triggers (2.87 sec)
```

| Request on the deployed Worker | Response                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /`                        | `200 text/html`, the app                                                                                                                                                                                                                                                                                                                                                       |
| `GET /api/providers`           | `200 application/json` `{"providers":[]}`                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/x`                   | `404 application/json` `{"error":"No API route matches /api/x."}`                                                                                                                                                                                                                                                                                                              |
| `GET /api/`                    | `404 application/json`                                                                                                                                                                                                                                                                                                                                                         |
| `GET /api`                     | `200 text/html`, the single-page app                                                                                                                                                                                                                                                                                                                                           |
| `GET /some/spa/route`          | `200 text/html`, with or without `Sec-Fetch-Mode: navigate`. The very first request, seconds after the deploy, returned `404 text/plain`; six later requests all returned 200. The cause was not confirmed; the likely one is static assets still propagating after the deploy. The deploy guide (#17) should tell people to wait a few seconds before opening a fresh deploy. |
| `POST /api/providers`          | `405`, `allow: GET`                                                                                                                                                                                                                                                                                                                                                            |

`--name` overrides the name in the redirected config, so a scratch deploy never touches the real name. The secret set in step 3 was still listed after this deploy.

### Step 5: deploy through Varlock

```text
$ vp exec varlock-wrangler deploy --name decisionmachines3000-scratch
✨ Deploying with varlock: 0 vars, 1 secret 🧙🔒
Your Worker has access to the following bindings:
Binding                                Resource
env.TYPESAFE_API_KEY ("(hidden)")      Environment Variable
env.__VARLOCK_ENV ("(hidden)")         Environment Variable
Deployed decisionmachines3000-scratch triggers (2.19 sec)

$ curl -s <scratch Worker URL>/api/providers
{"providers":[{"id":"typesafe","name":"TypeSafe"}]}  [200, three times]

$ vp exec wrangler secret list --name decisionmachines3000-scratch --format json
[
  { "name": "SPIKE_EXTRA_SECRET", "type": "secret_text" },
  { "name": "TYPESAFE_API_KEY", "type": "secret_text" },
  { "name": "__VARLOCK_ENV", "type": "secret_text" }
]
```

Wrangler's bindings table labels both values "Environment Variable", but the secret list shows they were stored as secrets (`secret_text`). `wrangler tail --format json` captured four events (three `GET /api/providers` and one `GET /api/x`, all `ok`, with no logs and no exceptions). The key search reported "not found" for the tail capture, the deploy output, and the secret list. The tail was stopped and `tail.json` deleted.

### Step 6: script-readable secret list

`JSON.parse` of the saved stdout from step 5 returned an array: `SPIKE_EXTRA_SECRET:secret_text, TYPESAFE_API_KEY:secret_text, __VARLOCK_ENV:secret_text`. No banner or other text was mixed in.

### Step 7: CPU and memory on Cloudflare

```text
$ vp exec wrangler deploy -c wrangler.jsonc worker/spike/encode-bench.ts --name decisionmachines3000-bench
Deployed decisionmachines3000-bench triggers (2.25 sec)
```

The two 4 MiB `/dev/urandom` files from the local run were posted 25 times with `curl -H "Expect:"`. Every request returned 200 with both parts as `File` objects of 4,194,304 bytes. `wrangler tail --format json` reported:

```text
events 25 outcomes {"ok":25}
cpuTime ms min 19 median 27 max 43
all cpuTime 19 21 22 22 22 22 23 23 24 24 26 26 27 27 27 29 30 31 34 35 36 39 39 40 43
```

The first five had `wallTime` between 76 and 120 ms. The bench's own timers read 0 ms on Cloudflare for both encoders and both readings, so the zero-delay timer does not let the clock advance there; `cpuTime` from the tail is the only usable number. The bench does more than a real handler would, because it runs both encoders, so a handler with one `toBase64()` call should land somewhat lower, but not near 10 ms.

### Step 8: clean up

```text
$ vp exec wrangler delete decisionmachines3000-scratch
? Are you sure you want to delete decisionmachines3000-scratch? This action cannot be undone.
🤖 Using fallback value in non-interactive context: yes
Successfully deleted decisionmachines3000-scratch
$ vp exec wrangler delete decisionmachines3000-bench
Successfully deleted decisionmachines3000-bench
```

Afterwards the scratch URL returned 404, and no `wrangler tail`, `vp dev`, or workerd process from this worktree was left running.

### Step 9: Deploy button

The owner ran this step in the browser, against the owner's throwaway clone of this branch. The clone differs from this branch in three ways: `wrangler.jsonc` uses a throwaway Worker name, the README carries the button, and a `.dev.vars.example` lists the three provider keys with no values. The results are also recorded on issue #17.

1. **The button refuses blank secrets.** Every key in `.dev.vars.example` becomes a required input, and the form enforces it with the browser's own "this field cannot be empty" validation. Leaving the keys you do not have blank is not possible.
2. **The button clones the repository into the deployer's GitHub account**, using the project name as the repository name. If that name is already taken, the deploy fails, so the deployer has to pick another project name.
3. **The first deploy failed during `npm install`.** Cloudflare's build image runs npm 11.16.0, which refused the exact `devEngines` pin `12.1.0` with `EBADDEVENGINES`. Issue #26 fixes it with the range `^11.16.0 || 12.1.0` (PR #28, open as of 2026-10-13), and the retry installed and deployed with that range.
4. **`unset` is accepted as a value, and it becomes a live secret.** With a real `TYPESAFE_API_KEY` and `unset` for the other two, the deploy succeeded, and `wrangler secret list --format json` on the new Worker listed `OPENAI_API_KEY`, `SUBQ_API_KEY`, and `TYPESAFE_API_KEY`, all `secret_text`. A Worker that lists every provider whose secret is non-empty, as the spike Worker does, would therefore show SubQ and OpenAI as configured. The Worker needs a rule that treats a value of exactly `unset` (trimmed, any case) as absent, which #17 records.
5. **The button rewrites only `name` in `wrangler.jsonc`**, setting it to the chosen project name. Comments, `run_worker_first`, and `not_found_handling` survive.
6. **Cloudflare's first build always fails, harmlessly.** It runs on Cloudflare's own "Uploading template." commit, which contains only `wrangler.jsonc`, and fails with `ENOENT … /opt/buildhome/repo/package.json`. The "source repo import" commit that follows builds and deploys.
7. **A Workers Builds build can list its Worker's secrets.** With the build command `npx wrangler secret list --format json && npm run build`, and no extra credentials, the build log printed `[{"name":"OPENAI_API_KEY","type":"secret_text"},{"name":"SUBQ_API_KEY","type":"secret_text"},{"name":"TYPESAFE_API_KEY","type":"secret_text"}]` as a bare JSON array. The deploy-time key check can therefore run inside the build command on the button path. It sees names only, so a key set to `unset` passes it, and the Worker's runtime rule stays the safeguard for that case.

For reference, this is the `.dev.vars.example` used in the clone. Its "Leave the others blank" line turned out to be wrong for the button path, as result 1 shows, so #17 has to word its file differently.

```dotenv
# Provider API keys for the Deploy to Cloudflare button test (spike #1).
# Set at least one of these. Leave the others blank. Never commit real values.

# TypeSafe API key, for the Jev decision model.
TYPESAFE_API_KEY=

# SubQ API key, for SubQ Snap.
SUBQ_API_KEY=

# OpenAI API key, for OpenAI Decisions.
OPENAI_API_KEY=
```

The button snippet follows the Deploy buttons page (https://developers.cloudflare.com/workers/platform/deploy-buttons/):

```md
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<public repository URL>)
```

## Path A under `vp dev`

`@cloudflare/vite-plugin` 1.63.1 runs under Vite+ 0.2.8 without changes. Before the 1Password run in step 1, it was tried without Varlock through a temporary config that was not committed, with `VITEST=1` set so that the existing gate in `vite.config.ts` would still have skipped Varlock if `vp dev` had ignored `--config`:

```ts
// vite.spike-dev.config.ts (temporary, deleted afterwards)
import { defineConfig } from "vite-plus";
import { cloudflare } from "@cloudflare/vite-plugin";
import { jevApiPlugin } from "./server/jev-api.ts";

export default defineConfig({
  plugins: [jevApiPlugin(), cloudflare()],
});
```

| Request (`VITEST=1 vp dev --config vite.spike-dev.config.ts --port 5199 --strictPort`) | Response                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/providers`                                                                   | `200 application/json` `{"providers":[]}` (no key in this session)                                                                                                          |
| `GET /api/x`                                                                           | `404 application/json` `{"error":"No API route matches /api/x."}`                                                                                                           |
| `POST /api/providers`                                                                  | `405`, `allow: GET`                                                                                                                                                         |
| `GET /some/spa/route`                                                                  | `200 text/html`, the app's `index.html` with `<script type="module" src="/@vite/client">`                                                                                   |
| `POST /api/jev` with `{}`                                                              | The Node middleware's own validation error: `{"ok":false,"error":"Set \"primitive\" to \"noul\", \"choice\", or \"score\". It is currently missing.","detail":"primitive"}` |

Plugin order matters. Both plugins add their middleware in `configureServer`, so the one listed first sees a request first. With `jevApiPlugin()` first, `/api/jev` stays in Node and every other `/api/*` path goes to the Worker. The Cloudflare side is `cloudflarePreMiddleware` in `node_modules/@cloudflare/vite-plugin/dist/index.mjs` (around line 95993), which sends paths that match `run_worker_first` to the Worker.

The committed `vite.config.ts` uses the same order. For `vp dev` and `vp preview` it loads `varlockCloudflareVitePlugin()`, which wraps the Cloudflare plugin and injects the resolved environment into the Worker. For `vp build` it loads the plain `cloudflare()` plugin. For tests and metadata reads it loads neither.

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

The built `wrangler.json` keeps `run_worker_first` and `not_found_handling`, and points `assets.directory` at `../client`. `wrangler dev` and `wrangler deploy` both pick the redirect up and print "Using redirected Wrangler configuration."

Two consequences follow from this:

- The Worker bundle is not served as a static file. `GET /decisionmachines3000/index.js` returns the single-page app, because only `dist/client` is the assets directory. That is why `wrangler.jsonc` points `assets.directory` at `./dist/client` rather than `./dist`.
- After a build, `wrangler dev worker/spike/encode-bench.ts` uses the redirected config, which has `no_bundle: true`, so it loads the TypeScript file unbundled and fails with `Uncaught SyntaxError: Unexpected identifier 'PartReport'`. Passing `-c wrangler.jsonc` fixes it, for `wrangler deploy` too.

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

The dummy value appears in neither the responses nor the Wrangler log: `grep -c spike-dummy-value-123` on both returned 0, and the bindings table shows `env.TYPESAFE_API_KEY ("(hidden)")`. Step 4 repeated the routing checks on Cloudflare with the same results.

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

Locally, `worker/spike/encode-bench.ts` received two 4 MiB random files (`image/png` and `image/jpeg`) and a text field, 8,389,052 bytes in total, sent with `curl -H "Expect:"`. Without `-H "Expect:"`, curl waits one second for a `100 Continue` reply that never comes, which inflates the parse time to about 1,040 ms. Over six local requests, `toBase64()` took 3 to 4 ms for both parts and `Buffer` took 4 to 8 ms. `parseAndReadMs` was 20 to 23 ms of wall time, which includes receiving 8 MiB through Wrangler's local proxy. Locally the clock runs freely (https://developers.cloudflare.com/workers/runtime-apis/performance/: "In local development, however, timers will increment regardless of whether I/O happens or not."). On Cloudflare it does not, which is why step 7 used the tail's `cpuTime`.

Local memory, sampled every 20 ms with `ps -o rss=` on the workerd process that runs the Worker:

| Run                               | Before      | Peak sampled | After       |
| --------------------------------- | ----------- | ------------ | ----------- |
| Fresh process, 1 request          | 103,248 KiB | 148,480 KiB  | 162,304 KiB |
| Warm process, 5 requests in a row | 105,184 KiB | 229,008 KiB  | 256,528 KiB |

One request grew the process by 45 to 59 MiB, while holding the 8 MiB body, an 8 MiB copy of the parts, and two rounds of 11 MB base64 strings. These numbers are process memory, not the isolate's heap. These local numbers include the whole runtime, so they are not comparable to the 128 MB isolate limit. Peak isolate memory was not measured on Cloudflare; 25 requests ran without a memory error, which only shows the isolate stayed under that limit.

## Path A and path B

- **Path A.** `vp dev` runs the Worker inside workerd through `@cloudflare/vite-plugin`, wrapped by `varlockCloudflareVitePlugin` so it gets the 1Password key. Dev serving still goes through `server/vite-host.ts`, the planned Node host (#6 adds it) that calls the Worker's `handle`, for whatever it registers first. Path A adds runtime parity for the routes the Worker owns.
- **Path B.** `@cloudflare/vite-plugin` is not used in `vp dev`. Only the planned `server/vite-host.ts` serves `/api/*`, in Node, and the Worker runtime is exercised only by `wrangler dev` and deploys.

Step 1 confirmed path A, and ADR-0001 records it as accepted.

## Results that change other issues

- **#15 (server-side images).** One 8 MiB request with two images cost 19 to 43 ms of CPU, against the Free plan's 10 ms. Plan for the Workers Paid plan, or cap uploads well below 8 MiB, and say so in the deploy guide. In-Worker timers read 0 on Cloudflare, so any CPU measurement in #15 has to use `wrangler tail` or the dashboard.
- **#17 (plain Wrangler profile and deploy-time key check).** `wrangler secret list` exits 1 with "Worker ... not found" before the first deploy, so the check script has to handle a Worker that does not exist yet instead of treating the error as a failure. `wrangler secret put` on a new name creates a placeholder Worker (`export default { fetch() {} }`) before the first real deploy, which contradicts Wrangler's own message for `secrets.required` that "secrets cannot be set in advance with `wrangler secret put`".
- **#17 (Deploy button).** The button refuses blank secrets, so every key in `.dev.vars.example` is required on the button path, and the file and guide must not tell people to leave keys blank. A placeholder is accepted but arrives as a live secret, so the Worker must treat a value of exactly `unset` (trimmed, any case) as absent, with tests on both sides of that rule. The deploy-time key check can run on the button path by putting it in the build command before `npm run build`, because a Workers Builds build can list its secrets; it sees names only, so the runtime rule remains the safeguard against `unset`. The guide should also warn that the first build always fails on Cloudflare's "Uploading template." commit, and that a taken repository name fails the deploy.
- **#26 (npm range in `devEngines`).** Cloudflare's build image runs npm 11.16.0, which refuses the exact pin `12.1.0` with `EBADDEVENGINES`, so no button deploy can install the project until #26 / PR #28 lands with `^11.16.0 || 12.1.0`. As of 2026-10-13, both `main` and the spike branch still have the exact pin.
- **#18 (Varlock profile).** `varlock-wrangler deploy` does not remove secrets that are missing from the schema, so a key removed from the vault stays on the Worker until `wrangler secret delete` runs. The guide should say that, and the "one writer" rule cannot rely on Varlock to clean up. Wrangler also labels Varlock's secrets "Environment Variable" in its bindings table; `wrangler secret list` is the way to confirm they are secrets.
- **#14 (fail closed on deployed instances).** Without `workers_dev` and `preview_urls` in `wrangler.jsonc`, Wrangler enables both on every deploy, so each version also gets a public preview URL. #14 has to set or protect both.
- **#6 (Worker skeleton).** `/api` without a trailing slash goes to the single-page app, not the Worker. If the Worker should own it, add `"/api"` to `run_worker_first`.

## Sources checked for syntax

- `wrangler.jsonc` keys: `node_modules/wrangler/config-schema.json` (`RawConfig`, which also lists `workers_dev` and `preview_urls`, and the `Assets` definition, which allows `directory`, `binding`, `html_handling`, `not_found_handling`, `base_path`, and `run_worker_first`).
- Wrangler commands and flags: `--help` for `whoami`, `types`, `dev`, `deploy`, `secret put`, `secret list`, `secret delete`, `tail`, and `delete`.
- `cloudflare()` options and the middleware order: `node_modules/@cloudflare/vite-plugin/dist/index.d.mts` and `dist/index.mjs`.
- `varlockCloudflareVitePlugin` and `varlock-wrangler`: `node_modules/@varlock/cloudflare-integration/dist/index.mjs`, `dist/dist-B9aOE838.mjs`, `dist/varlock-wrangler.mjs`.
- `lazyPlugins` and `lint.ignorePatterns`: `node_modules/vite-plus/docs/guide/troubleshooting.md` and `lint.md`.
- `toBase64` types: `node_modules/typescript/lib/lib.esnext.typedarrays.d.ts`.
- `op read`: `op read --help`.
- Deploy button snippet: https://developers.cloudflare.com/workers/platform/deploy-buttons/.
