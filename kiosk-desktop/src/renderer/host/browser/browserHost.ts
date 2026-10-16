/**
 * The browser host (a tab or an installed PWA at `/app`, and `npm run dev:web`): the engine is
 * remote — the cloud, or the APK main till on the LAN — or, in demo mode, the mock in the page.
 * There is no native code here, so this host carries out the engine's `hw.*` itself, in JS
 * (WebUSB, Web Serial, the cloud relay, the Windows bridge) — out of the screens' reach: they get
 * a `TillHost` without hardware (§3.1, the risk of v1 §7.6).
 */

import { MockTillEngine } from '../../../shared/till/mockEngine';
import type { EngineEndpoint, HwRequest } from '../../../shared/till/protocol';
import { browserCaps, type BrowserEnv } from '../caps';
import { endpointLink, wsEngineLink, type WsLike } from '../engineLink';
import { composePorts, DemoPrinterPort, executeHw, type ByteChannel, type HardwarePort } from '../HardwarePort';
import type { BundleInfo, DeviceInfo, EngineLink, HostRole, TillHost } from '../TillHost';

export type BrowserEngine = { kind: 'demo'; terminal?: boolean } | { kind: 'endpoint'; endpoint: EngineEndpoint } | { kind: 'ws'; url: string; connect(url: string): WsLike };

export interface BrowserHostOptions {
  engine: BrowserEngine;
  env: BrowserEnv;
  role?: HostRole;
  /** The real ports this page may use (WebUSB, Web Serial, relay, bridge), in order. */
  ports?: HardwarePort[];
  /** For the capability tiles: the relay / the bridge / a LAN main till are there. */
  relay?: boolean;
  bridge?: boolean;
  lanHost?: boolean;
  lite: boolean;
  device?: Partial<DeviceInfo>;
  bundle?: BundleInfo | null;
  /** The PWA's update gate listens here (client/src/lib/appPwa.ts): never mid-sale. */
  onIdleReport?(idle: boolean, busy: boolean): void;
  onReady?(): void;
}

export interface BrowserTillHost extends TillHost {
  /** The demo's virtual printer (null outside demo). */
  demoPrinter: DemoPrinterPort | null;
  /** The demo's engine (null outside demo) — the tests drive it. */
  demoEngine: MockTillEngine | null;
  dispose(): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<{ release(): Promise<void> }>;
}

export function createBrowserHost(o: BrowserHostOptions): BrowserTillHost {
  const demo = o.engine.kind === 'demo';
  const demoPrinter = demo ? new DemoPrinterPort() : null;
  const demoEngine = o.engine.kind === 'demo' ? new MockTillEngine({ terminal: o.engine.terminal === true, printerTarget: 'demo://printer', drawerTarget: 'demo://printer' }) : null;
  let link: EngineLink;
  let closeLink: () => void = () => undefined;
  const e = o.engine;
  if (e.kind === 'demo') link = endpointLink(demoEngine!);
  else if (e.kind === 'endpoint') link = endpointLink(e.endpoint);
  else {
    const ws = wsEngineLink({ url: e.url, connect: e.connect, callTimeoutMs: 180_000 });
    link = ws;
    closeLink = () => ws.close();
  }

  const port = composePorts([...(demoPrinter ? [demoPrinter] : []), ...(o.ports ?? [])]);
  const channels = new Map<string, ByteChannel>();
  // The engine's hardware requests, carried out here and answered.
  const offHw = link.on((e) => {
    if (e.ev !== 'hw') return;
    void executeHw(port, e.data as HwRequest, channels).then((r) => link.call('hw.result', r).catch(() => undefined));
  });

  const roleListeners = new Set<(r: HostRole) => void>();
  const caps = browserCaps(o.env, { relay: o.relay, bridge: o.bridge, lanHost: o.lanHost, demo });
  let wake: { release(): Promise<void> } | null = null;

  const scr = typeof window !== 'undefined' ? window.screen : null;
  const device: DeviceInfo = {
    model: 'browser',
    os: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 160) : 'unknown',
    screen: { width: scr?.width ?? 0, height: scr?.height ?? 0, dpr: typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1 },
    installationId: null,
    shellVersion: null,
    lite: o.lite,
    ...o.device,
  };

  return {
    kind: 'browser',
    shellApi: 0,
    role: o.role ?? 'till',
    demo,
    demoPrinter,
    demoEngine,
    onRoleChange: (cb) => {
      roleListeners.add(cb);
      return () => void roleListeners.delete(cb);
    },
    capabilities: async () => caps,
    engine: link,
    bundle: {
      current: o.bundle ?? null,
      pending: null,
      reportReady: () => o.onReady?.(),
      reportIdle: (idle, busy) => {
        o.onIdleReport?.(idle, busy);
        void link.call('host.idle', { idle, busy }).catch(() => undefined);
      },
    },
    device,
    ui: {
      keepAwake: (on) => {
        const wl = (typeof navigator !== 'undefined' ? (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock : undefined) ?? null;
        if (on && wl && !wake) {
          wl.request('screen').then(
            (w) => (wake = w),
            () => undefined,
          );
        } else if (!on && wake) {
          void wake.release().catch(() => undefined);
          wake = null;
        }
      },
      fullscreen: () => {
        const el = typeof document !== 'undefined' ? document.documentElement : null;
        if (el && typeof el.requestFullscreen === 'function' && !document.fullscreenElement) void el.requestFullscreen().catch(() => undefined);
      },
      lockOrientation: (orientation) => {
        // Chrome on Android, full screen only; elsewhere there is no lock — the layout follows the window.
        const so = typeof screen !== 'undefined' ? (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }) : undefined;
        if (orientation !== 'any' && so?.lock) void so.lock(orientation).catch(() => undefined);
      },
    },
    dispose: () => {
      offHw();
      closeLink();
      for (const ch of channels.values()) void ch.close().catch(() => undefined);
      channels.clear();
    },
  };
}
