import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact()],
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.crypto.test.ts'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
