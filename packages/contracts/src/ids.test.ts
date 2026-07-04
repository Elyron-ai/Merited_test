import { describe, expect, it } from 'vitest';
import { ID_PREFIXES, Id, newId } from './ids.js';

describe('Id / newId (FND-3 accept)', () => {
  it('has exactly thirteen prefixes (meta-test — additions are deliberate, SYN-4)', () => {
    expect(ID_PREFIXES).toHaveLength(13);
    expect([...ID_PREFIXES].sort()).toEqual(
      ['mer', 'off', 'com', 'agt', 'atk', 'clm', 'mnd', 'usr', 'evt', 'qte', 'apr', 'lnk', 'ern'].sort(),
    );
  });

  it('round-trips a generated id through its schema', () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(Id(prefix).parse(id)).toBe(id);
      expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`));
    }
  });

  it('rejects the wrong prefix', () => {
    expect(Id('mer').safeParse(newId('off')).success).toBe(false);
    expect(Id('agt').safeParse(newId('atk')).success).toBe(false);
  });

  it('rejects bad length', () => {
    expect(Id('mer').safeParse('mer_01ABC').success).toBe(false);
    expect(Id('mer').safeParse(`mer_${'0'.repeat(27)}`).success).toBe(false);
    expect(Id('mer').safeParse(`mer_${'0'.repeat(25)}`).success).toBe(false);
  });

  it('rejects bad alphabet (I, L, O, U excluded by Crockford; lowercase rejected)', () => {
    const good = newId('mer');
    for (const bad of ['I', 'L', 'O', 'U']) {
      expect(Id('mer').safeParse(`mer_${bad.repeat(26)}`).success).toBe(false);
    }
    expect(Id('mer').safeParse(good.toLowerCase()).success).toBe(false);
  });

  it('generates monotonically sortable ids within a process', () => {
    const a = newId('evt');
    const b = newId('evt');
    expect(b > a).toBe(true);
  });
});
