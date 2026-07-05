# Phase-1 cutover checklist (PH1-27 · retained for any future partner go-live)

FakeAurora's full-dress run (SYN-33) stands in for the design-partner cutover.
When a REAL partner arrives, this list is the delta between "green in CI" and
"live". A real partner reuses the exact FakeAurora path — the Grade-B adapter
is config-per-merchant (record, commercial config, webhook secret, custodied
keypair), never a fork.

## Environment

- [ ] Managed Postgres provisioned; `merited_admin` / `merited_migrate` /
      `merited_app` roles created with the FND-2 grants (app role: no DDL, no
      UPDATE/DELETE on ledger tables, column-level UPDATE on
      `trio.signing_keys.revoked_at` only).
- [ ] **PITR/backup verification**: point-in-time recovery enabled; perform
      one REAL restore drill into a scratch instance and run
      `pnpm verify-chain --against-heads <store>` against the restored copy —
      a backup that has never been restored is a hope, not a backup.
- [ ] **Postgres RLS belt-and-braces** (architecture §6): enable row-level
      security on `wallet.*` consumer-keyed tables as defence in depth under
      the app role; the application already scopes every query, RLS catches
      the query that forgets.
- [ ] Redis provisioned (rate limits + replay cache only — never a source of
      truth; cold start must be safe).
- [ ] Real KMS wired (`MERITED_KMS_*` env): master key created, key policy
      restricted to the trio's service identity; fake-kms is torn down.
- [ ] S3 bucket for head publication (`MERITED_HEADS_BUCKET`) — public-read
      object policy on `heads/*`; run the real-S3 smoke test (PH1-21 accept).
- [ ] VAPID production keypair generated into env (`MERITED_VAPID_*`).
- [ ] Resend production key (`MERITED_RESEND_API_KEY`) — swap from Mailpit by
      env only; no code change.
- [ ] OTel exporter pointed at Axiom/Grafana (§2.2); alert routes for
      `mint_vs_claim_under_reporting` and head-publication failures.

## Keys & audit

- [ ] Key-rotation rehearsal executed against the REAL trio per
      `apps/trio/runbooks/key-rotation.md` §3 (routine < 15 min, compromise
      < 60 min) and minuted for LEAD-5.
- [ ] `verify-chain --against-heads` wired into the ops cron beside the daily
      head publication job.
- [ ] TRIO-16 handoff pack + TRIO-17 directory seam reviewed (the trio still
      verifies every consent artefact's attestation before trusting it).

## Partner onboarding (per merchant, ~5 minutes — the MER-5 clause)

- [ ] Merchant record + commercial config through the control plane.
- [ ] Webhook secret issued (shown once) and configured in the partner's shop.
- [ ] Custodied signing keypair requested (real commitment service).
- [ ] Partner webhook endpoint verified: one test order → claim → verdict →
      statement, with the trace URL captured.
- [ ] Mint-vs-claim monitor floor/window agreed and configured for the
      partner's expected claim latency; badge visible on the merchant record.
- [ ] If the partner has an IdP: register Merited as an OAuth client and add
      the programme to the IdP registry. If not: hosted linking
      (member-number + verification email — never credential capture).

## The drills to re-run on live rails (from `e2e-phase1.ts`)

- [ ] Walletless conversion — one trace end-to-end, chain verifies.
- [ ] Wallet-path conversion — link, mandate, push, approve, re-mint, points.
- [ ] `FAKESHOP_DROP_WEBHOOK_PCT`-equivalent: drop the partner's webhook in
      staging → the monitor alerts within one projection cycle.
- [ ] Webhook replay → exactly one claim.
- [ ] Mid-flow mandate revocation → `MANDATE_REVOKED` on the next attempt.
