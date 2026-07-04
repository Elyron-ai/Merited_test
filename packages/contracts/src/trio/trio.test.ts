import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { COMMITMENT_FIXTURE, FIXTURE_IDS, TOKEN_CLAIMS_FIXTURE } from '../fixtures.js';
import { REJECTION_REASON_CODES } from '../reasons.js';
import {
  Balance,
  CommitmentCreateResponse,
  CommitmentDraft,
  CommitmentEndRequest,
  CommitmentEndResponse,
  CommitmentStatus,
  EntrySet,
  MintRequest,
  MintResponse,
  NettingRunResult,
  Position,
  ReverseRequest,
  ReverseResponse,
  Statement,
  VerifyResponse,
} from './index.js';

const ids = FIXTURE_IDS;
const gbp = (amount: number) => ({ amount, currency: 'GBP_pence' as const });

const DRAFT: CommitmentDraft = {
  merchant_id: ids.merchant,
  offer_ref: ids.offer,
  bounty: { type: 'fixed', amount: gbp(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: COMMITMENT_FIXTURE.terms,
  budget: gbp(600000),
};

const MINT_REQ: MintRequest = {
  cid: ids.commitment,
  qid: ids.quote,
  aid: ids.agent,
  tier: 'T3',
  session_nonce: 'nonce-1',
  quote: { expires_at: '2026-07-04T10:05:00Z', mandate_ref: null },
};

const ENTRIES: EntrySet = {
  entry_set_id: 'set_1',
  claim_id: ids.claim,
  lines: [
    { account: `merchant_payable:${ids.merchant}`, side: 'dr', amount: gbp(1200) },
    { account: `agent_receivable:${ids.agent}`, side: 'cr', amount: gbp(720) },
    { account: 'platform_revenue', side: 'cr', amount: gbp(240) },
    { account: `reserve:${ids.merchant}`, side: 'cr', amount: gbp(240) },
  ],
};

const GOLDENS: Array<[string, z.ZodTypeAny, unknown]> = [
  ['CommitmentDraft', CommitmentDraft, DRAFT],
  ['CommitmentCreateResponse', CommitmentCreateResponse, { commitment: COMMITMENT_FIXTURE }],
  ['CommitmentEndRequest', CommitmentEndRequest, { reason: 'bounty repriced' }],
  [
    'CommitmentEndResponse',
    CommitmentEndResponse,
    { commitment_id: ids.commitment, ended_at: '2026-07-04T10:03:00Z' },
  ],
  [
    'CommitmentStatus',
    CommitmentStatus,
    {
      commitment_id: ids.commitment,
      status: 'live',
      conversions_used: 3,
      max_conversions: 500,
      budget_remaining: gbp(596400),
    },
  ],
  ['MintRequest (walletless)', MintRequest, MINT_REQ],
  [
    'MintRequest (wallet re-mint)',
    MintRequest,
    { ...MINT_REQ, apr: ids.approval, quote: { expires_at: '2026-07-04T10:05:00Z', mandate_ref: ids.mandate } },
  ],
  ['MintResponse', MintResponse, { token: 'v4.public.fake.x', claims: TOKEN_CLAIMS_FIXTURE }],
  ['EntrySet', EntrySet, ENTRIES],
  ['VerifyResponse (verified)', VerifyResponse, { verdict: 'verified', entries_preview: ENTRIES }],
  [
    'VerifyResponse (rejected)',
    VerifyResponse,
    { verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' },
  ],
  [
    'ReverseRequest',
    ReverseRequest,
    { claim_id: ids.claim, merchant_id: ids.merchant, merchant_sig: 'fake-ed25519:sig' },
  ],
  [
    'ReverseResponse (rejected)',
    ReverseResponse,
    { verdict: 'rejected', reason_code: 'WINDOW_EXPIRED' },
  ],
  ['Balance', Balance, { direction: 'payable', amount: gbp(1200) }],
  ['Position', Position, { party: ids.merchant, direction: 'payable', amount: gbp(1200) }],
  [
    'NettingRunResult',
    NettingRunResult,
    {
      netting_run_id: 'net_1',
      period: '2026-W27',
      positions: [{ party: ids.merchant, direction: 'payable', amount: gbp(1200) }],
    },
  ],
  [
    'Statement',
    Statement,
    {
      party: ids.merchant,
      period: '2026-W27',
      opening: { direction: 'payable', amount: gbp(0) },
      lines: [{ seq: 1, description: 'Conversion clm fixture', side: 'dr', amount: gbp(1200) }],
      closing: { direction: 'payable', amount: gbp(1200) },
    },
  ],
];

describe('trio wire contracts (TRIO-1 accept)', () => {
  it.each(GOLDENS)('%s round-trips through Zod', (_name, schema, fixture) => {
    const parsed = schema.parse(fixture);
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('VerifyResponse rejected accepts every §3 reason code and nothing else (exhaustiveness)', () => {
    for (const code of REJECTION_REASON_CODES) {
      expect(VerifyResponse.safeParse({ verdict: 'rejected', reason_code: code }).success).toBe(
        true,
      );
    }
    expect(
      VerifyResponse.safeParse({ verdict: 'rejected', reason_code: 'TOKEN_ABSENT' }).success,
    ).toBe(false);
    expect(VerifyResponse.safeParse({ verdict: 'rejected' }).success).toBe(false);
    expect(VerifyResponse.safeParse({ verdict: 'verified' }).success).toBe(false); // preview required
  });

  it('no float crosses the wire: every Money field rejects non-integers', () => {
    expect(
      CommitmentDraft.safeParse({ ...DRAFT, budget: { amount: 12.5, currency: 'GBP_pence' } })
        .success,
    ).toBe(false);
    expect(
      EntrySet.safeParse({
        ...ENTRIES,
        lines: [
          { account: 'a', side: 'dr', amount: { amount: 0.5, currency: 'GBP_pence' } },
          { account: 'b', side: 'cr', amount: { amount: 0.5, currency: 'GBP_pence' } },
        ],
      }).success,
    ).toBe(false);
    expect(CommitmentDraft.safeParse({ ...DRAFT, take_rate_bps: 20.5 }).success).toBe(false);
  });

  it('EntrySet rejects unbalanced sets (Σdr must equal Σcr)', () => {
    const bad = {
      ...ENTRIES,
      lines: ENTRIES.lines.map((line, i) =>
        i === 1 ? { ...line, amount: gbp(999) } : line,
      ),
    };
    expect(EntrySet.safeParse(bad).success).toBe(false);
  });

  it('MintRequest requires the SYN-8 quote snapshot and a non-empty session nonce', () => {
    const { quote: _quote, ...withoutQuote } = MINT_REQ;
    expect(MintRequest.safeParse(withoutQuote).success).toBe(false);
    expect(MintRequest.safeParse({ ...MINT_REQ, session_nonce: '' }).success).toBe(false);
  });
});
