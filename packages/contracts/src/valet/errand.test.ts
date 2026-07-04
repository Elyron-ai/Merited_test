import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MERITED_EVENT_BODIES } from '../events/index.js';
import { EVENT_FIXTURES } from '../events/fixtures.js';
import { Brief, Errand, ErrandEvent, ErrandState } from './errand.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/** One valid payload per event variant — the round-trip matrix. */
const EVENT_SAMPLES: ErrandEvent[] = [
  { type: 'SEARCH_STARTED' },
  { type: 'QUOTE_RECEIVED', quote_id: 'qte_01J00000000000000000000000', token: 'v4.public.fake.tok.sig' },
  { type: 'QUOTE_RECEIVED', quote_id: 'qte_01J00000000000000000000000', token: null },
  { type: 'APPROVAL_REQUESTED' },
  { type: 'APPROVAL_GRANTED', approval_id: 'apr_01J00000000000000000000000', mode: 'explicit' },
  { type: 'APPROVAL_GRANTED', approval_id: 'apr_01J00000000000000000000000', mode: 'pre_authorised' },
  { type: 'APPROVAL_SKIPPED', reason: 'walletless' },
  { type: 'APPROVAL_DECLINED' },
  { type: 'EXECUTION_STARTED' },
  { type: 'CLAIM_VERIFIED', claim_id: 'clm_01J00000000000000000000000' },
  { type: 'CLAIM_REJECTED', reason_code: 'TOKEN_REPLAYED' },
  { type: 'TIMED_OUT', cause: 'quote expired before execution' },
  { type: 'RETRY' },
  { type: 'SEARCH_FAILED' },
];

describe('errand contracts (VAL-1 accept)', () => {
  it('Zod round-trip for EVERY event variant (parse → serialise → parse identical)', () => {
    const covered = new Set(EVENT_SAMPLES.map((e) => e.type));
    expect(covered).toEqual(new Set(ErrandEvent.options.map((o) => o.shape.type.value)));
    for (const sample of EVENT_SAMPLES) {
      const parsed = ErrandEvent.parse(sample);
      expect(ErrandEvent.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    }
  });

  it('the state enum is the FULL §4.3 set of ten', () => {
    expect(ErrandState.options).toEqual([
      'BRIEFED',
      'SEARCHING',
      'QUOTED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'EXECUTING',
      'CONFIRMED',
      'FAILED',
      'DECLINED',
      'EXPIRED',
    ]);
  });

  it('Errand record round-trips with nullable wallet fields and an opaque token', () => {
    const errand = Errand.parse({
      errand_id: 'ern_01J00000000000000000000000',
      agent_id: 'agt_01J00000000000000000000000',
      brief: Brief.parse({ text: 'spa day under £120', max_price: { amount: 12000, currency: 'GBP_pence' }, sub_hash: null }),
      mandate_id: null,
      approval_id: null,
      consumer_ref: null,
      sub_hash: null,
      quote_id: 'qte_01J00000000000000000000000',
      token: 'v4.public.fake.tok.sig',
      claim_id: null,
      created_at: '2026-07-04T10:00:00Z',
      updated_at: '2026-07-04T10:01:00Z',
    });
    expect(Errand.parse(JSON.parse(JSON.stringify(errand)))).toEqual(errand);
    // money in the brief is integer pence — floats refuse to parse
    expect(() =>
      Brief.parse({ text: 'x', max_price: { amount: 120.5, currency: 'GBP_pence' }, sub_hash: null }),
    ).toThrow();
  });

  it("ErrandStateChanged's from/to are now the ErrandState enum (FND-7 tighten reserved for VAL-1)", () => {
    const body = MERITED_EVENT_BODIES.ErrandStateChanged;
    const fixture = EVENT_FIXTURES.ErrandStateChanged as { data: Record<string, unknown> };
    expect(body.parse(fixture)).toBeTruthy();
    expect(() =>
      body.parse({ ...fixture, data: { ...fixture.data, to: 'NOT_A_STATE' } }),
    ).toThrow();
  });

  it('packages/contracts is the ONLY definition site (repo-wide grep)', () => {
    // definition syntax only — imports/uses of the types are exactly the point
    const pattern = String.raw`(const|type|interface|enum)\s+(ErrandState|ErrandEvent|Errand|Brief)\b\s*(=|\{|extends)`;
    const out = execSync(
      `grep -rnE '${pattern}' --include='*.ts' apps packages tools ` +
        `--exclude-dir=node_modules --exclude-dir=dist || true`,
      { cwd: repoRoot, encoding: 'utf8' },
    );
    const offenders = out
      .split('\n')
      .filter(Boolean)
      .filter((line) => !line.startsWith('packages/contracts/src/valet/'));
    expect(offenders).toEqual([]);
  });
});
