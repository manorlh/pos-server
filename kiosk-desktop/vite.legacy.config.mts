import { cpSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ConfigEnv, type Plugin, type PluginOption, type UserConfig } from 'vite';
import base from './vite.config.mts';
import { coverageGaps, legacyCss, LEGACY_CHROME } from './scripts/legacyCss.ts';

/**
 * The renderer for the Windows 7 LEGACY build (Electron 22 = Chromium 108; P:/specs/web-till-
 * spec-v2.md §13.2, §13.3) — the same screens (kiosk, KDS, board, the shell's), out to
 * dist/renderer-legacy/. The legacy installer (W7-1, the win7-x64 CI job) ships this folder as its
 * renderer; the modern build (vite.config.mts → dist/renderer, Electron 44) is untouched: it never
 * reads this file and its output does not change.
 *
 *  - JS lowered to chrome108;
 *  - every CSS file through scripts/legacyCss.ts (Lightning CSS at Chrome 108 targets: sRGB values
 *    first, the palette's custom properties too; gradients without `in oklab`). The build FAILS when
 *    the legacy sheet, as Chromium 108 keeps it, lacks anything the modern sheet sets
 *    (coverageGaps), other than the explained KNOWN_GAPS.
 *
 * `--mode web` builds it with the demo bridge (scripts/preview-legacy.mjs, the visual check).
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../client/src');
export const LEGACY_OUT = path.join(here, 'dist/renderer-legacy');

/** Each emitted CSS file → its Chromium 108 form, checked. */
export function legacyCssPlugin(): Plugin {
  return {
    name: 'r2m-legacy-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue;
        const modern = typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source);
        const legacy = legacyCss(modern, file.fileName);
        const gaps = coverageGaps(modern, legacy);
        if (gaps.length) this.error(`${file.fileName}: Chromium ${LEGACY_CHROME} would lose ${gaps.length} declaration(s): ${gaps.slice(0, 8).join(' ; ')}`);
        file.source = legacy;
      }
    },
  };
}

/** The dashboard's kiosk pictures and the tray icon, into the legacy folder (not dist/renderer). */
function legacyPublic(): Plugin {
  return {
    name: 'r2m-legacy-public',
    closeBundle() {
      const pictures = path.join(client, '..', 'public', 'kiosk');
      if (existsSync(pictures)) cpSync(pictures, path.join(LEGACY_OUT, 'kiosk'), { recursive: true });
      const icon = path.join(here, 'build', 'icon.png');
      if (existsSync(icon)) cpSync(icon, path.join(LEGACY_OUT, 'tray.png'));
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
  const cfg = (typeof base === 'function' ? base(env) : base) as UserConfig;
  return {
    ...cfg,
    // Not the modern build's public copy (it writes into dist/renderer): ours, into the legacy folder.
    plugins: [...flat(cfg.plugins as PluginOption[]).filter((p) => p.name !== 'kiosk-public'), legacyCssPlugin(), legacyPublic()],
    build: {
      ...(cfg.build ?? {}),
      outDir: LEGACY_OUT,
      emptyOutDir: true,
      target: `chrome${LEGACY_CHROME}`,
      cssTarget: `chrome${LEGACY_CHROME}`,
    },
  };
});
