import type { RejectionReasonCode } from '@merited/contracts';

/**
 * Service-level HTTP error carrying the §1 structured envelope fields:
 * `{ error: { code, message, reason_code? } }`. Route handlers throw it;
 * the validation plugin's error handler shapes the response.
 */
export class CoreHttpError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message?: string,
    public readonly reasonCode?: RejectionReasonCode,
  ) {
    super(message ?? code);
    this.name = 'CoreHttpError';
  }
}
