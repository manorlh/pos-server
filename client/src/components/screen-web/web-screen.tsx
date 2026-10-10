'use client';

/**
 * The browser KDS (`/kds`) and the "מסך מוכן / לא מוכן" board (`/board`) — docs/SPEC_KDS.md §13.
 * The Windows app's role screens (kiosk-shared/roles — one code) on the browser's local service
 * (lib/screenWebService.ts: pairing, the feed, the actions' outbox, the heartbeat), in any browser:
 * a TV's or a mini PC's Chrome / Edge, an Android or Windows tablet, an iPad.
 *
 * What makes the tab a screen: its own service worker and manifest (installs as "R2M KDS" /
 * "R2M Board", full screen, from its route), full screen on the first tap, the screen kept awake,
 * no zoom or context menu, reconnecting by itself (and at once when the browser says it is back on
 * line), the last board kept through a drop. Sound needs one tap first (the browsers' autoplay
 * rules) — a small "הקישו להפעלת צליל" says so until then.
 *
 * `?demo=1`: a pretend kitchen / board (lib/kdsScreenDemo.ts), never the network — `&kds=expo|manager`,
 * `&offline=1`, `&empty=1`, `&busy=1`; the look (docs/SPEC_KDS.md §14, lib/screenLook.ts
 * `lookFromQuery`): the KDS's `&layout=tickets|columns|rail|list|big`, `&by=`, `&density=`, `&font=`,
 * `&age=8-12|off`, `&hide=…`, `&clock=0`, `&counts=0`; the board's `&layout=columns|spotlight|grid|
 * split|ticker`, `&prep=0`, `&title=…`, `&ready=`, `&promo=…`, `&media=demo`; both `&theme=dark|light|
 * contrast|brand`, `&accent=%23rrggbb`.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import { KdsScreen, type KdsScreenProps } from '@/kiosk-shared/roles/kds/KdsScreen';
import { OrderStatusBoard } from '@/kiosk-shared/roles/board/OrderStatusBoard';
import { onSoundChange, soundReady, soundSupported, unlockSound } from '@/kiosk-shared/roles/audio';
import type { RoleScreenBridge, RoleScreenEvents } from '@/kiosk-shared/roles/bridge';
import { describeBrowser, webDeviceInfo, type FetchFn, type KioskCredentials } from '@/lib/kioskWebApi';
import { BridgeAgent, BridgeClient, bridgeCodeFromHash, bridgeWorthProbing, hashWithoutBridgeCode } from '@/lib/kioskBridge';
import { bridgeCanPrint, bridgeRoleOf, kdsBonDoc } from '@/lib/screenBridge';
import { KV, openKioskStore, type StorageLike } from '@/lib/kioskWebStore';
import { boardDemo, DEMO_MEDIA, kdsDemo } from '@/lib/kdsScreenDemo';
import { boardDisplayOf } from '@/lib/pickupBoard';
import { lookFromQuery } from '@/lib/screenLook';
import { ScreenWebService, screenKeys, screenStoreOptions, type ScreenRoute, type ScreenWebView } from '@/lib/screenWebService';
import { WebPairing, type PairingTexts } from '@/components/kiosk-web/web-pairing';
import { TapSequence, inTechnicianZone } from '@/components/kiosk-web/web-staff';
import { askPersistentStorage, isStandalone, useFullscreenOnTap, useKioskGuards, useWakeLock } from '@/components/kiosk-web/web-shell';
import { registerScreenWorker, screenManifest, useManifestLink } from './screen-shell';
import { ScreenStaff } from './screen-staff';
import { ScreenBridgePrompt, bridgePromptDue, useBridgeState } from './screen-bridge';

export const WEB_SCREEN_VERSION = '1.0.0';

const PAIRING: Record<ScreenRoute, PairingTexts> = {
  kds: {
    title: 'צימוד מסך מטבח (KDS) בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← מסך מטבח (KDS), בפלטפורמה דפדפן.',
    namePrefix: 'מסך מטבח',
    after: 'אחרי הצימוד: התקינו כאפליקציה (Chrome / Edge: "התקנת האפליקציה"; iPad: שיתוף ← "הוסף למסך הבית"), ונגיעה אחת במסך מפעילה צליל ומסך מלא.',
  },
  board: {
    title: 'צימוד מסך מוכן / לא מוכן בדפדפן',
    hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← מסך מוכן / לא מוכן, בפלטפורמה דפדפן.',
    namePrefix: 'מסך מוכן',
    after: 'בטלוויזיה: פתחו את הכתובת בדפדפן של המסך (או ב-Chrome / Edge של מחשב שמחובר אליו) במסך מלא. נגיעה / לחיצה אחת מפעילה את הצליל.',
  },
};

function safe<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

function storageEnv() {
  return { indexedDB: safe(() => window.indexedDB), localStorage: safe(() => window.localStorage as StorageLike) };
}

/** The demo's pretend cloud: the real screens on lib/kdsScreenDemo.ts. */
function demoBridge(route: ScreenRoute, params: URLSearchParams): { bridge: RoleScreenBridge; stop: () => void } {
  const listeners: { [K in keyof RoleScreenEvents]: Set<(p: RoleScreenEvents[K]) => void> } = { kds: new Set(), board: new Set() };
  const kds = kdsDemo((v) => listeners.kds.forEach((fn) => fn(v)), route === 'kds', params);
  const board = boardDemo((v) => listeners.board.forEach((fn) => fn(v)), route === 'board', params);
  return {
    bridge: {
      kds: async () => kds.view(),
      board: async () => board.view(),
      kdsAction: (a) => kds.action(a),
      activity: () => undefined,
      on: (event, fn) => {
        const set = listeners[event] as Set<typeof fn>;
        set.add(fn);
        return () => void set.delete(fn);
      },
    },
    stop: () => {
      kds.stop();
      board.stop();
    },
  };
}

