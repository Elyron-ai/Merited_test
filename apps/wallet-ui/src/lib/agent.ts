import type { OfferReadResponse } from '@merited/contracts';

/**
 * The UI's offer feed rides the platform's PUBLIC agent surface (P5): the
 * process registers ONCE through the open registration endpoint — exactly
 * like Valet does — and reads offers with the consumer's consented
 * sub_hash. No private imports from core; a plain fetch client.
 */
const coreBase = (): string => process.env['MERITED_CORE_API_URL'] ?? 'http://127.0.0.1:3100';

let credentials: { agent_id: string; api_key: string } | null = null;

const ensureRegistered = async (): Promise<{ agent_id: string; api_key: string }> => {
  if (credentials) return credentials;
  const response = await fetch(`${coreBase()}/v1/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Merited Wallet', contact: 'wallet@merited.test' }),
  });
  if (!response.ok) throw new Error(`agent registration failed: ${response.status}`);
  const body = (await response.json()) as { agent_id: string; api_key: string };
  credentials = { agent_id: body.agent_id, api_key: body.api_key };
  return credentials;
};

export const readOffersAsAgent = async (query: {
  sub_hash: string;
  mandate_ref?: string;
}): Promise<OfferReadResponse | null> => {
  try {
    const agent = await ensureRegistered();
    const params = new URLSearchParams({ sub_hash: query.sub_hash });
    if (query.mandate_ref) params.set('mandate_ref', query.mandate_ref);
    const response = await fetch(`${coreBase()}/v1/offers?${params.toString()}`, {
      headers: { 'x-merited-agent-key': agent.api_key },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    return (await response.json()) as OfferReadResponse;
  } catch {
    return null; // core unreachable → the screen renders its empty state
  }
};
