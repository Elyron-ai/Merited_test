// @merited/fake-aurora — the standing fictional org (SYN-33). Phase 0 ships
// the FakeShop storefront (MER-11); src/idp/ (OIDC) and src/loyalty/ land
// beside it in Phase 1 without a move.
export { createFakeShop, type FakeShopOptions } from './shop/server.js';
export { CATALOGUE, skuByRef, type CatalogueSku } from './shop/catalogue.js';
export { deliverOrderWebhook, type DeliveryResult, type WebhookDeliveryOptions } from './shop/webhook-sender.js';
