/**
 * Image input on `POST /api/decide/{provider}` (issue #15), end to end through
 * `handle`, plus the pure helpers in `multipart.ts`. The scenarios are in
 * `scenarios/15-server-images.feature`.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import { MAX_IMAGE_BYTES, openai, subq } from "../src/providers/catalog.ts";
import type { ImageCapabilities, ProviderDescriptor } from "../src/providers/catalog.ts";
import { MAX_BODY_BYTES, TEXT_ALLOWANCE_BYTES, TOO_LARGE_MESSAGE } from "./body-limit.ts";
import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";
import {
  EXTRA_PARTS_ALLOWANCE,
  countParts,
  encodeBase64,
  encodeImages,
  readMultipart,
} from "./multipart.ts";

const ORIGIN = "https://decisionmachines3000.example";
const SUBQ_KEY = "sk-test-subq-0123456789-never-logged";
const OPENAI_KEY = "sk-test-openai-0123456789-never-logged";
const keys: ProviderKeys = {
  TYPESAFE_API_KEY: "tsk-test-0123456789-never-logged",
  SUBQ_API_KEY: SUBQ_KEY,
  OPENAI_API_KEY: OPENAI_KEY,
};

const question = {
  primitive: "noul",
  state: "The attached images are the only evidence.",
  questions: { red: { instructions: "Is the image mostly red?" } },
};

/** The success bodies the providers recorded for an image request (`providers/fixtures/*`). */
const subqReply = {
  model: "subq-snap-preview",
  answers: { red: { type: "noul", noul: 0.98 } },
  usage: { input_tokens: 163, output_tokens: 0 },
};
const openaiReply = {
  model: "gpt-6-luna",
  answers: [{ type: "predicate", name: "red", probability: 0.84 }],
  usage: { input_tokens: 164, output_tokens: 0, total_tokens: 164 },
};

type StubDeps = HandlerDeps & { fetch: Mock<typeof fetch>; log: Mock<(line: string) => void> };

function stubDeps(reply?: unknown): StubDeps {
  return {
    host: "node-dev",
    fetch: vi.fn(() =>
      reply === undefined
        ? Promise.reject(new Error("deps.fetch was called."))
        : Promise.resolve(Response.json(reply)),
    ),
    timeoutSignal: vi.fn((_ms: number) => new AbortController().signal),
    log: vi.fn((_line: string) => {}),
  };
}

/** `size` bytes that start with the signature of `kind` and then repeat a filler byte. */
function image(kind: "png" | "jpeg" | "webp" | "gif", size = 64): Uint8Array<ArrayBuffer> {
  const head = {
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpeg: [0xff, 0xd8, 0xff, 0xe0],
    webp: [0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
    gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  }[kind];
  const bytes = new Uint8Array(Math.max(size, head.length)).fill(7);
  bytes.set(head);
  return bytes;
}

type Part = [name: string, value: string | Blob, filename?: string];

function multipart(provider: string, parts: Part[]): Request {
  const form = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, filename ?? "upload.bin");
  }
  // The Request sets the content type, boundary included, from the FormData body.
  return new Request(`${ORIGIN}/api/decide/${provider}`, { method: "POST", body: form });
}

function file(bytes: Uint8Array<ArrayBuffer>, declared = "image/png"): Blob {
  return new Blob([bytes], { type: declared });
}

const requestPart: Part = ["request", JSON.stringify(question)];

