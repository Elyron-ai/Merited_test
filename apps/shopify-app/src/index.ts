// @merited/shopify-app — Shopify Grade-A integration (PH3-5, §5.8 / §2.2).
// The checkout-side token capture (cart attribute), the orders/paid
// subscription config, and the simulated dev store CI runs against until
// LEAD-3's real store lands (launch-readiness A12).
export { cartAttributesFor, ordersPaidSubscription } from './capture.js';
export {
  createSimulatedShopifyStore,
  STORE_CATALOGUE,
  type SimulatedShopifyStoreOptions,
  type SimulatedStoreSku,
} from './simulated-store.js';
