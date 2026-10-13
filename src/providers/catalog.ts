/**
 * The providers a decision can run on, and what each one accepts.
 *
 * A descriptor is plain data. Validation reads limits from a provider's
 * `capabilities` instead of module constants, so adding a provider means adding
 * a descriptor here and nothing else in the validator. This file is the only
 * place a provider's name belongs: everything the UI renders takes the name
 * from `displayName`.
 *
 * Limits come from the live probes recorded in `docs/spikes/provider-probes.md`.
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
  mediaTypes: readonly string[];
};

export type ProviderCapabilities = {
  /** How many options a Choice question may offer. */
  choiceOptions: CountRange;
  /** How many levels a Score question may have. */
  scoreLevels: CountRange;
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
   * A cheap GET path that opens a connection without spending tokens.
   * Undefined when the provider has none worth using.
   */
  warmPath?: string;
  capabilities: ProviderCapabilities;
};

const MIB = 1024 * 1024;

/**
 * This project's own image caps for SubQ and OpenAI: 2 MiB per image and 2 MiB
 * per request. They sit below SubQ's documented 4 MiB per image and 8 MiB total.
 */
export const MAX_IMAGE_BYTES = 2 * MIB;
export const MAX_IMAGE_REQUEST_BYTES = 2 * MIB;

/** SubQ's documented limit is four images per request. */
const SUBQ_MAX_IMAGES = 4;

/** This project's own choice for OpenAI, which documents no count of its own. */
const OPENAI_MAX_IMAGES = 8;

const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Every probed provider accepts 255 options in a Choice question. */
const CHOICE_OPTIONS: CountRange = { min: 2, max: 255 };

/** Every probed provider accepts 2 to 10 levels in a Score question. */
const SCORE_LEVELS: CountRange = { min: 2, max: 10 };

export const typesafe: ProviderDescriptor = {
  id: "typesafe",
  displayName: "TypeSafe Jev",
  model: "jev-1.13.0",
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
  model: "gpt-6-luna",
  warmPath: "/v1/models/gpt-6-luna",
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

export const PROVIDERS: Record<ProviderId, ProviderDescriptor> = { typesafe, subq, openai };

/** The provider every request uses until the provider select lands. */
export const DEFAULT_PROVIDER: ProviderDescriptor = typesafe;
