import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  define: {
    'import.meta.env.FRONTEND_VERSION': JSON.stringify(process.env.FRONTEND_VERSION || 'vdev'),
    'import.meta.env.FRONTEND_COMMIT': JSON.stringify(process.env.FRONTEND_COMMIT || 'unknown'),
    'import.meta.env.FRONTEND_BUILD_TIME': JSON.stringify(process.env.FRONTEND_BUILD_TIME || 'unknown'),
  },
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
});
