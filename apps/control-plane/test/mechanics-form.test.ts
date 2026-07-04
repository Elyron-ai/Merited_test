import { OfferMechanics } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { exampleValueFor, mechanicsVariants, parseMechanicsForm } from '../src/lib/mechanics-form';

describe('schema-generated mechanics form (MER-9 accept — all variants round-trip)', () => {
  it('the descriptors cover EXACTLY the union — a new contracts variant surfaces automatically', () => {
    const described = mechanicsVariants().map((v) => v.type).sort();
    const union = OfferMechanics.options
      .map((o) => (o.shape as { type: { value: string } }).type.value)
      .sort();
    expect(described).toEqual(union);
    expect(described.length).toBe(27); // FND D10 / SYN-28
  });

  it('EVERY variant round-trips through the generated form', () => {
    for (const variant of mechanicsVariants()) {
      const form = new FormData();
      for (const field of variant.fields) form.set(`mech_${field.name}`, exampleValueFor(field));
      const parsed = parseMechanicsForm(variant.type, form);
      expect(parsed.type, variant.type).toBe(variant.type);
      expect(() => OfferMechanics.parse(parsed), variant.type).not.toThrow();
      // and back: the descriptor can re-render every parsed field
      for (const field of variant.fields) {
        expect(field.name in (parsed as Record<string, unknown>), `${variant.type}.${field.name}`).toBe(true);
      }
    }
  });

  it('floats and unknown variants are refused', () => {
    const form = new FormData();
    form.set('mech_pct_bps', '10.5');
    expect(() => parseMechanicsForm('percentage_off', form)).toThrow(/whole number/);
    expect(() => parseMechanicsForm('made_up_variant', new FormData())).toThrow(/unknown mechanics/);
  });
});
