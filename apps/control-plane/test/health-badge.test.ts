import { describe, expect, it } from 'vitest';
import { HEALTH_BADGE } from '../src/lib/health-badge';

/**
 * W14/#6 (SC 1.4.3): every health badge's foreground must clear WCAG AA (≥4.5:1)
 * against its own background. Black-on-dark used to be ~1.70:1; white-on-dark
 * is well over the bar. Computed with the WCAG relative-luminance formula.
 */
const lin = (c: number): number => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => {
  const n = hex.replace('#', '');
  return (
    0.2126 * lin(parseInt(n.slice(0, 2), 16)) +
    0.7152 * lin(parseInt(n.slice(2, 4), 16)) +
    0.0722 * lin(parseInt(n.slice(4, 6), 16))
  );
};
const ratio = (a: string, b: string): number => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};

describe('health badge contrast (W14/#6)', () => {
  it('every badge foreground clears AA (≥4.5:1) against its background', () => {
    for (const [status, badge] of Object.entries(HEALTH_BADGE)) {
      const r = ratio(badge.color, badge.background);
      expect(r, `${status}: ${badge.color} on ${badge.background} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every badge label carries a non-colour cue (emoji + words, SC 1.4.1)', () => {
    for (const badge of Object.values(HEALTH_BADGE)) {
      // an emoji prefix plus at least one word — status readable without colour
      expect(badge.label).toMatch(/\p{Emoji}/u);
      expect(badge.label.replace(/\p{Emoji}/gu, '').trim().length).toBeGreaterThan(0);
    }
  });
});
