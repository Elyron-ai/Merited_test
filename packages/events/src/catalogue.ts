import {
  MERITED_EVENT_BODIES,
  MERITED_EVENT_NAMES,
  type MeritedEventName,
} from '@merited/contracts';

/**
 * Frozen name → schema registry (FND D9). Body schemas are defined ONCE in
 * @merited/contracts (§1 single-source rule); this registry is what the
 * append path (FND-10) validates against — unregistered types are rejected
 * at append time.
 */
export const EVENT_CATALOGUE = Object.freeze({ ...MERITED_EVENT_BODIES });

export const isCatalogueEvent = (name: string): name is MeritedEventName =>
  Object.prototype.hasOwnProperty.call(EVENT_CATALOGUE, name);

export { MERITED_EVENT_NAMES };
export type { MeritedEventName };
