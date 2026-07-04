import { NextResponse, type NextRequest } from 'next/server';
import { bountyFrom } from '../../bounty-form';
import { getOffersStack } from '../../../../../lib/platform';

/** Bounty reprice (§5.1/SYN-34): CORE-5 ends the old COR and creates a new
 * one — history kept, in-flight tokens still verify. */
export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await context.params;
  const form = await request.formData();
  try {
    const bounty = bountyFrom(form);
    if (!bounty) throw new Error('a bounty is required to reprice');
    await getOffersStack().publisher.editBounty(id, { bounty });
    return NextResponse.redirect(new URL(`/offers/${id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(
      `Could not reprice: ${error instanceof Error ? error.message : 'invalid input'}`,
      { status: 400 },
    );
  }
};
