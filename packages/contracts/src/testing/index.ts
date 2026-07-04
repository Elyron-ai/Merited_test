/**
 * Deterministic test kit (XC-5, SYN-19, ADR-008) — `@merited/contracts/testing`.
 * Injectable Clock, seeded monotonic ULID factory, canonical fixture
 * loader, and fast-check arbitraries (XC-6). Consumed by determinism/
 * byte-identical tests and property suites. Test-side tooling only —
 * nothing here belongs in a production import.
 */
export { frozenClock, steppingClock, systemClock, type Clock } from './clock.js';
export { SEEDED_EPOCH, seededIdFactory, type SeededIdFactory } from './seeded-ids.js';
export { deepFreeze, loadFixture, type FixtureSchema } from './fixtures.js';
export {
  arbEventBody,
  arbEventBodySequence,
  arbMandate,
  arbMandateOrderingViolation,
  arbMandateTree,
  arbMechanics,
  arbMoney,
  mechanicsArbitraries,
} from './arbitraries.js';
