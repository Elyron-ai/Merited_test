import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REJECTION_REASON_CODES } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { openApiYaml } from './generate.js';

const committedPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'openapi.yaml',
);

describe('OpenAPI docs (TRIO-14 accept)', () => {
  it('the committed openapi.yaml regenerates byte-identical from the Zod source', () => {
    expect(readFileSync(committedPath, 'utf8')).toBe(openApiYaml());
  });

  it('every RejectionReasonCode enum member appears in the verify docs with a trigger', () => {
    const yaml = openApiYaml();
    for (const code of REJECTION_REASON_CODES) {
      expect(yaml.includes(code), `reason code missing from docs: ${code}`).toBe(true);
    }
  });

  it('every trio endpoint is documented', () => {
    const yaml = openApiYaml();
    for (const endpoint of [
      '/trio/commitments',
      '/trio/commitments/{id}/end',
      '/trio/commitments/{id}',
      '/trio/keys/merchant',
      '/trio/tokens/mint',
      '/trio/claims/verify',
      '/trio/claims/reverse',
      '/trio/netting/run',
      '/trio/positions/{party}',
      '/trio/statements/{party}/{period}',
      '/trio/statements/{party}/{period}/pdf',
      '/healthz',
    ]) {
      expect(yaml.includes(`${endpoint}:`), `endpoint missing from docs: ${endpoint}`).toBe(true);
    }
    // The normative semantics are stated, not implied.
    expect(yaml).toContain('first-failure-wins');
    expect(yaml).toContain('byte-for-byte');
  });
});
