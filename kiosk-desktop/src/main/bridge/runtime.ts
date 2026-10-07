/**
 * The bridge's runtime (docs/SPEC_KIOSK.md §28) — what answers the browser pages behind the local
 * API (server.ts), with no Electron import (tests run it under Node):
 *
 *  - the ONE pairing with a browser page (its role, its secret — sealed), and the 6-digit code;
 *  - the machine the page hands over (`/link`: the browser kiosk's own machine token). A kiosk gets
 *    the Windows kiosk's whole local service (service.ts) in bridge mode, in a folder of its own per
 *    machine: the same ledger and numbering, the same card rules (pending document before the frame,
 *    unknown → held, recovery by reference), the same print queue and terminal settings — not a
 *    second implementation. A KDS / board page's machine is kept only for the updates;
 *  - printing for the roles that print (a kiosk's receipts and bons from its ledger; a KDS's pages),
 *    the cash drawer when set, the technician's code for leaving kiosk mode;
 *  - the call log (memory + a daily file), the settings (printer, drawer, extra sites, "פתיחה בהפעלה").
 */

import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFile, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  BRIDGE_API,
  DEFAULT_ORIGINS,
  NO_CAPS,
  normalizeOrigin,
  originList,
  ROLE_CAPS,
  ROLE_LABEL,
  normalizeBridgeCode,
  type BridgeCaps,
  type BridgeHealth,
  type BridgeRole,
} from '../../core/bridgeProtocol';
import { checkCode, codeRefusalText, expired, newCode, secondsLeft, type PairingCode } from '../../core/bridgePairing';
import { DEFAULT_LAUNCHER, LAUNCHER_TEXT, launchable, parseDashboardLink, urlForRole, type LauncherPhase, type LauncherSettings } from '../../core/bridgeLauncher';
import { DRAWER_KICK } from '../../core/escpos';
import { slipDoc, type PrintDoc } from '../../core/printDocs';
import { attempt as techAttempt, codeMatches, NO_LOCK, type TechLock } from '../../core/technician';
import type { Activity } from '../../core/updatePolicy';
import type { AdminAction, OrderLineIn, StartPaymentIn } from '../../shared/bridge';
import type { BridgeActionResult, BridgeWindowAction, BridgeWindowView } from '../../shared/bridgeWindow';
import type { UpdateView } from '../../shared/roles';
import { openDb, type Db } from '../db/sqlite';
import { Kv, migrate } from '../db/schema';
import type { ProviderFactory } from '../payment/provider';
import { PrintQueue, type PageRenderer } from '../printer/printQueue';
import { DefaultTransport, type PrinterTarget, type Transport } from '../printer/transports';
import { resolvePrinterTarget, targetText, usbStatusText, UsbPrinterWatch, type PrinterResolution } from '../printer/usbPrinters';
import { KioskService, type PlatformHooks } from '../service';
import { Api, apiBase, type FetchFn } from '../sync/api';
import { PLAIN_BOX, type Credentials, type SecretBox } from '../sync/cloud';
import { b64url, newPairingId, newSecret } from './auth';
import type { BridgeEvent, BridgeHost, CallLogEntry, PairingSecret } from './server';

export interface BridgeRuntimeDeps {
  /** `%APPDATA%\R2M Kiosk\bridge` — never the kiosk app's own data folder. */
  dataDir: string;
  appVersion: string;
  deviceInfo: Record<string, string>;
  secretBox?: SecretBox;
  renderer: PageRenderer | null;
  transport?: Transport;
  providers?: ProviderFactory[];
  fetch?: FetchFn;
  platform?: Partial<PlatformHooks>;
  /** kiosk.json `bridgeOrigins`: more sites allowed besides the defaults. */
  extraOrigins?: readonly string[];
  randomBytes?: (n: number) => Uint8Array;
  now?: () => number;
  log?: (m: string) => void;
}

interface StoredPairing {
  pairingId: string;
  secret: string;
  sealed: boolean;
  role: BridgeRole;
  origin: string;
  url: string | null;
  device: Record<string, string>;
  pairedAt: string;
}

interface StoredLink {
  serverUrl: string;
  machineId: string;
  accessToken: string;
  sealed: boolean;
  role: BridgeRole;
  machineName: string | null;
  linkedAt: string;
}

export interface BridgeSettings {
  printer: PrinterTarget | null;
  drawer: boolean;
  origins: string[];
  launcher: LauncherSettings;
}

const K = {
  pairing: 'bridge.pairing',
  link: 'bridge.link',
  settings: 'bridge.settings',
  techLock: 'bridge.techLock',
  techCode: 'bridge.technicianCode',
} as const;

const DEFAULT_SETTINGS: BridgeSettings = { printer: null, drawer: false, origins: [], launcher: DEFAULT_LAUNCHER };
const CALLS_KEPT = 300;
const LOG_DAYS = 30;

/** What the admin actions a page may forward are (never "exit", "pause" or settings). */
const PAGE_ADMIN_ACTIONS: ReadonlySet<AdminAction['type']> = new Set([
  'syncNow',
  'reprintBon',
  'reprintReceipt',
  'testPrint',
  'checkTerminal',
  'recheckPayment',
  'markNotApproved',
  'retryPrints',
  'synqpayPair',
  'synqpayCode',
  'synqpayRetryUpload',
]);

