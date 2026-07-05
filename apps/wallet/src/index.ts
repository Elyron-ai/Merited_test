// @merited/wallet — the consumer wallet backend (Phase 1+). Modules land
// with their workstream tasks; the mailer adapter (PH1-7) is the first.
export { mailerFor, ResendMailer, SmtpMailer } from './lib/mailer/index.js';
export type { ResendMailerOptions, SmtpMailerOptions } from './lib/mailer/index.js';
export { LinkTokenStore } from './modules/linking/link-token-store.js';
export { buildWalletServer, type WalletServerOptions } from './server.js';
export { MagicLinkAuth } from './auth/magic-link.js';
export { SessionStore, WALLET_SESSION_COOKIE } from './auth/session.js';
export { PdStore } from './modules/pd-store/pd-store.js';
