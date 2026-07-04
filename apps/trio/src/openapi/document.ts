import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import {
  CommitmentCreateResponse,
  CommitmentDraft,
  CommitmentEndRequest,
  CommitmentEndResponse,
  CommitmentStatus,
  MintRequest,
  MintResponse,
  NettingRunRequest,
  NettingRunResult,
  Position,
  ReverseRequest,
  ReverseResponse,
  Statement,
  VerifyRequest,
  VerifyResponse,
  type RejectionReasonCode,
} from '@merited/contracts';
import { z } from 'zod';

extendZodWithOpenApi(z);

/**
 * TRIO-14: the trio's OpenAPI document, generated from the SAME Zod schemas
 * the routes parse (`packages/contracts`) — the yaml on disk is a build
 * artefact; `openapi.test.ts` fails CI on any drift from this source.
 *
 * Frozen at M1 with the contract suite (XC-7): post-freeze changes are
 * contracts-first PRs with a recorded high-scrutiny review.
 */

/** Trigger conditions per reason code — exhaustive over the closed enum by
 * construction (a new enum member fails this file's compilation). */
export const REASON_TRIGGERS: Record<RejectionReasonCode, string> = {
  SIG_INVALID:
    'Stage 1 (signature chain) — the merchant signature on the claim, the platform signature on the token, or either COR countersignature fails; or the claim references records the trio does not hold (unknown token, a different merchant’s commitment). Reversals reuse this code for unknown claims, foreign merchants and bad signatures (SYN-35).',
  TOKEN_REPLAYED:
    'Stage 2 (replay) — the token’s jti was already consumed by a verified conversion, or its qid already produced one via a re-mint (SYN-9: one verified conversion per quote, ever). A second reversal of the same conversion also reuses this code (SYN-35).',
  WINDOW_EXPIRED:
    'Stage 3 (attribution window) — order.ts falls outside [iat, iat + attribution_window_s]. A reversal submitted after clawback_window_s reuses this code with the clawback window as the trigger (SYN-10).',
  QUOTE_EXPIRED:
    'Stage 4 (quote liveness) — order.ts is after the quote expiry snapshotted at mint time (SYN-8: the trio trusts only its own mint record).',
  COMMITMENT_ENDED:
    'Stage 5 (commitment terms) — order.ts falls outside the COR’s valid_from/valid_until. Ending a commitment stops NEW mints only; in-flight tokens still verify (SYN-34 — no retroactive repricing).',
  CAP_EXHAUSTED:
    'Stage 5 (commitment terms) — max_conversions is used up. A clawback reversal frees the cap (SYN-10).',
  TIER_INELIGIBLE:
    'Stage 5 (commitment terms) — the token’s identity tier is not in the COR’s eligible_identity_tiers.',
  BUDGET_EXHAUSTED:
    'Stage 5 (commitment terms) — the commitment’s registered budget cannot cover this conversion’s bounty (SYN-12: budget is a Settlement counter, not a COR field).',
  APPROVAL_MISSING:
    'Stage 6 (approval checks, wallet path) — the token was minted under a mandate but carries no approval (SYN-8 guard), or the referenced approval is unknown or bound to a different quote.',
  APPROVAL_EXPIRED: 'Stage 6 (approval checks) — order.ts is after the approval’s expiry.',
  MANDATE_REVOKED:
    'Stage 6 (approval checks) — the mandate is missing, not active, or its attestation fails verification. Mandate status is read live on every claim; revocation takes effect immediately (B14).',
  LIMIT_EXCEEDED:
    'Stage 6 (approval checks) — the order’s gross value breaches the mandate’s per_txn limit, or cumulative verified spend this calendar month would breach per_month (SYN-11).',
};

const PIPELINE_DOC = [
  'Runs the normative six-stage verification pipeline, in this exact order, first-failure-wins',
  '(the response carries the reason code of the EARLIEST failing stage — SYN-2):',
  '',
  '1. **Signature chain** — merchant claim signature → platform token signature → both COR countersignatures.',
  '2. **Replay** — single-use jti; one verified conversion per qid (SYN-9). Consumption is atomic with the verdict: a rejected claim never burns the token.',
  '3. **Attribution window** — order.ts within [iat, iat + attribution_window_s].',
  '4. **Quote liveness** — order.ts within the quote expiry snapshotted at mint (SYN-8).',
  '5. **Commitment terms** — COR validity (SYN-34), conversion cap, identity tier, budget.',
  '6. **Approval checks** — wallet path only (apr set, or minted under a mandate): approval exists, quote-bound, unexpired; mandate active (live read) and within per_txn/per_month limits. Walletless claims (apr null, no mandate) skip this stage by design.',
  '',
  '### Rejection reason codes',
  '',
  ...Object.entries(REASON_TRIGGERS).map(([code, trigger]) => `- \`${code}\`: ${trigger}`),
  '',
  '### Idempotency (§8/D7)',
  '',
  'The `Idempotency-Key` header is required. Replaying the same key with the same body returns the',
  'stored original response **byte-for-byte** (responses are canonically serialised) without',
  're-executing the pipeline. The same key with a different body is rejected with HTTP 422',
  '(`IDEMPOTENCY_CONFLICT`).',
].join('\n');

