'use client';

import { useEffect } from 'react';

/**
 * Registers public/sw.js — in a production build only. Under `next dev` a worker would
 * serve stale chunks across hot reloads, so there any worker a production run on the
 * same origin left behind is removed instead.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    // The browser kiosk (`/k`) has a worker of its own (public/kiosk-sw.js, web-kiosk/web-shell.ts),
    // and so have the browser KDS and board (`/kds`, `/board`: public/screens-sw.js).
    const path = window.location.pathname;
    if (['/k', '/kds', '/board'].some((p) => path === p || path.startsWith(`${p}/`))) return;
    if (process.env.NODE_ENV !== 'production') {
      void navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((r) => r.unregister())))
        .catch(() => {});
      return;
    }
    // `updateViaCache: 'none'`: a new sw.js is picked up on the next visit, never served from HTTP cache.
    navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).catch(() => {
      // Not installable then, but the dashboard itself works the same.
    });
  }, []);
  return null;
}
