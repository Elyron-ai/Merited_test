import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { AURORA_COMMERCIAL, AURORA_MEMBERS, AURORA_MERCHANT_ID, AURORA_OFFERS } from './fixtures/aurora.js';

export interface SeedOptions {
  /** merited_app connection string — events+core+trio schemas migrated. */
  databaseUrl: string;
  serviceToken?: string;
  signerSecret?: string;
  log?: (line: string) => void;
}

export interface SeedResult {
  merchant_id: string;
  members: number;
  offers_published: number;
  /** The spa-day offer's COR — §10 step 1's countersigned commitment. */
  bounty_commitment_id: string | null;
}

const formatPence = (amount: number): string => `£${(amount / 100).toFixed(2)}`;

/**
 * Aurora Experiences seed (VAL-9, B22). Everything goes through the REAL
 * platform surfaces — merchants service, offers service, publish path →
 * trio commitment simulator (in-process over real HTTP) — never back-door
 * inserts, so seeding emits the same `OfferPublished` + `CommitmentCreated`
 * ledger events production would (§5.1). The only direct SQL is the Aurora
 * Club membership table: CORE-4 owns that schema, VAL-9 owns its rows.
 * Fixed IDs (D6) make re-runs converge on the same entities.
 */
export const runSeed = async (options: SeedOptions): Promise<SeedResult> => {
  const log = options.log ?? ((line: string) => console.log(line));
  const serviceToken = options.serviceToken ?? 'seed-local';
  const signerSecret = options.signerSecret ?? 'trio-dev-secret';

  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 5 });
  pool.on('error', () => {});
  let trio: SimulatedTrio | null = null;
  let core: SimulatedCore | null = null;
  try {
    trio = createSimulatedTrio({ databaseUrl: options.databaseUrl, serviceToken, signerSecret });
    const trioUrl = await trio.listen();
    core = createSimulatedCore({
      databaseUrl: options.databaseUrl,
      trioBaseUrl: trioUrl,
      trioServiceToken: serviceToken,
      signerSecret,
    });

    // 1. Merchant — fixed ID; on re-run the existing record is kept as-is.
    const existing = await pool.query(`SELECT 1 FROM core.merchants WHERE merchant_id = $1`, [
      AURORA_MERCHANT_ID,
    ]);
    if (existing.rowCount === 0) {
      await core.merchants.create({
        name: 'Aurora Experiences',
        commercial: AURORA_COMMERCIAL,
        merchant_id: AURORA_MERCHANT_ID,
      });
      log(`Created merchant Aurora Experiences (${AURORA_MERCHANT_ID}).`);
    } else {
      log(`Merchant Aurora Experiences already present — kept.`);
    }
    let merchant = await core.merchants.get(AURORA_MERCHANT_ID);
    if (!merchant.signing_key_ref) {
      await core.merchants.requestSigningKey(AURORA_MERCHANT_ID);
      merchant = await core.merchants.get(AURORA_MERCHANT_ID);
      log(`Custodied signing key requested: ${merchant.signing_key_ref}.`);
    }

    // 2. Aurora Club members — the Phase-0 static membership table (§5.3).
    for (const member of AURORA_MEMBERS) {
      await pool.query(
        `INSERT INTO core.aurora_club_members (member_ref, sub_hash, loyalty_tier, status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (member_ref) DO NOTHING`,
        [member.member_ref, member.sub_hash, member.loyalty_tier, member.status],
      );
    }
    log(`Seeded ${AURORA_MEMBERS.length} Aurora Club members (Member + Gold tiers, one revoked).`);

    // 3. Offers — draft with fixed IDs, then publish through the real path
    //    (the bounty offer's publish creates the COR via the trio simulator).
    let published = 0;
    let bountyCommitmentId: string | null = null;
    for (const fixture of AURORA_OFFERS) {
      const found = await core.repository.get(fixture.offer_id);
      if (!found) await core.offers.createDraft(fixture.draft, fixture.offer_id);
      const record = found ?? (await core.repository.get(fixture.offer_id))!;
      if (record.offer.status === 'draft') {
        const result = await core.publisher.publish(
          fixture.offer_id,
          fixture.bounty ? { bounty: fixture.bounty } : undefined,
        );
        published += 1;
        if (fixture.bounty) {
          bountyCommitmentId = result.commitment_id;
          log(
            `Published "${fixture.draft.title}" with a fixed CPA bounty of ` +
              `${formatPence(fixture.bounty.amount.amount)} — commitment ${result.commitment_id}.`,
          );
        } else {
          log(`Published "${fixture.draft.title}".`);
        }
      } else {
        if (fixture.bounty) bountyCommitmentId = record.current_commitment_id;
        log(`Offer "${fixture.draft.title}" already ${record.offer.status} — kept.`);
      }
    }

    log(
      `Aurora Experiences ready: ${AURORA_OFFERS.length} offers, ` +
        `take 20%, agent commission 60%, spa-day bounty ${formatPence(1200)}.`,
    );
    return {
      merchant_id: AURORA_MERCHANT_ID,
      members: AURORA_MEMBERS.length,
      offers_published: published,
      bounty_commitment_id: bountyCommitmentId,
    };
  } finally {
    if (core) await core.close();
    if (trio) await trio.close();
    await pool.end();
  }
};
