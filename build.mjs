import esbuild from 'esbuild';
import { readdir } from 'fs/promises';

// Usage: node build.mjs [testName...]
//   node build.mjs          → builds all tests/*.ts
//   node build.mjs smoke    → builds tests/smoke.ts only
const names = process.argv.slice(2);

const entryPoints =
  names.length > 0
    ? names.map((n) => `tests/${n}.ts`)
    : (await readdir('tests'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `tests/${f}`);

await esbuild.build({
  entryPoints,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2015',
  outdir: 'dist',
  // k6 built-in modules must stay external — not bundled
  external: ['k6', 'k6/*'],
  logLevel: 'info',
});
