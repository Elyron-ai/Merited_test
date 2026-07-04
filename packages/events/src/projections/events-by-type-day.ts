import type pg from 'pg';
import type { DeliveredEvent } from '../deliver/subscriber.js';
import type { Projection } from './framework.js';

/**
 * Reference projection (FND-12) — executable documentation of the framework.
 * Counts events per (type, day of created_at). B19's analytics projections
 * follow this exact shape in Phase 1.
 */
export const eventsByTypeDay: Projection = {
  name: 'events_by_type_day',
  handles: [
    'CommitmentCreated',
    'CommitmentEnded',
    'QuoteIssued',
    'TokenMinted',
    'ApprovalGranted',
    'ApprovalDeclined',
    'ConversionClaimed',
    'ConversionVerified',
    'ConversionRejected',
    'ConversionReversed',
    'LedgerEntryPosted',
    'SettlementNetted',
    'MandateGranted',
    'MandateRevoked',
    'AccountLinked',
    'AccountUnlinked',
    'NotificationSent',
    'OfferPublished',
    'AgentRegistered',
    'ErrandStateChanged',
  ],
  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    await client.query(
      `INSERT INTO events.events_by_type_day (type, day, count)
       VALUES ($1, ($2::timestamptz)::date, 1)
       ON CONFLICT (type, day) DO UPDATE SET count = events.events_by_type_day.count + 1`,
      [event.type, event.created_at],
    );
  },
  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM events.events_by_type_day');
  },
};
