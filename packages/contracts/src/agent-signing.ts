import { z } from 'zod';
import { Id } from './ids.js';

/**
 * Agent request signing (PH1-1/PH1-5, B4 upgrade). Requests carry four
 * headers; the signature is Ed25519 over the CANONICAL STRING below —
 * defined here once so client (SDK), server (core) and tests can never
 * drift. Timestamp skew tolerance is SYN-24's ±300s; the nonce is
 * replay-defended via ReplayCache (Redis fast path, never authoritative —
 * the skew window bounds the exposure either way).
 */

export const AGENT_SIGNATURE_HEADERS = {
  agentId: 'x-merited-agent-id',
  timestamp: 'x-merited-timestamp',
  nonce: 'x-merited-nonce',
  signature: 'x-merited-signature',
} as const;

export const AGENT_SIGNATURE_MAX_SKEW_S = 300;

/** The signed-request header set as it arrives (lowercased by HTTP). */
export const AgentSignatureHeaders = z.object({
  'x-merited-agent-id': Id('agt'),
  /** Unix seconds, as a decimal string on the wire. */
  'x-merited-timestamp': z.string().regex(/^\d{1,12}$/),
  /** Client-generated single-use value, ≥ 16 chars. */
  'x-merited-nonce': z.string().min(16).max(128),
  /** base64url Ed25519 signature over the canonical string. */
  'x-merited-signature': z.string().min(1),
});
export type AgentSignatureHeaders = z.infer<typeof AgentSignatureHeaders>;

export interface AgentCanonicalParts {
  method: string;
  /** Path + query exactly as sent, e.g. `/v1/offers?sku=sku_spa_day`. */
  pathWithQuery: string;
  /** Lowercase sha256 hex of the raw request body ('' body hashes too). */
  bodySha256: string;
  /** The `x-merited-timestamp` value. */
  timestamp: string;
  /** The `x-merited-nonce` value. */
  nonce: string;
}

/**
 * The exact byte string the agent signs (PH1-5's order):
 *   METHOD ‖ '\n' ‖ path?query ‖ '\n' ‖ sha256(body) ‖ '\n' ‖ ts ‖ '\n' ‖ nonce
 */
export const agentCanonicalString = (parts: AgentCanonicalParts): string =>
  `${parts.method.toUpperCase()}\n${parts.pathWithQuery}\n${parts.bodySha256}\n${parts.timestamp}\n${parts.nonce}`;