const errorBody = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: z.object({ error: z.object({ code: z.string() }) }),
    },
  },
});

export const buildOpenApiDocument = (): ReturnType<OpenApiGeneratorV3['generateDocument']> => {
  const registry = new OpenAPIRegistry();

  registry.registerComponent('securitySchemes', 'serviceToken', {
    type: 'apiKey',
    in: 'header',
    name: 'X-Merited-Service-Token',
    description:
      'Phase-0 transport gate (SYN-24): a shared service token on every route except /healthz. PH1-25 upgrades transport auth; payload trust always comes from signatures, never from this header.',
  });

  const security = [{ serviceToken: [] }];

  registry.registerPath({
    method: 'post',
    path: '/trio/commitments',
    summary: 'Countersign a commitment (COR) — §7.1',
    description:
      'Unsigned draft in, countersigned Commitment Object Record out. CORs are immutable: there is no update surface, and ledger roles revoke UPDATE/DELETE at the database. An optional budget registers a spend counter in Settlement; the COR itself stays budget-free (SYN-12). Emits `CommitmentCreated`.',
    security,
    request: {
      body: { content: { 'application/json': { schema: CommitmentDraft } } },
    },
    responses: {
      200: {
        description: 'The countersigned COR.',
        content: { 'application/json': { schema: CommitmentCreateResponse } },
      },
      400: errorBody('Malformed draft (`VALIDATION_FAILED`).'),
      401: errorBody('Missing or wrong service token (`SERVICE_AUTH_FAILED`).'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/trio/commitments/{id}/end',
    summary: 'End a commitment — §7.1',
    description:
      'Stops NEW token mints against the commitment. In-flight tokens still verify until their own windows close (SYN-34: §5.1 "old tokens still verify" governs — no retroactive repricing). Emits `CommitmentEnded`.',
    security,
    request: {
      params: z.object({ id: z.string() }),
      body: { content: { 'application/json': { schema: CommitmentEndRequest } } },
    },
    responses: {
      200: {
        description: 'Ended.',
        content: { 'application/json': { schema: CommitmentEndResponse } },
      },
      404: errorBody('Unknown commitment (`COMMITMENT_NOT_FOUND`).'),
      409: errorBody('Already ended (`COMMITMENT_ALREADY_ENDED`).'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/trio/commitments/{id}',
    summary: 'Commitment status — SYN-7',
    description:
      'Liveness (live / ended / expired / not_yet_valid) plus the Settlement counters (conversions used, budget remaining). Consumed by eligibility (CORE-6).',
    security,
    request: { params: z.object({ id: z.string() }) },
    responses: {
      200: {
        description: 'Current status.',
        content: { 'application/json': { schema: CommitmentStatus } },
      },
      404: errorBody('Unknown commitment (`COMMITMENT_NOT_FOUND`).'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/trio/tokens/mint',
    summary: 'Mint a quote-bound attribution token — §7.2',
    description:
      'Mints a single-use, quote-bound token (≤10-minute life, capped by the attribution window). The request snapshots the quote expiry and mandate reference (SYN-8) so verification never calls back into Core. Re-mint after an approval (B26): same qid, fresh jti, apr set — only one token per qid ever converts (SYN-9). Tokens are opaque to every consumer; claims are returned alongside for bookkeeping. Emits `TokenMinted`.',
    security,
    request: { body: { content: { 'application/json': { schema: MintRequest } } } },
    responses: {
      200: {
        description: 'Token + claims.',
        content: { 'application/json': { schema: MintResponse } },
      },
      400: errorBody('Malformed request (`VALIDATION_FAILED`).'),
      404: errorBody('Unknown commitment (`COMMITMENT_NOT_FOUND`).'),
      409: errorBody('Commitment not live (`COMMITMENT_NOT_LIVE`).'),
      422: errorBody('Quote expiry beyond token life (`QUOTE_EXPIRY_EXCEEDS_TOKEN`).'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/trio/claims/verify',
    summary: 'Verify a conversion claim — §7.2',
    description: PIPELINE_DOC,
    security,
    request: {
      headers: z.object({
        'idempotency-key': z.string().openapi({
          description: 'Required. Same key + same body replays the stored verdict byte-for-byte.',
        }),
      }),
      body: { content: { 'application/json': { schema: VerifyRequest } } },
    },
    responses: {
      200: {
        description:
          'The verdict — verified with a preview of the exact posted entry set, or rejected with the earliest failing stage’s reason code.',
        content: { 'application/json': { schema: VerifyResponse } },
      },
      400: errorBody('Malformed claim or missing idempotency key.'),
      422: errorBody('Same idempotency key, different body (`IDEMPOTENCY_CONFLICT`).'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/trio/claims/reverse',
    summary: 'Clawback reversal — §7.3',
    description:
      'Merchant-signed `ConversionReversed` claim, accepted only within the COR’s clawback_window_s of the conversion (after-window reuses `WINDOW_EXPIRED` — SYN-10). Posts the exact side-flipped entry set (history is append-only; net effect zero for the conversion) and frees the max_conversions counter — and only that counter. Double-reverse reuses `TOKEN_REPLAYED`; unknown claims, foreign merchants and bad signatures reuse `SIG_INVALID` (SYN-35). A reversal of an already-netted conversion posts into the open period. Emits `ConversionReversed`.',
    security,
    request: { body: { content: { 'application/json': { schema: ReverseRequest } } } },
    responses: {
      200: {
        description: 'Reversed with the reversing entry set, or rejected.',
        content: { 'application/json': { schema: ReverseResponse } },
      },
      400: errorBody('Malformed request (`VALIDATION_FAILED`).'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/trio/netting/run',
    summary: 'Netting run — §7.3',
    description:
      'Folds every un-netted entry set into per-party net positions (SYN-36 party mapping; zero folds omitted; positions always sum to zero). Entries are never edited — an append-only marker records the fold, and a set folds into exactly one run ever. Payout instructions are out of scope (SimulatedPayouts/statements-only through Phase 1). Emits `SettlementNetted`.',
    security,
    request: { body: { content: { 'application/json': { schema: NettingRunRequest } } } },
    responses: {
      200: {
        description: 'The run’s folded positions.',
        content: { 'application/json': { schema: NettingRunResult } },
      },
      400: errorBody('Malformed period (`INVALID_PERIOD`, format YYYY-MM).'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/trio/positions/{party}',
    summary: 'Live net position — §7.3',
    description:
      'Σ of the party’s account lines, netted or not (SYN-36: `mer_*`/`agt_*` ids, `platform`, or `reserve`; credit positive — a balance ≥ 0 is receivable, < 0 payable).',
    security,
    request: { params: z.object({ party: z.string() }) },
    responses: {
      200: { description: 'Current position.', content: { 'application/json': { schema: Position } } },
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/trio/statements/{party}/{period}',
    summary: 'Statement (JSON) — §7.3',
    description:
      'Opening balance, the party’s entry lines in the period (YYYY-MM), netting events that folded the party’s entries, and the closing balance. Closing always equals the live position once the period covers all activity.',
    security,
    request: { params: z.object({ party: z.string(), period: z.string() }) },
    responses: {
      200: { description: 'The statement.', content: { 'application/json': { schema: Statement } } },
      400: errorBody('Malformed period (`INVALID_PERIOD`).'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/trio/statements/{party}/{period}/pdf',
    summary: 'Statement (rendered PDF) — §7.3',
    description: 'The same statement rendered to PDF via the Playwright/Chromium path.',
    security,
    request: { params: z.object({ party: z.string(), period: z.string() }) },
    responses: {
      200: {
        description: 'The statement document.',
        content: { 'application/pdf': { schema: z.string().openapi({ format: 'binary' }) } },
      },
      400: errorBody('Malformed period (`INVALID_PERIOD`).'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/healthz',
    summary: 'Liveness probe (unauthenticated)',
    responses: {
      200: {
        description: 'Service is up.',
        content: {
          'application/json': { schema: z.object({ ok: z.boolean(), service: z.string() }) },
        },
      },
    },
  });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Merited trio — Commitment Signing, Token Mint + Conversion Verification, Net Settlement',
      version: '0.1.0',
      description:
        'The security-critical trio (BUILD-SPEC §7). Phase 0 serves these contracts from behaviourally faithful simulators; PH1-24…26 replace them file-for-file behind the UNCHANGED TRIO-13 contract suite. This document is generated from the packages/contracts Zod schemas — CI fails on drift.',
    },
    security: [{ serviceToken: [] }],
  });
};
