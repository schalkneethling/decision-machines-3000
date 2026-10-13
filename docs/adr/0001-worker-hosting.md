# ADR-0001: Worker hosting under Vite+

- **Status:** Accepted. The spike confirmed path A on 2026-10-12, including the Varlock-wrapped plugin under `vp dev` with the key resolved from 1Password.
- **Date:** 2026-10-12
- **Spike:** issue #1, results in [`docs/spikes/worker-toolchain.md`](../spikes/worker-toolchain.md)

## Context

The app will be hosted as a Cloudflare Worker that serves the Vite-built single-page app as static assets and answers `/api/*` itself. The project's toolchain is Vite+ 0.2.8, where `vite` is an alias for `@voidzero-dev/vite-plus-core`. Secrets come from 1Password through Varlock, and nothing that runs in `vp check`, `vp test`, or `vp run build` may wait on a 1Password prompt.

In both options below, dev serving goes through `server/vite-host.ts`, a planned Node host (not written yet; #6 adds it) that calls the Worker's `handle(request, env)`. The open question was whether `vp dev` can also run the real Worker runtime (workerd) through `@cloudflare/vite-plugin`.

- **Path A:** `vp dev` loads `@cloudflare/vite-plugin`, wrapped by `varlockCloudflareVitePlugin` from `@varlock/cloudflare-integration`, so the `/api/*` routes the Node host does not claim run in workerd with the 1Password-resolved environment. `vp run build` uses the plain Cloudflare plugin to produce the deployable output.
- **Path B:** `vp dev` does not load the Cloudflare plugin. Only the Node host serves `/api/*`. The build would still need a way to bundle the Worker, either the plain Cloudflare plugin in the build only or Wrangler's own bundler at deploy time.

## Decision

Choose **path A**.

The files named below are on the spike branch `issue-1-worker-toolchain-spike`, not on `main`. Issue #6 applies this decision to `main`.

1. `vite.config.ts` loads the plugins inside `lazyPlugins`, behind the existing Varlock gate:
   - `vp dev` and `vp preview`: `[jevApiPlugin(), varlockCloudflareVitePlugin()]`, imported dynamically, because importing `@varlock/cloudflare-integration` runs `varlock load` at once.
   - `vp build`: `[jevApiPlugin(), cloudflare()]`, which needs no secrets.
   - Tests and metadata reads: `[jevApiPlugin()]`.

   The Node middleware is listed first, because the plugin listed first sees each request first.

2. `wrangler.jsonc` sets `name`, `main: ./worker/index.ts`, `compatibility_date: 2026-10-06`, and `assets` with `directory: ./dist/client`, `run_worker_first: ["/api/*"]`, and `not_found_handling: single-page-application`. It sets no compatibility flags.
3. Worker code lives in `worker/` with its own `tsconfig.json` (`lib: ["ES2024", "ESNext.TypedArrays"]`, `types: ["./worker-configuration.d.ts"]`). The types come from `wrangler types`, not `@cloudflare/workers-types`.
4. Images are base64-encoded with `Uint8Array.prototype.toBase64()`. `Buffer` and `nodejs_compat` are not used.

## Why

- `@cloudflare/vite-plugin` 1.63.1 ran under `vp dev` without changes, both plain and wrapped by `varlockCloudflareVitePlugin`. With the wrapper, the key resolved from 1Password reached the Worker's `env` (`GET /api/providers` listed TypeSafe), `/api/jev` stayed in Node and completed a real TypeSafe call, and the app's HTML still got the Vite client.
- `vp run build` produced `dist/client`, `dist/decisionmachines3000/wrangler.json`, and the `.wrangler/deploy/config.json` redirect. Both `wrangler deploy` and `varlock-wrangler deploy` deployed that output to a scratch Worker, which served the UI, `GET /api/providers`, and the JSON 404.
- Path A tests the Worker in the same runtime it will be deployed to, which matters for workerd-specific behaviour such as `formData()`, `toBase64()`, and the asset routing rules.
- Path B gives up that parity and still needs the Cloudflare plugin or Wrangler to bundle the Worker, so it would not remove the dependency.

## Consequences

- `vp dev` and `vp preview` on this setup ask 1Password for the key, as they already do today. `vp check`, `vp test`, and `vp run build` do not.
- `@varlock/vite-integration` is no longer loaded by `vite.config.ts`. Removing it from `package.json` is left to the issue that moves the app onto the Worker.
- `varlock` needs `^1.22.0`, which is the peer range of `@varlock/cloudflare-integration` 1.6.1.
- `/api` without a trailing slash is served by the single-page app, because `run_worker_first: ["/api/*"]` does not match it.
- After `vp run build`, plain `wrangler dev` and `wrangler deploy` use the redirected, already-bundled config. Pass `-c wrangler.jsonc` to run or deploy a different entry point.
- No `.dev.vars` file may exist, because `varlockCloudflareVitePlugin` throws when it finds one. `.dev.vars.example` for the Deploy button is allowed.
- The Deploy button builds with npm 11.16.0, so the `devEngines` pin must accept it (#26).
- `wrangler.jsonc` does not set `workers_dev` or `preview_urls`, so Wrangler enables both by default and warns on every deploy. Issue #14 (fail closed on deployed instances) has to decide them.

## Fallback

If a later Vite+ or plugin release breaks `varlockCloudflareVitePlugin` under `vp dev`, switch to path B: keep `cloudflare()` for `vp build` only, load `varlockVitePlugin` from `@varlock/vite-integration` for `vp dev`, and let `server/vite-host.ts` serve `/api/*` alone.
