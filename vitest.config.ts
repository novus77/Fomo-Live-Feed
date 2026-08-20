import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/{unit,integration}/**/*.{test,spec}.{ts,tsx}'],
  },
});
