/**
 * Bundles the main process and the preload (esbuild → CommonJS for Electron), and the smoke
 * tool. Only `electron` and `sharp` (native) stay outside the bundle.
 *
 *   node scripts/build-main.mjs           production build
 *   node scripts/build-main.mjs --dev     with source maps
 *   node scripts/build-main.mjs --smoke   the Node smoke tool (pairing + sync against a dev API)
 */

import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const client = path.resolve(root, '../client/src');
const dev = process.argv.includes('--dev');
const smoke = process.argv.includes('--smoke');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: dev,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  alias: {
    '@dash-lib': path.join(client, 'lib'),
    '@kiosk-shared': path.join(client, 'kiosk-shared'),
  },
  define: { 'process.env.KIOSK_VERSION': JSON.stringify(pkg.version) },
  external: ['electron', 'sharp'],
};

if (smoke) {
  await build({ ...common, entryPoints: [path.join(root, 'scripts/smoke.ts')], outfile: path.join(root, 'dist/smoke/smoke.js'), minify: false, sourcemap: true });
} else {
  await build({ ...common, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(root, 'dist/main/index.js') });
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(root, 'dist/preload/index.js') });
}
