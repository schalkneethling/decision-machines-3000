# ADR-0001: Worker hosting under Vite+

- **Status:** Proposed. It becomes Accepted once step 1 of the spike's pending steps (the Varlock-wrapped plugin under `vp dev`) passes.
- **Date:** 2026-10-12
- **Spike:** issue #1, results in [`docs/spikes/worker-toolchain.md`](../spikes/worker-toolchain.md)

## Context

The app will be hosted as a Cloudflare Worker that serves the Vite-built single-page app as static assets and answers `/api/*` itself. The project's toolchain is Vite+ 0.2.8, where `vite` is an alias for `@voidzero-dev/vite-plus-core`. Secrets come from 1Password through Varlock, and nothing that runs in `vp check`, `vp test`, or `vp run build` may wait on a 1Password prompt.

In both options below, dev serving goes through `server/vite-host.ts`, a Node host that calls the Worker's `handle(request, env)`. The open question is whether `vp dev` can also run the real Worker runtime (workerd) through `@cloudflare/vite-plugin`.

- **Path A:** `vp dev` loads `@cloudflare/vite-plugin`, wrapped by `varlockCloudflareVitePlugin` from `@varlock/cloudflare-integration`, so `/api/*` routes the Node host does not claim run in workerd with the 1Password-resolved environment. `vp run build` uses the plain Cloudflare plugin to produce the deployable output.
- **Path B:** `vp dev` does not load the Cloudflare plugin. Only the Node host serves `/api/*`. The build would still need a way to bundle the Worker, either the plain Cloudflare plugin in the build only or Wrangler's own bundler at deploy time.

## Decision

Choose **path A**.

1. `vite.config.ts` loads the plugins inside `lazyPlugins`, behind the existing Varlock gate:
   - `vp dev` and `vp preview`: `[jevApiPlugin(), varlockCloudflareVitePlugin()]`, imported dynamically, because importing `@varlock/cloudflare-integration` runs `varlock load` at once.
   - `vp build`: `[jevApiPlugin(), cloudflare()]`, which needs no secrets.
   - Tests and metadata reads: `[jevApiPlugin()]`.
     The Node middleware is listed first, because the plugin listed first sees each request first.
2. `wrangler.jsonc` sets `name`, `main: ./worker/index.ts`, `compatibility_date: 2026-10-06`, and `assets` with `directory: ./dist/client`, `run_worker_first: ["/api/*"]`, and `not_found_handling: single-page-application`. It sets no compatibility flags.
3. Worker code lives in `worker/` with its own `tsconfig.json` (`lib: ["ES2024", "ESNext.TypedArrays"]`, `types: ["./worker-configuration.d.ts"]`). The types come from `wrangler types`, not `@cloudflare/workers-types`.
4. Images are base64-encoded with `Uint8Array.prototype.toBase64()`. `Buffer` and `nodejs_compat` are not used.

## Why

- `@cloudflare/vite-plugin` 1.63.1 ran under `vp dev` without changes. The Worker answered `/api/*` from workerd, `/api/jev` stayed in Node, and the app's HTML still got the Vite client.
- `vp run build` produced `dist/client`, `dist/decisionmachines3000/wrangler.json`, and the `.wrangler/deploy/config.json` redirect, and `wrangler dev` served that output with the expected routing.
- Path A tests the Worker in the same runtime it will be deployed to, which matters for workerd-specific behaviour such as `formData()`, `toBase64()`, and the asset routing rules.
- Path B gives up that parity and still needs the Cloudflare plugin or Wrangler to bundle the Worker, so it would not remove the dependency.

## Consequences

- `vp dev` and `vp preview` on this setup ask 1Password for the key, as they already do today. `vp check`, `vp test`, and `vp run build` do not.
- `@varlock/vite-integration` is no longer loaded by `vite.config.ts`. Removing it from `package.json` is left to the issue that moves the app onto the Worker.
- `varlock` needs `^1.22.0`, which is the peer range of `@varlock/cloudflare-integration` 1.6.1.
- `/api` without a trailing slash is served by the single-page app, because `run_worker_first: ["/api/*"]` does not match it.
- After `vp run build`, plain `wrangler dev` uses the redirected, already-bundled config. Pass `-c wrangler.jsonc` to run a different entry point.
- No `.dev.vars` file may exist, because `varlockCloudflareVitePlugin` throws when it finds one. `.dev.vars.example` for the Deploy button is allowed.

## If step 1 fails

If `varlockCloudflareVitePlugin` fails under `vp dev`, switch to path B: keep `cloudflare()` for `vp build` only, load the existing `varlockVitePlugin` from `@varlock/vite-integration` for `vp dev` as before, and let `server/vite-host.ts` serve `/api/*` alone. Record the error text in the spike document and set this ADR's decision to path B.
