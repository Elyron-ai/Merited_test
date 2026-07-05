/**
 * PH1-3 moved the chain to `pipeline.ts` (+ `stacking.ts`, `exclusions.ts`)
 * per the §6 row layout; this module re-exports so Phase-0 call sites keep
 * working unchanged.
 */
export { fetchCommitmentStatuses, filterEligibility, type EligibilityInput } from './pipeline.js';
