#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { verifyProofPack, type TrustAnchor } from './verify.js';

/**
 * `merited-verify <proofpack.json> --trust <trust-anchor.json>` — the offline
 * CLI (PH3-8). Exit codes: 0 = VERIFIED, 2 = REJECTED (the anchored ledger
 * records a rejection), 1 = INVALID (some check failed) or usage error. No
 * network, ever.
 *
 * W12/#3: the TRUST ANCHOR is a SEPARATE input the auditor supplies out-of-band
 * — the published head(s) fetched from the trusted append-only heads store and
 * the platform's public keys from its key manifest:
 *   { "heads": [{ "date": "…", "seq": N, "head_hash": "…" }],
 *     "platform": { "commitment_public_key": "<b64 spki>",
 *                   "mint_public_key": "<b64 spki>" } }
 * The pack's own `heads`/platform `keys` are NEVER trusted — otherwise a forged
 * pack self-certifies against its own head.
 */
const usage = 'usage: merited-verify <proofpack.json> --trust <trust-anchor.json>\n';

const readJson = (label: string, path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    process.stderr.write(`could not read ${label}: ${error instanceof Error ? error.message : 'unknown'}\n`);
    return undefined;
  }
};

const main = async (): Promise<number> => {
  const args = process.argv.slice(2);
  const trustIdx = args.indexOf('--trust');
  const trustPath = trustIdx >= 0 ? args[trustIdx + 1] : undefined;
  // the pack is the first positional — not a flag, and not the --trust value
  const packPath = args.find((a, i) => !a.startsWith('--') && i !== trustIdx + 1);
  if (!packPath || !trustPath) {
    process.stderr.write(usage);
    return 1;
  }

  const pack = readJson('proof pack', packPath);
  if (pack === undefined) return 1;
  const trust = readJson('trust anchor', trustPath);
  if (trust === undefined) return 1;

  const result = await verifyProofPack(pack, trust as TrustAnchor);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.outcome === 'VERIFIED') return 0;
  if (result.outcome === 'REJECTED') return 2;
  return 1;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`verifier error: ${error instanceof Error ? error.message : 'unknown'}\n`);
    process.exit(1);
  },
);
