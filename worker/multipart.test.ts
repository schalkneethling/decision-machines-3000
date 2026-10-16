/**
 * Image input on `POST /api/decide/{provider}` (issue #15), end to end through
 * `handle`, plus the pure helpers in `multipart.ts`. The scenarios are in
 * `scenarios/15-server-images.feature`.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import { openai, subq } from "../src/providers/catalog.ts";
import { MAX_BODY_BYTES, TEXT_ALLOWANCE_BYTES } from "./body-limit.ts";
import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";
import { detectMediaType, encodeBase64 } from "./multipart.ts";

const ORIGIN = "https://decisionmachines3000.example";
const SUBQ_KEY = "sk-test-subq-0123456789-never-logged";
const OPENAI_KEY = "sk-test-openai-0123456789-never-logged";
const keys: ProviderKeys = {
  TYPESAFE_API_KEY: "tsk-test-0123456789-never-logged",
  SUBQ_API_KEY: SUBQ_KEY,
  OPENAI_API_KEY: OPENAI_KEY,
};

const MIB = 1024 * 1024;

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
      "Image 2 is over this project's limit of 2 MB per image. Use a smaller picture.",
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
      "The images add up to more than this project's limit of 2 MB per request. Send fewer or smaller pictures.",
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
      multipart("subq", [requestPart, ["image", file(image("png", 2 * MIB))]]),
      deps,
    );

    expect(response.status).toBe(200);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(text).toContain("<image 1: image/png, 2.0 MB>");
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
    expect(parts.map((part) => part.type)).toEqual([
      "input_text",
      "input_image",
      "input_image",
      "input_image",
    ]);
    expect(parts.slice(1).map((part) => part.image_url?.split(";")[0])).toEqual([
      "data:image/png",
      "data:image/jpeg",
      "data:image/webp",
    ]);
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

describe("detectMediaType", () => {
  it("needs the whole PNG signature and both WebP markers", () => {
    expect(detectMediaType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
    const riffOnly = image("webp");
    riffOnly.set([0, 0, 0, 0], 8);
    expect(detectMediaType(riffOnly)).toBeUndefined();
    expect(detectMediaType(image("webp"))).toBe("image/webp");
  });

  it("does not read past a short input", () => {
    expect(detectMediaType(new Uint8Array([0xff, 0xd8]))).toBeUndefined();
  });
});

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