const ok = (body: unknown = { ok: true }) => ({ status: 200, body });
const refuse = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => ({ status, body: { error, message, ...extra } });

const testSlip = (): PrintDoc => slipDoc({ businessName: 'בדיקת מדפסת', pickupLabel: 'TEST', service: 'take_away', itemCount: 0, totalAgorot: 0 });

function safeDirName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'machine';
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** The basket as the page sends it, checked field by field (the service re-prices it from its own catalog). */
export function startPaymentInput(raw: unknown): StartPaymentIn | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  if (!Array.isArray(b.lines) || b.lines.length === 0 || b.lines.length > 200) return null;
  const lines: OrderLineIn[] = [];
  for (const l of b.lines as Array<Record<string, unknown>>) {
    if (!l || typeof l !== 'object') return null;
    const key = str(l.key, 120);
    const productId = str(l.productId, 64);
    const qty = Number(l.qty);
    if (!key || !productId || !Number.isFinite(qty) || qty < 1 || qty > 999) return null;
    const options = Array.isArray(l.options)
      ? (l.options as Array<Record<string, unknown>>).slice(0, 60).flatMap((o) => {
          const groupId = str(o?.groupId, 64);
          const optionId = str(o?.optionId, 64);
          const q = Number(o?.qty);
          const pre: 'lite' | 'extra' | 'side' | null = o?.pre === 'lite' || o?.pre === 'extra' || o?.pre === 'side' ? o.pre : null;
          return groupId && optionId ? [{ groupId, optionId, qty: Number.isFinite(q) && q >= 1 && q <= 99 ? Math.trunc(q) : 1, pre }] : [];
        })
      : [];
    // A meal: each slot's product (the service prices it from its own catalog).
    const parts = Array.isArray((l.meal as Record<string, unknown> | undefined)?.components)
      ? (((l.meal as Record<string, unknown>).components as Array<Record<string, unknown>>).slice(0, 20).flatMap((c) => {
          const slotId = str(c?.slotId, 64);
          const pid = str(c?.productId, 64);
          return slotId && pid ? [{ slotId, productId: pid }] : [];
        }))
      : [];
    const notes = Array.isArray(l.notes) ? (l.notes as unknown[]).flatMap((n) => (typeof n === 'string' && n.trim() ? [n.slice(0, 200)] : [])).slice(0, 5) : [];
    const unit = Number(l.unitAgorot);
    lines.push({ key, productId, qty: Math.trunc(qty), options, notes, ...(Number.isFinite(unit) ? { unitAgorot: Math.round(unit) } : {}), ...(parts.length > 0 ? { meal: { components: parts } } : {}) });
  }
  // "ללא סוג שירות": an explicit null stays none; anything else unknown is take-away, as always.
  const service = b.service === null ? null : b.service === 'eat_in' ? 'eat_in' : 'take_away';
  const tipPct = typeof b.tipPct === 'number' && Number.isFinite(b.tipPct) && b.tipPct >= 0 && b.tipPct <= 100 ? b.tipPct : null;
  const tipAgorot = typeof b.tipAgorot === 'number' && Number.isFinite(b.tipAgorot) && b.tipAgorot >= 0 ? Math.round(b.tipAgorot) : null;
  const expected = typeof b.expectedTotalAgorot === 'number' && Number.isFinite(b.expectedTotalAgorot) ? Math.round(b.expectedTotalAgorot) : undefined;
  return {
    lines,
    service,
    customerName: str(b.customerName, 60),
    customerPhone: str(b.customerPhone, 20),
    tableRef: str(b.tableRef, 20),
    tipPct,
    tipAgorot,
    ...(expected !== undefined ? { expectedTotalAgorot: expected } : {}),
  };
}

/** A page a role may print as it is: a bon or a slip, never a receipt (a tax document comes only from the ledger). */
export function printablePage(kind: unknown, doc: unknown): { kind: 'bon' | 'slip'; doc: PrintDoc } | null {
  if (kind !== 'bon' && kind !== 'slip') return null;
  if (!doc || typeof doc !== 'object' || (doc as { kind?: unknown }).kind !== kind) return null;
  if (JSON.stringify(doc).length > 100_000) return null;
  return { kind, doc: doc as PrintDoc };
}

export class BridgeRuntime extends EventEmitter implements BridgeHost {
  readonly db: Db;
  readonly kv: Kv;
  private svc: KioskService | null = null;
  private readonly queue: PrintQueue;
  private readonly transport: Transport;
  /** The USB printer plugged in ("אוטומטי"), looked at once for the bridge and its kiosk (printer/usbPrinters.ts). */
  private readonly usbWatch: UsbPrinterWatch;
  private readonly box: SecretBox;
  private code: PairingCode | null = null;
  private codeAsked = false;
  private calls: CallLogEntry[] = [];
  private lastPageAt: number | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private queues: string[] = [];
  private launcherState: { phase: LauncherPhase; browser: string | null } = { phase: 'off', browser: null };
  private port: number | null = null;
  private listenError: string | null = null;
  private updateView: (() => UpdateView | null) | null = null;
  private linking: Promise<unknown> | null = null;
  private readonly logDir: string;

