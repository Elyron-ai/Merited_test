import { NextResponse, type NextRequest } from 'next/server';
import { bountyFrom } from '../offers/bounty-form';
import { offerFields } from '../offers/offer-form';
import { getMerchantsService, getOffersStack, intField } from '../../../lib/platform';
import { allowSignup, clientIp, signupEnabled } from '../../../lib/rate-limit';

/**
 * Self-serve merchant onboarding (PH3-6, §11's Phase-3 unlock): ONE public
 * POST takes a merchant from nothing to live-in-the-read-path with ZERO
 * operator action — merchant record → custodied keypair issued via the trio
 * → integration credential (Shopify orders/paid or Grade-B webhook; same
 * secret store, different intake endpoint) → first offer authored and
 * published (COR countersigned by the trio). The response is the merchant's
 * complete integration sheet; the webhook secret appears EXACTLY once, here.
 *
 * §8: limits on every public surface. Per-IP AND a global ceiling (see
 * lib/rate-limit) so a spoofed X-Forwarded-For flood cannot drive unbounded
 * merchant/keypair/offer creation.
 */
export const POST = async (request: NextRequest): Promise<NextResponse> => {
  if (!signupEnabled()) {
    return NextResponse.json({ error: { code: 'SIGNUP_DISABLED' } }, { status: 403 });
  }
  const verdict = await allowSignup(clientIp(request.headers));
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED' } },
      { status: 429, headers: { 'retry-after': String(verdict.retryAfterS) } },
    );
  }

  const form = await request.formData();
  try {
    const integration = String(form.get('integration') ?? '').trim();
    if (integration !== 'shopify' && integration !== 'grade_b') {
      throw new Error("integration must be 'shopify' or 'grade_b'");
    }
    const bounty = bountyFrom(form);
    if (!bounty) throw new Error('a launch bounty is required (bounty_type)');

    const merchants = getMerchantsService();
    const budgetRaw = String(form.get('per_offer_default') ?? '').trim();

    // 1 · merchant record, commercial config from the form (integers only)
    const merchant = await merchants.create({
      name: String(form.get('name') ?? '').trim(),
      commercial: {
        take_rate_bps: intField(form, 'take_rate_bps'),
        agent_commission_bps: intField(form, 'agent_commission_bps'),
        attribution_window_s: intField(form, 'attribution_window_s'),
        clawback_window_s: intField(form, 'clawback_window_s'),
        budgets: {
          per_offer_default: budgetRaw
            ? { amount: intField(form, 'per_offer_default'), currency: 'GBP_pence' }
            : null,
        },
      },
    });

    // 2 · custodied signing keypair issued via the trio (PH1-24 path) —
    // claims cannot form without it, so onboarding is not done until it is
    await merchants.requestSigningKey(merchant.merchant_id);

    // 3 · integration credential — the endpoint the merchant (or their
    // Shopify install) will deliver order events to
    const issued = await merchants.issueWebhookSecret(merchant.merchant_id);
    const intake =
      integration === 'shopify'
        ? {
            endpoint: `/v1/merchants/${merchant.slug}/shopify/orders-paid`,
            scheme: 'shopify-native HMAC (base64, x-shopify-hmac-sha256)',
            note: `register the orders/paid subscription at install; the checkout writes the merited_token cart attribute`,
          }
        : {
            endpoint: `/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
            scheme: 'merited HMAC (hex, x-merited-signature over ts.body)',
            note: 'sign every delivery; verification is on in every environment',
          };

    // 4 · first offer authored and published — the COR countersign is the
    // publisher's trio call; after this the offer is LIVE in the read path
    const stack = getOffersStack();
    const draft = await stack.service.createDraft({
      merchant_id: merchant.merchant_id,
      ...offerFields(form),
    });
    const published = await stack.publisher.publish(draft.offer_id, { bounty });

    return NextResponse.json(
      {
        merchant: { merchant_id: merchant.merchant_id, slug: merchant.slug, name: merchant.name },
        signing_key: 'issued',
        integration: { selected: integration, ...intake, webhook_secret: issued.secret },
        offer: {
          offer_id: published.offer_id,
          commitment_id: published.commitment_id,
          status: 'live',
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: { message: error instanceof Error ? error.message : 'invalid input' } },
      { status: 400 },
    );
  }
};
