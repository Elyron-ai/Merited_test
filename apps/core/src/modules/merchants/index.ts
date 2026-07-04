// Merchants module (MER-2): CRUD, webhook secrets, custodied-key issuance.
export {
  MerchantsService,
  type CreateMerchantInput,
  type IssuedWebhookSecret,
  type TrioKeyIssuer,
} from './service.js';
export { TrioKeysClient, type TrioKeysClientOptions } from './trio-keys-client.js';