  constructor(private readonly d: BridgeRuntimeDeps) {
    super();
    mkdirSync(d.dataDir, { recursive: true });
    this.db = openDb(path.join(d.dataDir, 'bridge.db'));
    migrate(this.db);
    this.kv = new Kv(this.db);
    this.box = d.secretBox ?? PLAIN_BOX;
    this.transport = d.transport ?? new DefaultTransport(this.log);
    // Pages a KDS prints, test pages before a kiosk is linked: the bridge's own queue.
    this.queue = new PrintQueue(this.db, this.transport, () => this.printerTarget(), d.renderer, this.log);
    this.queue.onChange(() => this.changed());
    this.usbWatch = new UsbPrinterWatch(this.transport, this.log, () => this.queue.busy || (this.svc?.printQueue.busy ?? false));
    this.usbWatch.onChange(() => {
      this.queues = this.usbWatch.current()?.queues.map((q) => q.name) ?? this.queues;
      this.changed();
    });
    this.logDir = path.join(d.dataDir, 'logs');
    mkdirSync(this.logDir, { recursive: true });
  }

  private readonly log = (m: string) => this.d.log?.(`[bridge] ${m}`);

  now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private random(n: number): Uint8Array {
    return this.d.randomBytes ? this.d.randomBytes(n) : randomBytes(n);
  }

  /* ------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.queue.recover();
    void this.queue.work();
    this.pruneLogs();
    const link = this.storedLink();
    if (link?.role === 'kiosk') await this.openService(link, false).catch((e) => this.log(`service: ${String(e)}`));
    this.ensureCode();
    // The printers now and every 15 s: "אוטומטי" takes the USB printer plugged in.
    this.usbWatch.start();
  }

  stop() {
    this.stopped = true;
    this.usbWatch.stop();
    if (this.emitTimer) clearTimeout(this.emitTimer);
    this.svc?.stop();
    this.svc = null;
    this.transport.dispose();
    this.db.close();
  }

  /** The kiosk's local service (null unless a kiosk is linked). */
  get service(): KioskService | null {
    return this.svc;
  }

  setListening(port: number | null, error: string | null) {
    this.port = port;
    this.listenError = error;
    this.changed();
  }

  setUpdateView(fn: () => UpdateView | null) {
    this.updateView = fn;
  }

  setLauncherState(phase: LauncherPhase, browser: string | null) {
    if (phase === this.launcherState.phase && browser === this.launcherState.browser) return;
    this.launcherState = { phase, browser };
    this.changed();
  }

