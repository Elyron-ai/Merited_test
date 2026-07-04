import fc from 'fast-check';
import { z } from 'zod';
import { Money } from '../money.js';
import { OfferMechanics } from '../offer/mechanics/index.js';
import type { Mandate } from '../mandate.js';

/**
 * fast-check arbitraries for contracts types (XC-6, SYN-19, ADR-008).
 * The mechanics arbitrary is INTROSPECTED from the union — the same
 * classify-walk as the control plane's generated form (MER-9) — so a 28th
 * variant added to contracts is generated (and property-tested) with zero
 * changes here; the P-1 coverage test asserts generation covers every
 * union option.
 */

const MAX_PENCE = 10_000_000; // £100k — beyond any fixture, well inside int

export const arbMoney = (min = 0): fc.Arbitrary<Money> =>
  fc.record({
    amount: fc.integer({ min, max: MAX_PENCE }),
    currency: fc.constant('GBP_pence' as const),
  });

const arbSku = fc
  .integer({ min: 1, max: 9999 })
  .map((n) => `sku_fixture_${n}`);

/** Bounds chosen to satisfy every union refinement: positive ints,
 * `qty ≥ 2` (multibuy), bps values sane. */
const arbInt = fc.integer({ min: 2, max: 10_000 });

const isMoneyShape = (schema: z.ZodTypeAny): boolean =>
  schema instanceof z.ZodObject && 'amount' in schema.shape && 'currency' in schema.shape;

const arbForField = (schema: z.ZodTypeAny): fc.Arbitrary<unknown> => {
  let inner = schema;
  let nullable = false;
  while (inner instanceof z.ZodNullable || inner instanceof z.ZodOptional) {
    nullable = true;
    inner = inner.unwrap() as z.ZodTypeAny;
  }
  let base: fc.Arbitrary<unknown>;
  if (isMoneyShape(inner)) base = arbMoney(1);
  else if (inner instanceof z.ZodNumber) base = arbInt;
  else if (inner instanceof z.ZodArray) base = fc.array(arbSku, { minLength: 1, maxLength: 3 });
  else base = arbSku;
  return nullable ? fc.oneof(fc.constant(null), base) : base;
};

/** One arbitrary per union variant, keyed by its discriminant. */
export const mechanicsArbitraries = (): Map<string, fc.Arbitrary<OfferMechanics>> => {
  const perVariant = new Map<string, fc.Arbitrary<OfferMechanics>>();
  for (const option of OfferMechanics.options) {
    const shape = option.shape as Record<string, z.ZodTypeAny>;
    const type = (shape['type'] as z.ZodLiteral<string>).value;
    const fields: Record<string, fc.Arbitrary<unknown>> = { type: fc.constant(type) };
    for (const [name, field] of Object.entries(shape)) {
      if (name !== 'type') fields[name] = arbForField(field);
    }
    perVariant.set(type, fc.record(fields) as unknown as fc.Arbitrary<OfferMechanics>);
  }
  return perVariant;
};

/** Any of the 27 mechanics variants (P-1). */
export const arbMechanics = (): fc.Arbitrary<OfferMechanics> =>
  fc.oneof(...mechanicsArbitraries().values());

// ── Mandates (P-3) ──────────────────────────────────────────────────────────

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const arbUlidBody = fc
  .array(fc.integer({ min: 0, max: 31 }), { minLength: 26, maxLength: 26 })
  .map((indexes) => indexes.map((i) => ULID_ALPHABET[i]).join(''));

const arbId = <P extends string>(prefix: P) =>
  arbUlidBody.map((body) => `${prefix}_${body}` as `${P}_${string}`);

const arbIsoDate = fc
  .integer({ min: Date.parse('2026-01-01T00:00:00Z'), max: Date.parse('2030-01-01T00:00:00Z') })
  .map((ms) => new Date(ms).toISOString());

/** Three amounts ordered into the schema's invariant:
 * pre_authorised_up_to ≤ per_txn ≤ per_month. */
const arbOrderedLimits = fc
  .tuple(fc.integer({ min: 0, max: MAX_PENCE }), fc.integer({ min: 0, max: MAX_PENCE }), fc.integer({ min: 0, max: MAX_PENCE }))
  .map(([a, b, c]) => {
    const [pre, perTxn, perMonth] = [a, b, c].sort((x, y) => x - y);
    return { pre: pre!, perTxn: perTxn!, perMonth: perMonth! };
  });

