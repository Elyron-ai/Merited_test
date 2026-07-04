import { bigserial, char, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * The append-only event ledger — exactly the §3 row shape. Append-only is
 * enforced in Postgres (REVOKE UPDATE, DELETE — migration 0002), not just
 * in code. `type` duplicates `body.type` for indexing; both are asserted
 * equal at append and verify time (D2).
 */
export const eventsSchema = pgSchema('events');

export const events = eventsSchema.table('events', {
  seq: bigserial('seq', { mode: 'number' }).primaryKey(),
  evt_id: text('evt_id').notNull().unique(),
  type: text('type').notNull(),
  body: jsonb('body').notNull(),
  prev_hash: char('prev_hash', { length: 64 }).notNull(),
  this_hash: char('this_hash', { length: 64 }).notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
