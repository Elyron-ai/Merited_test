import { context, propagation, trace, type Span, type Tracer } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * OTel bootstrap (FND-14, B21). One trace ID must span
 * read → mint → checkout webhook → verify → ledger entries — that trace IS
 * the demo asset (§8). Exporter selection per §2.2: console locally,
 * OTLP (Axiom/Grafana) env-gated.
 *
 * Propagation is automatic for HTTP: initOtel registers http + undici
 * instrumentations, so inbound requests open a server span the handler
 * inherits and outbound `fetch` carries traceparent by itself (MER-12's
 * e2e proved hooks alone cannot do this — Fastify has no handler wrap
 * point). `withSpan` wraps in-process work; `injectTraceparent` remains
 * only for non-fetch transports.
 */
export interface OtelOptions {
  serviceName: string;
  exporter?: 'console' | 'otlp' | 'memory' | 'none';
  otlpEndpoint?: string;
}

let provider: NodeTracerProvider | null = null;
let memoryExporter: InMemorySpanExporter | null = null;

export const initOtel = (options: OtelOptions): void => {
  if (provider) return; // idempotent — first init wins per process
  const exporterKind = options.exporter ?? (process.env['MERITED_OTLP_ENDPOINT'] ? 'otlp' : 'console');

  let exporter: SpanExporter | null = null;
  if (exporterKind === 'console') exporter = new ConsoleSpanExporter();
  if (exporterKind === 'otlp') {
    const url = options.otlpEndpoint ?? process.env['MERITED_OTLP_ENDPOINT'];
    exporter = new OTLPTraceExporter(url ? { url } : {});
  }
  if (exporterKind === 'memory') {
    memoryExporter = new InMemorySpanExporter();
    exporter = memoryExporter;
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': options.serviceName }),
    spanProcessors: exporter
      ? [
          exporterKind === 'otlp'
            ? new BatchSpanProcessor(exporter)
            : new SimpleSpanProcessor(exporter),
        ]
      : [],
  });
  provider.register({ propagator: new W3CTraceContextPropagator() });
  // §8/B21 one-trace: auto-instrument inbound node:http servers and outbound
  // fetch (undici) so handler bodies inherit the request context and every
  // hop joins the same trace — Fastify has no wrap point for handlers, so
  // hooks alone cannot carry the context (found by MER-12's e2e).
  registerInstrumentations({
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });
};

/** Test hook: the in-memory exporter when initOtel({exporter:'memory'}) was used. */
export const getMemoryExporter = (): InMemorySpanExporter | null => memoryExporter;

export const shutdownOtel = async (): Promise<void> => {
  await provider?.shutdown();
  provider = null;
  memoryExporter = null;
};

export const tracer = (): Tracer => trace.getTracer('@merited/otel');

/** Run work inside a child span of the active context. */
export const withSpan = async <T>(name: string, work: (span: Span) => Promise<T> | T): Promise<T> => {
  return tracer().startActiveSpan(name, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: 2 });
      throw error;
    } finally {
      span.end();
    }
  });
};

/** Inject the active trace context into outbound headers (W3C traceparent).
 * NON-FETCH transports (queues, in-process `app.inject`) only — real `fetch`
 * calls are auto-instrumented, and adding this on top produces a doubled
 * comma-joined traceparent that breaks extraction (found by MER-12's e2e). */
export const injectTraceparent = (headers: Record<string, string> = {}): Record<string, string> => {
  propagation.inject(context.active(), headers);
  return headers;
};

export const activeTraceId = (): string | null =>
  trace.getActiveSpan()?.spanContext().traceId ?? null;
