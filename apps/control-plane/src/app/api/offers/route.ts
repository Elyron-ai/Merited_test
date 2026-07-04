import { NextResponse, type NextRequest } from 'next/server';
import { offerFields } from './offer-form';
import { getOffersStack } from '../../../lib/platform';

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const form = await request.formData();
  try {
    const offer = await getOffersStack().service.createDraft({
      merchant_id: String(form.get('merchant_id') ?? '') as `mer_${string}`,
      ...offerFields(form),
    });
    return NextResponse.redirect(new URL(`/offers/${offer.offer_id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(
      `Could not create the offer: ${error instanceof Error ? error.message : 'invalid input'}`,
      { status: 400 },
    );
  }
};
