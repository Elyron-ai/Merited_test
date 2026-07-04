import { NextResponse, type NextRequest } from 'next/server';
import { getMerchantsService, intField } from '../../../lib/platform';

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const form = await request.formData();
  try {
    const budgetRaw = String(form.get('per_offer_default') ?? '').trim();
    const merchant = await getMerchantsService().create({
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
    return NextResponse.redirect(new URL(`/merchants/${merchant.merchant_id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(
      `Could not create the merchant: ${error instanceof Error ? error.message : 'invalid input'}`,
      { status: 400 },
    );
  }
};
