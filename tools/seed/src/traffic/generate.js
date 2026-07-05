import { pence } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
/**
 * LEAD-4: synthetic/replayed traffic so B19 projections carry enough rows
 * to train on (architecture §3.4: the ML engine trains on ledger exhaust,
 * and ONLY ledger exhaust — so this generator writes EVENTS, never
 * projection rows; the projections are rebuilt from what it appends).
 *
 * Fully deterministic: a seeded PRNG and a caller-supplied base date — the
 * same inputs append byte-identical event bodies, so the training accept
 * can prove artefact determinism end to end.
 */
/** mulberry32 — tiny deterministic PRNG, plenty for traffic shaping. */
const mulberry32 = (seed) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const generateTraffic = async (pool, options) => {
    const random = mulberry32(options.seed ?? 42);
    const id = (prefix) => {
        let body = '';
        for (let i = 0; i < 26; i += 1)
            body += ULID_ALPHABET[Math.floor(random() * 32)];
        return `${prefix}_${body}`;
    };
    const merchants = options.merchants ?? 6;
    const days = options.days ?? 21;
    const mintsPerDay = options.mintsPerDay ?? 8;
    const base = Date.parse(`${options.baseDate}T00:00:00Z`);
    const REASONS = ['BUDGET_EXHAUSTED', 'QUOTE_EXPIRED', 'TOKEN_REPLAYED', 'TIER_INELIGIBLE'];
    let events = 0;
    for (let m = 0; m < merchants; m += 1) {
        const merchantId = id('mer');
        const commitmentId = id('com');
        const agents = Array.from({ length: 3 }, () => id('agt'));
        // each merchant has a personality: conversion propensity + rejection rate
        const propensity = 0.2 + random() * 0.6;
        const rejectionRate = 0.05 + random() * 0.25;
        const bounty = 500 + Math.floor(random() * 20) * 100;
        const commitment = {
            commitment_id: commitmentId,
            merchant_id: merchantId,
            offer_ref: id('off'),
            bounty: { type: 'fixed', amount: pence(bounty) },
            take_rate_bps: 2000,
            agent_commission_bps: 6000,
            terms: {
                attribution_window_s: 86400,
                eligible_identity_tiers: ['T1', 'T2', 'T3'],
                max_conversions: 100000,
                clawback_window_s: 2592000,
                valid_from: new Date(base - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
                valid_until: new Date(base + 90 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            },
            merchant_sig: 'fake-ed25519:synthetic-m',
            platform_sig: 'fake-ed25519:synthetic-p',
        };
        await appendEventInNewTx(pool, 'CommitmentCreated', { commitment });
        events += 1;
        for (let d = 0; d < days; d += 1) {
            const dayStart = base - (days - d) * 86400000;
            const at = (hourFraction) => new Date(dayStart + Math.floor(hourFraction * 86400000)).toISOString().replace(/\.\d{3}Z$/, 'Z');
            for (let k = 0; k < mintsPerDay; k += 1) {
                const jti = id('atk');
                const qid = id('qte');
                const aid = agents[Math.floor(random() * agents.length)];
                const t = (k + random()) / (mintsPerDay + 1);
                await appendEventInNewTx(pool, 'TokenMinted', {
                    claims: {
                        jti, cid: commitmentId, qid, aid,
                        tier: 'T3', sid: 'f'.repeat(64), apr: null,
                        iat: Math.floor((dayStart + t * 43200000) / 1000),
                        exp: Math.floor((dayStart + t * 43200000 + 600000) / 1000),
                    },
                });
                events += 1;
                const roll = random();
                if (roll < propensity) {
                    const claimId = id('clm');
                    const gross = 2000 + Math.floor(random() * 120) * 100;
                    await appendEventInNewTx(pool, 'ConversionClaimed', {
                        claim_id: claimId, merchant_id: merchantId, jti, qid, cid: commitmentId,
                        order_ref_hash: 'e'.repeat(64), gross_value: pence(gross), ts: at(t * 0.5 + 0.3),
                    });
                    await appendEventInNewTx(pool, 'ConversionVerified', {
                        claim_id: claimId, merchant_id: merchantId, jti, qid, cid: commitmentId,
                        gross_value: pence(gross), verified_at: at(t * 0.5 + 0.31),
                    });
                    events += 2;
                }
                else if (roll < propensity + rejectionRate) {
                    await appendEventInNewTx(pool, 'ConversionRejected', {
                        claim_id: id('clm'), merchant_id: merchantId, jti,
                        reason_code: REASONS[Math.floor(random() * REASONS.length)],
                        rejected_at: at(t * 0.5 + 0.35),
                    });
                    events += 1;
                }
            }
        }
    }
    return { events, merchants, days };
};
/** LEAD-4's adequacy audit: is the ledger exhaust thick enough to train on? */
export const auditExhaust = async (pool, minimumRows = 200) => {
    const { rows } = await pool.query('SELECT count(*) AS n FROM core.mint_vs_claim_by_merchant_day');
    const merchantDays = Number(rows[0]?.n ?? 0);
    return { merchantDays, verdict: merchantDays >= minimumRows ? 'adequate' : 'thin' };
};
//# sourceMappingURL=generate.js.map