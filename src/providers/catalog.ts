/**
 * The providers a decision can run on, and what each one accepts.
 *
 * A descriptor is plain data. Validation reads limits from a provider's
 * `capabilities` instead of module constants, so adding a provider means adding
 * a descriptor here and nothing else in the validator. This file is the only
 * place a provider's name belongs: everything the UI renders takes the name
 * from `displayName`.
 *
 * Where each limit comes from is noted beside it. Score levels (2 to 10) and
 * SubQ's question-name limit were measured by the live probes in
 * `docs/spikes/provider-probes.md`. The 255 choice options and SubQ's four
 * images come from the providers' documentation and were not probed. The image
 * byte caps and OpenAI's image count are this project's own limits (issue #15).
 */

export type ProviderId = "typesafe" | "subq" | "openai";

/** A range of counts. An undefined `max` means the provider states no upper limit. */
export type CountRange = {
  min: number;
  max?: number;
};

/** What a provider accepts as image input. */
export type ImageCapabilities = {
  /** The most images one request may carry. */
  maxCount: number;
  /** The most bytes one decoded image may hold. */
  maxBytesPerImage: number;
  /** The most bytes all decoded images in one request may hold together. */
  maxBytesPerRequest: number;
  readonly mediaTypes: readonly string[];
};

export type ProviderCapabilities = {
  /** How many options a Choice question may offer. */
  choiceOptions: Readonly<CountRange>;
  /** How many levels a Score question may have. */
  scoreLevels: Readonly<CountRange>;
  /** The longest question id, in characters. Undefined when the provider sets no limit. */
  questionNameMaxLength?: number;
  /** Image limits, or `false` when the provider accepts no images. */
  images: ImageCapabilities | false;
};

export type ProviderDescriptor = {
  id: ProviderId;
  /** The only provider name the UI may show. */
  displayName: string;
  /** The model id requests are pinned to. */
  model: string;
  /**
   * The origin every API path of the provider is resolved against, with no
   * trailing slash. It stays on the server: `GET /api/providers` never lists it.
   * The three origins are the ones the live probes in
   * `docs/spikes/provider-probes.md` called (`scripts/probe/run.mjs`).
   */
  baseUrl: string;
  /**
   * A cheap GET path that opens a connection without spending tokens, relative
   * to `baseUrl`. Undefined when the provider has none worth using.
   */
  warmPath?: string;
  capabilities: ProviderCapabilities;
};

const MIB = 1024 * 1024;

/**
 * This project's own image caps for SubQ and OpenAI: 2 MiB per image and 2 MiB
 * per request (issue #15). They sit below SubQ's documented 4 MiB per image
 * and 8 MiB total. The descriptors below refer to these two constants.
 */
export const MAX_IMAGE_BYTES = 2 * MIB;
export const MAX_IMAGE_REQUEST_BYTES = 2 * MIB;

/** SubQ's documentation states four images per request. This was not probed. */
const SUBQ_MAX_IMAGES = 4;

/** This project's own choice for OpenAI (issue #15); OpenAI's documentation gives no count. */
const OPENAI_MAX_IMAGES = 8;

/**
 * The media types the project accepts. The probes sent PNG and JPEG only, so
 * WebP rests on the providers' documentation.
 */
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** The providers' documentation states 255 options in a Choice question. This was not probed. */
const CHOICE_OPTIONS: Readonly<CountRange> = Object.freeze({ min: 2, max: 255 });

/** Probed: 2 and 10 levels were accepted and 11 was refused by all three providers. */
const SCORE_LEVELS: Readonly<CountRange> = Object.freeze({ min: 2, max: 10 });

const OPENAI_MODEL = "gpt-6-luna";
export const typesafe: ProviderDescriptor = {
  id: "typesafe",
  displayName: "TypeSafe Jev",
  model: "jev-1.13.0",
  baseUrl: "https://api.typesafe.ai",
  warmPath: "/v1/models",
  capabilities: {
    choiceOptions: CHOICE_OPTIONS,
    scoreLevels: SCORE_LEVELS,
    images: false,
  },
};

export const subq: ProviderDescriptor = {
  id: "subq",
  displayName: "SubQ Snap",
  model: "subq-snap-preview",
  baseUrl: "https://api.subq.ai",
  warmPath: "/v1/models",
  capabilities: {
    choiceOptions: CHOICE_OPTIONS,
    scoreLevels: SCORE_LEVELS,
    questionNameMaxLength: 100,
    images: {
      maxCount: SUBQ_MAX_IMAGES,
      maxBytesPerImage: MAX_IMAGE_BYTES,
      maxBytesPerRequest: MAX_IMAGE_REQUEST_BYTES,
      mediaTypes: IMAGE_MEDIA_TYPES,
    },
  },
};

export const openai: ProviderDescriptor = {
  id: "openai",
  displayName: "OpenAI Decisions",
  model: OPENAI_MODEL,
  baseUrl: "https://api.openai.com",
  warmPath: `/v1/models/${OPENAI_MODEL}`,
  capabilities: {
    choiceOptions: CHOICE_OPTIONS,
    scoreLevels: SCORE_LEVELS,
    images: {
      maxCount: OPENAI_MAX_IMAGES,
      maxBytesPerImage: MAX_IMAGE_BYTES,
      maxBytesPerRequest: MAX_IMAGE_REQUEST_BYTES,
      mediaTypes: IMAGE_MEDIA_TYPES,
    },
  },
};

export const PROVIDERS: Readonly<Record<ProviderId, ProviderDescriptor>> = {
  typesafe,
  subq,
  openai,
};

/** The order providers are listed in, set here so it never depends on object key order. */
export const PROVIDER_ORDER: readonly ProviderId[] = ["typesafe", "subq", "openai"];

/** The provider every request uses until the provider select lands. */
export const DEFAULT_PROVIDER: ProviderDescriptor = typesafe;
