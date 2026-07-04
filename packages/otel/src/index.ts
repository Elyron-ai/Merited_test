// @merited/otel — tracing bootstrap, span helpers, traced logger (B21).
export {
  activeTraceId,
  getMemoryExporter,
  initOtel,
  injectTraceparent,
  shutdownOtel,
  tracer,
  withSpan,
} from './sdk.js';
export { inRequestSpan, registerTracing } from './fastify-plugin.js';
export { createLogger, REDACT_PATHS } from './logger.js';
