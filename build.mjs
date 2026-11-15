// Bundles the extension (Node) and the Team panel (browser).
import { build } from 'esbuild';
import fs from 'node:fs';

// The mic recorder's native library: it loads from ../lib next to the bundled extension (dist/).
fs.rmSync('lib', { recursive: true, force: true });
fs.cpSync('node_modules/@picovoice/pvrecorder-node/lib/windows', 'lib/windows', { recursive: true });
fs.cpSync('node_modules/@picovoice/pvrecorder-node/lib/linux/x86_64', 'lib/linux/x86_64', { recursive: true });

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

await build({
  entryPoints: ['src/server.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/server.cjs',
  sourcemap: true,
  logLevel: 'warning',
});

console.log('built dist/extension.js, dist/server.cjs and media/webview.js');
