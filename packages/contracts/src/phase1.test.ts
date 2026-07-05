import { describe, expect, it } from 'vitest';
import {
  AGENT_SIGNATURE_MAX_SKEW_S,
  agentCanonicalString,
  AgentSignatureHeaders,
  CheckEligibilityInput,
  CheckEligibilityOutput,
  EligibilityRule,
  GetOfferInput,
  HeadPublication,
  HostedLinkStartRequest,
  HostedLinkStartResponse,
  HostedLinkVerifyRequest,
  LinkCallbackParams,
  LinkResult,
  LinkStartRequest,
  LinkStartResponse,
  Mandate,
  MerchantExclusion,
  NotificationPayload,
  pence,
  PushSubscription,
  SearchOffersInput,
  SearchOffersOutput,
} from './index.js';
import { defineEnv, EnvValidationError } from './env.js';
import { phase1EnvShape } from './env-shapes.js';

const roundTrip = <T>(schema: { parse(d: unknown): T }, value: T) => {
  expect(schema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
};

describe('PH1-1 — contracts delta (accept: every new schema round-trips)', () => {
  it('eligibility rules round-trip — all three variants (PH1-3 extension)', () => {
    const exclusion: MerchantExclusion = {
      rule_id: 'elr_1',
      type: 'merchant_agent_exclusion',
      merchant_id: 'mer_00000000000000000000000001',
      agent_id: 'agt_00000000000000000000000001',
      note: 'abusive traffic',
      created_at: '2026-07-05T00:00:00Z',
    };
    roundTrip(MerchantExclusion, exclusion);
    roundTrip(EligibilityRule, exclusion);
    roundTrip(EligibilityRule, {
      rule_id: 'elr_2',
      type: 'merchant_tier_exclusion',
      merchant_id: 'mer_00000000000000000000000001',
      tier: 'T3',
      segment: null,
      note: null,
      created_at: '2026-07-05T00:00:00Z',
    });
    roundTrip(EligibilityRule, {
      rule_id: 'elr_3',
      type: 'merchant_sku_exclusion',
      merchant_id: 'mer_00000000000000000000000001',
      sku_ref: 'sku_spa_day',
      note: null,
      created_at: '2026-07-05T00:00:00Z',
    });
  });

  it('MCP tool I/O round-trips; check_eligibility output carries no quote or token field', () => {
    roundTrip(SearchOffersInput, { text: 'spa day', sub_hash: 'abc' });
    roundTrip(GetOfferInput, { offer_id: 'off_00000000000000000000000001' });
    roundTrip(CheckEligibilityInput, {
      offer_ids: ['off_00000000000000000000000001'],
      member_ref: 'am_1',
    });
    const output: CheckEligibilityOutput = {
      results: [
        { offer_id: 'off_00000000000000000000000001', eligible: true },
        { offer_id: 'off_00000000000000000000000002', eligible: false, reason: 'MERCHANT_EXCLUDED' },
      ],
    };
    roundTrip(CheckEligibilityOutput, output);
    // SYN-26: verdicts only — the schema has no home for a quote or token
    expect(Object.keys(CheckEligibilityOutput.shape)).toEqual(['results']);
    expect(JSON.stringify(output)).not.toMatch(/token|quote_id/);
    // search output is the B9 read shape (quotes ARE tokenised there)
    expect(SearchOffersOutput.parse({ quotes: [] })).toEqual({ quotes: [] });
  });

  it('agent request-signing: headers validate; the canonical string is exact and stable', () => {
    AgentSignatureHeaders.parse({
      'x-merited-agent-id': 'agt_00000000000000000000000001',
      'x-merited-timestamp': '1783300000',
      'x-merited-nonce': 'n0nce-16-chars-min',
      'x-merited-signature': 'sig-bytes',
    });
    expect(AGENT_SIGNATURE_MAX_SKEW_S).toBe(300); // SYN-24
    const canonical = agentCanonicalString({
      method: 'get',
      pathWithQuery: '/v1/offers?sku=sku_spa_day',
      bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      timestamp: '1783300000',
      nonce: 'n0nce-16-chars-min',
    });
    expect(canonical).toBe(
      'GET\n/v1/offers?sku=sku_spa_day\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n1783300000\nn0nce-16-chars-min',
    );
    // a short nonce refuses
    expect(() =>
      AgentSignatureHeaders.parse({
        'x-merited-agent-id': 'agt_00000000000000000000000001',
        'x-merited-timestamp': '1783300000',
        'x-merited-nonce': 'short',
        'x-merited-signature': 'sig',
      }),
    ).toThrow();
  });

  it('linking DTOs round-trip and never carry token fields', () => {
    roundTrip(LinkStartRequest, {
      merchant_id: 'mer_00000000000000000000000001',
      programme: 'aurora-club',
    });
    roundTrip(LinkStartResponse, { authorize_url: 'https://idp.test/authorize?x=1', state: 's123' });
    roundTrip(LinkCallbackParams, { state: 's123', code: 'authcode' });
    roundTrip(HostedLinkStartRequest, {
      merchant_id: 'mer_00000000000000000000000001',
      programme: 'aurora-club',
      member_ref: 'am_seed_ada',
      email: 'ada@example.test',
    });
    roundTrip(HostedLinkStartResponse, { attempt_id: 'att_1', verification_sent: true });
    roundTrip(HostedLinkVerifyRequest, { attempt_id: 'att_1', token: 'emailed-token' });
    for (const schema of [LinkStartResponse, LinkResult]) {
      expect(JSON.stringify(Object.keys((schema as { shape: object }).shape))).not.toMatch(
        /refresh|access/,
      );
    }
  });

  it('push shapes round-trip with integer-pence money', () => {
    roundTrip(PushSubscription, {
      endpoint: 'https://push.example/ep',
      keys: { p256dh: 'k1', auth: 'k2' },
    });
    roundTrip(NotificationPayload, {
      title: 'Approve your spa day',
      body: 'Aurora Experiences — £84.50, quote expires soon.',
      quote: {
        quote_id: 'qte_00000000000000000000000001',
        offer_title: 'Full spa day',
        merchant_name: 'Aurora Experiences',
        final: pence(8450),
        expires_at: '2026-07-05T12:00:00Z',
      },
      deep_link: '/approvals/qte_00000000000000000000000001',
    });
    expect(() =>
      NotificationPayload.shape.quote.shape.final.parse({ amount: 84.5, currency: 'GBP_pence' }),
    ).toThrow();
  });

  it('HeadPublication pins date, seq and a 64-hex head', () => {
    roundTrip(HeadPublication, { date: '2026-07-05', seq: 20, head_hash: 'a'.repeat(64) });
    expect(() =>
      HeadPublication.parse({ date: '05/07/2026', seq: 20, head_hash: 'a'.repeat(64) }),
    ).toThrow();
    expect(() =>
      HeadPublication.parse({ date: '2026-07-05', seq: 20, head_hash: 'Z'.repeat(64) }),
    ).toThrow();
  });

  it('Mandate parses with pre_authorised_up_to (SYN-15 — verify, not add)', () => {
    const mandate = Mandate.parse({
      mandate_id: 'mnd_00000000000000000000000001',
      consumer_ref: 'usr_00000000000000000000000001',
      agent_id: 'agt_00000000000000000000000001',
      scopes: ['offers:read', 'checkout:execute'],
      limits: { per_txn: pence(10000), per_month: pence(50000), categories: [] },
      merchants: ['*'],
      data_sharing: { email: false, purchase_history: false, loyalty_ids: false },
      pre_authorised_up_to: pence(5000),
      status: 'active',
      exp: '2027-01-01T00:00:00Z',
      attestation: 'att',
    });
    expect(mandate.pre_authorised_up_to.amount).toBe(5000);
  });

  it('the env loader fails fast on missing Phase-1 vars — the complete list, one throw', () => {
    let caught: unknown;
    try {
      defineEnv(phase1EnvShape, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EnvValidationError);
    const problems = (caught as EnvValidationError).problems.join('\n');
    for (const key of [
      'MERITED_VAPID_PUBLIC_KEY',
      'MERITED_VAPID_PRIVATE_KEY',
      'MERITED_VAPID_SUBJECT',
      'MERITED_RESEND_API_KEY',
      'MERITED_RESEND_FROM',
      'MERITED_IDP_ISSUER',
      'MERITED_IDP_CLIENT_ID',
      'MERITED_IDP_CLIENT_SECRET',
      'MERITED_IDP_REDIRECT_URL',
      'MERITED_HEADS_BUCKET',
    ]) {
      expect(problems).toContain(`${key}: missing`);
    }
    // stub CREDS are fine; malformed values are not
    const env = defineEnv(phase1EnvShape, {
      MERITED_VAPID_PUBLIC_KEY: 'stub-vapid-public',
      MERITED_VAPID_PRIVATE_KEY: 'stub-vapid-private',
      MERITED_VAPID_SUBJECT: 'mailto:dev@merited.test',
      MERITED_RESEND_API_KEY: 'stub-resend-key',
      MERITED_RESEND_FROM: 'noreply@merited.test',
      MERITED_IDP_ISSUER: 'http://localhost:4600',
      MERITED_IDP_CLIENT_ID: 'merited-wallet',
      MERITED_IDP_CLIENT_SECRET: 'stub-idp-secret',
      MERITED_IDP_REDIRECT_URL: 'http://localhost:4700/v1/links/callback',
      MERITED_HEADS_BUCKET: 'file://./out/heads',
    });
    expect(env.MERITED_RESEND_API_KEY).toBe('stub-resend-key');
    expect(() =>
      defineEnv(phase1EnvShape, { MERITED_VAPID_SUBJECT: 'not-a-mailto' } as Record<string, string>),
    ).toThrow(EnvValidationError);
  });
});
