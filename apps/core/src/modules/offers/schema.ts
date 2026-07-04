import { integer, jsonb, pgSchema, text, timestamp } from 'drizzle-orm/pg-core';

/** Drizzle table definitions for core.offers (CORE-2, §5.1). The SQL source
 * of truth is drizzle/0000_offers.sql via the forward-only runner. */
export const core = pgSchema('core');

export const offers = core.table('offers', {
  offer_id: text('offer_id').primaryKey(),
  merchant_id: text('merchant_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  mechanics: jsonb('mechanics').notNull(),
  sku_scope: jsonb('sku_scope').notNull(),
  identity_tiers: text('identity_tiers').array().notNull(),
  stacking_group: text('stacking_group'),
  status: text('status', { enum: ['draft', 'live', 'paused', 'ended'] }).notNull(),
  valid_from: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull(),
  valid_until: timestamp('valid_until', { withTimezone: true, mode: 'date' }).notNull(),
  current_commitment_id: text('current_commitment_id'),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const offerCounters = core.table('offer_counters', {
  offer_id: text('offer_id').primaryKey(),
  redeem_count: integer('redeem_count').notNull().default(0),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export const offerCommitments = core.table('offer_commitments', {
  offer_id: text('offer_id').notNull(),
  commitment_id: text('commitment_id').notNull(),
  created_at: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  ended_at: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
});
