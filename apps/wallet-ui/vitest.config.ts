import { defineConfig } from 'vitest/config';

// The two e2e suites build and serve the SAME .next output — parallel
// files would wipe it under each other. Sequential by design, not flake.
export default defineConfig({ test: { fileParallelism: false } });
