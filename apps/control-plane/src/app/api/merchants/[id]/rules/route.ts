import { RulesStore } from '@merited/core';
import { NextResponse, type NextRequest } from 'next/server';
import { getPool } from '../../../../../lib/db';
import { ruleFromForm } from '../../../../../lib/rules-form';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const draft = ruleFromForm(id as `mer_${string}`, await request.formData());
    await new RulesStore(getPool()).add(draft);
  } catch (error) {
    return new NextResponse(`Rule refused: ${error instanceof Error ? error.message : 'invalid'}`, {
      status: 400,
    });
  }
  return NextResponse.redirect(new URL(`/merchants/${id}/rules`, request.url), 303);
}
