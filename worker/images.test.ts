/**
 * Image input on `POST /api/decide/{provider}` (issues #15 and #57), end to end
 * through `handle`, plus the pure helpers in `images.ts`. The images arrive as
 * base64 in the request's `images` list. The scenarios are in
 * `scenarios/15-server-images.feature`.
 */

import { describe, expect, it, vi } from "vite-plus/test";
import type { Mock } from "vite-plus/test";
import { sizeInWords } from "../src/providers/byte-size.ts";
import { MAX_IMAGE_BYTES, openai, subq } from "../src/providers/catalog.ts";
import type { ProviderDescriptor } from "../src/providers/catalog.ts";
import { encodeBase64 } from "../src/ui/attachments.ts";
import {
  FRAMING_ALLOWANCE_BYTES,
  MAX_BODY_BYTES,
  TEXT_ALLOWANCE_BYTES,
  TOO_LARGE_MESSAGE,
} from "./body-limit.ts";
import type { ProviderKeys } from "./env.ts";
import { handle } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";
import { MAX_NAME_CHARACTERS, decodedLength, takeImages } from "./images.ts";

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

const subqImages = subq.capabilities.images;
const openaiImages = openai.capabilities.images;
if (subqImages === false || openaiImages === false) throw new Error("Both providers take images.");

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

/** One entry of the `images` list, as the browser writes it. */
function entry(bytes: Uint8Array, name?: string): { base64: string; name?: string } {
  return name === undefined
    ? { base64: encodeBase64(bytes) }
    : { base64: encodeBase64(bytes), name };
}

/** A POST of `body` as JSON to the decide route of `provider`. */
function post(provider: string, body: unknown): Request {
  return new Request(`${ORIGIN}/api/decide/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** `request` with `pictures` as its `images` list. */
function withPictures(provider: string, pictures: unknown[], request: object = question): Request {
  return post(provider, { ...request, images: pictures });
}

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

/** The message of a refusal `takeImages` returned. */
async function refusalOf(result: ReturnType<typeof takeImages>): Promise<string> {
  if (result.ok) throw new Error("Expected a refusal.");
  return ((await result.response.json()) as { error: string }).error;
}

describe("decodedLength", () => {
  it.each([
    ["", 0],
    ["SGVsbG8=", 5],
    ["SGVsbA==", 4],
    ["SGVs", 3],
    // Unpadded text still counts its bytes.
    ["SGVsbG8", 5],
  ])("gives %j as %i bytes without decoding it", (base64, bytes) => {
    expect(decodedLength(base64)).toBe(bytes);
  });

  it("agrees with the encoder for every remainder", () => {
    for (const size of [1, 2, 3, 1000, 1001, 1002]) {
      expect(decodedLength(encodeBase64(new Uint8Array(size)))).toBe(size);
    }
  });
});

describe("images on a text-only provider", () => {
  it("answers 400 naming the provider, before any upstream call", async () => {
    const deps = stubDeps();
    const { response, body } = await send(withPictures("typesafe", [entry(image("png"))]), deps);

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "TypeSafe Jev evaluates text only, so it does not accept images. Remove them and run again.",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts an empty images list as no images", async () => {
    const taken = takeImages({ ...question, images: [] }, subq);

    expect(taken).toEqual({ ok: true, request: question, images: [] });
  });
});

describe("the limits from the catalog", () => {
  function pictures(count: number, size = 64) {
    return Array.from({ length: count }, () => entry(image("png", size)));
  }

  it("refuses more images than SubQ takes, naming the count and the limit", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      withPictures("subq", pictures(subqImages.maxCount + 1)),
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
      withPictures("openai", pictures(openaiImages.maxCount + 1)),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toContain(`at most ${openaiImages.maxCount}`);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses an image one byte over the per-image limit, naming it by position and the limit", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      withPictures("subq", [...pictures(1), entry(image("png", subqImages.maxBytesPerImage + 1))]),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      `Image 2 is over this project's limit of ${sizeInWords(subqImages.maxBytesPerImage)} per image. Use a smaller picture.`,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("accepts an image exactly at the per-image limit", async () => {
    const deps = stubDeps(subqReply);
    const { response } = await send(
      withPictures("subq", [entry(image("png", subqImages.maxBytesPerImage))]),
      deps,
    );

    expect(response.status).toBe(200);
  });

  it("holds a provider to its per-request limit when that is below twice its per-image limit", async () => {
    // Each image fits on its own, and the pair does not.
    const apart: ProviderDescriptor = {
      ...subq,
      capabilities: {
        ...subq.capabilities,
        images: { ...subqImages, maxBytesPerImage: 1024, maxBytesPerRequest: 1536 },
      },
    };
    const taken = takeImages(
      { ...question, images: [entry(image("png", 1024)), entry(image("png", 513))] },
      apart,
    );

    expect(await refusalOf(taken)).toBe(
      "The images add up to more than this project's limit of 1.5 KB per request. Send fewer or smaller pictures.",
    );
  });

  it("refuses images that add up to one byte over the per-request limit", async () => {
    // With the limit per image no lower than the total, each image below fits on its
    // own, so only the per-request check can refuse this request.
    const capped: ProviderDescriptor = {
      ...openai,
      capabilities: {
        ...openai.capabilities,
        images: { ...openaiImages, maxBytesPerImage: 2048, maxBytesPerRequest: 2048 },
      },
    };
    const taken = takeImages(
      { ...question, images: [entry(image("png", 1024)), entry(image("jpeg", 1025))] },
      capped,
    );

    expect(await refusalOf(taken)).toBe(
      "The images add up to more than this project's limit of 2 KB per request. Send fewer or smaller pictures.",
    );
  });

  it("is not refused for its framing when the images and the text fill their allowances", async () => {
    const deps = stubDeps(subqReply);
    const half = subqImages.maxBytesPerRequest / 2;
    const request = withPictures(
      "subq",
      [entry(image("png", half), "a".repeat(MAX_NAME_CHARACTERS)), entry(image("png", half))],
      { ...question, state: "x".repeat(TEXT_ALLOWANCE_BYTES - 1024) },
    );

    const { response } = await send(request, deps);

    expect(response.status).toBe(200);
  });
});

