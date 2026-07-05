import { describe, expect, it } from 'vitest';
import { EVENT_FIXTURES } from './fixtures.js';
import { MERITED_EVENT_BODIES, MERITED_EVENT_NAMES } from './index.js';

describe('event catalogue bodies (FND-7 accept)', () => {
  it('defines exactly the 21 names (§3 nineteen + CommitmentEnded SYN-3 + OfferSuppressed SYN-41)', () => {
    expect(MERITED_EVENT_NAMES).toHaveLength(21);
    expect([...MERITED_EVENT_NAMES].sort()).toEqual(
      [
        'CommitmentCreated',
        'CommitmentEnded',
        'QuoteIssued',
        'TokenMinted',
        'ApprovalGranted',
        'ApprovalDeclined',
        'ConversionClaimed',
        'ConversionVerified',
        'ConversionRejected',
        'ConversionReversed',
        'LedgerEntryPosted',
        'SettlementNetted',
        'MandateGranted',
        'MandateRevoked',
        'AccountLinked',
        'AccountUnlinked',
        'NotificationSent',
        'OfferPublished',
        'OfferSuppressed',
        'AgentRegistered',
        'ErrandStateChanged',
      ].sort(),
    );
  });

  it('every body validates its fixture and round-trips through JSON', () => {
    for (const name of MERITED_EVENT_NAMES) {
      const schema = MERITED_EVENT_BODIES[name];
      const fixture = EVENT_FIXTURES[name];
      const parsed = schema.parse(fixture);
      expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
      expect(parsed.type).toBe(name);
      expect(parsed.v).toBe(1);
    }
  });

  it('ConversionRejected requires a reason_code from the 12-code enum', () => {
    const schema = MERITED_EVENT_BODIES.ConversionRejected;
    const good = EVENT_FIXTURES.ConversionRejected as { data: Record<string, unknown> };
    expect(
      schema.safeParse({ ...good, data: { ...good.data, reason_code: 'NOT_A_CODE' } }).success,
    ).toBe(false);
    const { reason_code: _dropped, ...withoutReason } = good.data;
    expect(schema.safeParse({ ...good, data: withoutReason }).success).toBe(false);
  });

  it('LedgerEntryPosted rejects an unbalanced entry set', () => {
    const schema = MERITED_EVENT_BODIES.LedgerEntryPosted;
    const good = EVENT_FIXTURES.LedgerEntryPosted as {
      data: { lines: Array<{ amount: { amount: number } }> };
    };
    const bad = JSON.parse(JSON.stringify(good)) as typeof good;
    bad.data.lines[1]!.amount.amount = 999;
    expect(schema.safeParse(bad).success).toBe(false);
    expect(schema.safeParse(good).success).toBe(true);
  });

  it('wrong version and wrong type literal are rejected', () => {
    const good = EVENT_FIXTURES.OfferPublished as Record<string, unknown>;
    expect(MERITED_EVENT_BODIES.OfferPublished.safeParse({ ...good, v: 2 }).success).toBe(false);
    expect(
      MERITED_EVENT_BODIES.OfferPublished.safeParse({ ...good, type: 'AgentRegistered' }).success,
    ).toBe(false);
  });
});
