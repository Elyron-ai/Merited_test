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