  /** Something the window (or a page) shows changed: one view per 100 ms at most. */
  private changed() {
    if (this.emitTimer || this.stopped) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.stopped) return;
      this.emit('view');
      this.emitEvent({ type: 'status' });
    }, 100);
  }

  private emitEvent(e: BridgeEvent) {
    this.emit('event', e);
  }

  onEvent(fn: (e: BridgeEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }

  /* ------------------------------------------------------------- settings */

  settings(): BridgeSettings {
    const s = this.kv.getJson<Partial<BridgeSettings>>(K.settings) ?? {};
    return { ...DEFAULT_SETTINGS, ...s, launcher: { ...DEFAULT_LAUNCHER, ...(s.launcher ?? {}) }, origins: Array.isArray(s.origins) ? s.origins : [] };
  }

  private setSettings(patch: Partial<BridgeSettings>) {
    this.kv.setJson(K.settings, { ...this.settings(), ...patch });
    this.changed();
  }

  allowedOrigins(): string[] {
    return originList([...(this.d.extraOrigins ?? []), ...this.settings().origins]);
  }

  launcherSettings(): LauncherSettings {
    return this.settings().launcher;
  }

  /** The address the launcher opens (null when none is set or its site is not allowed). */
  launcherUrl(): string | null {
    const l = this.launcherSettings();
    return launchable(l.url ?? this.storedPairing()?.url ?? null, this.allowedOrigins());
  }

  /** Where a page goes: the printer set wins; "אוטומטי" — the USB printer plugged in, else a name guess. */
  private printerResolution(): PrinterResolution {
    return this.svc ? this.svc.printerResolution() : resolvePrinterTarget(this.settings().printer, this.usbWatch.current());
  }

  private printerTarget(): PrinterTarget {
    return this.printerResolution().target;
  }

  async refreshQueues(): Promise<string[]> {
    const scan = await this.usbWatch.refresh();
    this.queues = scan ? scan.queues.map((q) => q.name) : (await this.transport.list().catch(() => [])).map((p) => p.name);
    this.changed();
    return this.queues;
  }

  /* -------------------------------------------------------------- pairing */

  private storedPairing(): StoredPairing | null {
    const p = this.kv.getJson<StoredPairing>(K.pairing);
    return p && typeof p.pairingId === 'string' && typeof p.secret === 'string' ? p : null;
  }

  pairingSecret(): PairingSecret | null {
    const p = this.storedPairing();
    if (!p) return null;
    try {
      const secret = Buffer.from(p.sealed ? this.box.open(p.secret) : p.secret, 'base64url');
      return { pairingId: p.pairingId, secret, role: p.role };
    } catch {
      return null;
    }
  }

  /** A code is shown while no page is paired, or for 10 minutes after "קוד צימוד חדש". */
  private ensureCode() {
    const now = this.now();
    const want = !this.storedPairing() || this.codeAsked;
    if (!want) {
      this.code = null;
      return;
    }
    if (!this.code || (expired(this.code, now) && this.code.lockedUntil <= now)) {
      if (this.code && this.storedPairing() && expired(this.code, now)) {
        // An asked-for code ran out while a page is paired: none until asked again.
        this.codeAsked = false;
        this.code = null;
        return;
      }
      this.code = newCode((n) => this.random(n), now);
    }
  }

  /** The current code (for the launcher's first opening, and the window). */
  currentCode(): string | null {
    this.ensureCode();
    return this.code && this.code.lockedUntil <= this.now() ? this.code.code : null;
  }

  newPairingCode(): string {
    this.codeAsked = true;
    this.code = newCode((n) => this.random(n), this.now());
    this.changed();
    return this.code.code;
  }

  pair(input: { code: string; role: BridgeRole; url: string | null; origin: string; device: Record<string, string> }): { status: number; body: unknown } {
    const now = this.now();
    this.ensureCode();
    const { result, next } = checkCode(this.code, normalizeBridgeCode(input.code), now);
    if (!result.ok) {
      this.code = next;
      if (result.reason === 'locked_out' && next) this.code = { ...newCode((n) => this.random(n), now), lockedUntil: next.lockedUntil };
      if (result.reason === 'expired') this.code = newCode((n) => this.random(n), now);
      this.changed();
      return refuse(result.reason === 'no_code' ? 409 : 403, 'code', codeRefusalText(result), { reason: result.reason, triesLeft: result.triesLeft });
    }
    const secret = newSecret();
    const pairingId = newPairingId();
    const encoded = b64url(secret);
    const stored: StoredPairing = {
      pairingId,
      secret: this.box.seal(encoded),
      sealed: this.box !== PLAIN_BOX,
      role: input.role,
      origin: input.origin,
      url: input.url,
      device: input.device,
      pairedAt: new Date(now).toISOString(),
    };
    this.kv.setJson(K.pairing, stored);
    this.code = null;
    this.codeAsked = false;
    // "פתיחה בהפעלה" opens this page from now on (unless an address was typed in the window).
    const l = this.launcherSettings();
    const url = launchable(input.url, this.allowedOrigins());
    if (url && (!l.url || l.role !== input.role)) this.setSettings({ launcher: { ...l, url, role: input.role } });
    this.log(`paired with a ${input.role} page of ${input.origin}`);
    this.emit('pairing');
    this.changed();
    return ok({ pairingId, secret: encoded, role: input.role, api: BRIDGE_API, version: this.d.appVersion });
  }

  forgetPairing() {
    this.kv.delete(K.pairing);
    this.codeAsked = false;
    this.ensureCode();
    this.emit('pairing');
    this.changed();
  }

  /* ---------------------------------------------------------------- link */

  private storedLink(): StoredLink | null {
    const l = this.kv.getJson<StoredLink>(K.link);
    return l && typeof l.machineId === 'string' && typeof l.accessToken === 'string' ? l : null;
  }

  private credentialsOf(l: StoredLink): Credentials | null {
    try {
      return {
        serverUrl: l.serverUrl,
        accessToken: l.sealed ? this.box.open(l.accessToken) : l.accessToken,
        machineId: l.machineId,
        machineCode: null,
        tenantId: null,
        shopId: null,
        mqttClientId: null,
        realtimeChannel: null,
        pairedAt: l.linkedAt,
      };
    } catch {
      return null;
    }
  }

  private async openService(l: StoredLink, adopt: boolean): Promise<void> {
    const creds = this.credentialsOf(l);
    if (!creds) throw new Error('the kept token cannot be read');
    const dir = path.join(this.d.dataDir, 'machines', safeDirName(l.machineId));
    const svc = new KioskService({
      dataDir: dir,
      appVersion: this.d.appVersion,
      deviceInfo: { ...this.d.deviceInfo, bridge: 'browser' },
      secretBox: this.d.secretBox,
      renderer: this.d.renderer,
      transport: this.transport,
      usbWatch: this.usbWatch,
      providers: this.d.providers,
      fetch: this.d.fetch,
      platform: this.d.platform,
      log: this.d.log,
      bridge: true,
    });
    this.svc = svc;
    svc.on('pay', (p) => this.emitEvent({ type: 'pay', progress: p }));
    svc.on('view', () => {
      if (this.svc === svc && !svc.paired && this.storedLink()?.machineId === l.machineId) {
        // The token was revoked in the cloud: the link is gone (the documents stay in its folder).
        this.log('the machine token was revoked: unlinked');
        this.kv.delete(K.link);
        this.emit('link');
      }
      this.changed();
    });
    const printer = this.settings().printer;
    if (printer) svc.setLocalSettings({ printer });
    await svc.start();
    if (adopt || !svc.paired || svc.machineId !== l.machineId) await svc.adopt(creds);
    else if (svc.cloud.credentials()?.accessToken !== creds.accessToken) svc.cloud.setCredentials({ ...svc.cloud.credentials()!, accessToken: creds.accessToken });
    // The cloud's `fiscal: false` (a display device) always wins: then no terminal, no sale.
    svc.setFiscalRole(svc.cloud.machine()?.fiscal !== false);
    this.changed();
  }

  private closeService() {
    if (!this.svc) return;
    this.svc.stop();
    this.svc = null;
  }

  /** Why the machine cannot be switched now (data of the current one not in the cloud yet), or null. */
  private switchBlocker(): string | null {
    const s = this.svc;
    if (!s) return null;
    if (s.pay.cardInFlight) return 'תשלום באשראי בתהליך';
    if (s.pay.blocked()) return 'תשלום באשראי ממתין לבירור';
    if (s.outbox.count() > 0) return 'יש בגשר מסמכים של הקיוסק הקודם שעוד לא נשלחו לענן';
    return null;
  }

  private async link(raw: unknown, role: BridgeRole): Promise<{ status: number; body: unknown }> {
    const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const serverUrl = str(b.serverUrl, 300);
    const machineId = str(b.machineId, 64);
    const token = typeof b.accessToken === 'string' && b.accessToken.length >= 10 && b.accessToken.length <= 8_000 ? b.accessToken : null;
    if (!serverUrl || !/^https?:\/\//i.test(serverUrl) || !machineId || !/^[A-Za-z0-9-]{8,64}$/.test(machineId) || !token) {
      return refuse(400, 'link', 'פרטי המכשיר לא תקינים');
    }
    const current = this.storedLink();
    const sealed = this.box !== PLAIN_BOX;
    const next: StoredLink = {
      serverUrl: apiBase(serverUrl),
      machineId,
      accessToken: this.box.seal(token),
      sealed,
      role,
      machineName: str(b.machineName, 80),
      linkedAt: current?.machineId === machineId ? current.linkedAt : new Date(this.now()).toISOString(),
    };
    if (current && current.machineId === machineId && current.role === role) {
      const kept = this.credentialsOf(current);
      if (kept?.accessToken !== token || current.serverUrl !== next.serverUrl) {
        this.kv.setJson(K.link, next);
        if (this.svc) this.svc.cloud.setCredentials({ ...this.svc.cloud.credentials()!, accessToken: token, serverUrl: next.serverUrl });
      }
      if (role === 'kiosk' && !this.svc) await this.openService(next, false);
      return ok(this.status(role));
    }
    const blocker = current ? this.switchBlocker() : null;
    if (blocker) return refuse(409, 'busy', `לא ניתן לקשר מכשיר אחר עכשיו: ${blocker}`);
    this.closeService();
    this.kv.setJson(K.link, next);
    this.log(`linked to machine ${machineId} (${role})`);
    if (role === 'kiosk') await this.openService(next, true);
    else void this.fetchTechnicianCode(next);
    this.emit('link');
    this.changed();
    return ok(this.status(role));
  }

  private unlink(): { status: number; body: unknown } {
    const blocker = this.switchBlocker();
    if (blocker) return refuse(409, 'busy', `לא ניתן לנתק עכשיו: ${blocker}`);
    this.closeService();
    this.kv.delete(K.link);
    this.emit('link');
    this.changed();
    return ok();
  }

  /** A KDS / board machine's technician code (the kiosk's comes with its service). */
  private async fetchTechnicianCode(l: StoredLink) {
    const creds = this.credentialsOf(l);
    if (!creds) return;
    const api = new Api(l.serverUrl, () => creds.accessToken, this.d.fetch, `R2M-Bridge-Windows/${this.d.appVersion}`);
    const r = await api.get<{ parameters?: Record<string, unknown> }>(`sync/${l.machineId}/parameters`, { timeoutMs: 15_000 });
    if (r.kind === 'ok' && r.body?.parameters) {
      const code = r.body.parameters.technicianCode;
      if (typeof code === 'string' && code.trim()) this.kv.set(K.techCode, code.trim());
      else this.kv.delete(K.techCode);
    }
  }

  /** For the updater: the machine's API and token (any role), or null before a page links one. */
  updaterContext(): { api: Api; machineId: string; token: string } | null {
    const l = this.storedLink();
    const creds = l ? this.credentialsOf(l) : null;
    if (!l || !creds) return null;
    if (this.svc && this.svc.machineId === l.machineId) return { api: this.svc.api, machineId: l.machineId, token: creds.accessToken };
    return { api: new Api(l.serverUrl, () => creds.accessToken, this.d.fetch, `R2M-Bridge-Windows/${this.d.appVersion}`), machineId: l.machineId, token: creds.accessToken };
  }

  /** What the updater asks before installing: the kiosk's flow as the page reports it, else the last call. */
  activity(): Activity {
    if (this.svc) return { ...this.svc.activity(), role: 'kiosk' };
    const role = this.storedLink()?.role ?? null;
    return { role: role === 'kds' ? 'kds' : role === 'order_status_board' ? 'order_status_board' : null, screen: '', busy: false, idle: true, cardInFlight: false, cardBlocked: false, lastActivityAt: this.lastPageAt };
  }

  /* ---------------------------------------------------------- technician */

  /** The technician's code (the cloud's `technicianCode` of the linked machine, else 1995), with the kiosks' lockout. */
  checkTechnician(pin: string): { ok: boolean; message?: string } {
    const lock = this.kv.getJson<TechLock>(K.techLock) ?? NO_LOCK;
    const l = this.storedLink();
    const stored = this.svc ? this.svc.cloud.parameters().technicianCode : this.kv.get(K.techCode);
    const machineId = l?.machineId ?? 'unpaired';
    const r = techAttempt(lock, this.now(), () => codeMatches(pin, typeof stored === 'string' ? stored : null, machineId, (p, s, it, len) => pbkdf2Sync(p, s, it, len, 'sha256')));
    this.kv.setJson(K.techLock, r.lock);
    if (r.outcome === 'granted') return { ok: true };
    if (r.outcome === 'wrong') return { ok: false, message: `קוד שגוי (נותרו ${r.triesLeft} ניסיונות)` };
    return { ok: false, message: 'יותר מדי ניסיונות. נסו שוב בעוד 5 דקות.' };
  }

  /* --------------------------------------------------------------- health */

  /** What the paired role may do here now. */
  private ready(role: BridgeRole | null): BridgeCaps {
    if (!role) return NO_CAPS;
    const caps = ROLE_CAPS[role];
    return {
      card: caps.card && !!this.svc && this.svc.cardReadiness().ready,
      print: caps.print,
      drawer: caps.drawer && this.settings().drawer,
    };
  }

  health(): BridgeHealth {
    const p = this.storedPairing();
    return { bridge: 'r2m', api: BRIDGE_API, version: this.d.appVersion, paired: !!p, pairingId: p?.pairingId ?? null, role: p?.role ?? null, ready: this.ready(p?.role ?? null) };
  }

  private printerView() {
    const s = this.svc;
    const resolved = this.printerResolution();
    // As set: an empty Windows queue is "אוטומטי" (the window's choice shows that, not the queue found).
    const set = s ? s.localSettings().printer : (this.settings().printer ?? { transport: 'spooler' as const, queueName: null });
    const q = s ? s.printQueue : this.queue;
    return {
      target: targetText(resolved),
      transport: set.transport,
      queueName: set.queueName?.trim() || null,
      host: set.host ?? null,
      port: set.port ?? null,
      health: q.health(),
      lastError: q.lastFailure?.error ?? null,
      lastOkAt: q.lastOkAt,
      auto: resolved.auto,
      usb: usbStatusText(this.usbWatch.pick()),
    };
  }

  /** `GET /status`: everything the page shows and decides on. */
  status(role: BridgeRole) {
    const p = this.storedPairing();
    const l = this.storedLink();
    const s = this.svc;
    const me = s?.cloud.machine() ?? null;
    const card = s ? s.cardReadiness() : null;
    const shift = s?.ledger.currentShift() ?? null;
    return {
      api: BRIDGE_API,
      version: this.d.appVersion,
      role,
      pairing: p ? { pairedAt: p.pairedAt, origin: p.origin, url: p.url } : null,
      link: l ? { machineId: l.machineId, role: l.role, linkedAt: l.linkedAt, machineName: me?.machineName ?? l.machineName, shopName: me?.shopName ?? null, posNumber: me?.posNumber ?? null } : null,
      ready: this.ready(role),
      card: card
        ? {
            ...card,
            kind: s!.pay.describe().kind,
            unresolved: s!.pay.attempts().map((a) => ({ reference: a.vuid, amountAgorot: a.amountAgorot, startedAt: a.startedAt, note: a.note })),
          }
        : null,
      printer: this.printerView(),
      drawer: this.settings().drawer,
      shift: s ? { open: !!shift, number: shift?.sequence_number ?? null } : null,
      outbox: s?.outbox.count() ?? 0,
      pay: s?.currentPay() ?? null,
      statusPart: s?.bridgePart() ?? null,
      launcher: { enabled: this.launcherSettings().enabled, phase: this.launcherState.phase },
      update: this.updateView?.() ?? null,
    };
  }

  /* ----------------------------------------------------------------- calls */

  logCall(e: CallLogEntry) {
    this.calls.push(e);
    if (this.calls.length > CALLS_KEPT) this.calls.splice(0, this.calls.length - CALLS_KEPT);
    if (e.status < 400 && e.path !== '/health') this.lastPageAt = e.at;
    const day = new Date(e.at).toISOString().slice(0, 10);
    appendFile(path.join(this.logDir, `calls-${day}.log`), `${JSON.stringify(e)}\n`, () => undefined);
    if (e.path !== '/health') this.changed();
  }

  recentCalls(n = 60): CallLogEntry[] {
    return this.calls.slice(-n).reverse();
  }

  private pruneLogs() {
    try {
      for (const f of readdirSync(this.logDir)) {
        const p = path.join(this.logDir, f);
        if (this.now() - statSync(p).mtimeMs > LOG_DAYS * 86_400_000) rmSync(p, { force: true });
      }
    } catch {
      /* nothing to prune */
    }
  }

  async call(route: string, body: unknown, ctx: { role: BridgeRole; origin: string; query: URLSearchParams }): Promise<{ status: number; body: unknown }> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const s = this.svc;
    const needKiosk = () => refuse(409, 'not_linked', 'הגשר עוד לא מקושר לקיוסק — הדף שולח את פרטי המכשיר מיד אחרי הצימוד');
    switch (route) {
      case 'GET /status':
        return ok(this.status(ctx.role));
      case 'POST /link': {
        if (this.linking) await this.linking.catch(() => undefined);
        const p = this.link(body, ctx.role);
        this.linking = p;
        try {
          return await p;
        } finally {
          this.linking = null;
        }
      }
      case 'POST /unlink':
        return this.unlink();
      case 'POST /unpair':
        this.forgetPairing();
        return ok();
      case 'POST /flow': {
        if (s && typeof b.screen === 'string') {
          s.reportFlow({ flowState: String(b.flowState ?? b.screen).slice(0, 32), screen: b.screen.slice(0, 32), busy: b.busy === true, idle: b.idle !== false });
        }
        return ok();
      }
      case 'POST /launcher/exit': {
        const check = this.checkTechnician(typeof b.pin === 'string' ? b.pin : '');
        if (!check.ok) return refuse(403, 'pin', check.message ?? 'קוד שגוי');
        this.emit('launcherExit');
        return ok();
      }
      case 'POST /pay/start': {
        if (!s) return needKiosk();
        const input = startPaymentInput(body);
        if (!input) return refuse(400, 'basket', 'הסל לא תקין');
        return ok(await s.startPayment(input));
      }
      case 'GET /pay/status':
        return ok({ pay: s?.currentPay() ?? null });
      case 'POST /pay/cancel':
        if (s) await s.cancelPayment();
        return ok();
      case 'POST /pay/receipt': {
        if (!s) return needKiosk();
        const orderId = str(b.orderId, 64);
        if (!orderId) return refuse(400, 'order', 'הזמנה לא ידועה');
        await s.receiptChoice(orderId, b.print === true);
        return ok();
      }
      case 'POST /close-request': {
        if (!s) return needKiosk();
        const id = str(b.id, 64);
        if (!id) return refuse(400, 'request', 'בקשה לא ידועה');
        return ok(await s.closeForShopZ(id));
      }
      case 'GET /admin/info':
        if (!s) return needKiosk();
        return ok(s.adminInfo());
      case 'POST /admin/unlock':
        if (!s) return needKiosk();
        return ok(s.adminUnlock(typeof b.pin === 'string' ? b.pin.slice(0, 12) : ''));
      case 'POST /admin/action': {
        if (!s) return needKiosk();
        const type = b.type as AdminAction['type'];
        if (!PAGE_ADMIN_ACTIONS.has(type)) return refuse(400, 'action', 'פעולה לא מוכרת');
        return ok(await s.adminAction(b as unknown as AdminAction));
      }
      case 'POST /print':
        return this.print(b, ctx.role);
      case 'POST /drawer': {
        if (!this.settings().drawer) return refuse(409, 'drawer_off', 'לא הוגדרה מגירת כסף בגשר');
        try {
          if (s) await s.openDrawer();
          else await this.transport.send(this.printerTarget(), DRAWER_KICK);
          return ok();
        } catch (e) {
          return refuse(502, 'drawer', `המגירה לא נפתחה: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      default:
        return refuse(404, 'not_found', '');
    }
  }

  /** `POST /print`: a kiosk's reprint from its ledger, a test page, or a role's own bon / slip. */
  private async print(b: Record<string, unknown>, role: BridgeRole): Promise<{ status: number; body: unknown }> {
    const s = this.svc;
    if (b.test === true) {
      const id = s ? await s.printTest() : this.queue.enqueue('test', null, testSlip());
      return ok({ ok: true, jobs: [id] });
    }
    if (b.reprint === 'bon' || b.reprint === 'receipt') {
      if (role !== 'kiosk' || !s) return refuse(409, 'not_linked', 'הדפסה חוזרת — רק לקיוסק מקושר');
      const orderId = str(b.orderId, 64);
      if (!orderId) return refuse(400, 'order', 'הזמנה לא ידועה');
      if (b.reprint === 'bon') s.printBon(orderId, true);
      else s.printReceipt(orderId, true);
      return ok({ ok: true, jobs: s.printQueue.jobsFor(orderId, b.reprint).slice(-1).map((j) => j.id) });
    }
    const page = printablePage(b.kind, b.doc);
    if (!page) return refuse(400, 'page', 'דף להדפסה לא תקין (בון או פתק בלבד; קבלה רק מהקופה של הגשר)');
    const ref = str(b.refId, 64);
    const id = s ? s.printPage(page.kind, ref, page.doc) : this.queue.enqueue(page.kind, ref, page.doc);
    return ok({ ok: true, jobs: [id] });
  }

  /* ---------------------------------------------------------------- window */

  view(): BridgeWindowView {
    this.ensureCode();
    const now = this.now();
    const p = this.storedPairing();
    const l = this.storedLink();
    const s = this.svc;
    const me = s?.cloud.machine() ?? null;
    const card = s ? s.cardReadiness() : null;
    const shift = s?.ledger.currentShift() ?? null;
    const launcher = this.launcherSettings();
    const settings = this.settings();
    return {
      version: this.d.appVersion,
      port: this.port,
      listenError: this.listenError,
      pairing: {
        paired: !!p,
        role: p?.role ?? null,
        roleLabel: p ? ROLE_LABEL[p.role] : null,
        origin: p?.origin ?? null,
        url: p?.url ?? null,
        pairedAt: p?.pairedAt ?? null,
        device: p ? [p.device.browser, p.device.os].filter(Boolean).join(' · ') || null : null,
      },
      code: this.code ? { code: this.code.code, secondsLeft: secondsLeft(this.code, now), lockedSeconds: Math.max(0, Math.ceil((this.code.lockedUntil - now) / 1000)) } : null,
      link: l
        ? {
            machineId: l.machineId,
            machineName: me?.machineName ?? l.machineName,
            shopName: me?.shopName ?? null,
            companyName: me?.companyName ?? null,
            posNumber: me?.posNumber ?? null,
            role: l.role,
            linkedAt: l.linkedAt,
            lastSyncOkAt: s?.sync.status.lastBeatOkAt ?? null,
          }
        : null,
      card: s && card ? { kind: s.pay.describe().kind, address: s.pay.describe().address, state: card.state, ready: card.ready, reason: card.reason, unresolved: s.pay.attempts().length } : null,
      shift: s ? { open: !!shift, number: shift?.sequence_number ?? null } : null,
      outbox: s?.outbox.count() ?? 0,
      printer: this.printerView(),
      queues: this.queues,
      drawer: settings.drawer,
      origins: { defaults: [...DEFAULT_ORIGINS], extra: originList([...(this.d.extraOrigins ?? []), ...settings.origins]).filter((o) => !DEFAULT_ORIGINS.includes(o)) },
      launcher: { ...launcher, url: launcher.url ?? p?.url ?? null, phase: this.launcherState.phase, text: LAUNCHER_TEXT[this.launcherState.phase], runningBrowser: this.launcherState.browser },
      update: this.updateView?.() ?? null,
      calls: this.recentCalls(60),
    };
  }

  /** The window's actions that are the runtime's own (null: the Electron side's — launcher, updates, window). */
  async windowAction(a: BridgeWindowAction): Promise<BridgeActionResult | null> {
    switch (a.type) {
      case 'newCode':
        this.newPairingCode();
        return { ok: true };
      case 'unpair':
        this.forgetPairing();
        return { ok: true };
      case 'unlink': {
        const r = this.unlink();
        return r.status === 200 ? { ok: true } : { ok: false, message: (r.body as { message: string }).message };
      }
      case 'setPrinter': {
        const printer: PrinterTarget =
          a.transport === 'tcp'
            ? { transport: 'tcp', host: a.host?.trim() || null, port: a.port && a.port > 0 && a.port < 65_536 ? a.port : 9100 }
            : { transport: 'spooler', queueName: a.queueName?.trim() || null };
        if (printer.transport === 'tcp' && !/^[A-Za-z0-9.-]{1,120}$/.test(printer.host ?? '')) return { ok: false, message: 'כתובת מדפסת לא תקינה' };
        this.setSettings({ printer });
        this.svc?.setLocalSettings({ printer });
        return { ok: true };
      }
      case 'refreshQueues':
        await this.refreshQueues();
        return { ok: true };
      case 'testPrint':
        if (this.svc) await this.svc.printTest();
        else this.queue.enqueue('test', null, testSlip());
        return { ok: true, message: 'נשלח דף בדיקה' };
      case 'setDrawer':
        this.setSettings({ drawer: a.on });
        return { ok: true };
      case 'openDrawer':
        try {
          if (this.svc) await this.svc.openDrawer();
          else await this.transport.send(this.printerTarget(), DRAWER_KICK);
          return { ok: true };
        } catch (e) {
          return { ok: false, message: e instanceof Error ? e.message : String(e) };
        }
      case 'checkTerminal': {
        const p = this.svc?.pay.current;
        if (!p) return { ok: false, message: 'לא הוגדר מסופון (הגשר לא מקושר לקיוסק, או אין מסופון בהגדרות התשלום שלו)' };
        // Read-only: getStatus, never a charge.
        const r = await p.check().catch((e) => ({ ok: false, detail: String(e) }));
        return { ok: r.ok, message: r.ok ? 'המסופון עונה' : (r.detail ?? 'אין תשובה') };
      }
      case 'setLauncher': {
        const l = this.launcherSettings();
        const next: LauncherSettings = { ...l };
        if (a.enabled !== undefined) next.enabled = a.enabled;
        if (a.browser) next.browser = a.browser;
        if (a.role) next.role = a.role;
        if (a.url !== undefined) {
          if (a.url === null || !a.url.trim()) next.url = null;
          else {
            const url = launchable(a.url, this.allowedOrigins()) ?? (normalizeOrigin(a.url) ? launchable(urlForRole(a.url, next.role) ?? '', this.allowedOrigins()) : null);
            if (!url) return { ok: false, message: 'הכתובת אינה של אתר מורשה (הדשבורד). אפשר להוסיף אתר ב"אתרים מורשים".' };
            next.url = url;
          }
        }
        if (next.enabled && !(next.url ?? this.storedPairing()?.url)) return { ok: false, message: 'קבעו קודם כתובת לפתיחה' };
        this.setSettings({ launcher: next });
        this.emit('launcher');
        return { ok: true };
      }
      case 'useDashboardLink': {
        const parsed = parseDashboardLink(a.link);
        const url = parsed ? launchable(parsed.url, this.allowedOrigins()) : null;
        if (!parsed || !url) return { ok: false, message: 'זה לא קישור של הדשבורד' };
        const l = this.launcherSettings();
        this.setSettings({ launcher: { ...l, url, role: parsed.role ?? l.role, enabled: true } });
        this.emit('launcher', { pairCode: parsed.pairCode });
        return { ok: true };
      }
      case 'addOrigin':
      case 'removeOrigin': {
        const check = this.checkTechnician(a.pin);
        if (!check.ok) return check;
        const o = normalizeOrigin(a.origin);
        if (!o) return { ok: false, message: 'כתובת אתר לא תקינה (https://…)' };
        const list = this.settings().origins.filter((x) => normalizeOrigin(x) !== o);
        this.setSettings({ origins: a.type === 'addOrigin' ? [...list, o] : list });
        return { ok: true };
      }
      default:
        return null;
    }
  }
}
