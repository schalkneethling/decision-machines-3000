# Deploying DecisionMachines3000

This guide covers deploying the Worker with the Deploy to Cloudflare button, by hand with plain Wrangler, or with Varlock and 1Password, and protecting the instance afterwards. Whichever way you deploy, **the first step after the deploy is protecting the instance** (section 2), because a fresh instance refuses every run until you do.

## The one-writer rule

Read this before running any command below. **One tool writes a Worker's provider keys, and the other must not touch them.** This guide has two profiles, and a Worker uses one of them:

- **Plain Wrangler** (section 3, and section 1, where the button's form sets the keys): the keys are written by `wrangler secret put`, `wrangler secret bulk`, and `wrangler versions secret put`, and nothing else. Do not run `varlock-wrangler deploy` against such a Worker. It uploads every `@sensitive` item in `.env.schema` that has a value, so it overwrites a key you set by hand with whatever the vault holds, and it adds secrets of its own.
- **Varlock** (section 4): the keys are written by `vp run deploy:varlock`, which reads them from 1Password. Do not run `wrangler secret put` or `wrangler secret bulk` for a provider key on such a Worker, because the next `vp run deploy:varlock` writes the vault's value over yours. `varlock-wrangler deploy` also never removes a secret: a key you delete from the vault stays on the Worker until you run `wrangler secret delete` (section 4 shows how).

Going from Varlock to plain Wrangler by accident is the safer mistake. A plain `wrangler deploy` never deletes secrets (Wrangler 4.150.0 passes `keepSecrets: true` when it uploads a Worker, in `node_modules/wrangler/wrangler-dist/cli.js`; `--keep-vars` covers plain variables only), so running it against a Varlock-managed Worker leaves its secrets alone.

The protection settings from section 2 (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ALLOW_UNPROTECTED_INSTANCE`) are not in `.env.schema`, so Varlock does not manage them in either profile, and you set them with `wrangler secret put` as section 2 says.

**Target the same Worker every time.** Each `wrangler secret` command in this guide acts on the Worker named in `wrangler.jsonc` unless you add the same `--name` (and the same `--env` or `--config`, if you used one) that you gave the deploy. Without it, a protection setting could go to the wrong Worker and leave the one you deployed unprotected, and a `secret delete` could remove the wrong Worker's key.

## 1. Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/schalkneethling/decision-machines-3000)

The button clones this repository into your GitHub account, asks for the provider keys, and deploys a Worker to `<name>.<your-subdomain>.workers.dev`. These points come from a test of the button on a throwaway account (docs/spikes/worker-toolchain.md, step 9), and from a second run against this repository on 2026-10-19:

- **Change the project name before you deploy.** The form fills it in with the Worker name from `wrangler.jsonc`, `decisionmachines3000`. If your account already has a Worker with that name (for example one you deployed by hand), choose another name, because the button would deploy to it and write its own key secrets over yours. What happens in that case was not tested, so don't try it on a Worker you care about.

- **Every key is a required input.** The form refuses a blank (it uses the browser's own "this field cannot be empty" check), so you cannot leave a key out. For each provider you do not have, enter exactly the word `unset`. The Worker treats exactly that word (trimmed, in any case) as "no key", and nothing else: a short real key such as `x` still counts as a key.
- **At least one of the three must be a real key.** With all three set to `unset`, the page loads but `GET /api/providers` answers 503 with the setup notice.
- **`unset` is stored as a live secret.** `wrangler secret list` shows all three names even when two are `unset`. That is expected, and it is why the deploy-time key check (below) cannot spot it: the check reads names, never values.
- **The button names the new repository after the project name you choose.** If your GitHub account already has a repository with that name, the deploy fails. Choose another project name. The button also writes that name into `wrangler.jsonc` as the Worker's name.
- **The first build runs on the full source.** The 2026-10-19 run created the repository with one commit, "source repo import", and built that. (The earlier test saw a first build on a template-only "Uploading template." commit fail harmlessly; that commit no longer appears.) Cloudflare's build image installs with npm 10.9.2 and offers no way to choose another npm, which is why `devEngines` in `package.json` accepts it (#68). A build that fails at install with `EBADDEVENGINES` comes from a copy made before that change.
- **The form has three switches the earlier test did not see.** "Create private Git repository" is off by default. "Enable Preview builds" is on and runs `npx wrangler preview` for branches other than the production one; any version it uploads carries the same protection gate. "Protect with Cloudflare Access" is off. Turning it on was not tested, and even if it protects the hostname, the Worker still refuses runs until you set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` (section 2).
- **The deploy field is pre-filled from the `deploy` script** in `package.json` (Cloudflare's Deploy buttons page says so), which runs the key check and then a plain `wrangler deploy`. See "The deploy script" in section 3.
- **The prompts come from `.dev.vars.example`,** and their descriptions from `cloudflare.bindings` in `package.json`. The protection variables are not in that file on purpose: the button would make each one a required input, and `ALLOW_UNPROTECTED_INSTANCE` must never be set by accident. Section 2 sets them.

## 2. Protect the instance (do this first)

**A freshly deployed instance refuses every run.** Each `POST /api/decide/{provider}` answers a JSON 503 that says so, the page shows a notice above the panels, and no provider is called. The same gate stands in front of `POST /api/warm/{provider}`, the warm-connection demo's route, which a deployed Worker cannot serve anyway (it answers 501 once the gate lets it through; the demo runs only under `vp dev`). This is deliberate ([ADR-0003](./adr/0003-fail-closed-access.md)): the Worker holds your provider keys, and anyone who can reach its hostname could otherwise spend your credit. Nothing works until you choose one of the two options below.

### Option A, recommended: Cloudflare Access

Access puts a sign-in in front of the Worker. Only the people your policy allows can open the page, and the Worker verifies the signed token Access attaches to each request, so a request that reaches the Worker another way is still refused.

1. In the Cloudflare dashboard, open **Workers & Pages**, select your Worker, and open the **Access** tab.
2. Select **Protect this Worker behind Access**, choose **All traffic**, and under **Authentication policy** pick or create a policy that allows you (for example your Cloudflare account, or an Access policy that names your email address). Don't choose the pre-configured **Email domain** policy if your address is on a public mail service such as Gmail, because it lets in anyone with an address on that domain. Select **Apply Access**. Zero Trust has to be enabled on the account; the dashboard offers that if it is not.
3. Stay on the Worker's **Access** tab and reload it. Under **Application values** it shows the **AUD tag**, and a **JWKS** URL of the shape `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. Copy the AUD tag, and take your team domain, `<team>.cloudflareaccess.com`, from the JWKS URL. (The same AUD tag is also under **Zero Trust** > **Access controls** > **Applications** > the application Cloudflare created > Configure > Additional settings.)
4. Give the Worker both values (add your deploy's `--name`, as the rule above says). Secrets are the safe place, because a later `wrangler deploy` overwrites variables set in the dashboard but never touches secrets:

   ```sh
   vp exec wrangler secret put ACCESS_TEAM_DOMAIN   # your team, as `team` or `team.cloudflareaccess.com`
   vp exec wrangler secret put ACCESS_AUD           # the AUD tag you copied
   ```

   If you deployed with `--name` (or `--env` or `--config`), add the same flags to both commands.

   Each `secret put` deploys a new version at once. You can also set both as `vars` in `wrangler.jsonc` if you prefer them in the repository; they are not secret.

5. Open the page. Access asks you to sign in, and then the page loads without a notice. `GET /api/providers` reports `"protection": { "mode": "access", "validated": true }`.

If the page shows "Cloudflare Access is configured, but this request did not carry a valid Access token", the hostname you used is not behind Access. Use the protected one, or protect that hostname too. The Worker checks the token's signature against your team's current keys, its expiry, its issuer, and its audience, so a stale or foreign token is refused with a 403 that names the problem and never the token.

### Option B: accept an unprotected instance

If you want anyone to be able to use the instance, say so explicitly:

```sh
printf '%s' 'I accept the bill' | vp exec wrangler secret put ALLOW_UNPROTECTED_INSTANCE   # add the deploy's --name
```

The value has to be exactly that sentence; `yes`, `true`, or `1` do not count, which is what keeps this from being set by accident. The page then shows a notice that the instance is unprotected on purpose, and `GET /api/providers` reports `"mode": "opted_out"`. If you later set the Access variables as well, Access wins and the opt-out is ignored.

**An unprotected public instance can run up a bill.** Every run spends tokens on your provider account, and nothing in this app limits who can press Run or how often. Set a spending cap or a billing alert with each provider you have a key for before you opt out. A Turnstile check before each run (#65) and a rate limit on provider calls (#66) are the planned follow-ups for owners who want a public instance.

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

## 4. Deploy with Varlock and 1Password

Use this profile when your provider keys already live in 1Password. [Varlock](https://varlock.dev) reads them through the 1Password desktop app, `varlock-wrangler` (from `@varlock/cloudflare-integration`) uploads them to the Worker as secrets, and no key is ever written to disk or typed on a command line. It is an alternative to section 3, not an addition: pick one per Worker (see the one-writer rule above).

### What you need

- The [1Password desktop app](https://1password.com/downloads/) with its CLI integration turned on, and the [`op` CLI](https://developer.1password.com/docs/cli/). Run `op account list` to find your sign-in address.
- A 1Password item whose fields are named exactly `TYPESAFE_API_KEY`, `SUBQ_API_KEY`, and `OPENAI_API_KEY`. You need at least one of them to hold a real key, and the other two fields may be missing or empty. Get a key from [TypeSafe](https://typesafe.ai), [SubQ](https://subq.ai), or [OpenAI](https://platform.openai.com/api-keys).
- A Cloudflare login: `vp exec wrangler login`, or `CLOUDFLARE_API_TOKEN` in your environment.

### Steps

1. **Point `.env.schema` at your own item.** Change `account=my.1password.com` in the `@initOp(...)` line to your sign-in address, and replace `dev/nocajwa573emc6ko6sv5bkn6y4` in the three `op(op://...)` lines with your vault and item (each accepts a name or an id). Keep `allowMissing=true` on each of the three: `@optional` alone does not cover a field that is missing from the item, and without `allowMissing=true` the load fails on it. Each key is declared like this:

   ```env-spec
   # @optional @sensitive
   TYPESAFE_API_KEY=op(op://dev/nocajwa573emc6ko6sv5bkn6y4/TYPESAFE_API_KEY, allowMissing=true)
   ```

   The schema's last item, `AT_LEAST_ONE_PROVIDER_KEY`, is a check and needs no edit. It resolves to the word `ok` when at least one key has a value, and to an empty string otherwise, and because it is `@required`, an empty value fails the load. Each key also carries a type that rejects a value the Worker treats as no key: `unset` in any case, or whitespace only. The rule mirrors `isKeySet` in `worker/env.ts`. After editing the schema, run `vp run codegen` to refresh `env.d.ts`.

2. **Check what Varlock resolves.**

   ```sh
   vp exec varlock load
   ```

   It prints each key redacted, `undefined` for a key whose field is missing, and `"ok"` for `AT_LEAST_ONE_PROVIDER_KEY`. With no key at all it exits with code 1 and says `AT_LEAST_ONE_PROVIDER_KEY` is "required but is currently empty".

3. **Build, then deploy.**

   ```sh
   vp run build
   vp run deploy:varlock
   ```

   `deploy:varlock` in `package.json` is `varlock-wrangler deploy`. Arguments you give it go to Wrangler, so `vp run deploy:varlock --name my-worker` targets another Worker (give every later `wrangler secret` command the same flag).
   Varlock resolves the schema first. If that fails, which includes the case of no provider key, it prints `Failed to resolve environment variables` and exits with code 1 **before it starts Wrangler**, so nothing is uploaded. The script does not run the section 3 key check, because that check reads the secrets already on the Worker, and on a first Varlock deploy they do not exist yet. The schema's check item does the same job before the upload.

4. **Protect the instance** (section 2). A Varlock deploy does not protect it. The three protection settings are not in the schema, so set them with `wrangler secret put` as section 2 shows, adding the same `--name` you gave `deploy:varlock`. A Varlock deploy leaves them alone.

5. **Check the result.**

   ```sh
   vp exec wrangler secret list
   ```

   The list shows `__VARLOCK_ENV`, plus one name for each key that had a value, and the type `secret_text` for each. `GET /api/providers` on the Worker's URL lists the providers whose key was uploaded. Add the deploy's `--name <worker>` to `secret list` too.

### What the deploy uploads, and what to expect

- **Each key with a value becomes a secret.** A key whose field is missing from the item is not uploaded, so its provider does not appear in `GET /api/providers`. Leave an unwanted field out of the item entirely. A field that holds the word `unset` (in any case, with or without spaces around it) or only whitespace fails the load with "Value must match regex" on that key, because the Worker would ignore such a value at run time; the schema's rule mirrors the Worker's. An empty field (`""`) passes the load as a value, so `varlock-wrangler` would upload it (Wrangler may refuse an empty one, which was not tested), and the Worker would ignore it. To add a provider, put its key in the vault item and run `vp run build` and `vp run deploy:varlock` again.
- **`AT_LEAST_ONE_PROVIDER_KEY` arrives as a plain variable holding `ok`.** `varlock-wrangler` uploads every non-sensitive item that has a value with `--var NAME:value`. This one holds no secret, so it is a harmless marker, and the Worker does not read it. It is the only value this profile puts on a command line.
- **`__VARLOCK_ENV` is a secret holding the whole resolved environment as JSON, provider keys included.** The Worker does not read it: it reads `env.TYPESAFE_API_KEY` and the others directly, so it does not import `@varlock/cloudflare-integration/init`. Treat it like the keys themselves.
- **Wrangler's bindings table calls the secrets "Environment Variable".** That is only its label for what Varlock uploaded. `wrangler secret list` shows the real type, `secret_text`, and that is the check to trust.
- **Removing a key from the vault does not remove it from the Worker.** `varlock-wrangler deploy` passes the secrets to Wrangler in a file, and Wrangler only adds or replaces secrets from a file (reported upstream as [dmno-dev/varlock#1212](https://github.com/dmno-dev/varlock/issues/1212)). To take a provider off a deployed Worker, delete the secret by hand, and leave the field out of the vault as well, so the next deploy does not bring it back:

  ```sh
  vp exec wrangler secret delete OPENAI_API_KEY   # add the deploy's --name (and --env/--config)
  ```

- **Plain variables set only in the dashboard are removed at each deploy,** because `varlock-wrangler` adds `--keep-vars=false` to `wrangler deploy`. Keep any setting you need as a secret (as section 2 does) or in `wrangler.jsonc`.
- **How the keys travel (privacy).** On macOS and Linux `varlock-wrangler` serves the secrets to Wrangler through a named pipe, a file-like handle that exists only in memory, so the keys never touch disk and never appear in the process list or your shell history. On Windows it falls back to a temporary file. The keys then sit in your Cloudflare account as Worker secrets, and each run sends your questions to the providers whose keys you added. This repository's code never logs a key.

### `vp dev` in this profile

`vp dev` and `vp preview` load Varlock's Vite plugin (`varlockCloudflareVitePlugin` in `vite.config.ts`), which resolves `.env.schema` once at start-up, asks 1Password for approval, and hands the keys to the Node dev host through `process.env`. So `vp dev` serves exactly the providers whose field holds a key. With no key it prints Varlock's "Configuration is currently invalid" error that names `AT_LEAST_ONE_PROVIDER_KEY` and serves Varlock's error page instead of the app. `vp run build`, `vp check`, and `vp test` never load the plugin, so they never ask 1Password for anything.

**Without 1Password,** give Varlock a value for every key, so that it never calls 1Password. Create a `.env.local` in the repository root (Git ignores it: `.gitignore` lists `.env.*`). Put the keys you have in it, and set each key you do not have to an empty string, with the quotes:

```env
TYPESAFE_API_KEY=<your key>
SUBQ_API_KEY=""
OPENAI_API_KEY=""
```

The quotes matter: `KEY=""` overrides the schema with an empty value, but a bare `KEY=` sets nothing, and Varlock then still asks 1Password for that key. With Varlock 1.22.0, `vp exec varlock load` succeeded against an unreachable 1Password account when all three keys were set this way. At least one key must be real, and `unset` or whitespace is refused (see section 4, "What the deploy uploads"). This file is not `.dev.vars`: Varlock refuses to start while a `.dev.vars` exists, but it reads `.env.local`.

Compared with 1Password, `.env.local` is weaker. The keys sit unencrypted on disk, so any process or person with access to your user account can read them, and they can end up in backups, synced folders, or a support bundle. There is no per-use approval prompt, and rotating a key means editing the file on every machine. A `git add -f` or a changed `.gitignore` could commit them. Use 1Password where you have it.

## 5. Hostnames and older versions

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

`vp preview` cannot receive these variables: it takes its environment from Varlock's `.env.schema`, which declares the provider keys and the check item but not the protection variables (the schema leaves them out on purpose, because they belong to section 2, not to a profile), so the built Worker under `vp preview` refuses runs as an unconfigured instance.
