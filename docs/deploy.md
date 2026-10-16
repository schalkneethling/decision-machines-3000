# Deploying DecisionMachines3000

This guide covers deploying the Worker with the Deploy to Cloudflare button or by hand with plain Wrangler, and protecting the instance afterwards. Whichever way you deploy, **the first step after the deploy is protecting the instance** (section 2), because a fresh instance refuses every run until you do.

## The one-writer rule

Read this before running any command below. **One tool writes a Worker's secrets, and the other must not touch them.** This guide is the plain-Wrangler profile: the secrets are written by `wrangler secret put`, `wrangler secret bulk`, and `wrangler versions secret put`, and nothing else.

- Do not run `varlock-wrangler deploy` against a Worker whose secrets you set with this guide. It uploads every `@sensitive` item in `.env.schema` that has a value, so it overwrites a key you set here with whatever the vault holds, and it adds secrets of its own.
- Once a Varlock profile exists (issue #18), do not run `wrangler secret put` or `wrangler secret bulk` against a Worker it manages, because the next `varlock-wrangler deploy` writes the vault's value over yours.

Going the other way is the safer mistake. A plain `wrangler deploy` never deletes secrets (Wrangler 4.150.0 passes `keepSecrets: true` when it uploads a Worker, in `node_modules/wrangler/wrangler-dist/cli.js`; `--keep-vars` covers plain variables only), so running it by accident against a Varlock-managed Worker leaves its secrets alone.

## 1. Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/schalkneethling/jev-3000)

The button clones this repository into your GitHub account, asks for the provider keys, and deploys a Worker to `<name>.<your-subdomain>.workers.dev`. These points come from a test of the button on a throwaway account (docs/spikes/worker-toolchain.md, step 9):

- **Every key is a required input.** The form refuses a blank (it uses the browser's own "this field cannot be empty" check), so you cannot leave a key out. For each provider you do not have, enter exactly the word `unset`. The Worker treats exactly that word (trimmed, in any case) as "no key", and nothing else: a short real key such as `x` still counts as a key.
- **At least one of the three must be a real key.** With all three set to `unset`, the page loads but `GET /api/providers` answers 503 with the setup notice.
- **`unset` is stored as a live secret.** `wrangler secret list` shows all three names even when two are `unset`. That is expected, and it is why the deploy-time key check (below) cannot spot it: the check reads names, never values.
- **The button names the new repository after the project name you choose.** If your GitHub account already has a repository with that name, the deploy fails. Choose another project name. The button also writes that name into `wrangler.jsonc` as the Worker's name.
- **The first build fails, and that is harmless.** Cloudflare's first build runs on its own "Uploading template." commit, which holds only `wrangler.jsonc`, so it fails with an error about a missing `package.json`. The next commit brings the source, and the build after it succeeds.
- **The deploy field is pre-filled from the `deploy` script** in `package.json` (Cloudflare's Deploy buttons page says so), which runs the key check and then a plain `wrangler deploy`. See "The deploy script" in section 3.
- **The prompts come from `.dev.vars.example`,** and their descriptions from `cloudflare.bindings` in `package.json`. The protection variables are not in that file on purpose: the button would make each one a required input, and `ALLOW_UNPROTECTED_INSTANCE` must never be set by accident. Section 2 sets them.

## 2. Protect the instance (do this first)

**A freshly deployed instance refuses every run.** Each `POST /api/decide/{provider}` answers a JSON 503 that says so, the page shows a notice above the panels, and no provider is called. The same gate stands in front of `POST /api/warm/{provider}`, the warm-connection demo's route, which a deployed Worker cannot serve anyway (it answers 501 once the gate lets it through; the demo runs only under `vp dev`). This is deliberate ([ADR-0003](./adr/0003-fail-closed-access.md)): the Worker holds your provider keys, and anyone who can reach its hostname could otherwise spend your credit. Nothing works until you choose one of the two options below.

### Option A, recommended: Cloudflare Access

Access puts a sign-in in front of the Worker. Only the people your policy allows can open the page, and the Worker verifies the signed token Access attaches to each request, so a request that reaches the Worker another way is still refused.

1. In the Cloudflare dashboard, open **Workers & Pages**, select your Worker, and open the **Access** tab.
2. Select **Protect this Worker behind Access**, choose **All traffic**, and under **Authentication policy** pick or create a policy that allows you (for example your Cloudflare account, or your email domain). Select **Apply Access**. Zero Trust has to be enabled on the account; the dashboard offers that if it is not.
3. Open **Zero Trust** > **Access controls** > **Applications**, select the application Cloudflare just created for the Worker, and copy its **Application Audience (AUD) tag** (under Configure > Additional settings). Note your team domain too: it has the shape `<team>.cloudflareaccess.com`, and the team name is the one you chose when Zero Trust was set up.
4. Give the Worker both values. Secrets are the safe place, because a later `wrangler deploy` overwrites variables set in the dashboard but never touches secrets:

   ```sh
   vp exec wrangler secret put ACCESS_TEAM_DOMAIN   # your team, as `team` or `team.cloudflareaccess.com`
   vp exec wrangler secret put ACCESS_AUD           # the AUD tag you copied
   ```

   Each `secret put` deploys a new version at once. You can also set both as `vars` in `wrangler.jsonc` if you prefer them in the repository; they are not secret.

5. Open the page. Access asks you to sign in, and then the page loads without a notice. `GET /api/providers` reports `"protection": { "mode": "access", "validated": true }`.

If the page shows "Cloudflare Access is configured, but this request did not carry a valid Access token", the hostname you used is not behind Access. Use the protected one, or protect that hostname too. The Worker checks the token's signature against your team's current keys, its expiry, its issuer, and its audience, so a stale or foreign token is refused with a 403 that names the problem and never the token.

### Option B: accept an unprotected instance

If you want anyone to be able to use the instance, say so explicitly:

```sh
printf '%s' 'I accept the bill' | vp exec wrangler secret put ALLOW_UNPROTECTED_INSTANCE
```

The value has to be exactly that sentence; `yes`, `true`, or `1` do not count, which is what keeps this from being set by accident. The page then shows a notice that the instance is unprotected on purpose, and `GET /api/providers` reports `"mode": "opted_out"`. If you later set the Access variables as well, Access wins and the opt-out is ignored.

**An unprotected public instance can run up a bill.** Every run spends tokens on your provider account, and nothing in this app limits who can press Run or how often. Set a spending cap or a billing alert with each provider you have a key for before you opt out. Turnstile and Cloudflare WAF rate limiting are the planned follow-ups for owners who want a public instance.

## 3. Deploy by hand with plain Wrangler

Set at least one key first, then deploy, then do section 2. Log in once with `vp exec wrangler login` (or set `CLOUDFLARE_API_TOKEN`). The commands below use the Worker name in `wrangler.jsonc`; add `--name <worker>` to any of them to target another Worker. `vp run deploy` accepts the same flag (and `--env`/`-e` and `--config`/`-c`), and it passes the target to its key check as well as to the deploy, so the check always looks at the Worker that is about to change.

### Set the keys

```sh
vp exec wrangler secret put TYPESAFE_API_KEY     # prompts for the value without echoing it
vp exec wrangler secret list                     # names and types, never values
vp exec wrangler secret delete OPENAI_API_KEY    # removes one
```

- **`secret put` on a Worker that does not exist yet creates a placeholder Worker** (one whose handler does nothing) and then stores the secret. That is the supported way to set a key before the first deploy, and the next `wrangler deploy` replaces the placeholder with this app.
- **`secret list` before the first deploy fails** with `Worker "<name>" not found` and exit code 1. Nothing is wrong: it means no keys exist yet.
- **Several at once:** `secret bulk` takes a JSON file (`{"TYPESAFE_API_KEY": "...", "OPENAI_API_KEY": null}`, where `null` deletes) or a `.env` file (`KEY=VALUE`, no deletes), or reads the same from standard input. A file with real keys in it is a leak waiting to happen, so prefer standard input or delete the file at once.
- **Without deploying a new version at once:** `vp exec wrangler versions secret put TYPESAFE_API_KEY` creates a new version carrying the secret but does not send it traffic. `vp exec wrangler versions deploy` then rolls it out. In a terminal, a bare `versions deploy` opens an interactive picker. Outside a terminal (in a script or CI) it exits with code 0 without deploying anything, which looks like success, so there you pass the version and the traffic share, for example `vp exec wrangler versions deploy <version-id>@100 -y` (`-y` accepts the prompts). Plain `secret put` deploys at once.

### Keys from 1Password without a file

`op read` prints one field, and `-n` drops the trailing newline. Wrangler reads the secret from standard input when it is not run in a terminal, so the value never touches disk or your shell history:

```sh
op read -n "op://<vault>/<item>/<field>" | vp exec wrangler secret put TYPESAFE_API_KEY
```

This is plain Wrangler with 1Password as the source of the value. It is not the Varlock profile, and the one-writer rule above still holds.

### The deploy script

```sh
vp run build
vp run deploy
```

`deploy` in `package.json` runs `node scripts/deploy.ts`, which runs the key check and then `wrangler deploy`. It passes every argument you give it to `wrangler deploy`, and it passes the ones that choose the Worker (`--name`, `--env`/`-e`, `--config`/`-c`, `--cwd`, `--profile`, `--env-file`) to the check too. That matters because a plain `check && wrangler deploy` chain would hand extra arguments only to the deploy, so the check could pass on one Worker while the deploy changed another that has no keys. The check lists the Worker's secret names with `wrangler secret list --format json` and stops, with a message that names `TYPESAFE_API_KEY`, `SUBQ_API_KEY`, and `OPENAI_API_KEY`, if none of them exists. A Worker that does not exist yet counts as having none. If the listing fails for any other reason (for example you are not logged in), the check stops and says it could not read the names. The deploy step is a plain `wrangler deploy`, run only if the check passed, and the script exits with Wrangler's exit code. It prints no secret value, and it keeps every secret that is already set, so running it again never deletes a key.

The check sees names only. A key set to the word `unset` has a name, so it passes the check; the Worker's own rule treats it as absent at run time, and `GET /api/providers` answers 503 if every key is absent. On the button path the check runs in the deploy step, after the build.

To preview what a deploy would upload without uploading anything, run `vp exec wrangler deploy --dry-run`.

## 4. Hostnames and older versions

`wrangler.jsonc` keeps the `workers.dev` hostname on (`workers_dev: true`), because a fork has no other, and turns Version URLs off (`preview_urls: false`), so no version of the Worker gets a second public hostname. The gate lives in the Worker's code, not in the hostname, so for any version built from this change a custom domain or a Version URL you add later is refused in the same way until the request carries a valid Access token or the opt-out is set.

**Versions from before the gate have no gate.** Only versions built from this change (issue #14) carry it. If your Worker had versions before that, they answer runs for anyone, and they may still hold the provider keys, because secrets survive deploys. So:

- Do not roll back with `wrangler rollback` (or the dashboard's rollback) to a version from before #14 while the Worker holds a key. Delete those versions' keys first, or do not roll back.
- Do not turn Version URLs back on while a version from before #14 exists, because each version would get its own public hostname again.

What was verified on Cloudflare's pages (2026-10-15): `workers_dev` is on by default for a Worker without routes, and turning it off does not turn off Version, Preview, or Deployment URLs; `preview_urls` follows `workers_dev` when it is not set and is left unchanged by Wrangler when it is omitted; a Version URL has the shape `<version-prefix>-<worker-name>.<subdomain>.workers.dev`. What was not verified: whether a version that was never given a Version URL can still be reached by one after Version URLs are turned on, and whether rolling back re-exposes an old version at the production hostname with the current secrets. Treat both as yes until a live check says otherwise.

## Running the built Worker locally

`vp dev` needs none of this: its Node host is local by construction and runs every request. It counts as local whatever address it listens on, so starting it with `--host` on a shared network lets anyone on that network spend your credit; keep it on localhost.

`wrangler dev` runs the built Worker in workerd, which cannot tell a local run from Cloudflare, so it needs the same variables a deployment does, provider keys included. The project keeps no `.dev.vars` file (Varlock refuses to start beside one, so `vp dev` and `vp preview` both fail while one exists). There are two ways to pass the variables.

Without Varlock, copy [`.dev.vars.example`](../.dev.vars.example) to `.dev.vars`, fill in the keys you have, delete the lines you do not, and add the opt-out line. Git ignores `.dev.vars`. Delete it again before you run `vp dev` or `vp preview`.

Create or edit `.dev.vars` before `vp run build`, or rebuild after you change it: the build copies a root `.dev.vars` into `dist/decisionmachines3000/` and prints "Using secrets defined in .dev.vars". When you pass the built config yourself with `-c`, Wrangler reads the copy and ignores the root file. The copy sits inside `dist/`, which git ignores, and it is not uploaded: `wrangler deploy --dry-run` read the same 6 asset files and reported the same 182.23 KiB total with and without a `.dev.vars` present, because the assets directory is `dist/client`, a sibling of the copy. Still, delete `dist/decisionmachines3000/.dev.vars` (or `.dev.vars` and a rebuild) before you deploy by hand, so a stale local key never sits in a build you ship.

```sh
cp .dev.vars.example .dev.vars   # then edit it; add: ALLOW_UNPROTECTED_INSTANCE=I accept the bill
vp run build
vp exec wrangler dev
```

Or pass them on the command line with `--var KEY:VALUE`, which Wrangler splits at the first colon, so no file is involved. A command line lands in your shell history, so use this form for the opt-out and other non-secret values, and keep provider keys in `.dev.vars`:

```sh
vp run build
vp exec wrangler dev --var 'ALLOW_UNPROTECTED_INSTANCE:I accept the bill'
```

`vp preview` is not set up for these variables yet: it takes its environment from Varlock's `.env.schema`, which does not declare them (issue #18 covers that), so the built Worker under `vp preview` refuses runs as an unconfigured instance.
