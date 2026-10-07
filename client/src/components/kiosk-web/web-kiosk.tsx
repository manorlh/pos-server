'use client';

/**
 * The browser kiosk (`/k`, docs/SPEC_KIOSK.md §27): opens its storage, starts its local service
 * (lib/kioskWebService.ts — pairing, the cloud's copies, the sync, the orders) and shows the
 * screen the phase asks — pairing, "waiting for the cloud", or the kiosk itself (web-kiosk-app.tsx).
 * Any browser: Chrome / Edge on Android and Windows, Safari on iPad / iPhone, Samsung Internet.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMessages } from 'next-intl';
import { WebKioskService, type WebKioskView } from '@/lib/kioskWebService';
import { openKioskStore, type StorageLike } from '@/lib/kioskWebStore';
import { describeBrowser, webDeviceInfo, type FetchFn } from '@/lib/kioskWebApi';
import { BridgeAgent, BridgeClient, bridgeCodeFromHash, bridgeWorthProbing, hashWithoutBridgeCode } from '@/lib/kioskBridge';
import { kioskWords, type KioskWords } from './web-i18n';
import { WebKioskApp } from './web-kiosk-app';
import { WebPairing } from './web-pairing';
import { askPersistentStorage, cacheKioskMedia, isStandalone, registerKioskWorker, useFullscreenOnTap, useKioskGuards, useKioskManifest, useWakeLock } from './web-shell';
import { demoFetch, demoStore } from './web-demo';

export const WEB_KIOSK_VERSION = '1.0.0';

function safe<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

export function WebKiosk({ apiUrl }: { apiUrl: string }) {
  const messages = useMessages() as Record<string, unknown>;
  const words = useMemo(() => kioskWords(messages), [messages]);
  const [svc, setSvc] = useState<WebKioskService | null>(null);
  const [view, setView] = useState<WebKioskView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useKioskGuards();
  useKioskManifest();
  useWakeLock(view?.phase === 'kiosk');
  useFullscreenOnTap(view?.phase === 'kiosk');

  useEffect(() => {
    let gone = false;
    let made: WebKioskService | null = null;
    let stopBridge: () => void = () => undefined;
    const q = new URLSearchParams(window.location.search);
    const demo = q.get('demo') === '1';
    if (!demo) {
      registerKioskWorker();
      askPersistentStorage();
    }
    // "גשר לדפדפן" (§28): a bridge that opened this page passes its one-time code in the fragment.
    const bridgeCode = bridgeCodeFromHash(window.location.hash);
    if (bridgeCode) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + hashWithoutBridgeCode(window.location.hash));
      } catch {
        /* the address keeps it until the next load */
      }
    }
    (async () => {
      const store = demo
        ? await demoStore()
        : await openKioskStore({ indexedDB: safe(() => window.indexedDB), localStorage: safe(() => window.localStorage as StorageLike) });
      const fetchFn: FetchFn = demo ? demoFetch(q) : (input, init) => fetch(input, init);
      // The Windows bridge on this PC (card terminal, printer): never in the demo; looked for on
      // Windows, or when this page already paired with one / was opened by one.
      let bridge: BridgeAgent | null = null;
      if (!demo) {
        const client = new BridgeClient({ fetchFn: (url, init) => fetch(url, init as RequestInit), store, role: 'kiosk' });
        await client.load();
        if (bridgeWorthProbing({ userAgent: navigator.userAgent, hasPairing: client.paired, hasCode: !!bridgeCode })) {
          bridge = new BridgeAgent(client, {
            machine: () => made?.bridgeMachine() ?? null,
            pageUrl: () => `${window.location.origin}/k`,
            device: () => {
              const d = describeBrowser(navigator.userAgent);
              return { browser: d.browser, os: d.os };
            },
            log: (msg) => console.info(`[kiosk] ${msg}`),
          });
          bridge.pairWhenFound(bridgeCode);
        }
      }
      made = new WebKioskService({
        bridge,
        store,
        fetchFn,
        defaultServer: demo ? 'https://demo.invalid' : apiUrl,
        appVersion: `web-${WEB_KIOSK_VERSION}`,
        deviceInfo: () =>
          webDeviceInfo(
            {
              userAgent: navigator.userAgent,
              platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
              language: navigator.language,
              screen: { width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio || 1 },
              standalone: isStandalone(),
              touch: navigator.maxTouchPoints ?? 0,
            },
            WEB_KIOSK_VERSION,
          ),
        onMedia: demo ? undefined : cacheKioskMedia,
        log: (msg) => console.info(`[kiosk] ${msg}`),
      });
      made.on((v) => {
        if (!gone) setView(v);
      });
      const v = await made.init();
      if (gone) {
        made.stop();
        return;
      }
      stopBridge = () => bridge?.stop();
      bridge?.start();
      setSvc(made);
      setView(v);
    })().catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
      made?.stop();
      stopBridge();
    };
  }, [apiUrl]);

  // The browser's own word on the network: the next sync at once.
  useEffect(() => {
    if (!svc) return;
    const on = () => svc.networkChanged();
    window.addEventListener('online', on);
    window.addEventListener('offline', on);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', on);
    };
  }, [svc]);

  if (failed) return <Splash words={words} title="הקיוסק לא נפתח" body={failed} />;
  if (!svc || !view || view.phase === 'loading') return <Splash words={words} title={words.t('loading')} spin />;
  if (view.phase === 'unpaired') return <WebPairing defaultServer={apiUrl} onPair={(input) => svc.pair(input)} />;
  if (view.phase === 'waiting' || !view.config) {
    return <Waiting words={words} view={view} svc={svc} />;
  }
  return <WebKioskApp view={view} svc={svc} words={words} />;
}

