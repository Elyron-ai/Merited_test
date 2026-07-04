// MUST be act1's first import: http instrumentation patches node:http via
// require interception, so it has to run before Fastify's modules load
// (MER-12's lesson). Exporter 'none' — spans exist for trace IDs and W3C
// propagation; nothing is shipped anywhere.
import { initOtel } from '@merited/otel';

initOtel({ serviceName: 'merited-demo', exporter: 'none' });
