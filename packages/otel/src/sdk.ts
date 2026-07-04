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
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

/**
 * OTel bootstrap (FND-14, B21). One trace ID must span
 * read → mint → checkout webhook → verify → ledger entries — that trace IS
 * the demo asset (§8). Exporter selection per §2.2: console locally,
 * OTLP (Axiom/Grafana) env-gated.
 *
 * Deviation from the plan's "auto-instrumentation" wording (recorded in the
 * build log): propagation is explicit — the fastify plugin extracts
 * traceparent, `injectTraceparent` carries it on outbound calls, and
 * `withSpan`/`tracedQuery` wrap work — deterministic under ESM, no loader
 * hooks in every app boot.
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

/** Inject the active trace context into outbound headers (W3C traceparent). */
export const injectTraceparent = (headers: Record<string, string> = {}): Record<string, string> => {
  propagation.inject(context.active(), headers);
  return headers;
};

export const activeTraceId = (): string | null =>
  trace.getActiveSpan()?.spanContext().traceId ?? null;
