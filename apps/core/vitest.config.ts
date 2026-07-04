import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup-otel.ts'],
    passWithNoTests: true,
  },
});
