import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig(({ mode }) => {
  // Load environment variables
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [preact()],
    define: {
      'import.meta.env.FRONTEND_VERSION': JSON.stringify(env.FRONTEND_VERSION || process.env.FRONTEND_VERSION || 'vdev'),
      'import.meta.env.FRONTEND_COMMIT': JSON.stringify(env.FRONTEND_COMMIT || process.env.FRONTEND_COMMIT || 'unknown'),
      'import.meta.env.FRONTEND_BUILD_TIME': JSON.stringify(env.FRONTEND_BUILD_TIME || process.env.FRONTEND_BUILD_TIME || 'unknown'),
    },
    build: {
      outDir: 'dist',
      minify: 'esbuild',
      esbuild: {
        drop: [], // Don't drop console or debugger
      },
    },
    server: {
      port: 3000,
      proxy: {
        '/api': 'http://localhost:8000',
      },
    },
  };
});
