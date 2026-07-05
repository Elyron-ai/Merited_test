import type { Decisioner } from '@merited/contracts';
import { PassthroughDecisioner, RandomDecisioner } from './index.js';
import { RulesDecisioner, type RulesDecisionerOptions } from './rules-decisioner.js';

/**
 * Config-selected decisioner registry (PH1-4): `MERITED_DECISIONER` names
 * the implementation at BOOT — the value arrives here through the server's
 * env loading, never read ambiently (SYN-30). The Phase-2 ML sidecar
 * registers as another name over the same interface; swapping is a config
 * change, zero pipeline edits (§5.5 gate clause).
 *
 *   rules        — RulesDecisioner v1 (the Phase-1 production default)
 *   passthrough  — Phase-0 stable order
 *   random:<n>   — seeded shuffler (tests/CI swap proof only)
 */
export const decisionerFor = (
  name: string | undefined,
  options: RulesDecisionerOptions = {},
): Decisioner => {
  const selected = name ?? 'rules';
  if (selected === 'rules') return new RulesDecisioner(options);
  if (selected === 'passthrough') return new PassthroughDecisioner();
  const random = /^random:(\d+)$/.exec(selected);
  if (random) return new RandomDecisioner(Number.parseInt(random[1]!, 10));
  throw new Error(
    `unknown MERITED_DECISIONER '${selected}' — expected rules | passthrough | random:<seed>`,
  );
};
