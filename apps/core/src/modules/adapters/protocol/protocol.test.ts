import {
  ACP_TOKEN_KEY,
  UCP_EXTENSION_KEY,
  type AcpOrderWebhook,
  type UcpCheckoutCompleted,
} from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { protocolConformanceSuite, fixtureQuote, type ConformanceCase } from './harness.js';
import { AcpStubAdapter, UcpStubAdapter } from './stubs.js';

/**
 * PH3-2 accept: "harness runs both directions against stubs; token survives
 * the round-trip in each protocol's designated field." The recorded-fixture
 * builders below ARE the protocol fixtures — PH3-3/PH3-4 re-run this exact
 * suite against the real adapters.
 */

const ucpCase = (): ConformanceCase<ReturnType<UcpStubAdapter['offerOut']>, UcpCheckoutCompleted> => ({
  adapter: new UcpStubAdapter(),
  tokenFieldOf: (out) =>
    (out.extensions[UCP_EXTENSION_KEY] as { token?: string } | undefined)?.token,
  callbackWith: (token, orderRefHash, grossPence) => ({
    type: 'ucp.checkout.completed',
    checkout_id: 'ucp_chk_fixture_0001',
    order: {
      order_ref: orderRefHash, // hashed again by the adapter — a stable ref
      total: { amount_minor: grossPence, currency: 'GBP' },
      completed_at: '2026-07-05T12:05:00Z',
      line_items: [{ sku: 'sku_spa_day', quantity: 1 }],
      extensions: token
        ? { [UCP_EXTENSION_KEY]: { token, quote_id: 'qte_fixture', expires_at: '2026-07-05T12:10:00Z' } }
        : {},
    },
  }),
  callbackWithSmuggledToken: (token, orderRefHash, grossPence) => ({
    type: 'ucp.checkout.completed',
    checkout_id: 'ucp_chk_fixture_0002',
    order: {
      order_ref: orderRefHash,
      total: { amount_minor: grossPence, currency: 'GBP' },
      completed_at: '2026-07-05T12:05:00Z',
      line_items: [{ sku: `sku_notes_${token}`, quantity: 1 }], // wrong place
      extensions: { 'com.other.vendor': { token } }, // wrong namespace
    },
  }),
  serialise: (payload) => JSON.stringify(payload),
});

const acpCase = (): ConformanceCase<ReturnType<AcpStubAdapter['offerOut']>, AcpOrderWebhook> => ({
  adapter: new AcpStubAdapter(),
  tokenFieldOf: (out) => out.metadata[ACP_TOKEN_KEY],
  callbackWith: (token, orderRefHash, grossPence) => ({
    object: 'acp.order',
    id: 'acp_ord_fixture_0001',
    order_ref: orderRefHash,
    amount_minor: grossPence,
    currency: 'gbp',
    created_at: '2026-07-05T12:05:00Z',
    line_items: [{ sku: 'sku_spa_day', quantity: 1 }],
    metadata: token ? { [ACP_TOKEN_KEY]: token } : {},
  }),
  callbackWithSmuggledToken: (token, orderRefHash, grossPence) => ({
    object: 'acp.order',
    id: 'acp_ord_fixture_0002',
    order_ref: orderRefHash,
    amount_minor: grossPence,
    currency: 'gbp',
    created_at: '2026-07-05T12:05:00Z',
    line_items: [{ sku: 'sku_spa_day', quantity: 1 }],
    metadata: { 'someone_elses_key': token, 'merited:notes': token }, // NOT merited:token
  }),
  serialise: (payload) => JSON.stringify(payload),
});

protocolConformanceSuite('UCP (contract stub)', ucpCase);
protocolConformanceSuite('ACP (contract stub)', acpCase);

describe('PH3-2 mapping-table extras', () => {
  it('an anonymous (token: null) quote renders offer-out with NO merited fields at all', () => {
    const { quote, offer } = fixtureQuote();
    const anonymous = { ...quote, token: null, agent_id: null };
    const ucp = new UcpStubAdapter().offerOut({ quote: anonymous, offer });
    expect(JSON.stringify(ucp)).not.toContain('merited');
    expect(ucp.extensions[UCP_EXTENSION_KEY]).toBeUndefined();
    const acp = new AcpStubAdapter().offerOut({ quote: anonymous, offer });
    expect(acp.metadata[ACP_TOKEN_KEY]).toBeUndefined();
    expect(Object.keys(acp.metadata)).toHaveLength(0);
  });

  it('the mapping table document exists and names both designated fields', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(
      new URL('../../../../../../docs/spec/protocol-token-transport.md', import.meta.url),
      'utf-8',
    );
    expect(doc).toContain('com.merited.attribution');
    expect(doc).toContain('merited:token');
    expect(doc).toContain('no token, no bounty');
  });
});
