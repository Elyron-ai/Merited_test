import { NextResponse, type NextRequest } from 'next/server';
import { bountyFrom } from '../../bounty-form';
import { getOffersStack } from '../../../../../lib/platform';

export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await context.params;
  const form = await request.formData();
  try {
    const bounty = bountyFrom(form);
    await getOffersStack().publisher.publish(id, bounty ? { bounty } : undefined);
    return NextResponse.redirect(new URL(`/offers/${id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(
      `Could not publish: ${error instanceof Error ? error.message : 'invalid input'}`,
      { status: 400 },
    );
  }
};
