/**
 * Measurement Worker for issue #1. It is never deployed with the app: it runs only
 * through `vp exec wrangler dev -c wrangler.jsonc worker/spike/encode-bench.ts`,
 * which replaces the `main` entry from `wrangler.jsonc` for that session. The `-c`
 * matters after `vp run build`, because the build leaves a redirect to the bundled
 * config, which would load this file unbundled.
 *
 * `POST /api/bench` with a multipart body parses it with `request.formData()`,
 * checks that each file part is a `File` readable with `arrayBuffer()`, and
 * base64-encodes the bytes with every native encoder the runtime offers. The path
 * must start with `/api/` so that `run_worker_first` sends it here; other paths go
 * to the assets layer, which answers a POST with 405.
 *
 * Timing caveat: on Cloudflare's network, `performance.now()` advances only when
 * I/O completes, as a Spectre mitigation, so it reads the same before and after
 * synchronous work. Each measured step therefore ends with a zero-delay timer,
 * which counts as I/O and lets the clock catch up. `frozenClockMs` is the reading
 * without that timer, which shows whether the clock was frozen.
 */

type PartReport = {
  field: string;
  isFile: boolean;
  type: string;
  bytes: number;
};

type EncoderReport = {
  available: boolean;
  /** Milliseconds for all parts, measured across a timer tick. */
  ms?: number;
  /** The same measurement without a timer tick, which stays 0 if the clock is frozen. */
  frozenClockMs?: number;
  outputChars?: number;
  error?: string;
};

type BufferLike = {
  from(bytes: Uint8Array): { toString(encoding: "base64"): string };
};

/** Lets the workerd clock advance by completing a zero-delay timer. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function measure(
  encode: ((bytes: Uint8Array) => string) | undefined,
  parts: readonly Uint8Array[],
): Promise<EncoderReport> {
  if (!encode) return { available: false };
  try {
    await tick();
    const start = performance.now();
    let outputChars = 0;
    for (const bytes of parts) outputChars += encode(bytes).length;
    const frozenClockMs = performance.now() - start;
    await tick();
    return { available: true, ms: performance.now() - start, frozenClockMs, outputChars };
  } catch (error) {
    return { available: true, error: String(error) };
  }
}

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return Response.json({ error: "POST a multipart/form-data body." }, { status: 405 });
    }

    await tick();
    const parseStart = performance.now();
    const form = await request.formData();
    const reports: PartReport[] = [];
    const parts: Uint8Array[] = [];
    for (const [field, value] of form.entries()) {
      const isFile = value instanceof File;
      if (!isFile) {
        reports.push({ field, isFile, type: typeof value, bytes: 0 });
        continue;
      }
      const bytes = new Uint8Array(await value.arrayBuffer());
      parts.push(bytes);
      reports.push({ field, isFile, type: value.type, bytes: bytes.byteLength });
    }
    await tick();
    const parseMs = performance.now() - parseStart;

    const hasToBase64 = typeof Uint8Array.prototype.toBase64 === "function";
    const nodeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;

    return Response.json({
      parts: reports,
      parseAndReadMs: parseMs,
      encoders: {
        "Uint8Array.prototype.toBase64": await measure(
          hasToBase64 ? (bytes) => bytes.toBase64() : undefined,
          parts,
        ),
        "Buffer (globalThis)": await measure(
          nodeBuffer ? (bytes) => nodeBuffer.from(bytes).toString("base64") : undefined,
          parts,
        ),
      },
    });
  },
} satisfies ExportedHandler;
