import type { DecisionCtx, Decisioner, EligibleOffer, RankedOffer } from '@merited/contracts';

/**
 * The ML sidecar slot-in (PH2-7, §5.5): `Decisioner` over HTTP — the v2
 * engine lives in `apps/ml-decisioner` and NOWHERE else. Reads never fail
 * on the model's account: any error — timeout, network, non-200, malformed
 * body, or a response that is not an exact PERMUTATION of the input — falls
 * back to the injected deterministic decisioner (RulesDecisioner in
 * production). Ranking is the only thing the sidecar may change.
 */
export interface HttpDecisionerOptions {
  baseUrl: string;
  fallback: Decisioner;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class HttpDecisioner implements Decisioner {
  constructor(private readonly options: HttpDecisionerOptions) {}

  async rank(eligible: EligibleOffer[], ctx: DecisionCtx): Promise<RankedOffer[]> {
    if (eligible.length === 0) return [];
    try {
      const doFetch = this.options.fetchImpl ?? fetch;
      const response = await doFetch(`${this.options.baseUrl}/rank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ eligible, ctx }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 500),
      });
      if (!response.ok) return this.options.fallback.rank(eligible, ctx);
      const payload = (await response.json()) as { ranked?: Array<{ offer_id: string; score?: number }> };
      const order = payload.ranked;
      if (!Array.isArray(order)) return this.options.fallback.rank(eligible, ctx);

      // the sidecar returns an ORDERING (offer ids + scores); the offers
      // themselves never round-trip through the model. Anything that is not
      // an exact permutation of the input is refused wholesale.
      const byId = new Map(eligible.map((entry) => [entry.offer.offer_id as string, entry]));
      if (order.length !== eligible.length) return this.options.fallback.rank(eligible, ctx);
      const seen = new Set<string>();
      const ranked: RankedOffer[] = [];
      for (const item of order) {
        const entry = byId.get(item.offer_id);
        if (!entry || seen.has(item.offer_id)) return this.options.fallback.rank(eligible, ctx);
        seen.add(item.offer_id);
        ranked.push({
          ...entry,
          ...(typeof item.score === 'number' && Number.isFinite(item.score) ? { score: item.score } : {}),
        });
      }
      return ranked;
    } catch {
      // sidecar down/slow → deterministic fallback; the read NEVER fails
      return this.options.fallback.rank(eligible, ctx);
    }
  }
}
