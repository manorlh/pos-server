/**
 * The Windows host (S0-6): the bundle runs in R2M POS for Windows (the same Electron app and
 * installer as the kiosk — the till is just the role the cloud gives the device), loaded from a
 * verified bundle folder through `r2m://app/`. The engine is behind `window.r2mApp` (preload/
 * app.ts → main/roles/till.ts): the mock today, the bundled Java engine over stdio in P2. The
 * page gets no hardware: the engine's `hw.*` are carried out in the main process (§3.1).
 */

import type { AppHostInfo, R2mAppBridge } from '../../shared/till/appBridge';
import { endpointLink } from './engineLink';
import type { HostRole, TillHost } from './TillHost';

export function createElectronHost(bridge: R2mAppBridge, info: AppHostInfo): TillHost {
  const link = endpointLink({ hello: (since) => bridge.hello(since), call: (c) => bridge.call(c), on: (fn) => bridge.on(fn) });
  let role: HostRole = info.role;
  const listeners = new Set<(r: HostRole) => void>();
  bridge.onRole((r) => {
    role = r;
    for (const fn of Array.from(listeners)) fn(r);
  });
  return {
    kind: 'electron',
    shellApi: info.shellApi,
    get role() {
      return role;
    },
    demo: info.demo,
    onRoleChange: (cb) => {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
    capabilities: async () => info.caps,
    engine: link,
    bundle: {
      current: info.bundle,
      pending: null,
      reportReady: () => bridge.reportReady(),
      reportIdle: (idle, busy) => bridge.reportIdle(idle, busy),
    },
    device: info.device,
    ui: {
      keepAwake: (on) => bridge.keepAwake(on),
      // The window is the shell's (full screen, kiosk mode); nothing to do from the page.
      fullscreen: () => undefined,
    },
  };
}
