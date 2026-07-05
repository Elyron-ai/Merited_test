import { createAppPool } from '../db.js';
import { FakeObjectStore } from '../fake-object-store.js';
import { verifyAgainstHeads } from '../head-publisher.js';
import { S3ObjectStore, type ObjectStore } from '../object-store.js';
import { verifyChain } from '../verify.js';

/**
 * verify-chain CLI (FND-13, B2 acceptance; Phase 0 gate: "Chain verifies via
 * verify-chain"; demo Act 1 step 9). Walks seq ascending, recomputes every
 * hash, checks linkage; prints event count + head hash, or exits 1 naming the
 * first broken seq.
 *
 * PH1-21: `--against-heads <target>` additionally cross-checks the chain
 * against externally published head records — catching a consistently
 * REWRITTEN or truncated chain that pure recomputation cannot see. `<target>`
 * is a local directory (FakeObjectStore) or `s3://bucket[/prefix]`.
 */
export const storeForTarget = (target: string): ObjectStore => {
  if (target.startsWith('s3://')) {
    const uri = new URL(target);
    const prefix = uri.pathname.replace(/^\//, '');
    return new S3ObjectStore({
      bucket: uri.host,
      ...(prefix ? { prefix: prefix.endsWith('/') ? prefix : `${prefix}/` } : {}),
      ...(process.env['MERITED_HEADS_ENDPOINT'] ? { endpoint: process.env['MERITED_HEADS_ENDPOINT'] } : {}),
    });
  }
  return new FakeObjectStore(target);
};

export const runVerifyChain = async (
  databaseUrl?: string,
  options: { againstHeads?: ObjectStore } = {},
): Promise<{ code: number; output: string }> => {
  const pool = createAppPool(databaseUrl);
  try {
    const client = await pool.connect();
    try {
      const result = await verifyChain(client);
      if (!result.ok) {
        return {
          code: 1,
          output: `CHAIN BROKEN at seq ${result.broken_seq}: ${result.problem}`,
        };
      }
      const lines = [
        result.count === 0
          ? 'chain verified: 0 events (empty ledger)'
          : `chain verified: ${result.count} events\nhead hash: ${result.head}`,
      ];
      if (options.againstHeads) {
        const heads = await verifyAgainstHeads(client, options.againstHeads);
        if (!heads.ok) {
          return {
            code: 1,
            output: `HEADS MISMATCH (${heads.key}): ${heads.problem}`,
          };
        }
        lines.push(`published heads cross-checked: ${heads.checked}`);
      }
      return { code: 0, output: lines.join('\n') };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const flagIndex = process.argv.indexOf('--against-heads');
  const target = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
  if (flagIndex >= 0 && !target) {
    console.error('usage: verify-chain [--against-heads <dir | s3://bucket[/prefix]>]');
    process.exit(2);
  }
  runVerifyChain(undefined, target ? { againstHeads: storeForTarget(target) } : {})
    .then(({ code, output }) => {
      (code === 0 ? console.log : console.error)(output);
      process.exit(code);
    })
    .catch((error) => {
      console.error(`verify-chain failed: ${(error as Error).message}`);
      process.exit(2);
    });
}
