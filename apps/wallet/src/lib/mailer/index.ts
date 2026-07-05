import { resendEnvShape, type Mailer } from '@merited/contracts';
import { defineEnv } from '@merited/contracts';
import { ResendMailer } from './resend.js';
import { SmtpMailer } from './smtp.js';

export { ResendMailer, type ResendMailerOptions } from './resend.js';
export { SmtpMailer, type SmtpMailerOptions } from './smtp.js';

/**
 * Env-selected mailer (PH1-7): `MERITED_MAILER=smtp` (dev/test → Mailpit)
 * or `resend` (production). Resend credentials validate through the shared
 * `resendEnvShape` (stubbed in dev; a real key is an env change).
 */
export const mailerFor = (source: Record<string, string | undefined> = process.env): Mailer => {
  const kind = source['MERITED_MAILER'] ?? 'smtp';
  if (kind === 'resend') {
    const env = defineEnv(resendEnvShape, source);
    return new ResendMailer({ apiKey: env.MERITED_RESEND_API_KEY, from: env.MERITED_RESEND_FROM });
  }
  return new SmtpMailer({
    host: source['MERITED_SMTP_HOST'] ?? 'localhost',
    port: Number.parseInt(source['MERITED_SMTP_PORT'] ?? '1025', 10),
    from: source['MERITED_MAIL_FROM'] ?? 'noreply@merited.test',
  });
};
