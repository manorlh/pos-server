import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import base from './vite.config.mts';

/**
 * The ONE app bundle (`r2m-app`, P:/specs/web-till-spec-v2.md §8.1) — the generalisation of
 * vite.android.config.mts: one entry (src/renderer/app.html → index.html) that picks the host
 * (browser / Windows shell / APK / iOS) and runs the role it says; out to dist/app-bundle/.
 * Built by scripts/build-app-bundle.mjs (manifest, the floor check, the zip).
 *
 * The floor is Chromium 108 and Safari 16.4 (§13.3, S0-12) — Windows 7 on Electron 22, Chrome /
 * Edge 109 there, the iPad. JS is lowered to it (build.target) and CSS goes through Lightning CSS
 * with the same targets (nesting lowered, colour fallbacks). APIs newer than 108 are kept out by
 * lint (eslint.config.mjs, the till / host / app folders) — no core-js here (a new dependency the
 * owner has not approved yet). src/renderer/.browserslistrc says the same floor in browserslist's
 * words; test/appBundleFloor.test.ts keeps them in step.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_OUT = path.join(here, 'dist/app-bundle');

/** esbuild / Rolldown targets. */
export const APP_BUILD_TARGET = ['chrome108', 'safari16.4'];
/** Lightning CSS targets: major << 16 | minor << 8. */
export const APP_CSS_TARGETS = {
  chrome: 108 << 16,
  edge: 108 << 16,
  safari: (16 << 16) | (4 << 8),
  ios_saf: (16 << 16) | (4 << 8),
  samsung: 20 << 16,
  firefox: 115 << 16,
};
export const APP_MIN_CHROME = 108;
export const APP_MIN_SAFARI = '16.4';

/** app.html becomes index.html. */
function appLayout(): Plugin {
  return {
    name: 'app-bundle-layout',
    closeBundle() {
      const html = path.join(APP_OUT, 'app.html');
      if (existsSync(html)) renameSync(html, path.join(APP_OUT, 'index.html'));
    },
  };
}

function flat(list: PluginOption[] | undefined): Plugin[] {
  const out: Plugin[] = [];
  const walk = (p: PluginOption) => {
    if (!p) return;
    if (Array.isArray(p)) p.forEach(walk);
    else if (typeof (p as Promise<unknown>).then !== 'function') out.push(p as Plugin);
  };
  (list ?? []).forEach(walk);
  return out;
}

export default defineConfig((env: ConfigEnv): UserConfig => {
  const cfg = (typeof base === 'function' ? base({ ...env, mode: 'production' }) : base) as UserConfig;
  const bundle = {
    version: process.env.APP_BUNDLE_VERSION ?? 'dev',
    versionCode: Number(process.env.APP_BUNDLE_CODE ?? 0),
    protocol: 1,
  };
  return {
    ...cfg,
    // Not the Windows build's public-pictures copy (it writes into dist/renderer).
    plugins: [...flat(cfg.plugins as PluginOption[]).filter((p) => p.name !== 'kiosk-public'), appLayout()],
    define: { ...(cfg.define ?? {}), __WEB_BRIDGE__: 'false', __APP_BUNDLE__: JSON.stringify(bundle) },
    css: { ...(cfg.css ?? {}), transformer: 'lightningcss', lightningcss: { targets: APP_CSS_TARGETS } },
    build: {
      ...(cfg.build ?? {}),
      outDir: APP_OUT,
      emptyOutDir: true,
      target: APP_BUILD_TARGET,
      cssTarget: APP_BUILD_TARGET,
      cssMinify: 'lightningcss',
      sourcemap: false,
      rollupOptions: { input: { app: path.join(here, 'src/renderer/app.html') } },
    },
  };
});
