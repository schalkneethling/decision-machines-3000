import { describe, expect, it } from "vite-plus/test";

import { configuredProviders, isKeySet } from "./env.ts";

describe("isKeySet", () => {
  it.each(["unset", "UNSET", " unset ", "Unset", "", "   "])("treats %j as absent", (value) => {
    expect(isKeySet(value)).toBe(false);
  });

  it.each([undefined, null, 0, true, {}, ["unset"]])(
    "treats the non-string %j as absent",
    (value) => {
      expect(isKeySet(value)).toBe(false);
    },
  );

  // The rule is an exact word, not a guess about what a key looks like, so short
  // and odd values that are not the placeholder all count as keys.
  it.each(["x", "none", "unsetx", "un set", "sk-short", "unset1", "0"])(
    "treats %j as a real key",
    (value) => {
      expect(isKeySet(value)).toBe(true);
    },
  );
});

describe("configuredProviders", () => {
  it("lists only the providers whose key is a real value, in catalog order", () => {
    expect(
      configuredProviders({
        OPENAI_API_KEY: "sk-real",
        SUBQ_API_KEY: "unset",
        TYPESAFE_API_KEY: "x",
      }),
    ).toEqual(["typesafe", "openai"]);
  });

  it("lists nothing when every key is the placeholder", () => {
    expect(
      configuredProviders({
        OPENAI_API_KEY: "unset",
        SUBQ_API_KEY: "UNSET",
        TYPESAFE_API_KEY: " unset ",
      }),
    ).toEqual([]);
  });
});
