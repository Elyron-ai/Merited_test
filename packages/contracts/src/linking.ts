import { z } from 'zod';
import { Id } from './ids.js';
import { IdentityLink } from './identity-link.js';

/**
 * Account-linking DTOs (PH1-1 → PH1-13/14, B23). Tokens NEVER appear here
 * (§6.3): the OAuth exchange happens server-side and the resulting
 * access/refresh material lives encrypted in the wallet's `link_tokens`
 * store — these shapes carry only the flow plumbing.
 */

/** `POST /v1/links/start` — wallet session → provider authorize hop. */
export const LinkStartRequest = z.object({
  merchant_id: Id('mer'),
  programme: z.string().min(1),
  /** Where the wallet UI resumes after the callback. */
  return_url: z.string().url().optional(),
});
export type LinkStartRequest = z.infer<typeof LinkStartRequest>;

export const LinkStartResponse = z.object({
  authorize_url: z.string().url(),
  /** Opaque CSRF state — the callback must return it verbatim. */
  state: z.string().min(1),
});
export type LinkStartResponse = z.infer<typeof LinkStartResponse>;

/** Provider → wallet callback query (`GET /v1/links/callback`). */
export const LinkCallbackParams = z.object({
  state: z.string().min(1),
  code: z.string().min(1).optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});
export type LinkCallbackParams = z.infer<typeof LinkCallbackParams>;

export const LinkResult = z.object({
  link: IdentityLink,
});
export type LinkResult = z.infer<typeof LinkResult>;

// ── Hosted-linking fallback (PH1-14): IdP-less programmes ──────────────────

/** Member-number entry starts a verification-email loop via `Mailer`. */
export const HostedLinkStartRequest = z.object({
  merchant_id: Id('mer'),
  programme: z.string().min(1),
  member_ref: z.string().min(1),
  email: z.string().email(),
});
export type HostedLinkStartRequest = z.infer<typeof HostedLinkStartRequest>;

export const HostedLinkStartResponse = z.object({
  /** Opaque attempt handle; the emailed token redeems against it. */
  attempt_id: z.string().min(1),
  verification_sent: z.literal(true),
});
export type HostedLinkStartResponse = z.infer<typeof HostedLinkStartResponse>;

/** Redeeming the emailed token completes the SAME `IdentityLink` shape the
 * OAuth path produces — downstream code cannot tell the flows apart. */
export const HostedLinkVerifyRequest = z.object({
  attempt_id: z.string().min(1),
  token: z.string().min(1),
});
export type HostedLinkVerifyRequest = z.infer<typeof HostedLinkVerifyRequest>;
