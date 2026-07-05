import type { HeadPublication } from '@merited/contracts';
import { publishHead, type ObjectStore, type PublishOutcome } from '@merited/events';
import type pg from 'pg';

/**
 * Daily head-publication job (PH1-21, architecture §2.6). Publishes the
 * ledger head for today's UTC date; `publishHead` is first-write-wins per
 * day, so the job can tick hourly and still publish exactly once a day.
 * When a head IS newly published, the optional per-merchant webhook posters
 * fire (merchants that asked to receive the head into their own systems) —
 * best-effort, never blocking the publication itself.
 */
export interface HeadPublicationJobDeps {
  pool: pg.Pool;
  store: ObjectStore;
  clock?: { now(): Date };
  logger?: { info(payload: Record<string, unknown>, message: string): void; warn(payload: Record<string, unknown>, message: string): void };
  /** Per-merchant webhook posters, called once per NEW publication. */
  webhooks?: ReadonlyArray<(publication: HeadPublication) => Promise<void>>;
}

export class HeadPublicationJob {
  private readonly clock: { now(): Date };

  constructor(private readonly deps: HeadPublicationJobDeps) {
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  async runOnce(): Promise<PublishOutcome> {
    const outcome = await publishHead(this.deps.pool, this.deps.store, { clock: this.clock });
    if (outcome.published) {
      this.deps.logger?.info(
        { head: outcome.publication },
        `ledger head published for ${outcome.publication.date}`,
      );
      for (const post of this.deps.webhooks ?? []) {
        await post(outcome.publication).catch((error) => {
          this.deps.logger?.warn(
            { head: outcome.publication, message: (error as Error).message },
            'head-publication webhook failed (publication itself is safe)',
          );
        });
      }
    }
    return outcome;
  }

  /** Run continuously; hourly ticks are safe (idempotent per day). */
  start(intervalMs = 3_600_000): { stop(): void } {
    let running = false;
    const tick = (): void => {
      if (running) return;
      running = true;
      void this.runOnce()
        .catch((error) => {
          this.deps.logger?.warn({ message: (error as Error).message }, 'head publication cycle failed');
        })
        .finally(() => {
          running = false;
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return { stop: () => clearInterval(timer) };
  }
}
