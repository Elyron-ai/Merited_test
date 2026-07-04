import { newId, type Brief, type ErrandEvent, type MeritedId } from '@merited/contracts';
import type { ApprovalGate } from '../ports/approval-gate.js';
import { CheckoutFailedError, type CheckoutRail } from '../ports/checkout-rail.js';
import type { QuoteClient } from '../ports/quote-client.js';
import { VerdictTimeoutError, type VerdictPoller } from '../ports/verdict-poller.js';
import { transition, isTerminal } from './reducer.js';
import type { ErrandStore, StoredErrand } from './store.js';
import type { LedgerMirror } from './ledger-mirror.js';

export interface DriverDeps {
  store: ErrandStore;
  mirror: LedgerMirror;
  quotes: QuoteClient;
  rail: CheckoutRail;
  gate: ApprovalGate;
  poller: VerdictPoller;
  /** Product resolution: the platform quotes OFFERS; the merchant sells
   * SKUs. An agent browses the shop's public catalogue for the product
   * matching the brief — null means nothing matched. */
  resolveSku(brief: Brief): Promise<string | null>;
  now?(): Date;
}

export class InvalidDispatchError extends Error {
  constructor(errandId: string, state: string, event: string) {
    super(`reducer rejected ${state} × ${event} for ${errandId}`);
    this.name = 'InvalidDispatchError';
  }
}

const isoS = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

const STOPWORDS = new Set([
  'a', 'an', 'and', 'book', 'buy', 'for', 'get', 'me', 'of', 'over', 'please', 'the', 'under',
]);

/** Deterministic Phase-0 brief interpretation (arch §4.3: the LLM
 * interpreter is Phase-2 flesh on this skeleton): strip prices and filler,
 * then search the cleaned phrase first and single keywords as fallback —
 * the read path's text filter is plain substring match (§11 restraint). */
export const searchTermsFrom = (text: string): string[] => {
  const words = text
    .toLowerCase()
    .replace(/£?\d+(\.\d+)?/g, ' ')
    .split(/[^a-z]+/)
    .filter((word) => word.length > 1 && !STOPWORDS.has(word));
  return [...new Set([words.join(' '), ...words])].filter((term) => term.length > 0);
};

/**
 * The errand driver (VAL-6, §6.6): side effects per state, with EVERY
 * dispatch running reducer → store persist → ledger mirror → side effect,
 * in that order — state is never acknowledged before it is durable, and
 * the mirror trail follows the persisted truth. The quote-expiry watchdog
 * is deterministic: expiry is checked at each pre-execution step boundary
 * (no background timers — a resumed process re-derives everything from
 * Postgres + the clock).
 */
