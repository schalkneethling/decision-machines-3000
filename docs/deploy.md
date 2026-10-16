# Deploying DecisionMachines3000

This guide covers what to do right after the Deploy to Cloudflare button, starting with the step that matters most: protecting the instance. Issue #17 extends it with the full deploy walkthrough.

## 1. Deploy with the button

The button clones this repository into your GitHub account, asks for the provider keys, and deploys a Worker to `<name>.<your-subdomain>.workers.dev`. A key you do not have gets the placeholder `unset`, which the Worker treats as "no key". At least one real key is needed; the README's "The Worker" section names them.

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

## 3. Hostnames and older versions

`wrangler.jsonc` keeps the `workers.dev` hostname on (`workers_dev: true`), because a fork has no other, and turns Version URLs off (`preview_urls: false`), so no version of the Worker gets a second public hostname. The gate lives in the Worker's code, not in the hostname, so for any version built from this change a custom domain or a Version URL you add later is refused in the same way until the request carries a valid Access token or the opt-out is set.

**Versions from before the gate have no gate.** Only versions built from this change (issue #14) carry it. If your Worker had versions before that, they answer runs for anyone, and they may still hold the provider keys, because secrets survive deploys. So:

- Do not roll back with `wrangler rollback` (or the dashboard's rollback) to a version from before #14 while the Worker holds a key. Delete those versions' keys first, or do not roll back.
- Do not turn Version URLs back on while a version from before #14 exists, because each version would get its own public hostname again.

What was verified on Cloudflare's pages (2026-10-15): `workers_dev` is on by default for a Worker without routes, and turning it off does not turn off Version, Preview, or Deployment URLs; `preview_urls` follows `workers_dev` when it is not set and is left unchanged by Wrangler when it is omitted; a Version URL has the shape `<version-prefix>-<worker-name>.<subdomain>.workers.dev`. What was not verified: whether a version that was never given a Version URL can still be reached by one after Version URLs are turned on, and whether rolling back re-exposes an old version at the production hostname with the current secrets. Treat both as yes until a live check says otherwise.

## Running the built Worker locally

`vp dev` needs none of this: its Node host is local by construction and runs every request. It counts as local whatever address it listens on, so starting it with `--host` on a shared network lets anyone on that network spend your credit; keep it on localhost.

`wrangler dev` runs the built Worker in workerd, which cannot tell a local run from Cloudflare, so it needs the same variables a deployment does. The project keeps no `.dev.vars` file (Varlock refuses to start beside one), so pass them on the command line with `--var KEY:VALUE`, which Wrangler splits at the first colon:

```sh
vp run build
vp exec wrangler dev --var 'ALLOW_UNPROTECTED_INSTANCE:I accept the bill'
```

`vp preview` is not set up for these variables yet: it takes its environment from Varlock's `.env.schema`, which does not declare them (issue #18 covers that), so the built Worker under `vp preview` refuses runs as an unconfigured instance.
