// Loaded via vitest setupFiles BEFORE any test module: auto-instrumentation
// must patch node:http/undici before fastify captures them (the production
// boot gets this ordering from `import '@merited/otel/register'` first).
import { initOtel } from '@merited/otel';

initOtel({ serviceName: 'core-tests', exporter: 'memory' });
