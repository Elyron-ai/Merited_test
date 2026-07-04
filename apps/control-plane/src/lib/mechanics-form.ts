import { OfferMechanics } from '@merited/contracts';
import { z } from 'zod';

/**
 * MER-9: the authoring form is GENERATED from the `OfferMechanics`
 * discriminated union — the UI can never drift from the 27 mechanics, and a
 * new variant added to contracts surfaces here automatically (the tests
 * assert descriptor coverage equals the union's options).
 */

export type FieldKind = 'int' | 'money' | 'money-nullable' | 'string' | 'strings';

export interface MechanicsField {
  name: string;
  kind: FieldKind;
  label: string;
}

export interface MechanicsVariant {
  type: string;
  fields: MechanicsField[];
}

const isMoneyShape = (schema: z.ZodTypeAny): boolean =>
  schema instanceof z.ZodObject &&
  'amount' in schema.shape &&
  'currency' in schema.shape;

const classify = (name: string, schema: z.ZodTypeAny): MechanicsField => {
  let inner = schema;
  let nullable = false;
  while (inner instanceof z.ZodNullable || inner instanceof z.ZodOptional) {
    nullable = true;
    inner = inner.unwrap() as z.ZodTypeAny;
  }
  const label = name.replace(/_/g, ' ');
  if (isMoneyShape(inner)) {
    return { name, kind: nullable ? 'money-nullable' : 'money', label: `${label} (pence)` };
  }
  if (inner instanceof z.ZodNumber) return { name, kind: 'int', label };
  if (inner instanceof z.ZodArray) return { name, kind: 'strings', label: `${label} (comma-separated)` };
  return { name, kind: 'string', label };
};

/** Every union variant, with its fields introspected from the Zod shape. */
export const mechanicsVariants = (): MechanicsVariant[] =>
  OfferMechanics.options.map((option) => {
    const shape = option.shape as Record<string, z.ZodTypeAny>;
    return {
      type: (shape['type'] as z.ZodLiteral<string>).value,
      fields: Object.entries(shape)
        .filter(([name]) => name !== 'type')
        .map(([name, field]) => classify(name, field)),
    };
  });

export const variantByType = (type: string): MechanicsVariant | undefined =>
  mechanicsVariants().find((variant) => variant.type === type);

const intFrom = (raw: string, name: string): number => {
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new Error(`${name} must be a whole number (integer pence or bps — floats never cross the wire)`);
  }
  return Number.parseInt(raw.trim(), 10);
};

/**
 * Build the mechanics object from posted form fields, then validate through
 * the UNION itself — contracts remain the single source of truth.
 */
export const parseMechanicsForm = (type: string, form: FormData): z.infer<typeof OfferMechanics> => {
  const variant = variantByType(type);
  if (!variant) throw new Error(`unknown mechanics variant '${type}'`);
  const draft: Record<string, unknown> = { type };
  for (const field of variant.fields) {
    const raw = String(form.get(`mech_${field.name}`) ?? '').trim();
    switch (field.kind) {
      case 'int':
        draft[field.name] = intFrom(raw, field.name);
        break;
      case 'money':
        draft[field.name] = { amount: intFrom(raw, field.name), currency: 'GBP_pence' };
        break;
      case 'money-nullable':
        draft[field.name] = raw ? { amount: intFrom(raw, field.name), currency: 'GBP_pence' } : null;
        break;
      case 'strings':
        draft[field.name] = raw.split(',').map((v) => v.trim()).filter(Boolean);
        break;
      case 'string':
        draft[field.name] = raw;
        break;
    }
  }
  return OfferMechanics.parse(draft);
};

/** A valid example value per field — the round-trip tests post these. */
export const exampleValueFor = (field: MechanicsField): string => {
  switch (field.kind) {
    case 'int':
      return '1000';
    case 'money':
    case 'money-nullable':
      return '2500';
    case 'strings':
      return 'sku_spa_day, sku_lunch';
    case 'string':
      return 'sku_spa_day';
  }
};
