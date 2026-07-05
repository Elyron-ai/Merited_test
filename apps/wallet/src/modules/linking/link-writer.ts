import { createHash } from 'node:crypto';
import { IdentityLink, newId } from '@merited/contracts';
import { appendEventInNewTx } from '@merited/events';
import type pg from 'pg';

/**
 * Shared link finalisation for BOTH linking flows (PH1-13 OAuth, PH1-14
 * hosted). The IdentityLink derivation lives here once so the two paths are
 * byte-for-byte indistinguishable downstream (§6.3 accept: "the hosted flow
 * yields an IdentityLink byte-compatible with the OAuth flow's — same schema,
 * same T1 behaviour"). `sub` is the IdP subject for OAuth, or the loyalty
 * member number for the hosted flow; for FakeAurora these are the same value,
 * so a member linked either way resolves the same T1 identity.
 */
const sha256hex = (input: string): string => createHash('sha256').update(input).digest('hex');

/** Scopes recorded on the IdentityLink (the wire-facing `openid` is dropped). */
export const LINK_RECORD_SCOPES = ['profile', 'balance', 'tier'] as const;

export const buildIdentityLink = (input: {
  consumerRef: string;
  merchantId: string;
  programme: string;
  sub: string;
  linkedAt: string;
}): IdentityLink =>
  IdentityLink.parse({
    link_id: newId('lnk'),
    consumer_ref: input.consumerRef,
    merchant_id: input.merchantId,
    programme: input.programme,
    // tokenise the member reference — the raw sub never lands on the wire
    member_ref: `mbr_${sha256hex(`${input.programme}:${input.sub}`).slice(0, 24)}`,
    sub_hash: sha256hex(input.sub),
    scopes: [...LINK_RECORD_SCOPES],
    status: 'active',
    linked_at: input.linkedAt,
  });

/** Persist the link row and append `AccountLinked` to the hash-chained
 * ledger. The event body carries the link ONLY — never token material. */
export const persistLink = async (pool: pg.Pool, link: IdentityLink): Promise<void> => {
  await pool.query(
    `INSERT INTO wallet.identity_links (link_id, consumer_ref, merchant_id, programme, member_ref, sub_hash, scopes, status, linked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [
      link.link_id,
      link.consumer_ref,
      link.merchant_id,
      link.programme,
      link.member_ref,
      link.sub_hash,
      JSON.stringify(link.scopes),
      link.status,
      link.linked_at,
    ],
  );
  await appendEventInNewTx(pool, 'AccountLinked', { link });
};
