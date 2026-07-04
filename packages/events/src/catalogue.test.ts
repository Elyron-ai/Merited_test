import { describe, expect, it } from 'vitest';
import { EVENT_CATALOGUE, isCatalogueEvent, MERITED_EVENT_NAMES } from './catalogue.js';

describe('event catalogue registry (FND-7 accept)', () => {
  it('covers exactly the 20 names (meta-test)', () => {
    expect(Object.keys(EVENT_CATALOGUE)).toHaveLength(20);
    expect(Object.keys(EVENT_CATALOGUE).sort()).toEqual([...MERITED_EVENT_NAMES].sort());
  });

  it('is frozen — additions are a deliberate contracts-first PR, not a runtime mutation', () => {
    expect(Object.isFrozen(EVENT_CATALOGUE)).toBe(true);
    expect(() => {
      (EVENT_CATALOGUE as Record<string, unknown>)['RogueEvent'] = {};
    }).toThrow();
  });

  it('isCatalogueEvent guards unregistered types (consumed by FND-10 append)', () => {
    expect(isCatalogueEvent('CommitmentCreated')).toBe(true);
    expect(isCatalogueEvent('RogueEvent')).toBe(false);
    expect(isCatalogueEvent('commitmentcreated')).toBe(false);
  });
});
