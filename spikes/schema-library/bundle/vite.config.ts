import { defineConfig } from "vite-plus";

/**
 * Builds one minimal browser entry per schema library so their gzipped sizes can
 * be compared. Run from the repository root, once per entry:
 *
 *   vp build spikes/schema-library/bundle --mode valibot
 *   vp build spikes/schema-library/bundle --mode zod-mini
 *   vp build spikes/schema-library/bundle --mode zod-mini-en
 *   vp build spikes/schema-library/bundle --mode hand-written
 *
 * `--mode` selects `entry-<mode>.ts`; the output lands in `dist/<mode>/<mode>.js`.
 * Everything else is Vite's production default (minified, target
 * `baseline-widely-available`). Option names come from `BuildEnvironmentOptions`
 * in node_modules/vite/dist/vite/node/index.d.ts.
 */
export default defineConfig(({ mode }) => ({
  logLevel: "warn",
  build: {
    outDir: `dist/${mode}`,
    emptyOutDir: true,
    modulePreload: false,
    rollupOptions: {
      input: `entry-${mode}.ts`,
      output: { entryFileNames: "[name].js" },
    },
  },
}));
