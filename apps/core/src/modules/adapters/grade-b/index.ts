// Grade-B webhook adapter (MER-3 intake; MER-4 pipeline plugs in behind OrderProcessor).
export { registerGradeBWebhook, type GradeBDeps, type OrderProcessor } from './routes.js';
export { verifyWebhookSignature, type WebhookVerification } from './verify.js';
export { GradeBOrderProcessor, type GradeBProcessorDeps } from './processor.js';
export { normaliseOrder } from './normalise.js';
export { buildSignedClaim, decodeTokenClaims } from './claim-builder.js';
