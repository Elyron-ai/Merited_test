'use client';

import { useState, type FormEvent } from 'react';
import { messageForError } from './signup-error';

/**
 * W13/#8 (SC 3.3.1 / 4.1.3): the signup form used to POST straight to
 * `/api/signup` and NAVIGATE the browser to the raw JSON response — no heading,
 * no field association, entered values lost, nothing announced. This client
 * component keeps the JSON API unchanged (the PH3-6 gate posts to it directly)
 * but submits via fetch and renders the outcome IN-PAGE: a `role="alert"` error
 * with the values preserved, or the one-time integration sheet on success.
 */

interface SignupSuccess {
  merchant: { merchant_id: string; slug: string; name: string };
  integration: { selected: string; endpoint: string; scheme?: string; webhook_secret: string };
  offer: { offer_id: string; commitment_id: string; status: string };
}

export function SignupForm({ nowIso, inAYearIso }: { nowIso: string; inAYearIso: string }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SignupSuccess | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        body: new URLSearchParams(new FormData(event.currentTarget) as unknown as Record<string, string>),
      });
      if (res.ok) {
        setSuccess((await res.json()) as SignupSuccess);
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      setError(messageForError(body));
    } catch {
      setError('We couldn’t reach the server. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <section aria-labelledby="live-heading">
        <h2 id="live-heading">You’re live, {success.merchant.name}</h2>
        <p role="status">Your offer is quotable now. Store the webhook secret below — it is shown once.</p>
        <dl>
          <dt>Merchant id</dt>
          <dd><code>{success.merchant.merchant_id}</code></dd>
          <dt>Webhook endpoint</dt>
          <dd><code>{success.integration.endpoint}</code></dd>
          <dt>Webhook secret (shown once — copy it now)</dt>
          <dd><code>{success.integration.webhook_secret}</code></dd>
          <dt>Offer</dt>
          <dd><code>{success.offer.offer_id}</code> — {success.offer.status}</dd>
        </dl>
      </section>
    );
  }

  return (
    <>
      {error && (
        <p
          role="alert"
          style={{
            color: '#b91c1c',
            background: '#fef2f2',
            border: '1px solid #f0a3a3',
            borderRadius: '0.3rem',
            padding: '0.5rem 0.75rem',
            maxWidth: '30rem',
          }}
        >
          <strong>Signup didn’t go through.</strong> {error}
        </p>
      )}
      <form onSubmit={onSubmit} style={{ display: 'grid', gap: '0.5rem', maxWidth: '30rem' }}>
        <h2>Business</h2>
        <label>Trading name <input name="name" required style={{ width: '100%' }} /></label>

        <h2>Integration</h2>
        <label>
          Platform{' '}
          <select name="integration" required defaultValue="grade_b">
            <option value="shopify">Shopify (app install, orders/paid)</option>
            <option value="grade_b">Direct webhook (Grade B)</option>
          </select>
        </label>

        <h2>Commercial terms</h2>
        <label>Take rate (bps) <input name="take_rate_bps" inputMode="numeric" pattern="\d+" defaultValue="2000" required /></label>
        <label>Agent commission (bps) <input name="agent_commission_bps" inputMode="numeric" pattern="\d+" defaultValue="6000" required /></label>
        <label>Attribution window (seconds) <input name="attribution_window_s" inputMode="numeric" pattern="\d+" defaultValue="86400" required /></label>
        <label>Clawback window (seconds) <input name="clawback_window_s" inputMode="numeric" pattern="\d+" defaultValue="2592000" required /></label>
        <label>Per-offer budget (pence, blank = none) <input name="per_offer_default" inputMode="numeric" pattern="\d*" /></label>

        <h2>Your first offer</h2>
        <input type="hidden" name="type" value="percentage_off" />
        <label>Title <input name="title" required style={{ width: '100%' }} /></label>
        <label>Description <textarea name="description" required style={{ width: '100%' }} /></label>
        <label>Discount (bps, e.g. 1500 = 15%) <input name="mech_pct_bps" inputMode="numeric" pattern="\d+" defaultValue="1000" required /></label>
        <label>SKU scope (comma-separated, or the word all) <input name="sku_scope" defaultValue="all" required /></label>
        <label>Identity tiers (comma-separated of T1,T2,T3) <input name="identity_tiers" defaultValue="T1,T2,T3" required /></label>
        <label>Stacking group (blank = none) <input name="stacking_group" /></label>
        <label>Valid from (ISO) <input name="valid_from" defaultValue={nowIso} required /></label>
        <label>Valid until (ISO) <input name="valid_until" defaultValue={inAYearIso} required /></label>
        <label>
          Launch bounty{' '}
          <select name="bounty_type" required defaultValue="fixed">
            <option value="fixed">Fixed (pence)</option>
            <option value="pct_of_order">% of order (bps)</option>
          </select>
        </label>
        <label>Bounty amount (pence, for fixed) <input name="bounty_amount" inputMode="numeric" pattern="\d*" defaultValue="500" /></label>
        <label>Bounty rate (bps, for % of order) <input name="bounty_pct_bps" inputMode="numeric" pattern="\d*" /></label>

        <button type="submit" disabled={submitting}>{submitting ? 'Going live…' : 'Go live'}</button>
      </form>
    </>
  );
}
