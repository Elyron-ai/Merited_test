import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COMMITMENT_FIXTURE, FIXTURE_IDS } from './fixtures.js';
import { EVENT_FIXTURES } from './events/fixtures.js';
import { ControlPlaneSession, ControlPlaneUser } from './control-plane.js';
import { Merchant } from './merchant.js';
import {
  FakeShopOrderWebhook,
  IDEMPOTENCY_KEY_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TIMESTAMP_MAX_SKEW_S,
} from './webhooks.js';

const gbp = (amount: number) => ({ amount, currency: 'GBP_pence' as const });

describe('merchant-side contracts (MER-1 accept)', () => {
  it('all new schemas round-trip through Zod', () => {
    const fixtures: Array<[{ parse: (v: unknown) => unknown }, unknown]> = [
      [
        Merchant,
        {
          merchant_id: FIXTURE_IDS.merchant,
          name: 'Aurora Experiences',
          slug: 'aurora-experiences',
          status: 'active',
          commercial: {
            take_rate_bps: 2000,
            agent_commission_bps: 6000,
            attribution_window_s: 86400,
            clawback_window_s: 2592000,
            budgets: { per_offer_default: gbp(60000) },
          },
          signing_key_ref: 'merchant/mer_01J0000000000000000000000A',
          created_at: '2026-07-04T12:00:00Z',
        },
      ],
      [
        FakeShopOrderWebhook,
        {
          event: 'order.confirmed',
          shop_domain: 'aurora.fakeshop.test',
          order: {
            number: 10042,
            placed_at: '2026-07-04T12:34:56Z',
            total: { amount_minor: 8450, currency_code: 'GBP' },
            attribution: { merited_token: 'v4.public.fake.abc.def' },
            lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
          },
        },
      ],
      [
        ControlPlaneUser,
        { user_id: 'cpu-1', email: 'ops@merited.test', totp_enabled: true, created_at: '2026-07-04T12:00:00Z' },
      ],
      [
        ControlPlaneSession,
        { session_id: 'sess-1', user_id: 'cpu-1', expires_at: '2026-07-05T12:00:00Z' },
      ],
    ];
    for (const [schema, fixture] of fixtures) {
      const parsed = schema.parse(fixture);
      expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
    expect(WEBHOOK_SIGNATURE_HEADER).toBe('x-merited-signature');
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe('x-merited-timestamp');
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
    expect(WEBHOOK_TIMESTAMP_MAX_SKEW_S).toBe(300);
  });

  it('the FakeShop native shape is genuinely different from OrderConfirmed (normaliser is real work)', () => {
    const native = FakeShopOrderWebhook.parse({
      event: 'order.confirmed',
      shop_domain: 'aurora.fakeshop.test',
      order: {
        number: 1,
        placed_at: '2026-07-04T12:00:00Z',
        total: { amount_minor: 100, currency_code: 'GBP' },
        attribution: { merited_token: null },
        lines: [{ sku: 's', qty: 1, unit_price_minor: 100 }],
      },
    });
    // no shared field names with OrderConfirmed's flat shape
    expect('order_ref_hash' in native.order).toBe(false);
    expect('gross_value' in native.order).toBe(false);
    expect(native.order.lines.length).toBeGreaterThan(0); // basket exists here, dropped at MER-4
  });

  it('under-reporting denominator: TokenMinted and QuoteIssued join to merchant_id via the COR', () => {
    // The B19 mint-vs-claim monitor needs mints per merchant. Both event
    // bodies must reach merchant_id through their commitment reference.
    const merchantByCommitment = new Map([[COMMITMENT_FIXTURE.commitment_id, COMMITMENT_FIXTURE.merchant_id]]);

    const minted = (EVENT_FIXTURES.TokenMinted as { data: { claims: { cid: string } } }).data;
    expect(merchantByCommitment.get(minted.claims.cid as never)).toBe(FIXTURE_IDS.merchant);

    const quoted = (EVENT_FIXTURES.QuoteIssued as { data: { commitment_id: string } }).data;
    expect(merchantByCommitment.get(quoted.commitment_id as never)).toBe(FIXTURE_IDS.merchant);
  });

  it('no merchant-side object types exist outside packages/contracts (grep lint)', () => {
    const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const roots = ['apps', 'packages', 'tools']
      .flatMap((dir) =>
        readdirSync(path.join(repoRoot, dir), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => path.join(repoRoot, dir, e.name, 'src')),
      )
      .filter((p) => !p.includes(`packages${path.sep}contracts`));

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          const source = readFileSync(full, 'utf8');
          // definitions only — type-only IMPORTS of the contracts shape are the point
          if (
            /(?:^|\n)\s*(?:export\s+)?(?:interface\s+Merchant\b|type\s+Merchant\s*=|const\s+Merchant\s*=\s*z\.object)/.test(
              source,
            )
          ) {
            offenders.push(path.relative(repoRoot, full));
          }
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
