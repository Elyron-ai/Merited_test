// XC-2 (BUILD-SPEC §1): Zod schema declarations live ONLY in
// packages/contracts — "packages/contracts is the only place types are
// defined". The rule reports the OUTERMOST zod builder call per schema (one
// error per declaration, not one per field) in any file that imports zod.
//
// Sanctioned homes outside contracts, each for a recorded reason:
//  - test files (*.test.ts / test/ / contract-tests/): throwaway schemas
//    asserting plumbing are not shared types.
//  - apps/fake-aurora: simulates an EXTERNAL merchant system (MER-11, P5) —
//    the fake merchant must NOT know Merited's contracts; its shapes are
//    deliberately native.
//  - apps/*/src/openapi/: the generated API document embeds contracts
//    schemas; its own z.objects are route plumbing (path params, headers,
//    error envelopes), never shared types.
//  - */src/env.ts: per-app deployment config through contracts' typed env
//    loader (§8, SYN-2) — an env spec is not a wire shape.

const isContracts = (filename) => /packages[\\/]contracts[\\/]/.test(filename);

const isExempt = (filename) =>
  /\.(test|spec)\.[jt]sx?$/.test(filename) ||
  /[\\/](test|tests|__tests__|contract-tests)[\\/]/.test(filename) ||
  /apps[\\/]fake-aurora[\\/]/.test(filename) ||
  /src[\\/]openapi[\\/]/.test(filename) ||
  /src[\\/]env\.[jt]s$/.test(filename);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Zod schema declarations only in packages/contracts (XC-2, BUILD-SPEC §1 contracts-first rule)',
    },
    messages: {
      schemaOutsideContracts:
        'Zod schema declared outside packages/contracts — §1: contracts is the only place types are defined. Move this schema to @merited/contracts and import it.',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (isContracts(filename) || isExempt(filename)) return {};

    // Local bindings of zod's namespace (`import { z } from 'zod'`,
    // `import z from 'zod'`, `import * as zed from 'zod'`).
    const zodNames = new Set();

    const isZodCall = (node) =>
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      zodNames.has(node.callee.object.name);

    const hasZodCallAncestor = (node) => {
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (isZodCall(parent)) return true;
      }
      return false;
    };

    return {
      ImportDeclaration(node) {
        if (node.source.value !== 'zod') return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.imported.name === 'z') {
            zodNames.add(specifier.local.name);
          }
          if (specifier.type === 'ImportDefaultSpecifier' || specifier.type === 'ImportNamespaceSpecifier') {
            zodNames.add(specifier.local.name);
          }
        }
      },
      CallExpression(node) {
        if (!isZodCall(node)) return;
        if (hasZodCallAncestor(node)) return; // report the declaration once
        context.report({ node, messageId: 'schemaOutsideContracts' });
      },
    };
  },
};
