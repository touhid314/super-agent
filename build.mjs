// Bundles the extension (Node) and the Team panel (browser). Shares React/esbuild with ../super-agent so the
// core and UI components imported from there resolve to a single copy.
import path from 'node:path';
import { createRequire } from 'node:module';

const shared = path.resolve('../super-agent/node_modules');
const require = createRequire(path.join(shared, 'noop.js'));
const { build } = require('esbuild');

await build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  outfile: 'dist/extension.js',
  nodePaths: [shared],
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
  nodePaths: [shared],
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  logLevel: 'warning',
});

console.log('built dist/extension.js and media/webview.js');
