import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { buildOpenApiDocument } from './document.js';

/** Serialised deterministically — `openapi.test.ts` fails CI on drift. */
export const openApiYaml = (): string =>
  stringify(buildOpenApiDocument(), { lineWidth: 0 });

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'openapi.yaml');
  writeFileSync(target, openApiYaml());
  console.log(`wrote ${target}`);
}
