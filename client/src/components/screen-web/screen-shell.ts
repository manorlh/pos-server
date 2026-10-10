'use client';

/**
 * What makes a browser tab a kitchen screen or a pickup board (`/kds`, `/board` — docs/SPEC_KDS.md
 * §13), next to the kiosk's own pieces (components/kiosk-web/web-shell.ts: full screen on the first
 * tap, Screen Wake Lock, persistent storage, no zoom / context menu, the install offer — reused as
 * they are): the route's own service worker and web app manifest.
 */

import { useEffect } from 'react';
import type { ScreenRoute } from '@/lib/screenWebService';

const SW_URL = '/screens-sw.js';

/** The route's worker (public/screens-sw.js, scope `/kds` or `/board`): in a production build (under `next dev` only with `?sw=1`). */
export function registerScreenWorker(route: ScreenRoute): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const dev = process.env.NODE_ENV !== 'production';
  if (dev && !new URLSearchParams(window.location.search).has('sw')) return;
  navigator.serviceWorker.register(`${SW_URL}?screen=${route}${dev ? '&dev=1' : ''}`, { scope: `/${route}`, updateViaCache: 'none' }).catch(() => {
    // No worker (private mode, an old browser): the screen works, a reload needs the network.
  });
}

/** `/kds.webmanifest` / `/board.webmanifest`. */
export function screenManifest(route: ScreenRoute): string {
  return `/${route}.webmanifest`;
}

/**
 * The page's manifest link pointed at the route's own (the dashboard's app/manifest.ts is linked on
 * every page of the site), before anyone installs it — and again whenever the framework rewrites
 * the head.
 */
export function useManifestLink(href: string): void {
  useEffect(() => {
    const point = () => {
      const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]'));
      if (links.length === 0) {
        const link = document.createElement('link');
        link.rel = 'manifest';
        link.href = href;
        document.head.appendChild(link);
        return;
      }
      for (const link of links) if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    };
    point();
    const watch = new MutationObserver(() => {
      if (Array.from(document.querySelectorAll('link[rel="manifest"]')).some((l) => l.getAttribute('href') !== href)) point();
    });
    watch.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    return () => watch.disconnect();
  }, [href]);
}
