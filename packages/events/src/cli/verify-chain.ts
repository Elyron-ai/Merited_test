import { createAppPool } from '../db.js';
import { verifyChain } from '../verify.js';

/**
 * verify-chain CLI (FND-13, B2 acceptance; Phase 0 gate: "Chain verifies via
 * verify-chain"; demo Act 1 step 9). Walks seq ascending, recomputes every
 * hash, checks linkage; prints event count + head hash, or exits 1 naming the
 * first broken seq.
 */
export const runVerifyChain = async (
  databaseUrl?: string,
): Promise<{ code: number; output: string }> => {
  const pool = createAppPool(databaseUrl);
  try {
    const client = await pool.connect();
    try {
      const result = await verifyChain(client);
      if (result.ok) {
        return {
          code: 0,
          output:
            result.count === 0
              ? 'chain verified: 0 events (empty ledger)'
              : `chain verified: ${result.count} events\nhead hash: ${result.head}`,
        };
      }
      return {
        code: 1,
        output: `CHAIN BROKEN at seq ${result.broken_seq}: ${result.problem}`,
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runVerifyChain()
    .then(({ code, output }) => {
      (code === 0 ? console.log : console.error)(output);
      process.exit(code);
    })
    .catch((error) => {
      console.error(`verify-chain failed: ${(error as Error).message}`);
      process.exit(2);
    });
}