describe("the real format of an image", () => {
  it("sends the type the bytes show, whatever the name says", async () => {
    const deps = stubDeps(subqReply);
    const { response } = await send(
      withPictures("subq", [entry(image("jpeg"), "photo.png")]),
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
    const { response } = await send(withPictures("subq", [entry(image(kind))]), deps);

    expect(response.status).toBe(200);
    expect((upstreamBody(deps).images as { mediaType: string }[])[0]?.mediaType).toBe(mediaType);
  });

  it.each([
    ["a GIF", entry(image("gif"), "secret-name.gif")],
    ["an empty image", entry(new Uint8Array(0), "secret-name.png")],
    ["text", entry(new TextEncoder().encode("not a picture at all"), "secret-name.png")],
    ["text that is not base64", { base64: "!!!! not base64 !!!!", name: "secret-name.png" }],
    ["a data URL", { base64: `data:image/png;base64,${encodeBase64(image("png"))}` }],
  ])("refuses %s, naming the accepted formats and not the image", async (_name, picture) => {
    const deps = stubDeps();
    const { response, body, text } = await send(withPictures("subq", [picture]), deps);

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      "Image 1 is not image/png, image/jpeg, or image/webp, judging by its first bytes.",
    );
    expect(text).not.toContain("secret-name");
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("names the second image when only it is bad", async () => {
    const { body } = await send(
      withPictures("subq", [entry(image("png")), entry(image("gif"))]),
      stubDeps(),
    );

    expect(body.error).toContain("Image 2 is not");
  });

  it("names only the formats of a provider that accepts only PNG", async () => {
    const pngOnly: ProviderDescriptor = {
      ...subq,
      capabilities: {
        ...subq.capabilities,
        images: { ...subqImages, mediaTypes: ["image/png"] },
      },
    };

    expect(await refusalOf(takeImages({ images: [entry(image("jpeg"))] }, pngOnly))).toBe(
      "Image 1 is not image/png, judging by its first bytes.",
    );
    expect(takeImages({ images: [entry(image("png"))] }, pngOnly).ok).toBe(true);
  });
});

describe("the shape of the images list", () => {
  it.each([
    ["a list that is an object", { a: 1 }, `"images" must be a list of images.`],
    [
      "an entry that is text",
      ["abc"],
      `Image 1 must be an object with "base64" and an optional "name".`,
    ],
    [
      "an entry without base64",
      [{ name: "a.png" }],
      `Image 1 needs "base64": the picture's bytes as base64 text.`,
    ],
    [
      "base64 that is a number",
      [{ base64: 12 }],
      `Image 1 needs "base64": the picture's bytes as base64 text.`,
    ],
    [
      "a name that is a number",
      [{ base64: encodeBase64(image("png")), name: 3 }],
      `The "name" of Image 1 must be text.`,
    ],
    [
      "an entry with another field",
      [{ base64: encodeBase64(image("png")), mediaType: "image/png" }],
      `Image 1 may hold only "name" and "base64".`,
    ],
  ])("refuses %s", async (_name, images, message) => {
    const deps = stubDeps();
    const { response, body } = await send(post("subq", { ...question, images }), deps);

    expect(response.status).toBe(400);
    expect(body.error).toBe(message);
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it("refuses a name over the length it reads, without echoing it", async () => {
    const name = `secret-${"n".repeat(MAX_NAME_CHARACTERS)}`;
    const { response, body, text } = await send(
      withPictures("subq", [entry(image("png")), entry(image("png"), name)]),
      stubDeps(),
    );

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      `The "name" of Image 2 is longer than ${MAX_NAME_CHARACTERS} characters.`,
    );
    expect(text).not.toContain("secret-");
  });

  it("validates the request without its images list, so the list is not an unknown field", async () => {
    const deps = stubDeps();
    const { response, body } = await send(
      withPictures("subq", [entry(image("png"))], { ...question, primitive: "maybe" }),
      deps,
    );

    expect(response.status).toBe(400);
    expect(body.error).toContain("primitive");
    expect(body.error).not.toContain("images");
  });

  it("leaves a body that is not an object to the request validator", () => {
    expect(takeImages([1, 2], subq)).toEqual({ ok: true, request: [1, 2], images: [] });
  });
});

describe("what reaches the provider and what comes back", () => {
  it("sends two images to SubQ as the base64 that arrived, in order", async () => {
    const first = image("png", 300);
    const second = image("jpeg", 500);
    const deps = stubDeps(subqReply);

    const { response, body, text } = await send(
      withPictures("subq", [entry(first), entry(second)]),
      deps,
    );

    expect(response.status).toBe(200);
    const sent = upstreamBody(deps).images as { mediaType: string; base64: string }[];
    expect(sent).toEqual([
      { mediaType: "image/png", base64: encodeBase64(first) },
      { mediaType: "image/jpeg", base64: encodeBase64(second) },
    ]);
    const wire = body.wire as { request: { images: { base64: string }[] } };
    expect(wire.request.images.map((image) => image.base64)).toEqual([
      "<image 1: image/png, 300 bytes>",
      "<image 2: image/jpeg, 500 bytes>",
    ]);
    expect(text).not.toContain(sent[0]!.base64);
  });

  it("keeps the response small and free of base64 for the largest image", async () => {
    const deps = stubDeps(subqReply);
    const { response, text } = await send(
      withPictures("subq", [entry(image("png", MAX_IMAGE_BYTES))]),
      deps,
    );

    expect(response.status).toBe(200);
    expect(text.length).toBeLessThan(64 * 1024);
    expect(text).toContain(`<image 1: image/png, ${sizeInWords(MAX_IMAGE_BYTES)}>`);
  });

  it("sends three images to OpenAI as data URLs in order", async () => {
    const deps = stubDeps(openaiReply);
    const kinds = ["png", "jpeg", "webp"] as const;

    const { response } = await send(
      withPictures(
        "openai",
        kinds.map((kind) => entry(image(kind))),
      ),
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
      withPictures("subq", [
        entry(image("png"), "private-name.png"),
        entry(image("png"), "private-name-2.png"),
      ]),
      deps,
    );

    const lines = deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain("images=2");
    expect(lines).not.toContain("private-name");
  });

  it("leaves the key out of every reply", async () => {
    const deps = stubDeps(subqReply);
    const { text } = await send(withPictures("subq", [entry(image("png"))]), deps);

    expect(text).not.toContain(SUBQ_KEY);
  });
});

describe("the body limit", () => {
  it("answers 413 and stops reading once a streamed body passes the limit, with no Content-Length", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
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
      headers: { "content-type": "application/json" },
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

describe("the text allowance", () => {
  /** A valid request whose JSON text is exactly `size` bytes. */
  function padded(size: number): string {
    const bare = JSON.stringify({ ...question, state: "" });
    return JSON.stringify({ ...question, state: "a".repeat(size - bare.length) });
  }

  it("takes a request without images at the allowance and refuses one byte more with a 413", async () => {
    const at = await send(post("subq", padded(TEXT_ALLOWANCE_BYTES)), stubDeps(subqReply));
    const over = await send(post("subq", padded(TEXT_ALLOWANCE_BYTES + 1)), stubDeps());

    expect(at.response.status).toBe(200);
    expect(over.response.status).toBe(413);
    expect(over.body.error).toBe(TOO_LARGE_MESSAGE);
  });

  it("counts the text in bytes, not characters", async () => {
    // Each "é" is two bytes, so this text has fewer characters than the allowance has bytes.
    const bare = JSON.stringify({ ...question, state: "" });
    const characters = (TEXT_ALLOWANCE_BYTES - bare.length) / 2 + 1;
    const text = JSON.stringify({ ...question, state: "é".repeat(characters) });

    const { response } = await send(post("subq", text), stubDeps());

    expect(response.status).toBe(413);
  });

  it("does not count the images' base64 against the text, only the JSON around them", async () => {
    const size = TEXT_ALLOWANCE_BYTES + FRAMING_ALLOWANCE_BYTES;
    const picture = entry(image("png", subqImages.maxBytesPerRequest));
    const bare = JSON.stringify({ ...question, state: "", images: [picture] });
    const fill = (extra: number) =>
      JSON.stringify({
        ...question,
        state: "a".repeat(size - (bare.length - picture.base64.length) + extra),
        images: [picture],
      });

    const at = await send(post("subq", fill(0)), stubDeps(subqReply));
    const over = await send(post("subq", fill(1)), stubDeps());

    expect(at.response.status).toBe(200);
    expect(over.response.status).toBe(413);
  });
});

describe("image labels (issue #57)", () => {
  const twoImages = () => [entry(image("png"), "a.png"), entry(image("jpeg"), "b.jpg")];

  it("labels the images for OpenAI with their names, in order", async () => {
    const deps = stubDeps(openaiReply);
    const { response } = await send(withPictures("openai", twoImages()), deps);

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
    const { response } = await send(withPictures("subq", twoImages()), deps);

    expect(response.status).toBe(200);
    const sent = upstreamBody(deps);
    expect(sent.state).toBe(`${question.state}\n\nImage 1: a.png\nImage 2: b.jpg`);
    expect((sent.images as object[]).map((image) => Object.keys(image).sort())).toEqual([
      ["base64", "mediaType"],
      ["base64", "mediaType"],
    ]);
  });

  it("labels an image without a name by its number alone", async () => {
    const deps = stubDeps(subqReply);
    await send(withPictures("subq", [entry(image("png"))]), deps);

    expect(upstreamBody(deps).state).toBe(`${question.state}\n\nImage 1`);
  });

  it("shows the labels in the wire record, beside the placeholders, on OpenAI", async () => {
    const deps = stubDeps(openaiReply);
    const { body } = await send(withPictures("openai", twoImages()), deps);

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
    const { body } = await send(withPictures("subq", twoImages()), deps);

    const wire = body.wire as { request: { state: string } };
    expect(wire.request.state).toContain("Image 1: a.png\nImage 2: b.jpg");
  });

  it("clips a 300-character name and removes control characters before labelling", async () => {
    const deps = stubDeps(openaiReply);
    const long = `${"n".repeat(296)}.png`;
    const messy = "line\nbreak‮.png";
    const { response } = await send(
      withPictures("openai", [entry(image("png"), long), entry(image("png"), messy)]),
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
  ])("keeps every name out of the log for %s", async (_name, reply) => {
    const deps = stubDeps(reply);
    await send(
      withPictures("openai", [
        entry(image("png"), "secret-holiday.png"),
        entry(image("png"), "second-secret.png"),
      ]),
      deps,
    );

    const lines = deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain("images=2");
    expect(lines).not.toContain("secret");
  });

  it("logs only the status of a provider error that quotes the names", async () => {
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
      withPictures("openai", [entry(image("png"), "secret-holiday.png")]),
      deps,
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const lines = deps.log.mock.calls.map(([line]) => line).join("\n");
    expect(lines).toContain('detail="400"');
    expect(lines).toContain("images=1");
    expect(lines).not.toContain("secret");
  });
});

describe("a blank state with images", () => {
  const blankState = { ...question, state: "" };

  it("is sent to SubQ with the image labels as the state", async () => {
    const deps = stubDeps(subqReply);
    const { response } = await send(
      withPictures("subq", [entry(image("png"), "photo.png")], blankState),
      deps,
    );

    expect(response.status).toBe(200);
    expect(upstreamBody(deps).state).toBe("Image 1: photo.png");
  });

  it("is refused without images, with a message that offers attaching one", async () => {
    const deps = stubDeps();
    const { response, body } = await send(post("subq", blankState), deps);

    expect(response.status).toBe(400);
    expect(body.error).toBe(
      `"state" is empty. Add the text, object, or list to evaluate, or attach an image.`,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});
