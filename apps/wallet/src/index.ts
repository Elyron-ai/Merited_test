// @merited/wallet — the consumer wallet backend (Phase 1+). Modules land
// with their workstream tasks; the mailer adapter (PH1-7) is the first.
export { mailerFor, ResendMailer, SmtpMailer } from './lib/mailer/index.js';
export type { ResendMailerOptions, SmtpMailerOptions } from './lib/mailer/index.js';
