import { RulesStore } from '@merited/core';
import { NextResponse, type NextRequest } from 'next/server';
import { getPool } from '../../../../../../../lib/db';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string; ruleId: string }> },
) {
  const { id, ruleId } = await context.params;
  await new RulesStore(getPool()).remove(ruleId);
  return NextResponse.redirect(new URL(`/merchants/${id}/rules`, request.url), 303);
}
