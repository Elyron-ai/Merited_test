import { z } from 'zod';

/**
 * Mail message shape (PH1-7). The `Mailer` PORT lives in `ports/index.ts`
 * (FND-6 — the single source both impls implement); this schema validates a
 * message at the boundary so `ResendMailer` and `SmtpMailer` reject the same
 * malformed input identically. UK-English copy is the caller's; the mailer
 * only carries bytes.
 */
export const MailMessage = z.object({
  to: z.string().email(),
  subject: z.string().min(1),
  text: z.string().min(1),
  html: z.string().optional(),
});
export type MailMessage = z.infer<typeof MailMessage>;
