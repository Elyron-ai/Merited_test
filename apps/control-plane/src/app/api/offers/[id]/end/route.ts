import { NextResponse, type NextRequest } from 'next/server';
import { getOffersStack } from '../../../../../lib/platform';

export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await context.params;
  try {
    await getOffersStack().service.end(id);
    return NextResponse.redirect(new URL(`/offers/${id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(`Could not end: ${error instanceof Error ? error.message : 'error'}`, { status: 409 });
  }
};
