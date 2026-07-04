import { context, propagation, SpanKind, trace } from '@opentelemetry/api';

/**
 * Server-span hooks for Fastify (structural typing — no runtime fastify dep):
 * extracts inbound W3C `traceparent`, opens a server span, binds it as the
 * active context for the handler, closes on response.
 */
interface Fastifyish {
  addHook(name: 'onRequest', hook: (req: Requestish, reply: unknown) => Promise<void>): void;
  addHook(name: 'onResponse', hook: (req: Requestish, reply: Replyish) => Promise<void>): void;
}
interface Requestish {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  otelSpan?: ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>;
}
interface Replyish {
  statusCode: number;
}

export const registerTracing = (app: Fastifyish, serviceName: string): void => {
  const tracer = trace.getTracer(serviceName);
  app.addHook('onRequest', async (req) => {
    const parentCtx = propagation.extract(context.active(), req.headers);
    const span = tracer.startSpan(
      `${req.method} ${req.url.split('?')[0]}`,
      { kind: SpanKind.SERVER, attributes: { 'http.method': req.method, 'http.target': req.url } },
      parentCtx,
    );
    req.otelSpan = span;
    // Fastify hooks lack a wrap point for the whole handler, so handler
    // bodies opt in via `inRequestSpan(req, work)` below.
  });
  app.addHook('onResponse', async (req, reply) => {
    req.otelSpan?.setAttribute('http.status_code', reply.statusCode);
    req.otelSpan?.end();
  });
};

/** Run a handler body inside the request's server-span context. */
export const inRequestSpan = async <T>(req: Requestish, work: () => Promise<T> | T): Promise<T> => {
  const span = req.otelSpan;
  if (!span) return work();
  return context.with(trace.setSpan(context.active(), span), work);
};
