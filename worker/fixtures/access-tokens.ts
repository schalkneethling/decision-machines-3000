/**
 * Test support for the Access gate: RSA key pairs, tokens shaped and signed
 * the way Cloudflare Access signs them (RS256), and the key set the team's
 * `/cdn-cgi/access/certs` endpoint publishes. Everything uses Web Crypto, so it
 * runs wherever the verifier does.
 */

import type { AccessApplication } from "../access.ts";

/** A key pair that signs tokens, and the public half as the certs endpoint lists it. */
export type Signer = {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
};

const RSA_SHA256 = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
};

export async function createSigner(kid: string): Promise<Signer> {
  // The Workers types declare the return as `CryptoKey | CryptoKeyPair`; RSA always gives a pair.
  const pair = (await crypto.subtle.generateKey(RSA_SHA256, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, publicJwk };
}

export function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The claims of an application token, as the "Application token" page lists
 * them, valid for five minutes from a minute ago. `overrides` replaces any of
 * them; `undefined` removes one.
 */
export function accessClaims(
  application: AccessApplication,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const now = nowSeconds();
  const claims: Record<string, unknown> = {
    aud: [application.audience],
    email: "owner@example.com",
    exp: now + 300,
    iat: now - 60,
    nbf: now - 60,
    iss: application.issuer,
    type: "app",
    identity_nonce: "6ei69kawdKzMIAPF",
    sub: "7335d417-61da-459d-899c-0a01c76a2f94",
    country: "ZA",
    ...overrides,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete claims[name];
  }
  return claims;
}

/** A token signed by `signer`, with the standard header unless another is given. */
export async function signToken(
  signer: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: signer.kid, typ: "JWT" },
): Promise<string> {
  const signed = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(
    RSA_SHA256.name,
    signer.privateKey,
    new TextEncoder().encode(signed),
  );
  return `${signed}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * The body of `/cdn-cgi/access/certs` for `signers`, in the shape Cloudflare
 * publishes: the JWKS `keys`, plus the PEM fields the verifier ignores.
 */
export function keySetBody(...signers: Signer[]): Record<string, unknown> {
  return {
    keys: signers.map((signer) => ({
      kid: signer.kid,
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      e: signer.publicJwk.e,
      n: signer.publicJwk.n,
    })),
    public_cert: {
      kid: signers[0]?.kid ?? "",
      cert: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
    },
    public_certs: [],
  };
}
