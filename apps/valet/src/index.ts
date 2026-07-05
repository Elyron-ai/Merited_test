// @merited/valet — Valet v0 (B18). The errand state machine lands with
// VAL-2; store, ports, driver and CLI follow in their workstream tasks.
export { transition, isTerminal, type TransitionResult } from './errand/reducer.js';
export {
  ErrandStore,
  StaleTransitionError,
  type CreateErrandInput,
  type ErrandEventRow,
  type StoredErrand,
} from './errand/store.js';
export {
  EventsPackageMirror,
  type LedgerMirror,
  type MirrorResult,
  type MirrorTransition,
} from './errand/ledger-mirror.js';
export { QuoteClient, type QuoteClientOptions, type ReadQuery } from './ports/quote-client.js';
export {
  PostgresCredentialsStore,
  type AgentCredentials,
  type CredentialsStore,
} from './ports/credentials.js';
export {
  CheckoutFailedError,
  FakeShopRail,
  type CheckoutConfirmation,
  type CheckoutRail,
  type CheckoutRequest,
} from './ports/checkout-rail.js';
export { UcpCheckoutRail, type UcpRailOptions } from './ports/ucp-rail.js';
export { VerdictPoller, VerdictTimeoutError, type VerdictEvent } from './ports/verdict-poller.js';
export { AutoSkipGate, WalletApprovalGate, type ApprovalGate, type ApprovalOutcome } from './ports/approval-gate.js';
export { ErrandDriver, InvalidDispatchError, searchTermsFrom, type DriverDeps } from './errand/driver.js';
export { shopCatalogueSkuResolver } from './ports/checkout-rail.js';
export {
  AnthropicInterpreter,
  interpreterFromEnv,
  priceCeilingFrom,
  ScriptedInterpreter,
  type BriefInterpreter,
  type InterpretContext,
} from './interpreter/index.js';
export { type ApprovalContext } from './ports/approval-gate.js';
