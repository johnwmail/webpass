import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const outDir = join(__dirname, 'dist');

try { rmSync(outDir, { recursive: true }); } catch {}
mkdirSync(join(outDir, 'popup'), { recursive: true });
mkdirSync(join(outDir, 'background'), { recursive: true });
mkdirSync(join(outDir, 'content'), { recursive: true });
mkdirSync(join(outDir, 'options'), { recursive: true });

async function buildAll() {
  await esbuild.build({
    entryPoints: { 'popup/popup': 'src/popup/popup.tsx' },
    outdir: outDir, bundle: true, format: 'esm', target: 'es2020',
    jsxFactory: 'h', jsxFragment: 'Fragment',
    loader: { '.ts': 'ts', '.tsx': 'tsx' },
    minify: false, sourcemap: false,
    define: { 'globalThis.__DEV__': 'false' },
  });

  await esbuild.build({
    entryPoints: { 'background/sw': 'src/background/sw.ts' },
    outdir: outDir, bundle: true, format: 'esm', target: 'es2020',
    minify: false, sourcemap: false,
  });

  await esbuild.build({
    entryPoints: { 'content/autofill': 'src/content/autofill.ts' },
    outdir: outDir, bundle: true, format: 'iife', target: 'es2020',
    minify: false, sourcemap: false,
  });

  await esbuild.build({
    entryPoints: { 'options/options': 'src/options/options.ts' },
    outdir: outDir, bundle: true, format: 'esm', target: 'es2020',
    minify: false, sourcemap: false,
  });

  copyFileSync('src/popup/index.html', join(outDir, 'popup/index.html'));
  copyFileSync('src/options/options.html', join(outDir, 'options/options.html'));
  copyFileSync('src/icon.png', join(outDir, 'icon.png'));
  copyFileSync('manifest.json', join(outDir, 'manifest.json'));

  console.log('✅ Build complete');
}

buildAll().catch(e => { console.error(e); process.exit(1); });
