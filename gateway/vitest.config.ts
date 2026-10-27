import { defineConfig } from 'vitest/config';

// Runs the gateway, analyzer adapter and script tests from one place.
export default defineConfig({
  test: {
    root: '..',
    include: ['gateway/tests/**/*.test.ts', 'analyzers/**/*.test.mjs', 'scripts/**/*.test.mjs', 'report-store/**/*.test.mjs'],
  },
});
