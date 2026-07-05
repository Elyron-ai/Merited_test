import { SHOPIFY_TOKEN_ATTRIBUTE, poundsToPence, penceToPounds } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { commerceAdapterContractSuite } from './contract-suite.js';
import { FakeShopCommerceAdapter } from './fake-shop.js';
import { ShopifyCommerceAdapter } from './shopify.js';

/**
 * PH3-5 accept: "CommerceAdapter contract suite passes for both FakeShop
 * and Shopify implementations" — the same §5.8/§2.4 semantics behind the
 * same port, whatever the platform's native shape.
 */

commerceAdapterContractSuite('FakeShop (Grade B)', () => ({
  adapter: new FakeShopCommerceAdapter(),
  eventWith: (token) => ({
    event: 'order.confirmed',
    shop_domain: 'aurora.fakeshop.test',
    order: {
      number: 4242,
      placed_at: '2026-07-05T12:00:00Z',
      total: { amount_minor: 8450, currency_code: 'GBP' },
      attribution: { merited_token: token ?? null },
      lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
    },
  }),
  expectedGrossPence: 8450,
  basketMarker: 'sku_spa_day',
}));

commerceAdapterContractSuite('Shopify (Grade A)', () => ({
  adapter: new ShopifyCommerceAdapter(),
  eventWith: (token) => ({
    shop_domain: 'aurora-experiences.myshopify.com',
    order: {
      id: 987654321,
      order_number: 1042,
      total_price: '84.50',
      currency: 'GBP',
      processed_at: '2026-07-05T13:05:00+01:00', // offset form — Shopify's habit
      note_attributes: token ? [{ name: SHOPIFY_TOKEN_ATTRIBUTE, value: token }] : [],
      line_items: [{ sku: 'sku_spa_day', quantity: 1, price: '84.50' }],
    },
  }),
  expectedGrossPence: 8450,
  basketMarker: 'sku_spa_day',
}));

describe('Shopify normalisation specifics', () => {
  it('decimal-string totals convert by string maths — "84.50" → 8450 pence', () => {
    expect(poundsToPence('84.50')).toBe(8450);
    expect(poundsToPence('0.05')).toBe(5);
    expect(poundsToPence('120.00')).toBe(12000);
    expect(() => poundsToPence('84.5')).toThrow(); // strict 2dp only
    expect(() => poundsToPence('84')).toThrow();
    expect(penceToPounds(8450)).toBe('84.50');
    expect(penceToPounds(5)).toBe('0.05');
    expect(poundsToPence(penceToPounds(1))).toBe(1);
  });

  it('a token under any OTHER note attribute is ignored (one designated field)', () => {
    const adapter = new ShopifyCommerceAdapter();
    const order = adapter.normaliseOrderEvent({
      shop_domain: 'aurora-experiences.myshopify.com',
      order: {
        id: 987654322,
        order_number: 1043,
        total_price: '84.50',
        currency: 'GBP',
        processed_at: '2026-07-05T12:05:00Z',
        note_attributes: [
          { name: 'merited_notes', value: 'v4.public.smuggled-token' },
          { name: 'gift_message', value: 'v4.public.smuggled-token' },
        ],
        line_items: [{ sku: 'sku_spa_day', quantity: 1, price: '84.50' }],
      },
    });
    expect(order.token).toBeUndefined();
  });

  it('offset timestamps normalise to UTC ISO form', () => {
    const adapter = new ShopifyCommerceAdapter();
    const order = adapter.normaliseOrderEvent({
      shop_domain: 'aurora-experiences.myshopify.com',
      order: {
        id: 987654323,
        order_number: 1044,
        total_price: '18.00',
        currency: 'GBP',
        processed_at: '2026-07-05T13:05:00+01:00',
        note_attributes: [],
        line_items: [{ sku: 'sku_yoga_class', quantity: 1, price: '18.00' }],
      },
    });
    expect(order.ts).toBe('2026-07-05T12:05:00.000Z');
  });
});
