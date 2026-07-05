/**
 * Public self-serve onboarding (PH3-6, §11's Phase-3 unlock): merchant →
 * keypair → integration → commercial config → first live offer, in one
 * POST, zero operator action. This page is reachable WITHOUT a session
 * (see isPublicPath); everything else in the control plane stays gated.
 * The launch offer here uses the percentage_off mechanics — the full
 * catalogue of mechanics is available from the dashboard afterwards.
 */
export const dynamic = 'force-dynamic';

export default function Signup() {
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const inAYearIso = new Date(Date.now() + 365 * 86400 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  return (
    <main>
      <h1>Sell to agents on Merited</h1>
      <p>
        One form: your business, how you integrate, your commercial terms, and your first live
        offer. No sales call, no operator — your offer is quotable the moment this submits.
      </p>
      <form action="/api/signup" method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '30rem' }}>
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

        <button type="submit">Go live</button>
      </form>
      <p>
        You will receive your webhook endpoint and signing secret exactly once in the response —
        store the secret before leaving the page.
      </p>
    </main>
  );
}
