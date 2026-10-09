/**
 * `TillHost` — what the screens of the one app bundle (`r2m-app`) see of the place they run in
 * (P:/specs/web-till-spec-v2.md §3.1): a browser / PWA, the Windows app (Electron), the APK's
 * WebView, an iOS shell. Only the implementation differs between hosts; the screens are one.
 *
 *  - `engine`: the link to the till engine (the state, the ops, the events) — the screens never
 *    number, never decide a fiscal rule;
 *  - `capabilities()`: what this host can do, honestly — a tile that would fail is greyed with the
 *    reason (§2.5), never shown as a button that fails;
 *  - `bundle`: the screens' version, and "at rest" for an update (never mid-sale, §2.6, §8.2);
 *  - hardware is NOT here: in the shells `hw.*` go from the engine to native code; in a plain
 *    browser the host runs them itself (host/browser), out of the screens' reach (§3.1, §9.5).
 *
 * Every API used here exists in Chromium 108 (the Windows 7 floor, §13.3).
 */

import type { DeviceRoleName, EngineEvent, HelloReply, OpArgs, TillOp, TillState } from '../../shared/till/protocol';

export type HostKind = 'browser' | 'electron' | 'android' | 'ios';
export type HostRole = DeviceRoleName;
export type Orientation = 'portrait' | 'landscape' | 'any';

export interface HostCaps {
  /** The engine runs on this device (Windows with the bundled Java, the APK): works offline. */
  localEngine: boolean;
  print: { tcp: boolean; spooler: boolean; usb: boolean; btSpp: boolean; ble: boolean; airprint: boolean; relay: boolean; lanHost: boolean; system: boolean };
  drawer: { viaPrinter: boolean; devicePort: boolean };
  channels: { tcpTls: boolean; https: boolean; serial: boolean; usbCdc: boolean };
  terminals: { nayaxLan: boolean; nayaxUsb: boolean; synqpayLan: boolean; synqpaySerial: boolean; zcredit: boolean; agamento: boolean };
  scan: { hid: boolean; camera: boolean };
  customerDisplay: boolean;
  secureStore: boolean;
  backgroundSync: boolean;
}

export type LinkStatus = 'connecting' | 'ready' | 'offline' | 'mismatch';

export interface CallOptions {
  /** Given for a retry of the same op; a new one is made for every changing op otherwise. */
  clientOpId?: string;
  timeoutMs?: number;
}

export interface EngineLink {
  /** An op; a refusal rejects with an EngineCallError (code + Hebrew message). */
  call<K extends TillOp>(op: K, args?: OpArgs[K], opts?: CallOptions): Promise<unknown>;
  /** Engine events (`state`, `hw` in a browser host, `toast`). */
  on(fn: (e: EngineEvent) => void): () => void;
  /** `session.hello {since}`: the engine's state (full, or the changes since). */
  hello(since?: number): Promise<HelloReply>;
  /** The last state known, synchronously (null before the first hello). */
  snapshot(): { seq: number; state: TillState } | null;
  status(): LinkStatus;
  onStatus(fn: (s: LinkStatus) => void): () => void;
}

export interface BundleInfo {
  version: string;
  versionCode: number;
  protocol: number;
}

export interface BundleControl {
  current: BundleInfo | null;
  pending: BundleInfo | null;
  /** The screens are drawn (the watchdog's "ready", §8.2). */
  reportReady(): void;
  /** At rest or not: the host swaps a bundle only when idle and not busy (the engine confirms). */
  reportIdle(idle: boolean, busy: boolean): void;
}

export interface DeviceInfo {
  model: string;
  os: string;
  screen: { width: number; height: number; dpr: number };
  installationId: string | null;
  shellVersion: string | null;
  /** The "lite" profile: no animations, no shadows (§13.4) — a hint the screens follow. */
  lite: boolean;
}

export interface TillHost {
  kind: HostKind;
  /** 0 in a browser; rises when a shell adds a native capability (§8.4). */
  shellApi: number;
  role: HostRole;
  onRoleChange(cb: (role: HostRole) => void): () => void;
  capabilities(): Promise<HostCaps>;
  engine: EngineLink;
  bundle: BundleControl;
  device: DeviceInfo;
  ui: { keepAwake(on: boolean): void; fullscreen(): void; lockOrientation?(o: Orientation): void };
  /** A demo engine: the screens say so on every screen. */
  demo: boolean;
}

/** An engine's refusal (the protocol's error code and its Hebrew text). */
export class EngineCallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'EngineCallError';
  }
}
