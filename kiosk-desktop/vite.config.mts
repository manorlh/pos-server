import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The renderer (the kiosk's screens). The screens themselves are shared with the dashboard's
 * live preview: they live in `client/src/kiosk-shared` and the config logic in
 * `client/src/lib/kioskConfig.ts`. Those files import React and friends as bare names; they are
 * deduped to this package's node_modules so there is one React (and the dashboard's
 * node_modules is not needed to build the kiosk).
 *
 * `--mode web` (npm run dev:web) serves the screens in a browser with a fake bridge — a quick
 * way to look at them without Electron. Never used by the kiosk itself.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '../client/src');

export const sharedAlias = {
  '@kiosk-shared': path.join(client, 'kiosk-shared'),
  '@dash-lib': path.join(client, 'lib'),
  '@dash-messages': path.join(client, 'messages'),
  // The shared screens import the dashboard's own alias (`@/lib/utils`, `@/lib/kioskConfig`).
  '@': client,
};

/**
 * `virtual:kiosk-strings`: the kiosk's Hebrew texts taken from the dashboard's messages at build
 * time — `kiosks.builtin` (the screens' built-in texts) and `kiosks.preview` (the preview's
 * labels) — so the kiosk and the preview say the same words, without bundling all of he.json.
 */
function kioskStrings(): Plugin {
  const id = 'virtual:kiosk-strings';
  return {
    name: 'kiosk-strings',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const file = path.join(client, 'messages', 'he.json');
      this.addWatchFile(file);
      const he = JSON.parse(readFileSync(file, 'utf8')) as { kiosks?: { builtin?: unknown; preview?: unknown } };
      return `export default ${JSON.stringify({ builtin: he.kiosks?.builtin ?? {}, preview: he.kiosks?.preview ?? {} })};`;
    },
  };
}

/** The dashboard's public kiosk pictures (`/kiosk/card_terminals.png`…), served and copied as they are. */
function kioskPublic(): Plugin {
  const src = path.join(client, '..', 'public', 'kiosk');
  return {
    name: 'kiosk-public',
    configureServer(server) {
      server.middlewares.use('/kiosk', (req, res, next) => {
        const file = path.join(src, decodeURIComponent((req.url ?? '').split('?')[0]));
        if (!file.startsWith(src) || !existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    closeBundle() {
      if (existsSync(src)) cpSync(src, path.join(here, 'dist/renderer/kiosk'), { recursive: true });
      // The bridge's tray icon (main/bridge/electron.ts reads dist/renderer/tray.png).
      const icon = path.join(here, 'build', 'icon.png');
      if (existsSync(icon)) cpSync(icon, path.join(here, 'dist/renderer/tray.png'));
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: path.join(here, 'src/renderer'),
  base: './',
  plugins: [react(), tailwindcss(), kioskStrings(), kioskPublic()],
  define: {
    __WEB_BRIDGE__: JSON.stringify(mode === 'web'),
  },
  resolve: {
    alias: sharedAlias,
    dedupe: ['react', 'react-dom', 'lucide-react', 'qrcode.react', 'clsx', 'tailwind-merge'],
  },
  json: { namedExports: true, stringify: false },
  server: {
    port: 5178,
    fs: { allow: [here, client] },
  },
  build: {
    outDir: path.join(here, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: mode === 'development',
    reportCompressedSize: false,
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        index: path.join(here, 'src/renderer/index.html'),
        print: path.join(here, 'src/renderer/print.html'),
        // "גשר לדפדפן": the bridge's tray window (main/bridge/electron.ts).
        bridge: path.join(here, 'src/renderer/bridge.html'),
      },
    },
  },
}));