export class ErrandDriver {
  constructor(private readonly deps: DriverDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async startErrand(input: { brief: Brief; mandate_id?: MeritedId<'mnd'> | null }): Promise<StoredErrand> {
    const credentials = await this.deps.quotes.ensureRegistered();
    return this.deps.store.create({
      errand_id: newId('ern'),
      agent_id: credentials.agent_id,
      brief: input.brief,
      mandate_id: input.mandate_id ?? null,
      sub_hash: input.brief.sub_hash,
    });
  }

  /** One dispatch: reducer → persist → mirror (in order). */
  private async dispatch(stored: StoredErrand, event: ErrandEvent): Promise<StoredErrand> {
    const result = transition(stored.state, event);
    if ('error' in result) {
      throw new InvalidDispatchError(stored.errand.errand_id, stored.state, event.type);
    }
    const persisted = await this.deps.store.recordTransition(
      stored.errand.errand_id as MeritedId<'ern'>,
      stored.state,
      result.next,
      event,
    );
    await this.deps.mirror.mirror({
      errand: persisted.errand,
      from: stored.state,
      to: persisted.state,
      at: isoS(this.now()),
    });
    return persisted;
  }

  private async quoteExpired(stored: StoredErrand): Promise<boolean> {
    if (!stored.errand.quote_id) return false;
    const status = await this.deps.quotes.getQuote(stored.errand.quote_id);
    return status.status === 'expired' || Date.parse(status.quote.expires_at) <= this.now().getTime();
  }

  /** The next event for the current state, running that state's side
   * effect. Null means "nothing to do" (terminal, or FAILED awaiting an
   * explicit retry — a CLAIM_REJECTED errand must NOT auto-retry: the
   * token is consumed and every retry would replay it). */
  private async nextEvent(stored: StoredErrand): Promise<ErrandEvent | null> {
    switch (stored.state) {
      case 'BRIEFED':
        return { type: 'SEARCH_STARTED' };
      case 'SEARCHING': {
        const ceiling = stored.errand.brief.max_price?.amount ?? Infinity;
        for (const term of searchTermsFrom(stored.errand.brief.text)) {
          const read = await this.deps.quotes.readOffers({
            text: term,
            ...(stored.errand.sub_hash ? { sub_hash: stored.errand.sub_hash } : {}),
          });
          const top = read.quotes.find((q) => q.token !== null && q.price.final.amount <= ceiling);
          if (top) return { type: 'QUOTE_RECEIVED', quote_id: top.quote_id, token: top.token };
        }
        return { type: 'SEARCH_FAILED' };
      }
      case 'QUOTED': {
        if (await this.quoteExpired(stored)) {
          return { type: 'TIMED_OUT', cause: 'quote expired before approval' };
        }
        const quote = await this.deps.quotes.getQuote(stored.errand.quote_id!);
        return this.deps.gate.consult({
          quote_id: quote.quote.quote_id,
          final: quote.quote.price.final,
          expires_at: quote.quote.expires_at,
        });
      }
      case 'AWAITING_APPROVAL':
        // Phase 0 never enters here (AutoSkipGate); a wallet gate blocks
        // until granted/declined/expired. Watchdog still applies:
        return (await this.quoteExpired(stored))
          ? { type: 'TIMED_OUT', cause: 'quote expired awaiting approval' }
          : null;
      case 'APPROVED':
        return (await this.quoteExpired(stored))
          ? { type: 'TIMED_OUT', cause: 'quote expired before execution' }
          : { type: 'EXECUTION_STARTED' };
      case 'EXECUTING': {
        try {
          const sku = await this.deps.resolveSku(stored.errand.brief);
          if (!sku) return { type: 'TIMED_OUT', cause: 'no product matches the brief' };
          await this.deps.rail.checkout({
            sku,
            attribution_token: stored.errand.token,
            errand_id: stored.errand.errand_id as MeritedId<'ern'>,
          });
          return await this.deps.poller.poll(stored.errand.quote_id!);
        } catch (error) {
          if (error instanceof CheckoutFailedError || error instanceof VerdictTimeoutError) {
            return { type: 'TIMED_OUT', cause: error.message };
          }
          throw error;
        }
      }
      case 'FAILED':
      case 'CONFIRMED':
      case 'DECLINED':
      case 'EXPIRED':
        return null;
    }
  }

  /** ONE step: run the current state's side effect and apply its event.
   * Returns null when there is nothing to do (terminal, FAILED awaiting an
   * explicit retry, or a blocked waiting state). Public so the CLI can
   * print transitions live (VAL-7) and tests can interleave. */
  async step(errandId: string): Promise<StoredErrand | null> {
    const stored = await this.deps.store.get(errandId);
    if (!stored) throw new Error(`unknown errand ${errandId}`);
    if (isTerminal(stored.state)) return null;
    const event = await this.nextEvent(stored);
    if (!event) return null;
    return this.dispatch(stored, event);
  }

  /** Run one errand to rest: loops steps until nothing remains to do. */
  async drive(errandId: string): Promise<StoredErrand> {
    for (;;) {
      const next = await this.step(errandId);
      if (!next) return (await this.deps.store.get(errandId))!;
    }
  }

  /** Operator-initiated retry of a transiently-failed errand. */
  async retry(errandId: string): Promise<StoredErrand> {
    const stored = await this.deps.store.get(errandId);
    if (!stored) throw new Error(`unknown errand ${errandId}`);
    await this.dispatch(stored, { type: 'RETRY' });
    return this.drive(errandId);
  }

  /** Restart path (VAL-8): rehydrate every open errand and re-enter its
   * current state's side effect idempotently (checkout idempotency-keyed
   * by errand id; FAILED errands stay parked for explicit retry). */
  async resumeAll(): Promise<StoredErrand[]> {
    const open = await this.deps.store.loadOpenErrands();
    const results: StoredErrand[] = [];
    for (const stored of open) {
      results.push(await this.drive(stored.errand.errand_id));
    }
    return results;
  }
}
