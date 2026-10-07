/**
 * The bridge's own small window (tray → "R2M POS · גשר לדפדפן"): its contract with the main process
 * (`window.r2mBridge`, preload/index.ts). What it shows: the pairing code or the paired page, the
 * kiosk machine it serves, the card terminal and the printer, "פתיחה בהפעלה" (the browser in kiosk
 * mode), the allowed sites, updates and the log of the calls.
 */

import type { BrowserChoice, LauncherPhase, LauncherSettings } from '../core/bridgeLauncher';
import type { BridgeRole } from '../core/bridgeProtocol';
import type { UpdateView } from './roles';

export interface BridgeCallRow {
  at: number;
  method: string;
  path: string;
  origin: string | null;
  status: number;
  ms: number;
  note?: string | null;
}

export interface BridgeWindowView {
  version: string;
  /** The port the API listens on (null: not listening — `listenError` says why). */
  port: number | null;
  listenError: string | null;
  pairing: {
    paired: boolean;
    role: BridgeRole | null;
    roleLabel: string | null;
    origin: string | null;
    url: string | null;
    pairedAt: string | null;
    device: string | null;
  };
  /** The code to type in the page (while no page is paired, or after "קוד צימוד חדש"). */
  code: { code: string; secondsLeft: number; lockedSeconds: number } | null;
  link: {
    machineId: string;
    machineName: string | null;
    shopName: string | null;
    companyName: string | null;
    posNumber: string | null;
    role: BridgeRole;
    linkedAt: string;
    lastSyncOkAt: number | null;
  } | null;
  card: { kind: string | null; address: string | null; state: string; ready: boolean; reason: string | null; unresolved: number } | null;
  shift: { open: boolean; number: number | null } | null;
  outbox: number;
  printer: {
    target: string;
    transport: 'spooler' | 'tcp' | 'none';
    queueName: string | null;
    host: string | null;
    port: number | null;
    health: string;
    lastError: string | null;
    lastOkAt: number | null;
  };
  queues: string[];
  drawer: boolean;
  origins: { defaults: string[]; extra: string[] };
  launcher: LauncherSettings & { phase: LauncherPhase; text: string; runningBrowser: string | null };
  update: UpdateView | null;
  calls: BridgeCallRow[];
}

export type BridgeWindowAction =
  | { type: 'newCode' }
  | { type: 'unpair' }
  | { type: 'unlink' }
  | { type: 'setPrinter'; transport: 'spooler' | 'tcp'; queueName?: string | null; host?: string | null; port?: number | null }
  | { type: 'refreshQueues' }
  | { type: 'testPrint' }
  | { type: 'setDrawer'; on: boolean }
  | { type: 'openDrawer' }
  | { type: 'checkTerminal' }
  | { type: 'setLauncher'; enabled?: boolean; browser?: BrowserChoice; url?: string | null; role?: BridgeRole }
  /** A link from the dashboard (`…/k#pair=CODE`): the page to open, and the cloud's pairing code once. */
  | { type: 'useDashboardLink'; link: string }
  | { type: 'openBrowserNow' }
  | { type: 'exitKioskMode'; pin: string }
  | { type: 'addOrigin'; origin: string; pin: string }
  | { type: 'removeOrigin'; origin: string; pin: string }
  | { type: 'checkUpdate' }
  | { type: 'installUpdate' }
  | { type: 'hide' }
  | { type: 'quit'; pin: string };

export interface BridgeActionResult {
  ok: boolean;
  message?: string;
}

export interface BridgeWindowApi {
  view(): Promise<BridgeWindowView>;
  action(a: BridgeWindowAction): Promise<BridgeActionResult>;
  on(fn: (v: BridgeWindowView) => void): () => void;
}