function Splash({ words, title, body, spin }: { words: KioskWords; title: string; body?: string; spin?: boolean }) {
  return (
    <div dir="rtl" className="flex h-dvh w-screen flex-col items-center justify-center gap-3 bg-neutral-50 p-8 text-center text-neutral-900">
      {spin ? <span className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-200 border-t-blue-600" /> : null}
      <h1 className="text-xl font-extrabold">{title}</h1>
      {body ? <p className="max-w-md text-sm text-neutral-500">{body}</p> : null}
      <p className="text-[10px] tracking-[0.12em] text-neutral-400">{words.t('poweredBy')}</p>
    </div>
  );
}

function Waiting({ words, view, svc }: { words: KioskWords; view: WebKioskView; svc: WebKioskService }) {
  const [ask, setAsk] = useState(false);
  return (
    <div dir="rtl" className="flex h-dvh w-screen flex-col items-center justify-center gap-3 bg-neutral-50 p-8 text-center text-neutral-900">
      <span className="h-12 w-12 animate-spin rounded-full border-4 border-neutral-200 border-t-blue-600" />
      <h1 className="text-2xl font-extrabold">{words.t('waitingTitle')}</h1>
      <p className="max-w-md text-sm text-neutral-500">{view.staff.notKiosk ? words.t('notKioskBody') : words.t('waitingBody')}</p>
      <p className="text-xs text-neutral-400">
        {view.machine?.name ?? ''} {view.machine?.shopName ? `· ${view.machine.shopName}` : ''}
      </p>
      {ask ? (
        <div className="flex gap-2">
          <button type="button" className="rounded-full bg-neutral-200 px-4 py-2 text-sm font-bold" onClick={() => setAsk(false)}>
            ביטול
          </button>
          <button type="button" className="rounded-full bg-red-600 px-4 py-2 text-sm font-bold text-white" onClick={() => void svc.unpair()}>
            ניתוק וצימוד מחדש
          </button>
        </div>
      ) : (
        <button type="button" className="text-xs text-neutral-400 underline" onClick={() => setAsk(true)}>
          צימוד מחדש
        </button>
      )}
    </div>
  );
}
