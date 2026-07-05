import { metrics } from '@opentelemetry/api';
import { catchUp } from '@merited/events';
import type pg from 'pg';
import { analyticsProjection } from './projections/index.js';

/**
 * Mint-vs-claim monitor (PH1-20; architecture §5). Tokens minted vs claims
 * arriving is THE signal a merchant is quietly dropping conversion webhooks —
 * the under-reporting failure mode on the risk register. On every cycle the
 * monitor advances the analytics projection one cycle, computes each
 * merchant's claim rate over a trailing window, and:
 *
 *   - upserts `core.merchant_health` (the control-plane badge's read model),
 *   - on a breach, emits an OTel counter metric + a structured alert log line
 *     (→ Axiom/Grafana per §2.2's observability row).
 *
 * A merchant below `minMints` in the window is `insufficient_data` — never
 * alerted (a partner with three test mints is not under-reporting). Floors
 * and windows are configuration, not code.
 */
export interface MonitorOptions {
  /** Claim-rate floor in basis points (2500 = a quarter of mints must claim). */
  floorBps?: number;
  /** Trailing evaluation window in days. */
  windowDays?: number;
  /** Below this many mints in-window a merchant is insufficient_data. */
  minMints?: number;
}

export interface MerchantHealth {
  merchant_id: string;
  status: 'healthy' | 'under_reporting' | 'insufficient_data';
  claim_rate_bps: number | null;
  mints: number;
  claims: number;
}

export interface AlertLogger {
  warn(payload: Record<string, unknown>, message: string): void;
  info(payload: Record<string, unknown>, message: string): void;
}

export interface MonitorDeps {
  pool: pg.Pool;
  clock?: { now(): Date };
  logger?: AlertLogger;
  options?: MonitorOptions;
}

const alertCounter = metrics
  .getMeter('@merited/core')
  .createCounter('merited.mint_vs_claim.under_reporting_alerts', {
    description: 'Under-reporting alerts fired by the mint-vs-claim monitor (PH1-20)',
  });

export class MintVsClaimMonitor {
  private readonly floorBps: number;
  private readonly windowDays: number;
  private readonly minMints: number;
  private readonly clock: { now(): Date };
  private readonly logger: AlertLogger | undefined;

  constructor(private readonly deps: MonitorDeps) {
    this.floorBps = deps.options?.floorBps ?? 2500;
    this.windowDays = deps.options?.windowDays ?? 7;
    this.minMints = deps.options?.minMints ?? 10;
    this.clock = deps.clock ?? { now: () => new Date() };
    this.logger = deps.logger;
  }

  /** One evaluation cycle: projection catch-up → rates → badge rows → alerts. */
  async runOnce(): Promise<MerchantHealth[]> {
    await catchUp(this.deps.pool, analyticsProjection); // ONE projection cycle
    const since = new Date(this.clock.now().getTime() - this.windowDays * 86_400_000);
    const { rows } = await this.deps.pool.query<{ merchant_id: string; mints: string; claims: string }>(
      `SELECT merchant_id, COALESCE(SUM(mints), 0) AS mints, COALESCE(SUM(claims), 0) AS claims
         FROM core.mint_vs_claim_by_merchant_day
        WHERE day >= $1::date
        GROUP BY merchant_id ORDER BY merchant_id`,
      [since.toISOString().slice(0, 10)],
    );

    const results: MerchantHealth[] = [];
    for (const row of rows) {
      const mints = Number(row.mints);
      const claims = Number(row.claims);
      const rateBps = mints > 0 ? Math.floor((claims * 10000) / mints) : null;
      const status: MerchantHealth['status'] =
        mints < this.minMints
          ? 'insufficient_data'
          : rateBps !== null && rateBps < this.floorBps
            ? 'under_reporting'
            : 'healthy';

      await this.deps.pool.query(
        `INSERT INTO core.merchant_health
           (merchant_id, status, claim_rate_bps, mints, claims, window_days, floor_bps, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (merchant_id) DO UPDATE SET
           status = $2, claim_rate_bps = $3, mints = $4, claims = $5,
           window_days = $6, floor_bps = $7, evaluated_at = $8`,
        [row.merchant_id, status, rateBps, mints, claims, this.windowDays, this.floorBps, this.clock.now().toISOString()],
      );

      if (status === 'under_reporting') {
        alertCounter.add(1, { merchant_id: row.merchant_id });
        this.logger?.warn(
          {
            alert: 'mint_vs_claim_under_reporting',
            merchant_id: row.merchant_id,
            claim_rate_bps: rateBps,
            floor_bps: this.floorBps,
            window_days: this.windowDays,
            mints,
            claims,
          },
          'merchant claim rate below floor — possible conversion under-reporting',
        );
      }
      results.push({ merchant_id: row.merchant_id, status, claim_rate_bps: rateBps, mints, claims });
    }
    return results;
  }

  /** Run continuously (the "live" in the gate line). Returns a stopper. */
  start(intervalMs = 60_000): { stop(): void } {
    let running = false;
    const tick = (): void => {
      if (running) return; // a slow cycle never overlaps itself
      running = true;
      void this.runOnce()
        .catch((error) => {
          this.logger?.warn({ alert: 'mint_vs_claim_monitor_error', message: (error as Error).message }, 'monitor cycle failed');
        })
        .finally(() => {
          running = false;
        });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return {
      stop: () => clearInterval(timer),
    };
  }
}
