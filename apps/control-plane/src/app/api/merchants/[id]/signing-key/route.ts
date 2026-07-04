import { NextResponse, type NextRequest } from 'next/server';
import { getMerchantsService } from '../../../../../lib/platform';

/** Requests a custodied keypair from the trio (MER-2 → SYN-22: the private
 * half never leaves the trio; the UI shows the reference and public key). */
export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await context.params;
  try {
    await getMerchantsService().requestSigningKey(id as `mer_${string}`);
    return NextResponse.redirect(new URL(`/merchants/${id}`, request.url), 303);
  } catch (error) {
    return new NextResponse(
      `Could not request a keypair: ${error instanceof Error ? error.message : 'trio unavailable'}`,
      { status: 502 },
    );
  }
};
