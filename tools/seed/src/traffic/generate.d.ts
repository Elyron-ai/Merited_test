import type pg from 'pg';
export interface TrafficOptions {
    seed?: number;
    merchants?: number;
    days?: number;
    /** Mint volume per merchant-day (claims/verdicts derive from it). */
    mintsPerDay?: number;
    /** UTC midnight the window ENDS at, exclusive — deterministic input. */
    baseDate: string;
}
export interface TrafficReport {
    events: number;
    merchants: number;
    days: number;
}
export declare const generateTraffic: (pool: pg.Pool, options: TrafficOptions) => Promise<TrafficReport>;
/** LEAD-4's adequacy audit: is the ledger exhaust thick enough to train on? */
export declare const auditExhaust: (pool: pg.Pool, minimumRows?: number) => Promise<{
    merchantDays: number;
    verdict: "adequate" | "thin";
}>;
//# sourceMappingURL=generate.d.ts.map