/**
 * Bundles the main process and the preload (esbuild → CommonJS for Electron), and the smoke
 * tool, and the PayLink utility process (the cash host's vendor DLL, main/cash/paylinkWorker.ts).
 * Only `electron`, `sharp` and `koffi` (native) stay outside the bundle.
 *
 *   node scripts/build-main.mjs           production build
 *   node scripts/build-main.mjs --dev     with source maps
 *   node scripts/build-main.mjs --smoke   the Node smoke tool (pairing + sync against a dev API)
 *   node scripts/build-main.mjs --print-e2e [--win7]  the print smoke run under Electron (scripts/print-e2e.ts)
 *   node scripts/build-main.mjs --win7    the Windows 7 build (P:/specs/windows7-till.md): Node 16.17 / Electron 22,
 *                                         into legacy/dist/, src/legacy/main.ts first (Node 16's missing globals),
 *                                         undici from legacy/node_modules, better-sqlite3 + serialport left to it
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
const cashSim = process.argv.includes('--cash-sim');
const win7Check = process.argv.includes('--win7-check');
const printE2e = process.argv.includes('--print-e2e');
const win7 = process.argv.includes('--win7') || win7Check;
/** Where dist/ goes: the Windows 7 build packs from legacy/ (its own package.json and node_modules). */
const out = win7 ? path.join(root, 'legacy') : root;
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const common = {
  bundle: true,
  platform: 'node',
  target: win7 ? 'node16.17' : 'node22',
  format: 'cjs',
  sourcemap: dev,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'info',
  alias: {
    '@dash-lib': path.join(client, 'lib'),
    '@kiosk-shared': path.join(client, 'kiosk-shared'),
    // undici 5 (Node 16) from legacy/node_modules — never the newer copies electron-builder / @electron/get bring.
    ...(win7 ? { undici: path.join(root, 'legacy', 'node_modules', 'undici') } : {}),
  },
  define: { 'process.env.KIOSK_VERSION': JSON.stringify(pkg.version), 'process.env.R2M_APP_BUILD': JSON.stringify(win7 ? 'win7' : 'standard') },
  external: ['electron', 'sharp', 'koffi', ...(win7 ? ['better-sqlite3', 'serialport'] : [])],
};

if (cashSim) {
  // A cash host with a simulated PayLink, under Node (scripts/cash-sim.ts): a kiosk's cash client tested against the real LAN API.
  await build({ ...common, entryPoints: [path.join(root, 'scripts/cash-sim.ts')], outfile: path.join(root, 'dist/cash-sim/cash-sim.js'), minify: false, sourcemap: true });
} else if (smoke) {
  await build({ ...common, entryPoints: [path.join(root, 'scripts/smoke.ts')], outfile: path.join(root, 'dist/smoke/smoke.js'), minify: false, sourcemap: true });
} else if (printE2e) {
  // The print smoke run under Electron (scripts/print-e2e.ts): beside the build it checks (dist/ or legacy/dist/) — not packed.
  // Windows 7: Node 16's missing globals first, as src/legacy/main.ts does for the app.
  await build({ ...common, entryPoints: [path.join(root, 'scripts/print-e2e.ts')], outfile: path.join(out, 'dist-e2e/print-e2e.js'), minify: false, sourcemap: true, inject: win7 ? [path.join(root, 'src/legacy/polyfills.ts')] : [] });
} else if (win7Check) {
  // The Windows 7 build's runtime check under Electron 22's Node (scripts/win7-check.ts) — not packed.
  await build({ ...common, entryPoints: [path.join(root, 'scripts/win7-check.ts')], outfile: path.join(out, 'dist-check/win7-check.js'), minify: false });
} else if (win7) {
  // No PayLink worker: the cash host is not a role of the Windows 7 build (till only, core/appBuild.ts).
  await build({ ...common, entryPoints: [path.join(root, 'src/legacy/main.ts')], outfile: path.join(out, 'dist/main/index.js') });
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(out, 'dist/preload/index.js') });
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/app.ts')], outfile: path.join(out, 'dist/preload/app.js') });
  // "מצב הדגמה" (main/demo/demoShell.ts): `window.r2mDemo` only.
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/demo.ts')], outfile: path.join(out, 'dist/preload/demo.js') });
} else {
  await build({ ...common, entryPoints: [path.join(root, 'src/main/index.ts')], outfile: path.join(root, 'dist/main/index.js') });
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/index.ts')], outfile: path.join(root, 'dist/preload/index.js') });
  await build({ ...common, entryPoints: [path.join(root, 'src/main/cash/paylinkWorker.ts')], outfile: path.join(root, 'dist/main/paylinkWorker.js') });
  // The till role's view (main/roles/tillElectron.ts): `window.r2mApp` only.
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/app.ts')], outfile: path.join(root, 'dist/preload/app.js') });
  // "מצב הדגמה" (main/demo/demoShell.ts): `window.r2mDemo` only.
  await build({ ...common, entryPoints: [path.join(root, 'src/preload/demo.ts')], outfile: path.join(root, 'dist/preload/demo.js') });
}