async function send(request: Request, deps: StubDeps) {
  const response = await handle(request, keys, deps);
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

/** The JSON body the stubbed upstream received. */
function upstreamBody(deps: StubDeps): Record<string, unknown> {
  const init = deps.fetch.mock.calls[0]?.[1];
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

describe("images on a text-only provider", () => {
  it("answers 400 naming the provider, before any upstream call", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      multipart("typesafe", [requestPart, ["image", file(image("png"))]]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "TypeSafe Jev evaluates text only, so it does not accept images. Remove them and run again.",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe("the limits from the catalog", () => {
  const subqImages = subq.capabilities.images;
  const openaiImages = openai.capabilities.images;
  if (subqImages === false || openaiImages === false)
    throw new Error("Both providers take images.");

  function pictures(count: number, size = 64): Part[] {
    return Array.from({ length: count }, (): Part => ["image", file(image("png", size))]);
  }

  it("refuses more images than SubQ takes, naming the count and the limit", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      multipart("subq", [requestPart, ...pictures(subqImages.maxCount + 1)]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      `This request has ${subqImages.maxCount + 1} images. SubQ Snap takes at most ${subqImages.maxCount} per request in this project.`,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses more images than OpenAI takes", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      multipart("openai", [requestPart, ...pictures(openaiImages.maxCount + 1)]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toContain(`at most ${openaiImages.maxCount}`);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses an image one byte over the per-image limit, naming it by position and the limit", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      multipart("subq", [
        requestPart,
        ...pictures(1),
        ["image", file(image("png", subqImages.maxBytesPerImage + 1))],
      ]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Image 2 is over this project's limit of 64 KB per image. Use a smaller picture.",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts an image exactly at the per-image limit", async () => {
    const deps = stubDeps(subqReply);
    const { response } = await send(
      multipart("subq", [requestPart, ["image", file(image("png", subqImages.maxBytesPerImage))]]),
      deps,
    );

    expect(response.status).toBe(200);
  });

  it("holds a provider to its per-request limit when that is below twice its per-image limit", async () => {
    // The catalog's two caps are equal today. This provider has different ones, so
    // the per-request check stays tested for the day the catalog's caps diverge:
    // each image fits on its own, and the pair does not.
    const apart: ProviderDescriptor = {
      ...subq,
      capabilities: {
        ...subq.capabilities,
        images: { ...subqImages, maxBytesPerImage: 1024, maxBytesPerRequest: 1536 },
      },
    };
    const request = multipart("subq", [
      requestPart,
      ["image", file(image("png", 1024))],
      ["image", file(image("png", 513))],
    ]);

    const result = await readMultipart(
      new Uint8Array(await request.arrayBuffer()),
      request.headers.get("content-type") ?? "",
      apart,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const { error } = (await result.response.json()) as { error: string };
    expect(error).toBe(
      "The images add up to more than this project's limit of 1.5 KB per request. Send fewer or smaller pictures.",
    );
  });

  // With equal caps, each image below is within the per-image limit, so only the
  // per-request check can refuse this request.
  it("refuses images that add up to one byte over the per-request limit", async () => {
    const half = openaiImages.maxBytesPerRequest / 2;
    const deps = stubDeps();
    const { response, body } = await send(
      multipart("openai", [
        requestPart,
        ["image", file(image("png", half))],
        ["image", file(image("jpeg", half + 1))],
      ]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "The images add up to more than this project's limit of 64 KB per request. Send fewer or smaller pictures.",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("is not refused for its framing when the images and the text fill their allowances", async () => {
    const deps = stubDeps(subqReply);
    const text = JSON.stringify({
      ...question,
      state: "x".repeat(TEXT_ALLOWANCE_BYTES - 1024),
    });
    const request = multipart("subq", [
      ["request", text],
      ["image", file(image("png", subqImages.maxBytesPerRequest / 2))],
      ["image", file(image("png", subqImages.maxBytesPerRequest / 2))],
    ]);

    const { response } = await send(request, deps);

    expect(response.status).toBe(200);
  });
});

describe("the real format of an image", () => {
  it("sends the type the bytes show, ignoring the declared type and the file name", async () => {
    const deps = stubDeps(subqReply);
    const { response } = await send(
      multipart("subq", [requestPart, ["image", file(image("jpeg"), "image/png"), "photo.png"]]),
      deps,
    );

    expect(response.status).toBe(200);
    expect(upstreamBody(deps).images).toEqual([
      { mediaType: "image/jpeg", base64: encodeBase64(image("jpeg")) },
    ]);
  });

  it.each([
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ] as const)("recognises %s", async (kind, mediaType) => {
    const deps = stubDeps(subqReply);
    const { response } = await send(
      multipart("subq", [requestPart, ["image", file(image(kind), "application/octet-stream")]]),
      deps,
    );

    expect(response.status).toBe(200);
    expect((upstreamBody(deps).images as { mediaType: string }[])[0]?.mediaType).toBe(mediaType);
  });

  it.each([
    ["a GIF", image("gif")],
    ["an empty file", new Uint8Array(0)],
    ["text", new TextEncoder().encode("not a picture at all")],
  ])("refuses %s, naming the accepted formats and not the file", async (_name, bytes) => {
    const deps = stubDeps();
    const { response, body, text } = await send(
      multipart("subq", [
        requestPart,
        ["image", file(bytes as Uint8Array<ArrayBuffer>), "secret-name.png"],
      ]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Image 1 is not image/png, image/jpeg, or image/webp, judging by its first bytes. The type the upload declares is ignored.",
    );
    expect(text).not.toContain("secret-name");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("names the second image when only it is bad", async () => {
    const { body } = await send(
      multipart("subq", [
        requestPart,
        ["image", file(image("png"))],
        ["image", file(image("gif"))],
      ]),
      stubDeps(),
    );

    expect(body.error).toContain("Image 2 is not");
  });
});

describe("the shape of the multipart body", () => {
  it("requires a request part", async () => {
    const deps = stubDeps();
    const { response, body } = await send(multipart("subq", [["image", file(image("png"))]]), deps);

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'The "request" part is required. Send it as text that holds the request as JSON.',
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses two request parts", async () => {
    const { response, body } = await send(
      multipart("subq", [requestPart, requestPart]),
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe('Send exactly one "request" part, not several.');
  });

  it("refuses a request part that is a file", async () => {
    const { response, body } = await send(
      multipart("subq", [["request", new Blob(["{}"])]]),
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'The "request" part must be text that holds the request as JSON, not a file.',
    );
  });

  it("refuses an image part that is text, not a file", async () => {
    const { response, body } = await send(
      multipart("subq", [requestPart, ["image", "just text"]]),
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe('Each "image" part must be a file.');
  });

  it("refuses a part with another name without echoing the name", async () => {
    const { response, body, text } = await send(
      multipart("subq", [requestPart, ["notes-secret", "hello"]]),
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'A multipart request may hold only a "request" part and "image" parts.',
    );
    expect(text).not.toContain("notes-secret");
  });

  it("answers a multipart content type with no boundary with a 400, not a 500", async () => {
    const { response, body } = await send(
      new Request(`${ORIGIN}/api/decide/subq`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data" },
        body: "--x\r\n",
      }),
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toContain('no "boundary" parameter');
  });

  it("checks the request JSON before it reads the images", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      multipart("subq", [
        ["request", JSON.stringify({ ...question, primitive: "maybe" })],
        ["image", file(image("gif"))],
      ]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toContain("primitive");
  });
});

describe("what reaches the provider and what comes back", () => {
  it("sends two images to SubQ as base64 that decodes to the uploaded bytes, in order", async () => {
    const first = image("png", 300);
    const second = image("jpeg", 500);
    const deps = stubDeps(subqReply);

    const { response, body, text } = await send(
      multipart("subq", [requestPart, ["image", file(first)], ["image", file(second)]]),
      deps,
    );

    expect(response.status).toBe(200);
    const sent = upstreamBody(deps).images as { mediaType: string; base64: string }[];
    expect(sent.map((entry) => entry.mediaType)).toEqual(["image/png", "image/jpeg"]);
    expect(Uint8Array.from(atob(sent[0]!.base64), (c) => c.charCodeAt(0))).toEqual(first);
    expect(Uint8Array.from(atob(sent[1]!.base64), (c) => c.charCodeAt(0))).toEqual(second);
    const wire = body.wire as { request: { images: { base64: string }[] } };
    expect(wire.request.images.map((entry) => entry.base64)).toEqual([
      "<image 1: image/png, 300 bytes>",
      "<image 2: image/jpeg, 500 bytes>",
    ]);
    expect(text).not.toContain(sent[0]!.base64);
  });

  it("keeps the response small and free of base64 for the largest image", async () => {
    const deps = stubDeps(subqReply);
    const { response, text } = await send(
      multipart("subq", [requestPart, ["image", file(image("png", MAX_IMAGE_BYTES))]]),
      deps,
    );

    expect(response.status).toBe(200);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(text).toContain("<image 1: image/png, 64 KB>");
  });

  it("sends three images to OpenAI as data URLs in order", async () => {
    const deps = stubDeps(openaiReply);
    const kinds = ["png", "jpeg", "webp"] as const;

    const { response } = await send(
      multipart("openai", [
        requestPart,
        ...kinds.map((kind): Part => ["image", file(image(kind))]),
      ]),
      deps,
    );

    expect(response.status).toBe(200);
    const input = upstreamBody(deps).input as {
      content: { type: string; image_url?: string }[];
    }[];
    const parts = input[0]!.content;
    // The state, then a label before each image (issue #57).
    expect(parts.map((part) => part.type)).toEqual([
      "input_text",
      "input_text",
      "input_image",
      "input_text",
      "input_image",
      "input_text",
      "input_image",
    ]);
    expect(
      parts
        .filter((part) => part.type === "input_image")
        .map((part) => part.image_url?.split(";")[0]),
    ).toEqual(["data:image/png", "data:image/jpeg", "data:image/webp"]);
  });

  it("logs how many images came, and nothing that names them", async () => {
    const deps = stubDeps(subqReply);
    await send(
      multipart("subq", [
        requestPart,
        ["image", file(image("png")), "private-name.png"],
        ["image", file(image("png")), "private-name-2.png"],
      ]),
      deps,
    );

    const lines = deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain("images=2");
    expect(lines).not.toContain("private-name");
  });

  it("leaves the key out of every reply", async () => {
    const deps = stubDeps(subqReply);
    const { text } = await send(
      multipart("subq", [requestPart, ["image", file(image("png"))]]),
      deps,
    );

    expect(text).not.toContain(SUBQ_KEY);
  });
});

describe("the body limit with a streamed multipart body", () => {
  it("answers 413 and stops reading once the count passes the limit, with no Content-Length", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(1);
    let pulled = 0;
    const total = MAX_BODY_BYTES + 10 * chunk.length;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled * chunk.length >= total) {
          controller.close();
          return;
        }
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    // Node's Request needs `duplex` for a stream body; the Fetch types used here do not declare it.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: stream,
      duplex: "half",
    };
    const deps = stubDeps();

    const { response } = await send(new Request(`${ORIGIN}/api/decide/subq`, init), deps);

    expect(response.status).toBe(413);
    expect(pulled * chunk.length).toBeLessThan(total);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

// `detectMediaType` is tested in `src/providers/image-bytes.test.ts`, where it now lives.

describe("encodeBase64", () => {
  const bytes = Uint8Array.from({ length: 70_000 }, (_, index) => index % 256);
  // Built one character at a time, so it shares no slicing with the code under test.
  const expected = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

  it("encodes a known value", () => {
    expect(encodeBase64(new TextEncoder().encode("Hello"))).toBe("SGVsbG8=");
  });

  it("matches a one-character-at-a-time encoding on the btoa path used where the native encoder is missing", () => {
    const prototype = Uint8Array.prototype as { toBase64?: unknown };
    const original = Object.getOwnPropertyDescriptor(prototype, "toBase64");
    delete prototype.toBase64;
    try {
      expect(encodeBase64(bytes)).toBe(expected);
    } finally {
      if (original !== undefined) Object.defineProperty(prototype, "toBase64", original);
    }
  });

  it("uses the native encoder when the runtime has one", () => {
    const prototype = Uint8Array.prototype as { toBase64?: unknown };
    const original = Object.getOwnPropertyDescriptor(prototype, "toBase64");
    Object.defineProperty(prototype, "toBase64", {
      configurable: true,
      value: () => "native",
    });
    try {
      expect(encodeBase64(bytes)).toBe("native");
    } finally {
      if (original === undefined) delete prototype.toBase64;
      else Object.defineProperty(prototype, "toBase64", original);
    }
  });
});

/** A multipart body written out by hand: `request` once, then `images` empty `image` parts, and the closing line. */
function rawMultipart(provider: string, images: number): Request {
  const boundary = "XB-test-boundary";
  const head = (name: string, filename?: string) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"` +
    `${filename === undefined ? "" : `; filename="${filename}"`}\r\n\r\n`;
  const body =
    `${head("request")}${JSON.stringify(question)}\r\n` +
    `${head("image", "a.png")}\r\n`.repeat(images) +
    `--${boundary}--\r\n`;
  return new Request(`${ORIGIN}/api/decide/${provider}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body,
  });
}

describe("parts are counted before they are parsed", () => {
  /** Far more parts than any provider takes, yet a body under the size limit, which is checked first. */
  const MANY_PARTS = 2_000;

  const tooMany =
    'The multipart body has too many parts. Send one "request" part and up to 4 "image" parts.';

  it("refuses a flood of empty parts without ever calling formData()", async () => {
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      const deps = stubDeps();
      const { response, body, text } = await send(rawMultipart("subq", MANY_PARTS), deps);

      expect(response.status).toBe(400);
      expect(body.error).toBe(tooMany);
      expect(text).not.toContain(String(MANY_PARTS));
      expect(text).not.toContain("XB-test-boundary");
      expect(parse).not.toHaveBeenCalled();
      expect(deps.fetch).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("tells a text-only provider that it takes no image parts", async () => {
    const { response, body } = await send(rawMultipart("typesafe", MANY_PARTS), stubDeps());

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'The multipart body has too many parts. Send one "request" part and no "image" parts, because TypeSafe Jev evaluates text only.',
    );
  });

  it("parses a body with one request part and the most image parts allowed", async () => {
    const parse = vi.spyOn(Response.prototype, "formData");
    try {
      const parts: Part[] = Array.from({ length: 4 }, (): Part => ["image", file(image("png"))]);
      const { response } = await send(
        multipart("subq", [requestPart, ...parts]),
        stubDeps(subqReply),
      );

      expect(response.status).toBe(200);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it("leaves a small excess to the schema's own message, up to the allowance and not past it", async () => {
    const atAllowance = await send(rawMultipart("subq", 4 + EXTRA_PARTS_ALLOWANCE), stubDeps());
    expect(atAllowance.body.error).toContain("This request has");

    const past = await send(rawMultipart("subq", 4 + EXTRA_PARTS_ALLOWANCE + 1), stubDeps());
    expect(past.body.error).toBe(tooMany);
  });

  it("does not count the closing delimiter, and counts only the boundary it is given", () => {
    const text = new TextEncoder().encode("--abc\r\nx\r\n--abc\r\nx\r\n--abc--\r\n");
    expect(countParts(text, "abc", 10)).toBe(2);
    expect(countParts(text, "other", 10)).toBe(0);
  });

  it("counts a delimiter only when the line ends after it, so a longer line that starts with it is content", () => {
    // A file's bytes can hold a line such as "--abcdef"; only "--abc" followed
    // by optional spaces or tabs and a line break opens a part (RFC 2046 5.1.1).
    const text = new TextEncoder().encode(
      "--abc\r\nx\r\n--abcdef\r\n--abcX\n--abc-\r\n--abc \t\r\ny\r\n--abc\nz\n--abc--\r\n",
    );
    expect(countParts(text, "abc", 10)).toBe(3);
  });

  it("counts a delimiter on the body's last line when no line break follows it", () => {
    expect(countParts(new TextEncoder().encode("--abc\r\nx\r\n--abc"), "abc", 10)).toBe(2);
  });
});

describe("images are not read until the request has passed validation", () => {
  it("reads no image bytes when the request JSON is invalid", async () => {
    const read = vi.spyOn(Blob.prototype, "arrayBuffer");
    try {
      const { response } = await send(
        multipart("subq", [
          ["request", JSON.stringify({ ...question, primitive: "maybe" })],
          ["image", file(image("png"))],
        ]),
        stubDeps(),
      );

      expect(response.status).toBe(400);
      expect(read).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
    }
  });
});

describe("encodeImages against a provider's own media types", () => {
  const pngOnly: ImageCapabilities = {
    maxCount: 1,
    maxBytesPerImage: 1024,
    maxBytesPerRequest: 1024,
    mediaTypes: ["image/png"],
  };

  it("refuses a real JPEG for a provider that accepts only PNG, naming only PNG", async () => {
    const result = await encodeImages([new File([image("jpeg")], "a.jpg")], pngOnly);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const { error } = (await result.response.json()) as { error: string };
    expect(error).toBe(
      "Image 1 is not image/png, judging by its first bytes. The type the upload declares is ignored.",
    );
  });

  it("accepts a PNG for that provider", async () => {
    const result = await encodeImages([new File([image("png")], "a.png")], pngOnly);

    expect(result.ok).toBe(true);
  });
});

describe("the text allowance", () => {
  /** A valid request whose JSON text is exactly `size` bytes. */
  function padded(size: number): string {
    const bare = JSON.stringify({ ...question, state: "" });
    return JSON.stringify({ ...question, state: "a".repeat(size - bare.length) });
  }

  it("takes a request part at the allowance and refuses one byte more with a 413", async () => {
    const at = await send(
      multipart("subq", [["request", padded(TEXT_ALLOWANCE_BYTES)]]),
      stubDeps(subqReply),
    );
    const over = await send(
      multipart("subq", [["request", padded(TEXT_ALLOWANCE_BYTES + 1)]]),
      stubDeps(),
    );

    expect(at.response.status).toBe(200);
    expect(over.response.status).toBe(413);
    expect(over.body.error).toBe(TOO_LARGE_MESSAGE);
  });

  it("counts the request part in bytes, not characters", async () => {
    // Each "é" is two bytes, so this text has fewer characters than the allowance has bytes.
    const bare = JSON.stringify({ ...question, state: "" });
    const characters = (TEXT_ALLOWANCE_BYTES - bare.length) / 2 + 1;
    const text = JSON.stringify({ ...question, state: "é".repeat(characters) });

    const { response } = await send(multipart("subq", [["request", text]]), stubDeps());

    expect(response.status).toBe(413);
  });
});

describe("image labels (issue #57)", () => {
  const twoImages = (): Part[] => [
    requestPart,
    ["image", file(image("png")), "a.png"],
    ["image", file(image("jpeg")), "b.jpg"],
  ];

  it("labels the images for OpenAI with the uploaded file names, in order", async () => {
    const deps = stubDeps(openaiReply);
    const { response } = await send(multipart("openai", twoImages()), deps);

    expect(response.status).toBe(200);
    const input = upstreamBody(deps).input as { content: { type: string; text?: string }[] }[];
    expect(input[0]!.content.map((part) => part.text ?? part.type)).toEqual([
      question.state,
      "Image 1: a.png",
      "input_image",
      "Image 2: b.jpg",
      "input_image",
    ]);
  });

  it("labels the images for SubQ in the state, and keeps the image objects to two fields", async () => {
    const deps = stubDeps(subqReply);
    const { response } = await send(multipart("subq", twoImages()), deps);

    expect(response.status).toBe(200);
    const sent = upstreamBody(deps);
    expect(sent.state).toBe(`${question.state}\n\nImage 1: a.png\nImage 2: b.jpg`);
    expect((sent.images as object[]).map((entry) => Object.keys(entry).sort())).toEqual([
      ["base64", "mediaType"],
      ["base64", "mediaType"],
    ]);
  });

  it("shows the labels in the wire record, beside the placeholders, on OpenAI", async () => {
    const deps = stubDeps(openaiReply);
    const { body } = await send(multipart("openai", twoImages()), deps);

    const wire = body.wire as {
      request: { input: { content: { type: string; text?: string; image_url?: string }[] }[] };
    };
    const shown = wire.request.input[0]!.content.slice(1).map(
      (part) => part.text ?? part.image_url,
    );
    expect(shown).toEqual([
      "Image 1: a.png",
      "data:image/png;base64,<image 1: image/png, 64 bytes>",
      "Image 2: b.jpg",
      "data:image/jpeg;base64,<image 2: image/jpeg, 64 bytes>",
    ]);
  });

  it("shows the labels in the wire record on SubQ", async () => {
    const deps = stubDeps(subqReply);
    const { body } = await send(multipart("subq", twoImages()), deps);

    const wire = body.wire as { request: { state: string } };
    expect(wire.request.state).toContain("Image 1: a.png\nImage 2: b.jpg");
  });

  it("clips a 300-character name and removes control characters before labelling", async () => {
    const deps = stubDeps(openaiReply);
    const long = `${"n".repeat(296)}.png`;
    const messy = "line\nbreak‮.png";
    const { response } = await send(
      multipart("openai", [
        requestPart,
        ["image", file(image("png")), long],
        ["image", file(image("png")), messy],
      ]),
      deps,
    );

    expect(response.status).toBe(200);
    const input = upstreamBody(deps).input as { content: { type: string; text?: string }[] }[];
    const labels = input[0]!.content.filter((part, i) => i > 0 && part.type === "input_text");
    expect(labels.map((part) => part.text)).toEqual([
      `Image 1: ${"n".repeat(80)}…`,
      "Image 2: linebreak.png",
    ]);
  });

  it.each([
    ["a run that succeeds", openaiReply],
    ["a run whose reply cannot be read", { unexpected: true }],
  ])("keeps every file name out of the log for %s", async (_name, reply) => {
    const deps = stubDeps(reply);
    await send(
      multipart("openai", [
        requestPart,
        ["image", file(image("png")), "secret-holiday.png"],
        ["image", file(image("png")), "second-secret.png"],
      ]),
      deps,
    );

    const lines = deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain("images=2");
    expect(lines).not.toContain("secret");
  });

  it("logs only the status of a provider error that quotes the file names", async () => {
    const deps = stubDeps();
    deps.fetch.mockImplementation(() =>
      Promise.resolve(
        Response.json(
          {
            error: {
              message: "Could not read Image 1: secret-holiday.png",
              type: "invalid_request_error",
              param: null,
              code: null,
            },
          },
          { status: 400 },
        ),
      ),
    );
    const { response } = await send(
      multipart("openai", [requestPart, ["image", file(image("png")), "secret-holiday.png"]]),
      deps,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const lines = deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain('detail="400"');
    expect(lines).toContain("images=1");
    expect(lines).not.toContain("secret");
  });

  it("keeps the file names out of a refusal for an unsupported image", async () => {
    const deps = stubDeps();
    const { text, response } = await send(
      multipart("subq", [requestPart, ["image", file(image("gif")), "secret-holiday.gif"]]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(text).not.toContain("secret");
  });
});
