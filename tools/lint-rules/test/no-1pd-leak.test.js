import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';
import rule from '../no-1pd-leak.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const lint = (code, filename) => {
  const linter = new Linter({ cwd: repoRoot });
  return linter.verify(
    code,
    {
      plugins: { merited: { rules: { 'no-1pd-leak': rule } } },
      rules: { 'merited/no-1pd-leak': 'error' },
      files: ['**/*.ts', '**/*.js'],
      languageOptions: { ecmaVersion: 2024, sourceType: 'module' },
    },
    { filename: path.join(repoRoot, filename) },
  );
};

describe('no-1pd-leak (PH2-9 accept — 1pd never in agent-facing responses)', () => {
  it('BITES: a pd key in a contracts response schema is an error', () => {
    const schema = `export const OfferQuote = z.object({ pd: z.record(z.string()) });`;
    expect(lint(schema, 'packages/contracts/src/quote.ts')).toHaveLength(1);
  });

  it('BITES: a pd key in a route handler response is an error', () => {
    const route = `app.get('/v1/offers', async () => ({ quotes, pd: ctx.pd }));`;
    expect(lint(route, 'apps/core/src/routes/v1/index.ts')).toHaveLength(1);
  });

  it('sanctioned homes stay legal: pipeline DecisionCtx and the wallet pd-store', () => {
    const ctx = `export const DecisionCtx = z.object({ pd: z.record(z.string()).optional() });`;
    expect(lint(ctx, 'packages/contracts/src/pipeline.ts')).toHaveLength(0);
    const store = `const row = { pd: value };`;
    expect(lint(store, 'apps/wallet/src/modules/pd-store/pd-store.ts')).toHaveLength(0);
  });

  it('ordinary app code (not a response surface) is untouched', () => {
    const engine = `const ctx = { pd: enrichment };`;
    expect(lint(engine, 'apps/core/src/modules/offers/read-offers.ts')).toHaveLength(0);
  });
});
