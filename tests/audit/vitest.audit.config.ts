import { defineConfig } from 'vitest/config';

// Separate from the main suite (vitest.config.ts): audit tests live in tests/audit.
export default defineConfig({
  test: { include: ['tests/audit/**/*.audit.test.ts'], environment: 'node' },
});
