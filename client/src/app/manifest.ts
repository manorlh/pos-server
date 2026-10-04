import type { MetadataRoute } from 'next';

/**
 * The web app manifest (served at /manifest.webmanifest): what lets a phone install the
 * dashboard to its home screen and open it full screen, in Hebrew, right to left.
 *
 * The colours are the light theme's (`--background` and `--primary` in globals.css);
 * the icons come from scripts/generate-pwa-icons.mjs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'R2M POS — ניהול',
    short_name: 'R2M POS',
    description: 'ניהול קטלוג ומכשירי POS בענן',
    lang: 'he',
    dir: 'rtl',
    id: '/dashboard',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#ffffff',
    theme_color: '#ffffff',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
