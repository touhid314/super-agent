// Bundles the extension (Node) and the Team panel (browser).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  sourcemap: true,
  logLevel: 'warning',
});

await build({
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  outfile: 'media/webview.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  logLevel: 'warning',
});

console.log('built dist/extension.js and media/webview.js');