const mandateFrom = (
  ids: { mnd: string; usr: string; agt: string },
  limits: { pre: number; perTxn: number; perMonth: number },
  exp: string,
): Mandate =>
  ({
    mandate_id: ids.mnd,
    consumer_ref: ids.usr,
    agent_id: ids.agt,
    scopes: ['offers:read', 'checkout:execute'],
    limits: {
      per_txn: { amount: limits.perTxn, currency: 'GBP_pence' },
      per_month: { amount: limits.perMonth, currency: 'GBP_pence' },
      categories: [],
    },
    merchants: ['*'],
    data_sharing: { email: false, purchase_history: false, loyalty_ids: false },
    pre_authorised_up_to: { amount: limits.pre, currency: 'GBP_pence' },
    status: 'active',
    exp,
    attestation: 'fixture-attestation',
  }) as Mandate;

/** A valid mandate — limits always in schema order (P-3 positive half). */
export const arbMandate = (): fc.Arbitrary<Mandate> =>
  fc
    .tuple(arbId('mnd'), arbId('usr'), arbId('agt'), arbOrderedLimits, arbIsoDate)
    .map(([mnd, usr, agt, limits, exp]) => mandateFrom({ mnd, usr, agt }, limits, exp));

/** A parent with an ATTENUATED child (child ≤ parent on every limit) —
 * the P-3 tree shape; the full parent/child validation property lands with
 * the wallet's mandates module (Phase 1). */
export const arbMandateTree = (): fc.Arbitrary<{ parent: Mandate; child: Mandate }> =>
  fc
    .tuple(arbMandate(), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 100 }), arbId('mnd'))
    .map(([parent, prePct, txnPct, monthPct, childId]) => {
      const scale = (amount: number, pct: number) => Math.floor((amount * pct) / 100);
      const child: Mandate = {
        ...parent,
        mandate_id: childId as Mandate['mandate_id'],
        limits: {
          ...parent.limits,
          per_txn: { amount: scale(parent.limits.per_txn.amount, txnPct), currency: 'GBP_pence' },
          per_month: { amount: scale(parent.limits.per_month.amount, monthPct), currency: 'GBP_pence' },
        },
        pre_authorised_up_to: {
          amount: scale(parent.pre_authorised_up_to.amount, prePct),
          currency: 'GBP_pence',
        },
      };
      // keep the child internally ordered too (schema invariant)
      const amounts = [
        child.pre_authorised_up_to.amount,
        child.limits.per_txn.amount,
        child.limits.per_month.amount,
      ].sort((x, y) => x - y);
      child.pre_authorised_up_to = { amount: amounts[0]!, currency: 'GBP_pence' };
      child.limits.per_txn = { amount: amounts[1]!, currency: 'GBP_pence' };
      child.limits.per_month = { amount: amounts[2]!, currency: 'GBP_pence' };
      return { parent, child };
    });

/** A mandate whose limit ordering is violated — the schema must refuse it
 * (P-3 negative half; "widening is a validation error by construction"). */
export const arbMandateOrderingViolation = (): fc.Arbitrary<Record<string, unknown>> =>
  fc
    .tuple(arbMandate(), fc.integer({ min: 1, max: MAX_PENCE }))
    .map(([mandate, extra]) => ({
      ...mandate,
      // pre_authorised_up_to strictly above per_txn — never valid
      pre_authorised_up_to: {
        amount: mandate.limits.per_txn.amount + extra,
        currency: 'GBP_pence',
      },
    }));

// ── Event bodies (P-6) ──────────────────────────────────────────────────────

/** Hash-safe values: strings, integers, booleans, null, and shallow trees
 * of them — exactly what the ledger's assertHashSafe admits (no floats,
 * no undefined). */
const arbHashSafeLeaf = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null),
);

export const arbEventBody = (): fc.Arbitrary<Record<string, unknown>> =>
  fc.dictionary(
    fc.stringMatching(/^[a-z][a-z_]{0,10}$/),
    fc.oneof(
      arbHashSafeLeaf,
      fc.array(arbHashSafeLeaf, { maxLength: 4 }),
      fc.dictionary(fc.stringMatching(/^[a-z][a-z_]{0,10}$/), arbHashSafeLeaf, { maxKeys: 4 }),
    ),
    { minKeys: 1, maxKeys: 6 },
  );

/** A sequence of event bodies for chain properties (P-6). */
export const arbEventBodySequence = (maxLength = 12): fc.Arbitrary<Record<string, unknown>[]> =>
  fc.array(arbEventBody(), { minLength: 1, maxLength });
