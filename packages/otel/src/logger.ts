import { pino, type Logger, type DestinationStream } from 'pino';
import { activeTraceId } from './sdk.js';
import { trace } from '@opentelemetry/api';

/**
 * Structured logger factory (FND-14): every line carries trace_id/span_id
 * from the active span, and the redact paths are pre-wired for FND-15's
 * secret-hygiene rule — refresh/access tokens and auth headers never reach
 * a log sink unredacted (§6.3).
 */
export const REDACT_PATHS = [
  'refresh_token',
  'access_token',
  '*.refresh_token',
  '*.access_token',
  'req.headers.authorization',
  'headers.authorization',
];

export const createLogger = (name: string, stream?: DestinationStream): Logger =>
  pino(
    {
      name,
      redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
      mixin() {
        const span = trace.getActiveSpan();
        return span
          ? { trace_id: span.spanContext().traceId, span_id: span.spanContext().spanId }
          : {};
      },
    },
    stream,
  );

export { activeTraceId };
