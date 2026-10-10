import { cpSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import base from './vite.config.mts';

/**
 * The Android kiosk's bundle (pos-android ui/kiosk/web): the SAME screens as the Windows kiosk,
 * built for the APK's WebView — entry src/renderer/android.html (the Android bridge first, then the
 * screens), out to dist/android-bundle/ with index.html at its root (the APK serves it at
 * https://appassets.androidplatform.net/), the dashboard's kiosk pictures under kiosk/.
 *
 * Run by scripts/build-android-bundle.mjs (which also writes the manifest and the zip); the
 * version comes in through KIOSK_BUNDLE_VERSION / KIOSK_BUNDLE_CODE / KIOSK_BUNDLE_BRIDGE_API.
 * Everything else — React deduped, the shared aliases, the kiosk strings — is vite.config.mts's.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../client/src');
export const ANDROID_OUT = path.join(here, 'dist/android-bundle');

/** android.html becomes index.html; the dashboard's public kiosk pictures go along. */
function androidLayout(): Plugin {
  return {
    name: 'android-bundle-layout',
    closeBundle() {
      const html = path.join(ANDROID_OUT, 'android.html');
      if (existsSync(html)) renameSync(html, path.join(ANDROID_OUT, 'index.html'));
      const pictures = path.join(client, '..', 'public', 'kiosk');
      if (existsSync(pictures)) cpSync(pictures, path.join(ANDROID_OUT, 'kiosk'), { recursive: true });
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
    version: process.env.KIOSK_BUNDLE_VERSION ?? 'dev',
    versionCode: Number(process.env.KIOSK_BUNDLE_CODE ?? 0),
    bridgeApi: Number(process.env.KIOSK_BUNDLE_BRIDGE_API ?? 1),
  };
  return {
    ...cfg,
    // Not the Windows build's public-pictures copy (it writes into dist/renderer): ours, into the bundle.
    plugins: [...flat(cfg.plugins as PluginOption[]).filter((p) => p.name !== 'kiosk-public'), androidLayout()],
    define: { ...(cfg.define ?? {}), __WEB_BRIDGE__: 'false', __KIOSK_BUNDLE__: JSON.stringify(bundle) },
    build: {
      ...(cfg.build ?? {}),
      outDir: ANDROID_OUT,
      emptyOutDir: true,
      // The WebView floor of the manifest's minChrome (scripts/androidBundle.ts MIN_CHROME).
      target: 'chrome111',
      sourcemap: false,
      rollupOptions: { input: { android: path.join(here, 'src/renderer/android.html') } },
    },
  };
});
