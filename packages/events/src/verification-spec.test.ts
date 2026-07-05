import { readFileSync } from 'node:fs';
import { REJECTION_REASON_CODES } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';
import { chainHash, GENESIS_PREV_HASH } from './hash.js';

/**
 * PH3-7: the open verification spec is pinned to the CODE. The worked
 * example in docs/spec/verification.md must be reproducible by this
 * package's own primitives — if either the doc or the implementation
 * drifts, this suite fails. (The full "a reader can implement a verifier
 * from the doc alone" proof is PH3-8, built strictly against the doc.)
 */

const spec = readFileSync(
  new URL('../../../docs/spec/verification.md', import.meta.url),
  'utf-8',
);

describe('docs/spec/verification.md (PH3-7)', () => {
  it('exists and states the normative chain formula and genesis', () => {
    expect(spec).toContain('this_hash = SHA256_hex( prev_hash ‖ canonical_json(body) )');
    expect(spec).toContain('sixty-four');
    expect(spec).toContain('RFC 8785');
    expect(spec).toContain('merited-proof-pack/1');
  });

  it('the worked example reproduces EXACTLY under the real primitives', () => {
    const body1 = { type: 'ExampleEvent', v: 1, data: { note: 'worked example', value_pence: 8450 } };
    const canonical1 = canonicalJson(body1);
    expect(spec).toContain(canonical1); // the doc shows the true canonical form
    const h1 = chainHash(GENESIS_PREV_HASH, canonical1);
    expect(spec).toContain(h1);

    const body2 = { type: 'ExampleEvent', v: 1, data: { note: 'second event' } };
    const canonical2 = canonicalJson(body2);
    expect(spec).toContain(canonical2);
    const h2 = chainHash(h1, canonical2);
    expect(spec).toContain(h2);
  });

  it('names all twelve reason codes of the closed enum — and no thirteenth', () => {
    for (const code of REJECTION_REASON_CODES) {
      expect(spec).toContain(code);
    }
    expect(REJECTION_REASON_CODES).toHaveLength(12);
    expect(spec).toContain('closed');
  });

  it('pins the signature and token formats the artefacts actually use', () => {
    expect(spec).toContain('ed25519:');
    expect(spec).toContain('base64url');
    expect(spec).toContain('PASETO v4.public');
    expect(spec).toContain('"mc"');
    // dual-signature byte layouts, both directions
    expect(spec).toContain('COR minus merchant_sig minus platform_sig');
    expect(spec).toContain('COR minus platform_sig');
    expect(spec).toContain('claim minus merchant_sig');
    // the dev formats are named as REFUSED, not verifiable
    expect(spec).toContain('v4.public.fake.');
  });

  it('head publication format matches the publisher', () => {
    expect(spec).toContain('heads/<YYYY-MM-DD>.json');
    expect(spec).toContain('heads/latest.json');
    expect(spec).toContain('first write wins');
    expect(spec).toContain('"head_hash"');
  });
});
