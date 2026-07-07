import { defineConfig } from 'vitest/config';

// Unit tests only — fast, no DB, no network. The live integration/e2e flows
// stay in scripts/ (npm run test:auth / test:http / test:services).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
  },
});
