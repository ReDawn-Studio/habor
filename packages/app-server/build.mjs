import { mkdirSync } from 'node:fs';
import { build } from 'esbuild';
mkdirSync('dist', { recursive: true });
const options = { bundle: true, platform: 'node', format: 'esm', sourcemap: false };
await build({ ...options, entryPoints: ['src/index.mjs'], outfile: 'dist/index.mjs' });
await build({ ...options, entryPoints: ['src/http.mjs'], outfile: 'dist/http.mjs' });
