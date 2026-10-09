/**
 * `window.r2mApp` — the Windows shell's door for the one app bundle in the till role (S0-6;
 * preload/app.ts ↔ main/roles/till.ts). It carries the till protocol's envelopes to the engine
 * (the mock today, the bundled JVM engine over stdio in P2) and back, the host's facts, and the
 * bundle's "ready" / "at rest". It exposes NO hardware: `hw.*` go from the engine to the main
 * process directly (§3.1, §9.5), so script injected into the page can never print or open the
 * drawer. Nothing here carries the machine token.
 */

import type { BundleInfo, DeviceInfo, HostCaps } from '../../renderer/host/TillHost';
import type { DeviceRoleName, EngineCall, EngineEvent, EngineReply, HelloReply } from './protocol';

/** The shell API version this preload speaks (§8.4: a bundle hides what a shell lacks). */
export const ELECTRON_SHELL_API = 1;

export interface AppHostInfo {
  role: DeviceRoleName;
  shellApi: number;
  shellVersion: string;
  caps: HostCaps;
  device: DeviceInfo;
  bundle: BundleInfo | null;
  demo: boolean;
}

export interface R2mAppBridge {
  info(): Promise<AppHostInfo>;
  hello(since?: number): Promise<HelloReply>;
  call(c: EngineCall): Promise<EngineReply>;
  on(fn: (e: EngineEvent) => void): () => void;
  onRole(fn: (role: DeviceRoleName) => void): () => void;
  reportReady(): void;
  reportIdle(idle: boolean, busy: boolean): void;
  keepAwake(on: boolean): void;
}

/** The IPC channel names (one place, for the preload and the main process). */
export const APP_IPC = {
  info: 'app:info',
  hello: 'app:hello',
  call: 'app:call',
  event: 'app:event',
  role: 'app:role',
  ready: 'app:ready',
  idle: 'app:idle',
  keepAwake: 'app:keepAwake',
} as const;
