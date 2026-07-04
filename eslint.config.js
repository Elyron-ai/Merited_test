import tseslint from 'typescript-eslint';
import noRefreshToken from './tools/lint-rules/no-refresh-token.js';

const merited = { rules: { 'no-refresh-token': noRefreshToken } };

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', 'apps/control-plane/next-env.d.ts', '**/*.tsbuildinfo', 'BUILD-*.md'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
    },
  },
  {
    // FND-15 (§6.3): the rule self-scopes by filename — contracts files ban
    // token identifiers/keys outright; everywhere else, logger-call
    // arguments are swept for token keys.
    files: ['**/*.ts', '**/*.js'],
    plugins: { merited },
    rules: { 'merited/no-refresh-token': 'error' },
  },
  {
    // VAL-5 import fence (P5): Valet ships as an ORDINARY agent — its
    // production code reaches the platform only through @merited/{contracts,
    // sdk,events}. Tests are exempt: booting a local Core/FakeShop is the
    // stated contract-test harness, not a private import.
    files: ['apps/valet/src/**/*.ts'],
    ignores: ['apps/valet/src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@merited/core',
                '@merited/core/*',
                '@merited/trio',
                '@merited/trio/*',
                '@merited/fake-aurora',
                '@merited/fake-aurora/*',
                '@merited/signing',
                '@merited/seed',
                '@merited/wallet',
                '@merited/control-plane',
                '@merited/mcp-server',
                '**/apps/core/*',
                '**/apps/trio/*',
                '**/apps/fake-aurora/*',
              ],
              message:
                'apps/valet is fenced to @merited/{contracts,sdk,events} (VAL-5, P5 — Valet is an ordinary registered agent)',
            },
          ],
        },
      ],
    },
  },
);
