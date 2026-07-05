import {
  CheckEligibilityInput,
  GetOfferInput,
  SearchOffersInput,
} from '@merited/contracts';
import type { MeritedClient } from '@merited/sdk';
import { z } from 'zod';

/**
 * The three MCP tools (PH1-6, B10) — thin wrappers over the canonical read
 * path, reached THROUGH the SDK as an ordinary registered agent (P5, no
 * private Core imports). SYN-26/P2: `search_offers`/`get_offer` return
 * tokenised quotes (every payable read mints); `check_eligibility` returns
 * verdicts + exclusion reasons only, never a token.
 *
 * Input shapes come straight from contracts (single source); each tool's
 * handler returns MCP content with the raw JSON as text so an agent can
 * parse the exact wire shapes.
 */
const asContent = (payload: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
});

const consumerFrom = (input: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const key of ['consumer_ref', 'sub_hash', 'member_ref', 'hashed_email'] as const) {
    const value = input[key];
    if (typeof value === 'string') out[key] = value;
  }
  return out;
};

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler(args: unknown, client: MeritedClient): Promise<ReturnType<typeof asContent>>;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'search_offers',
    description:
      'Search live offers for the calling agent. Returns quote-bound, tokenised OfferQuotes for every payable, eligible offer (an anonymous agent gets token:null quotes plus a register-to-earn hint).',
    inputSchema: SearchOffersInput,
    handler: async (args, client) => {
      const input = SearchOffersInput.parse(args);
      const query: Record<string, string | undefined> = {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.merchant_id !== undefined ? { merchant_id: input.merchant_id } : {}),
        ...(input.sku !== undefined ? { sku: input.sku } : {}),
        ...consumerFrom(input),
      };
      return asContent(await client.readOffers(query));
    },
  },
  {
    name: 'get_offer',
    description:
      'Fetch a single offer by id as a fresh quote-bound, tokenised OfferQuote (mints a new quote every call). 404s when the offer is unknown, not live, or not eligible for this agent.',
    inputSchema: GetOfferInput,
    handler: async (args, client) => {
      const input = GetOfferInput.parse(args);
      // getOffer takes only the id today; consumer signals ride the search
      // path — a single-offer consumer read is a Phase-2 nicety, not this row.
      return asContent(await client.getOffer(input.offer_id));
    },
  },
  {
    name: 'check_eligibility',
    description:
      'Check whether specific offers are eligible for the calling agent WITHOUT minting anything. Returns per-offer verdicts; an ineligible offer carries its exclusion reason (e.g. TIER_INELIGIBLE, MERCHANT_EXCLUDED, CAP_EXHAUSTED). Never returns a quote or token.',
    inputSchema: CheckEligibilityInput,
    handler: async (args, client) => {
      const input = CheckEligibilityInput.parse(args);
      return asContent(await client.checkEligibility([...input.offer_ids], consumerFrom(input)));
    },
  },
];
