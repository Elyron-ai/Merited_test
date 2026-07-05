export interface SeedOptions {
    /** merited_app connection string — events+core+trio schemas migrated. */
    databaseUrl: string;
    /** `--reset` (VAL-10): truncate the non-ledger seed targets first, then
     * reseed. Requires `resetDatabaseUrl` — the app role deliberately holds
     * no DELETE anywhere in core, so resetting is an operator action under
     * the migrate role, never something runtime credentials can do. */
    reset?: boolean;
    /** merited_migrate connection string, used ONLY for the reset truncate. */
    resetDatabaseUrl?: string;
    serviceToken?: string;
    signerSecret?: string;
    /** PH1-27: inject the REAL signer so the seeded CORs/keys verify on real rails. */
    signer?: import('@merited/signing').Signer;
    log?: (line: string) => void;
}
export interface SeedResult {
    merchant_id: string;
    members: number;
    offers_published: number;
    /** The spa-day offer's COR — §10 step 1's countersigned commitment. */
    bounty_commitment_id: string | null;
}
/**
 * Aurora Experiences seed (VAL-9, B22). Everything goes through the REAL
 * platform surfaces — merchants service, offers service, publish path →
 * trio commitment simulator (in-process over real HTTP) — never back-door
 * inserts, so seeding emits the same `OfferPublished` + `CommitmentCreated`
 * ledger events production would (§5.1). The only direct SQL is the Aurora
 * Club membership table: CORE-4 owns that schema, VAL-9 owns its rows.
 * Fixed IDs (D6) make re-runs converge on the same entities.
 */
export declare const runSeed: (options: SeedOptions) => Promise<SeedResult>;
//# sourceMappingURL=seed.d.ts.map