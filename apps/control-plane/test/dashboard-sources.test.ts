import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PH2-2 / architecture §3.5: "no new data collection" — the dashboards READ
 * the four B19 projection tables and nothing else. A structural proof over
 * the page sources: every `core.*` table referenced must be a projection
 * (plus `merchants` via the service for the page header), and no page may
 * contain a write statement. Fails the moment someone quietly adds a
 * side-table or a write to a dashboard.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = [
  'src/app/dashboard/page.tsx',
  'src/app/merchants/[id]/dashboard/page.tsx',
];

const B19_PROJECTIONS = new Set([
  'core.conversions_by_agent_day',
  'core.mint_vs_claim_by_merchant_day',
  'core.rejections_by_reason_day',
  'core.budget_burn',
]);

describe('dashboards render from B19 projections alone (§3.5)', () => {
  for (const page of PAGES) {
    const source = readFileSync(path.join(root, page), 'utf8');

    it(`${page}: every table referenced is a B19 projection`, () => {
      const tables = new Set(source.match(/core\.[a-z_]+/g) ?? []);
      expect(tables.size).toBeGreaterThan(0); // the page genuinely reads projections
      for (const table of tables) {
        expect(B19_PROJECTIONS.has(table), `${table} is not a B19 projection`).toBe(true);
      }
    });

    it(`${page}: read-only — no write statements`, () => {
      expect(source).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/);
    });
  }
});
