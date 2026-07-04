import { NextResponse, type NextRequest } from 'next/server';
import { offerFields } from '../offer-form';
import { getOffersStack } from '../../../../lib/platform';

export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await context.params;
  const form = await request.formData();
  try {
    await getOffersStack().service.update(id, offerFields(form));
    return NextResponse.redirect(new URL(`/offers/${id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(
      `Could not update the offer: ${error instanceof Error ? error.message : 'invalid input'}`,
      { status: 400 },
    );
  }
};
