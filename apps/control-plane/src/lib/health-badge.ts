/**
 * W14/#6: the mint-vs-claim health badge palette. Extracted so the contrast of
 * every badge (foreground vs background) is unit-tested against WCAG AA. Each
 * label carries an emoji + words, so status is never conveyed by colour alone
 * (SC 1.4.1); the explicit white foreground fixes the SC 1.4.3 text contrast
 * (black-on-dark was ~1.70:1).
 */
export interface HealthBadge {
  label: string;
  background: string;
  color: string;
}

export const HEALTH_BADGE: Record<string, HealthBadge> = {
  healthy: { label: '✅ Healthy', background: '#0a3d1f', color: '#ffffff' },
  under_reporting: { label: '⚠️ UNDER-REPORTING', background: '#5a1a1a', color: '#ffffff' },
  insufficient_data: { label: 'ℹ️ Insufficient data', background: '#333333', color: '#ffffff' },
};
