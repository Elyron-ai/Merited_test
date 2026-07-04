// Grade-B webhook adapter (MER-3 intake; MER-4 pipeline plugs in behind OrderProcessor).
export { registerGradeBWebhook, type GradeBDeps, type OrderProcessor } from './routes.js';
export { verifyWebhookSignature, type WebhookVerification } from './verify.js';
