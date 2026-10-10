'use client';

/**
 * What makes a browser tab a kiosk (`/k`, docs/SPEC_KIOSK.md §27): its own service worker
 * (public/kiosk-sw.js — the app shell and the kiosk's media kept, so a reload or a short network
 * drop never blanks the screen), full screen on the first tap where the browser allows it, the
 * screen kept awake (Screen Wake Lock) where supported, persistent storage asked for, and no
 * context menu, pinch zoom or double-tap zoom. Nothing here changes a device setting.
 */

import { useEffect, useState } from 'react';

const SW_URL = '/kiosk-sw.js';
const SW_SCOPE = '/k';

/** The kiosk's worker: in a production build (under `next dev` only with `?sw=1`, never serving stale chunks otherwise). */
export function registerKioskWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const dev = process.env.NODE_ENV !== 'production';
  if (dev && !new URLSearchParams(window.location.search).has('sw')) return;
  navigator.serviceWorker.register(dev ? `${SW_URL}?dev=1` : SW_URL, { scope: SW_SCOPE, updateViaCache: 'none' }).catch(() => {
    // No worker (private mode, an old browser): the kiosk works, a reload needs the network.
  });
}

/** The media the kiosk shows: the worker fetches what it does not have yet and drops the rest. */
export function cacheKioskMedia(urls: string[]): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then((reg) => reg.active?.postMessage({ type: 'kiosk-media', urls }))
    .catch(() => undefined);
}

/** Opened from the home screen / as an installed app (no browser bar). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia('(display-mode: fullscreen)').matches || window.matchMedia('(display-mode: standalone)').matches) return true;
  } catch {
    /* an old browser */
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Asks the browser to keep the kiosk's storage (credentials, the cloud's copies) under pressure. */
export function askPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.().catch(() => undefined);
  } catch {
    /* not offered */
  }
}

/** Full screen on the first tap (a browser allows it only on a gesture); not on iPhone (iOS has no Fullscreen API for pages). */
export function useFullscreenOnTap(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return;
    const go = () => {
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
      if (document.fullscreenElement || isStandalone()) return;
      try {
        if (document.fullscreenEnabled && el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => undefined);
        else el.webkitRequestFullscreen?.();
      } catch {
        /* refused: the kiosk works in the tab */
      }
    };
    window.addEventListener('pointerdown', go, { capture: true });
    return () => window.removeEventListener('pointerdown', go, { capture: true });
  }, [enabled]);
}

/** The screen stays on while the kiosk is shown (Screen Wake Lock: Chrome, Edge, Safari 16.4+), taken again when the tab comes back. */
export function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined') return;
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; addEventListener(t: string, f: () => void): void }> } };
    if (!nav.wakeLock) return;
    let lock: { release(): Promise<void> } | null = null;
    let gone = false;
    const take = async () => {
      if (gone || document.visibilityState !== 'visible') return;
      try {
        lock = await nav.wakeLock!.request('screen');
      } catch {
        lock = null;
      }
    };
    const onVisible = () => void take();
    void take();
    document.addEventListener('visibilitychange', onVisible);
    // A tap also takes it again (some browsers drop it on their own).
    window.addEventListener('pointerdown', onVisible, { passive: true });
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pointerdown', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [enabled]);
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/** Chrome / Edge's "install app" offer, kept for the staff screen's button (Safari: Share → Add to Home Screen). */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<boolean> } {
  const [evt, setEvt] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setEvt(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return {
    canInstall: !!evt,
    install: async () => {
      if (!evt) return false;
      await evt.prompt();
      const choice = await evt.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
      setEvt(null);
      return choice.outcome === 'accepted';
    },
  };
}

/**
 * The kiosk's own web app manifest (`/k.webmanifest`: "R2M Kiosk", full screen, start and scope `/k`).
 * The dashboard's app/manifest.ts is linked on every page of the site (a file convention a page
 * cannot override), so the link is pointed here once the page is up — before anyone installs it:
 * Chrome / Edge follow a changed manifest link, and Safari reads it when "הוסף למסך הבית" is tapped.
 */
export const KIOSK_MANIFEST = '/k.webmanifest';

export function useKioskManifest(): void {
  useEffect(() => {
    const point = () => {
      const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="manifest"]'));
      if (links.length === 0) {
        const link = document.createElement('link');
        link.rel = 'manifest';
        link.href = KIOSK_MANIFEST;
        document.head.appendChild(link);
        return;
      }
      for (const link of links) if (link.getAttribute('href') !== KIOSK_MANIFEST) link.setAttribute('href', KIOSK_MANIFEST);
    };
    point();
    // The framework writes its head again (streamed metadata, a soft navigation): pointed here again.
    const watch = new MutationObserver(() => {
      if (Array.from(document.querySelectorAll('link[rel="manifest"]')).some((l) => l.getAttribute('href') !== KIOSK_MANIFEST)) point();
    });
    watch.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    return () => watch.disconnect();
  }, []);
}

/** No context menu, no pinch or ctrl-wheel zoom, no iOS gesture zoom. */
export function useKioskGuards(): void {
  useEffect(() => {
    const prevent = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey) e.preventDefault();
    };
    window.addEventListener('contextmenu', prevent);
    window.addEventListener('wheel', wheel, { passive: false });
    document.addEventListener('gesturestart', prevent);
    return () => {
      window.removeEventListener('contextmenu', prevent);
      window.removeEventListener('wheel', wheel);
      document.removeEventListener('gesturestart', prevent);
    };
  }, []);
}
