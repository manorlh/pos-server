/**
 * The contract between the kiosk's screens (renderer) and its local service (main process).
 * The screens never reach the network: everything they show comes from here, from local data.
 */

import type { KCategory, KGroup, KProduct } from '../main/kiosk/catalog';

export type KioskPhase = 'unpaired' | 'waiting' | 'kiosk';

export interface KioskView {
  phase: KioskPhase;
  /** The kiosk's own build. */
  appVersion: string;
  machine: {
    machineId: string;
    name: string | null;
    shopName: string | null;
    companyName: string | null;
    posNumber: string | null;
    serverUrl: string | null;
  } | null;
  /** The effective config as the cloud resolved it; every MediaRef pointing at the local copy (or null). */
  config: Record<string, unknown> | null;
  configVersion: string | null;
  /** @font-face for the theme's font, from the local file (or null: the device font). */
  fontFace: string | null;
  fontFamily: string | null;
  brandName: string;
  catalog: {
    categories: KCategory[];
    products: KProduct[];
    groups: Record<string, KGroup[]>;
    quickNotes: Record<string, string[]>;
    upsells: Array<{ triggerType: string; triggerIds: string[]; productIds: string[]; categoryIds: string[]; prompt: string | null }>;
    /** Kiosk category pictures (local) by category id. */
    categoryImages: Record<string, string>;
  };
  state: {
    paused: boolean;
    pausedMessage: string | null;
    pausedUntil: string | null;
    /** The kiosk's terminal cannot charge (none / unreachable). */
    noPayment: boolean;
    terminal: string;
    offline: boolean;
    offlineSince: number | null;
    /** A payment's outcome is unknown: every card blocked until staff settle it. */
    cardBlocked: boolean;
  };
  staff: {
    unprintedBons: number;
    printer: string;
    pendingUploads: number;
    mediaMissing: number;
  };
}

export interface OrderLineIn {
  key: string;
  productId: string;
  qty: number;
  options: Array<{ groupId: string; optionId: string }>;
  notes: string[];
}

export interface StartPaymentIn {
  lines: OrderLineIn[];
  service: 'take_away' | 'eat_in';
  customerName: string | null;
  customerPhone: string | null;
  tableRef: string | null;
  tipPct: number | null;
}

export type BasketChange = { kind: 'removed'; productId: string; name: string } | { kind: 'repriced'; productId: string; name: string; from: number; to: number };

export type StartPaymentOut =
  | { ok: true; orderId: string; amountAgorot: number }
  | { ok: false; reason: 'changed'; changes: BasketChange[] }
  | { ok: false; reason: 'terminal' | 'unresolved' | 'busy' | 'empty' | 'no_shift' | 'error'; message: string };

export type PayPhase = 'starting' | 'charging' | 'approved' | 'declined' | 'unknown';

export interface PayProgress {
  orderId: string;
  phase: PayPhase;
  message: string | null;
  amountAgorot: number;
  canCancel: boolean;
  cancelling: boolean;
  /** On approval. */
  pickupLabel?: string;
  documentNumber?: string;
  receipt?: 'ask' | 'printing' | 'printed' | 'declined' | 'none' | 'failed';
}

export interface AdminInfo {
  operator: { id: string; name: string } | null;
  shift: { open: boolean; number: number | null; openedAt: string | null };
  terminal: { kind: string | null; address: string | null; state: string; lastOkAt: number | null; lastError: string | null; unresolved: Array<{ reference: string; amountAgorot: number; startedAt: string; note: string | null }> };
  printer: { target: string; health: string; lastError: string | null; queues: string[] };
  sync: { lastBeatOkAt: number | null; lastKioskSyncAt: number | null; lastError: string | null; outbox: number; configVersion: string | null };
  media: { files: number; bytes: number; missing: number };
  orders: Array<{ localId: string; label: string | null; at: number; totalAgorot: number; bon: string; receipt: string; number: string | null }>;
  zs: Array<{ number: number; closedAt: string; state: string }>;
  zOwed: boolean;
  zMode: string;
  offlineSince: number | null;
}

export interface TechnicianInfo {
  machine: KioskView['machine'];
  deviceRole: string | null;
  shopName: string | null;
  companyName: string | null;
  network: { online: boolean; lastBeatOkAt: number | null; serverUrl: string | null; interfaces: Array<{ name: string; address: string }> };
  printer: AdminInfo['printer'];
  terminal: AdminInfo['terminal'];
  update: { current: string; available: string | null; status: string };
  quickSupport: string | null;
}

export interface KioskEvents {
  view: KioskView;
  pay: PayProgress;
  toast: { text: string; tone: 'info' | 'warn' | 'error' };
}

/** What the screens may ask (ipcRenderer.invoke under the hood). */
export interface KioskBridge {
  bootstrap(): Promise<KioskView>;
  pair(input: { serverUrl: string; code: string; machineName: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  reportFlow(input: { flowState: string; screen: string; busy: boolean; idle: boolean }): void;
  startPayment(input: StartPaymentIn): Promise<StartPaymentOut>;
  cancelPayment(): Promise<void>;
  receiptChoice(orderId: string, print: boolean): Promise<void>;
  /** "עזרה": a help request to the tills (an alert on the next sync). */
  helpRequest(): Promise<void>;
  adminUnlock(pin: string): Promise<{ ok: true; name: string } | { ok: false; error: string }>;
  adminInfo(): Promise<AdminInfo>;
  adminAction(action: AdminAction): Promise<{ ok: boolean; message?: string }>;
  technicianUnlock(code: string): Promise<{ outcome: 'granted' | 'wrong' | 'locked_out' | 'locked'; triesLeft: number; lockedForMs: number }>;
  technicianInfo(): Promise<TechnicianInfo>;
  technicianAction(action: TechnicianAction): Promise<{ ok: boolean; message?: string }>;
  on<K extends keyof KioskEvents>(event: K, fn: (payload: KioskEvents[K]) => void): () => void;
}

export type AdminAction =
  | { type: 'syncNow' }
  | { type: 'pause'; paused: boolean }
  | { type: 'reprintBon'; orderId: string }
  | { type: 'reprintReceipt'; orderId: string }
  | { type: 'testPrint' }
  | { type: 'checkTerminal' }
  | { type: 'recheckPayment'; reference: string }
  | { type: 'markNotApproved'; reference: string }
  | { type: 'retryPrints' }
  | { type: 'exitKiosk' };

export type TechnicianAction =
  | { type: 'printerTest' }
  | { type: 'setPrinter'; transport: 'spooler' | 'tcp'; queueName?: string; host?: string; port?: number }
  | { type: 'pinpadCheck' }
  | { type: 'updateCheck' }
  | { type: 'updateInstall' }
  | { type: 'quickSupport' }
  | { type: 'setZoom'; zoom: number }
  | { type: 'unpair' };
