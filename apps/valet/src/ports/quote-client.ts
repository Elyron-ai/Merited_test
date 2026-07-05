import type { ClaimStatusResponse, OfferReadResponse, QuoteStatusResponse } from '@merited/contracts';
import { MeritedClient } from '@merited/sdk';
import type { AgentCredentials, CredentialsStore } from './credentials.js';

export interface QuoteClientOptions {
  baseUrl: string;
  store: CredentialsStore;
  /** Registration identity, used only on first run. */
  name?: string;
  contact?: string;
}

export interface ReadQuery {
  text?: string;
  /** Seeded-T1 handle (§5.3) from the brief, when the consumer gave one. */
  sub_hash?: string;
  /** PH2-4 (§6.6): the errand's mandate — minted tokens demand approval. */
  mandate_ref?: string;
}

/**
 * The platform read/quote port (VAL-5). Everything goes through
 * `@merited/sdk` — Valet is an ORDINARY registered agent (P5): first use
 * registers via the open endpoint and persists `agt_…` + api key locally;
 * every later run reuses the stored identity.
 */
export class QuoteClient {
  private sdk: MeritedClient | null = null;
  private credentials: AgentCredentials | null = null;

  constructor(private readonly options: QuoteClientOptions) {}

  async ensureRegistered(): Promise<AgentCredentials> {
    if (this.credentials) return this.credentials;
    const stored = await this.options.store.load();
    if (stored) {
      this.credentials = stored;
      this.sdk = new MeritedClient({ baseUrl: this.options.baseUrl, apiKey: stored.api_key });
      return stored;
    }
    const client = new MeritedClient({ baseUrl: this.options.baseUrl });
    const registered = await client.register({
      name: this.options.name ?? 'Valet',
      contact: this.options.contact ?? 'valet@merited.test',
    });
    const credentials: AgentCredentials = {
      agent_id: registered.agent_id,
      api_key: registered.api_key,
    };
    await this.options.store.save(credentials);
    this.credentials = credentials;
    this.sdk = client;
    return credentials;
  }

  private async client(): Promise<MeritedClient> {
    await this.ensureRegistered();
    return this.sdk!;
  }

  async readOffers(query: ReadQuery): Promise<OfferReadResponse> {
    return (await this.client()).readOffers({
      ...(query.text ? { text: query.text } : {}),
      ...(query.sub_hash ? { sub_hash: query.sub_hash } : {}),
      ...(query.mandate_ref ? { mandate_ref: query.mandate_ref } : {}),
    });
  }

  async getQuote(quoteId: string): Promise<QuoteStatusResponse> {
    return (await this.client()).getQuote(quoteId);
  }

  /** SYN-40 discovery: the latest claim consuming the agent's own quote. */
  async getQuoteClaim(quoteId: string): Promise<ClaimStatusResponse> {
    return (await this.client()).getQuoteClaim(quoteId);
  }
}