/** A pairing of another route: its page takes the credentials and opens. */
async function handOver(target: ScreenRoute | 'k', creds: KioskCredentials): Promise<void> {
  if (target === 'k') {
    const store = await openKioskStore(storageEnv());
    await store.set(KV.credentials, creds);
  } else {
    const store = await openKioskStore(storageEnv(), screenStoreOptions(target));
    await store.set(screenKeys(target).credentials, creds);
  }
  window.location.replace(`/${target}`);
}

/** "הקישו להפעלת צליל" until the browser lets the page make sound (one tap anywhere does it). */
function SoundHint({ big }: { big: boolean }) {
  const [ready, setReady] = useState(() => soundReady());
  useEffect(() => {
    const update = () => setReady(soundReady());
    const off = onSoundChange(update);
    const t = setInterval(update, 2_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  if (!soundSupported()) return null;
  if (ready) {
    return big ? null : <Volume2 aria-label="צליל פעיל" className="shrink-0 opacity-60" size={22} />;
  }
  return (
    <span className={`inline-flex shrink-0 items-center gap-2 rounded-xl bg-amber-400 px-3 py-1.5 font-extrabold text-black ${big ? 'text-[2vmin]' : 'text-lg'}`}>
      <VolumeX size={big ? 24 : 20} /> הקישו על המסך להפעלת צליל
    </span>
  );
}

export function WebScreen({ route, apiUrl }: { route: ScreenRoute; apiUrl: string }) {
  const [svc, setSvc] = useState<ScreenWebService | null>(null);
  const [view, setView] = useState<ScreenWebView | null>(null);
  const [demo, setDemo] = useState<{ bridge: RoleScreenBridge; params: URLSearchParams } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [staff, setStaff] = useState(false);
  const [agent, setAgent] = useState<BridgeAgent | null>(null);
  const [promptClosed, setPromptClosed] = useState(false);
  const bridgeState = useBridgeState(agent);
  const taps = useRef(new TapSequence());

  useKioskGuards();
  useManifestLink(screenManifest(route));
  const live = !!demo || view?.phase === 'ready';
  useWakeLock(live);
  useFullscreenOnTap(live);

  // The first tap (anywhere, any time) lets the page make sound.
  useEffect(() => {
    const on = () => unlockSound();
    window.addEventListener('pointerdown', on, { capture: true });
    window.addEventListener('keydown', on, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', on, { capture: true });
      window.removeEventListener('keydown', on, { capture: true });
    };
  }, []);

  useEffect(() => {
    let gone = false;
    let made: ScreenWebService | null = null;
    let bridge: BridgeAgent | null = null;
    let stopDemo: (() => void) | null = null;
    const q = new URLSearchParams(window.location.search);
    if (q.get('demo') === '1') {
      const d = demoBridge(route, q);
      stopDemo = d.stop;
      // Set from the effect on purpose: the address is read on the device, never on the server.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDemo({ bridge: d.bridge, params: q });
      return () => stopDemo?.();
    }
    registerScreenWorker(route);
    askPersistentStorage();
    // "גשר לדפדפן" (SPEC_KIOSK §28): a bridge that opened this page passes its one-time code in the fragment.
    const bridgeCode = bridgeCodeFromHash(window.location.hash);
    if (bridgeCode) {
      try {
        window.history.replaceState(null, '', window.location.pathname + window.location.search + hashWithoutBridgeCode(window.location.hash));
      } catch {
        /* the address keeps it until the next load */
      }
    }
    (async () => {
      const store = await openKioskStore(storageEnv(), screenStoreOptions(route));
      // The Windows bridge on this PC (printing for the KDS, opening on start): looked for on Windows,
      // or when this page already paired with one / was opened by one. Never in the demo.
      const client = new BridgeClient({ fetchFn: (url, init) => fetch(url, init as RequestInit), store, role: bridgeRoleOf(route) });
      await client.load();
      if (bridgeWorthProbing({ userAgent: navigator.userAgent, hasPairing: client.paired, hasCode: !!bridgeCode })) {
        bridge = new BridgeAgent(client, {
          // Linked to the screen's machine: the bridge then knows this screen (and its technician code).
          machine: () => {
            const c = made?.credentials();
            return c ? { serverUrl: c.serverUrl, machineId: c.machineId, accessToken: c.accessToken, machineName: made?.view().machine?.name ?? null } : null;
          },
          pageUrl: () => `${window.location.origin}/${route}`,
          device: () => {
            const d = describeBrowser(navigator.userAgent);
            return { browser: d.browser, os: d.os };
          },
          log: (msg) => console.info(`[${route}] ${msg}`),
        });
        bridge.pairWhenFound(bridgeCode);
      }
      const fetchFn: FetchFn = (input, init) => fetch(input, init);
      made = new ScreenWebService({
        route,
        store,
        fetchFn,
        defaultServer: apiUrl,
        appVersion: `web-${route}-${WEB_SCREEN_VERSION}`,
        deviceInfo: () => ({
          ...webDeviceInfo(
            {
              userAgent: navigator.userAgent,
              platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
              language: navigator.language,
              screen: { width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio || 1 },
              standalone: isStandalone(),
              touch: navigator.maxTouchPoints ?? 0,
            },
            WEB_SCREEN_VERSION,
          ),
          client: `r2m-web-${route}`,
        }),
        log: (msg) => console.info(`[${route}] ${msg}`),
      });
      made.onView((v) => {
        if (!gone) setView(v);
      });
      const v = await made.init();
      if (gone) {
        made.stop();
        return;
      }
      bridge?.start();
      setSvc(made);
      setView(v);
      setAgent(bridge);
    })().catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
      made?.stop();
      bridge?.stop();
    };
  }, [apiUrl, route]);

  // The browser's own word on the network, and a tab that comes back: the board and the waiting actions at once.
  useEffect(() => {
    if (!svc) return;
    const on = () => svc.networkChanged();
    const visible = () => {
      if (document.visibilityState === 'visible') svc.networkChanged();
    };
    window.addEventListener('online', on);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('online', on);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [svc]);

  const bridge = useMemo<RoleScreenBridge | null>(() => demo?.bridge ?? svc?.bridge() ?? null, [demo, svc]);
  // The demo's look from the address (docs/SPEC_KDS.md §14): `&layout=`, `&theme=`, `&accent=`… — screenLook.ts `lookFromQuery`.
  const forcedDisplay = useMemo(() => (demo ? boardDisplayOf(lookFromQuery(demo.params, 'board', DEMO_MEDIA)) : null), [demo]);

  /** Six taps in the top-left corner: the staff sheet (with the technician code). */
  const corner = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!svc) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (inTechnicianZone(e.clientX - rect.left, e.clientY - rect.top) && taps.current.tap(e.timeStamp)) setStaff(true);
  };

  if (failed) return <Splash title="המסך לא נפתח" body={failed} />;
  if (demo && bridge) return <Screen route={route} shows={route} bridge={bridge} forced={forcedDisplay} />;
  if (!svc || !view || view.phase === 'loading' || !bridge) return <Splash title="טוען…" spin />;
  // "הדפס" on the KDS's cards: the bridge prints the card as a bon (only when it can now).
  const onPrint: KdsScreenProps['onPrint'] =
    agent && view.shows === 'kds' && bridgeCanPrint(bridgeState)
      ? async (o, device) => {
          const doc = kdsBonDoc(o, { device, machineName: view.machine?.name ?? null, now: new Date() });
          const r = await agent.print({ kind: 'bon', doc: { ...doc }, refId: o.id });
          return r.kind === 'ok' ? { ok: true } : { ok: false, message: r.kind === 'refused' ? (r.message ?? 'ההדפסה נכשלה') : 'הגשר לא ענה' };
        }
      : undefined;
  const prompt = !!agent && !staff && !promptClosed && bridgePromptDue(bridgeState, route, bridgeState?.checkedAt ?? 0);

  if (view.phase === 'unpaired') {
    return (
      <WebPairing
        defaultServer={apiUrl}
        texts={PAIRING[route]}
        onPair={async (input) => {
          const r = await svc.pair(input);
          if (!r.ok) return r;
          if (r.handoff && svc.handedOver) await handOver(r.handoff, svc.handedOver);
          return { ok: true };
        }}
      />
    );
  }
  return (
    <Screen
      route={route}
      shows={view.shows}
      bridge={bridge}
      machineName={view.machine?.name ?? null}
      shopName={view.machine?.shopName ?? null}
      onPointerDown={corner}
      onPrint={onPrint}
      overlay={
        staff ? (
          <ScreenStaff view={view} svc={svc} bridge={agent} onClose={() => setStaff(false)} />
        ) : prompt && agent ? (
          <ScreenBridgePrompt agent={agent} route={route} onClose={() => setPromptClosed(true)} />
        ) : null
      }
    />
  );
}

function Screen({
  shows,
  bridge,
  machineName = null,
  shopName = null,
  onPointerDown,
  overlay = null,
  forced = null,
  onPrint,
}: {
  route: ScreenRoute;
  shows: ScreenRoute;
  bridge: RoleScreenBridge;
  machineName?: string | null;
  shopName?: string | null;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  overlay?: React.ReactNode;
  forced?: ReturnType<typeof boardDisplayOf> | null;
  onPrint?: KdsScreenProps['onPrint'];
}) {
  if (shows === 'board') {
    return <OrderStatusBoard bridge={bridge} shopName={shopName} onPointerDown={onPointerDown} overlay={overlay} display={forced} headerExtra={<SoundHint big />} />;
  }
  return <KdsScreen bridge={bridge} machineName={machineName} shopName={shopName} onPointerDown={onPointerDown} overlay={overlay} onPrint={onPrint} headerExtra={<SoundHint big={false} />} />;
}

function Splash({ title, body, spin }: { title: string; body?: string; spin?: boolean }) {
  return (
    <div dir="rtl" className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-[#0d1016] p-8 text-center text-white">
      {spin ? <span className="h-10 w-10 animate-spin rounded-full border-4 border-white/20 border-t-sky-400" /> : null}
      <h1 className="text-xl font-extrabold">{title}</h1>
      {body ? <p className="max-w-md text-sm text-white/60">{body}</p> : null}
      <p className="text-[10px] tracking-[0.12em] text-white/40">Powered by R2M</p>
    </div>
  );
}
