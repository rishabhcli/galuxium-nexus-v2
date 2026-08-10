import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    environment: 'node',
    exclude: [
      '**/.dev/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/tests/e2e/**',
      '**/test-results/**',
    ],
    globals: false,
    include: ['**/*.{test,spec}.{ts,tsx,mts,cts,js,mjs,cjs}'],
    mockReset: true,
    passWithNoTests: false,
    pool: 'forks',
    reporters: ['default'],
    restoreMocks: true,
    sequence: {
      shuffle: false,
    },
    testTimeout: 10_000,
    unstubEnvs: true,
    unstubGlobals: true,
    coverage: {
      clean: true,
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
    },
  },
});
