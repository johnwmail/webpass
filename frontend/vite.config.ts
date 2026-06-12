import { defineConfig, loadEnv } from 'vite';
import preact from '@preact/preset-vite';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

function openpgpPreloadPlugin(): import('vite').Plugin {
  return {
    name: 'openpgp-preload',
    enforce: 'post',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      let html: string;
      try {
        html = readFileSync(resolve(dist, 'index.html'), 'utf-8');
      } catch {
        return;
      }
      const assets = resolve(dist, 'assets');
      let openpgpFile: string | undefined;
      try {
        openpgpFile = readdirSync(assets).find((f) => f.startsWith('openpgp') && f.endsWith('.js'));
      } catch {}
      if (openpgpFile && !html.includes(openpgpFile)) {
        html = html.replace(
          '</head>',
          `  <link rel="modulepreload" crossorigin href="/assets/${openpgpFile}">\n</head>`
        );
        writeFileSync(resolve(dist, 'index.html'), html);
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load environment variables
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [preact(), openpgpPreloadPlugin()],
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
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (
              id.includes('/src/lib/session') ||
              id.includes('/src/lib/api') ||
              id.includes('/src/lib/storage')
            ) {
              return 'core';
            }
            if (id.includes('node_modules/openpgp')) {
              return 'openpgp';
            }
            if (id.includes('node_modules/qrcode')) {
              return 'qrcode';
            }
            if (
              id.includes('node_modules/preact') ||
              id.includes('node_modules/lucide-preact') ||
              id.includes('node_modules/otpauth') ||
              id.includes('node_modules/fflate')
            ) {
              return 'vendor';
            }
          },
        },
      },
    },
    server: {
      port: 3000,
      proxy: {
        '/api': 'http://localhost:8080',
      },
    },
  };
});
