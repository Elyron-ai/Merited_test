/**
 * Public self-serve onboarding (PH3-6, §11's Phase-3 unlock): merchant →
 * keypair → integration → commercial config → first live offer, in one
 * POST, zero operator action. This page is reachable WITHOUT a session
 * (see isPublicPath); everything else in the control plane stays gated.
 * The launch offer here uses the percentage_off mechanics — the full
 * catalogue of mechanics is available from the dashboard afterwards.
 */
import { SignupForm } from './SignupForm';

export const dynamic = 'force-dynamic';

export default function Signup() {
  // computed server-side and passed down so the client form has no Date.now()
  // hydration mismatch (W13/#8)
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
      <p>
        You will receive your webhook endpoint and signing secret exactly once, on this page —
        store the secret before leaving.
      </p>
      <SignupForm nowIso={nowIso} inAYearIso={inAYearIso} />
    </main>
  );
}
