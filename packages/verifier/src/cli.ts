#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { verifyProofPack } from './verify.js';

/**
 * `merited-verify <proofpack.json>` — the offline CLI (PH3-8). Exit codes:
 * 0 = VERIFIED, 2 = REJECTED (the anchored ledger records a rejection),
 * 1 = INVALID (some check failed) or usage error. No network, ever.
 */
const main = async (): Promise<number> => {
  const packPath = process.argv[2];
  if (!packPath) {
    process.stderr.write('usage: merited-verify <proofpack.json>\n');
    return 1;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packPath, 'utf-8'));
  } catch (error) {
    process.stderr.write(`could not read proof pack: ${error instanceof Error ? error.message : 'unknown'}\n`);
    return 1;
  }
  const result = await verifyProofPack(parsed);
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
