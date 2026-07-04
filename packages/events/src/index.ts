// @merited/events — hash-chained append-only ledger (B2).
export * from './catalogue.js';
export * from './canonical-json.js';
export * from './hash.js';
export * from './append.js';
export * from './verify.js';
export { createAppPool, assertUrlRole } from './db.js';
export { events, eventsSchema } from './schema.js';
export * from './deliver/subscriber.js';
export * from './projections/framework.js';
export { eventsByTypeDay } from './projections/events-by-type-day.js';
