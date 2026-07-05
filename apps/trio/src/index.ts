// @merited/trio — security-critical trio host (contracts + simulators in
// Phase 0; real implementations replace simulator.ts files in Phase 1,
// PH1-24…26, behind the unchanged contract suite).
export { createTrioServer } from './shared/server.js';
export { systemClock, type Clock } from './shared/clock.js';
export { PgKeyStore } from './shared/pg-key-store.js';
