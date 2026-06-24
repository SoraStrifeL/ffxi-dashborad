import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals:     true,
    environment: 'node',
    include:     ['tests/**/*.test.ts'],
    testTimeout: 10_000,
    env: {
      // auth.ts exits at load time if this is missing
      DASHBOARD_JWT_SECRET: 'test-secret-that-is-long-enough-hmac',
      DB_HOST:  'localhost',
      DB_USER:  'test',
      DB_PASS:  'test',
      DB_NAME:  'test',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include:  ['src/**/*.ts'],
      exclude:  ['src/server.ts'],
    },
  },
});
