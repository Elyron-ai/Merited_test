import { AttributionTokenClaims } from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { Ed25519Signer, type Signer } from '@merited/signing';
import { V4 } from 'paseto';
import { PLATFORM_MINT_KEY } from '../shared/deps.js';

/**
 * Token codec (PH1-25): the ONLY code that knows what an attribution token
 * looks like on the wire. Two implementations, selected by the signer's
 * capability — the claims shape, TTL arithmetic and every pipeline check
 * are IDENTICAL either side of the swap:
 *
 *  - `FakeTokenCodec` — Phase 0's pseudo-format
 *    `v4.public.fake.<base64url(canonical claims)>.<FakeSigner sig>`.
 *  - `PasetoTokenCodec` — real PASETO v4.public via the `paseto` library
 *    (ADR-006: versioned, algorithm-fixed Ed25519, no negotiable header).
 *    Claims ride under one private claim (`mc`) so PASETO's registered
 *    claims never collide with ours; expiry stays OUR pipeline's job
 *    (stage 3/4), so registered-claim validation is disabled on verify.
 *
 * decode() returns the VERIFIED claims or null — a null is stage 1's
 * SIG_INVALID. Fail closed: any parse error, wrong version, wrong purpose
 * (`v4.local`, `v3.public`), or bad signature is null, never a throw.
 */
export interface TokenCodec {
  mint(claims: AttributionTokenClaims): Promise<string>;
  decode(token: string): Promise<AttributionTokenClaims | null>;
}

const base64url = (input: string): string => Buffer.from(input, 'utf8').toString('base64url');

export class FakeTokenCodec implements TokenCodec {
  constructor(private readonly signer: Signer) {}

  async mint(claims: AttributionTokenClaims): Promise<string> {
    const canonicalClaims = canonicalJson(claims);
    const signature = await this.signer.sign(PLATFORM_MINT_KEY, canonicalClaims);
    return `v4.public.fake.${base64url(canonicalClaims)}.${signature}`;
  }

  async decode(token: string): Promise<AttributionTokenClaims | null> {
    const parts = token.split('.');
    if (parts.length !== 5 || !token.startsWith('v4.public.fake.')) return null;
    const canonicalClaims = Buffer.from(parts[3]!, 'base64url').toString('utf8');
    if (!(await this.signer.verify(PLATFORM_MINT_KEY, canonicalClaims, parts[4]!))) return null;
    try {
      return AttributionTokenClaims.parse(JSON.parse(canonicalClaims));
    } catch {
      return null;
    }
  }
}

export class PasetoTokenCodec implements TokenCodec {
  constructor(private readonly signer: Ed25519Signer) {}

  async mint(claims: AttributionTokenClaims): Promise<string> {
    return this.signer.usePrivateKey(PLATFORM_MINT_KEY, (privateKey) =>
      V4.sign({ mc: claims }, privateKey, { iat: false }),
    );
  }

  async decode(token: string): Promise<AttributionTokenClaims | null> {
    // strict single-version parsing (threat notes §2): exactly v4.public,
    // and never the fake format
    if (!token.startsWith('v4.public.') || token.startsWith('v4.public.fake.')) return null;
    try {
      // rotation-tolerant (PH1-22): try every non-revoked key version,
      // newest first — tokens minted under key N verify after rotation to N+1
      const payload = await this.signer.usePublicKeyVersions(PLATFORM_MINT_KEY, (publicKey) =>
        V4.verify(token, publicKey),
      );
      return AttributionTokenClaims.parse((payload as { mc: unknown }).mc);
    } catch {
      return null; // bad signature, wrong key, malformed payload — all closed
    }
  }
}

/** Capability-selected: the real signer mints real PASETO; anything else
 * stays on the Phase-0 pseudo-format (dev/demo). A fake-format token
 * presented to a PASETO trio is null → SIG_INVALID, and vice versa. */
export const codecFor = (signer: Signer): TokenCodec =>
  signer instanceof Ed25519Signer ? new PasetoTokenCodec(signer) : new FakeTokenCodec(signer);
