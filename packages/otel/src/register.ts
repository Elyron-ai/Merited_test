import { initOtel } from './sdk.js';

/**
 * Boot entry (FND-14): `import '@merited/otel/register'` first thing in every
 * app. Exporter selection: MERITED_OTLP_ENDPOINT set → OTLP (Axiom/Grafana,
 * §2.2); otherwise console. MERITED_OTEL=off disables spans entirely.
 * Sentry (§2.2) initialises only when MERITED_SENTRY_DSN is set — disabled
 * locally by default; the dependency is loaded lazily so local dev never
 * pays for it.
 */
initOtel({
  serviceName: process.env['MERITED_SERVICE_NAME'] ?? 'merited',
  ...(process.env['MERITED_OTEL'] === 'off' ? { exporter: 'none' as const } : {}),
});

const sentryDsn = process.env['MERITED_SENTRY_DSN'];
if (sentryDsn) {
  const sentryModule = '@sentry/node';
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  import(/* @vite-ignore */ sentryModule as string)
    .then((Sentry: { init: (o: { dsn: string }) => void }) => Sentry.init({ dsn: sentryDsn }))
    .catch(() => {
      console.error('MERITED_SENTRY_DSN set but @sentry/node is not installed');
    });
}
