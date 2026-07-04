import type { Errand, ErrandState, MeritedEventName } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import type pg from 'pg';

export interface MirrorTransition {
  errand: Errand;
  from: ErrandState;
  to: ErrandState;
  /** Transition instant (ISO seconds); the driver stamps it so mirror
   * retries reproduce the same event body. */
  at: string;
}

export interface MirrorResult {
  mirrored: boolean;
  seq?: number;
}

/**
 * Ledger mirroring port (VAL-4, D3). Phase 0 implements it over the shared
 * `@merited/events` writer; Phase 2 may swap the transport for a public
 * mirror endpoint — this interface is the one file that changes.
 */
export interface LedgerMirror {
  mirror(transition: MirrorTransition): Promise<MirrorResult>;
}

/** BRIEFED/SEARCHING are wallet-DB-only (§3); QUOTED onward is platform
 * history. Membership is by TARGET state. */
const MIRRORED_STATES: readonly ErrandState[] = [
  'QUOTED',
  'AWAITING_APPROVAL',
  'APPROVED',
  'EXECUTING',
  'CONFIRMED',
  'FAILED',
  'DECLINED',
  'EXPIRED',
];

/** SYN-21: the ONLY event type Valet's credential may emit. */
const VALET_ALLOWLIST: readonly MeritedEventName[] = ['ErrandStateChanged'];

/**
 * The Phase-0 mirror (D3/SYN-21). `pool` MUST be connected as the dedicated
 * `merited_valet` role: the code-level allow-list here and the
 * `valet_emitter_fence` trigger in the events schema are twin fences — even
 * a compromised or buggy Valet cannot append anything but
 * `ErrandStateChanged` (high-scrutiny item, flagged for LEAD-5).
 */
export class EventsPackageMirror implements LedgerMirror {
  constructor(private readonly pool: pg.Pool) {}

  async mirror(transition: MirrorTransition): Promise<MirrorResult> {
    if (!MIRRORED_STATES.includes(transition.to)) return { mirrored: false };
    const appended = await appendEventInNewTx(
      this.pool,
      'ErrandStateChanged',
      {
        errand_id: transition.errand.errand_id,
        agent_id: transition.errand.agent_id,
        from: transition.from,
        to: transition.to,
        at: transition.at,
        quote_id: transition.errand.quote_id,
        claim_id: transition.errand.claim_id,
      },
      { allowlist: VALET_ALLOWLIST },
    );
    return { mirrored: true, seq: appended.seq };
  }
}
