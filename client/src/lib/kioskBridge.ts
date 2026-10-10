/**
 * "גשר לדפדפן" — the browser side of the local bridge (docs/SPEC_KIOSK.md §28): a page of this
 * dashboard (the browser kiosk `/k`, a KDS, the "מוכן / לא מוכן" board) running in Chrome / Edge on
 * a Windows PC where R2M POS for Windows runs in bridge mode, reaching it on
 * http://127.0.0.1:47615 for the card terminal, the printer and the cash drawer.
 *
 *  - `GET /health` (no secret): is a bridge there, which version, is a page paired, what is ready;
 *  - pairing ONCE with the 6 digits the bridge shows (or that it hands the page it opens itself, in
 *    the address's fragment `#bridge=…`): the bridge answers a pairing id and a secret, kept here
 *    (this page's own storage) — never sent anywhere else;
 *  - every other call signed: HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body)) in the
 *    X-R2M-* headers (WebCrypto), so no other site — nor a page without the secret — can charge,
 *    print or open the drawer;
 *  - the kiosk hands the bridge its machine (`/link`) so the bridge issues the card sale's tax
 *    document in the Windows kiosk's own ledger, as that machine (the browser never does).
 *
 * The bridge's copy of these rules is kiosk-desktop/src/core/bridgeProtocol.ts; its test
 * (kiosk-desktop/test/bridge.test.ts) runs THIS file against the bridge's real server.
 * Pure of React and of `@/` imports (the node tests compile it on its own).
 */

import type { StartVouchers } from './kioskVoucherClient';

export const BRIDGE_API = 1;
export const BRIDGE_PORT = 47615;
export const BRIDGE_BASE = `http://127.0.0.1:${BRIDGE_PORT}`;

export type BridgeRole = 'kiosk' | 'kds' | 'order_status_board';

export interface BridgeCaps {
  card: boolean;
  print: boolean;
  drawer: boolean;
}

export const NO_CAPS: BridgeCaps = { card: false, print: false, drawer: false };

export interface BridgeHealth {
  bridge: 'r2m';
  api: number;
  version: string;
  paired: boolean;
  pairingId: string | null;
  role: BridgeRole | null;
  ready: BridgeCaps;
}

/** The payment as the bridge's kiosk service reports it (kiosk-desktop shared/bridge.ts PayProgress). */
export interface BridgePayProgress {
  orderId: string;
  phase: 'starting' | 'charging' | 'approved' | 'declined' | 'unknown';
  message: string | null;
  amountAgorot: number;
  canCancel: boolean;
  cancelling: boolean;
  pickupLabel?: string;
  documentNumber?: string;
  receipt?: 'ask' | 'printing' | 'printed' | 'declined' | 'none' | 'failed';
}

/** `GET /status` (kiosk-desktop main/bridge/runtime.ts status()). */
export interface BridgeStatus {
  api: number;
  version: string;
  role: BridgeRole;
  link: { machineId: string; role: BridgeRole; linkedAt: string; machineName: string | null; shopName: string | null; posNumber: string | null } | null;
  ready: BridgeCaps;
  card: {
    ready: boolean;
    state: string;
    blocked: boolean;
    reason: string | null;
    kind: string | null;
    unresolved: Array<{ reference: string; amountAgorot: number; startedAt: string; note: string | null }>;
  } | null;
  printer: { target: string; health: string; lastError: string | null; lastOkAt: number | null } | null;
  drawer: boolean;
  shift: { open: boolean; number: number | null } | null;
  outbox: number;
  pay: BridgePayProgress | null;
  /** The bridge's part of the kiosk's `kiosk/sync` status (the shift, printer, terminal, card orders). */
  statusPart: Record<string, unknown> | null;
  launcher: { enabled: boolean; phase: string } | null;
}

export type StartPaymentOut =
  | { ok: true; orderId: string; amountAgorot: number }
  | { ok: false; reason: 'changed'; changes: Array<{ kind: 'removed' | 'repriced'; productId: string; name: string; key?: string; from?: number; to?: number }>; totalAgorot?: number }
  | { ok: false; reason: string; message: string };

export interface BridgeBasketLine {
  key: string;
  productId: string;
  qty: number;
  unitAgorot: number;
  /** "תפריטים" (lib/kioskMenus.ts menuMemoryOf): the dish's own price as the line was added at, the catalog's then, the menu. */
  listAgorot?: number;
  catalogAgorot?: number;
  menuId?: string;
  priceSource?: 'menu' | 'catalog';
  options: Array<{ groupId: string; optionId: string }>;
  notes: string[];
}

export interface BridgeStartPayment {
  lines: BridgeBasketLine[];
  /** The order's vouchers (lib/kioskVoucherClient.ts StartVouchers): the sale is priced with the discount ones, the goods ones are legs beside the card. */
  vouchers?: StartVouchers;
  /** Null: "ללא סוג שירות" — the order has none. */
  service: 'take_away' | 'eat_in' | null;
  customerName: string | null;
  customerPhone: string | null;
  tableRef: string | null;
  tipPct: number | null;
  tipAgorot: number | null;
  expectedTotalAgorot: number;
}

/* ------------------------------------------------------------------ signing */

export function canonical(method: string, path: string, ts: number | string, nonce: string, bodySha256Hex: string): string {
  return [method.toUpperCase(), path, String(ts), nonce, bodySha256Hex.toLowerCase()].join('\n');
}

interface SubtleLike {
  digest(alg: string, data: Uint8Array): Promise<ArrayBuffer>;
  importKey(format: 'raw', key: Uint8Array, alg: { name: 'HMAC'; hash: 'SHA-256' }, extractable: boolean, usages: string[]): Promise<unknown>;
  sign(alg: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function webCrypto(): { subtle: SubtleLike | null; random: ((n: number) => Uint8Array) | null } {
  const c = (globalThis as unknown as { crypto?: { subtle?: unknown; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  return {
    subtle: (c?.subtle as SubtleLike | undefined) ?? null,
    random: c?.getRandomValues ? (n) => c.getRandomValues!(new Uint8Array(n)) : null,
  };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function base64url(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += B64[(n >> 6) & 63];
  }
  return out;
}

export function fromBase64url(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new Error('not base64url');
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buf >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/* -------------------------------------------------------------------- client */

export interface BridgeRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  cache?: 'no-store';
  credentials?: 'omit';
  mode?: 'cors';
  /** Chrome's Local Network Access: the bridge is on this computer. */
  targetAddressSpace?: 'loopback';
}

export type BridgeFetch = (url: string, init: BridgeRequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface BridgeKv {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}

export interface BridgePairing {
  pairingId: string;
  secret: string;
  role: BridgeRole;
  pairedAt: string;
  version: string | null;
}

/** Where a page keeps its pairing (per role: a PC may run a kiosk page and a board page). */
export function bridgeStoreKey(role: BridgeRole): string {
  return `r2m.bridge.${role}`;
}

export type BridgeReply<T> =
  | { kind: 'ok'; status: number; body: T }
  | { kind: 'refused'; status: number; body: unknown; error: string | null; message: string | null }
  | { kind: 'offline'; reason: string };

export class BridgeClient {
  pairing: BridgePairing | null = null;
  readonly base: string;

  constructor(
    private readonly d: {
      fetchFn: BridgeFetch;
      store: BridgeKv;
      role: BridgeRole;
      base?: string;
      now?: () => number;
      subtle?: SubtleLike | null;
      random?: (n: number) => Uint8Array;
    },
  ) {
    this.base = (d.base ?? BRIDGE_BASE).replace(/\/+$/, '');
  }

  get role(): BridgeRole {
    return this.d.role;
  }

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private subtle(): SubtleLike | null {
    return this.d.subtle ?? webCrypto().subtle;
  }

  private random(n: number): Uint8Array {
    const r = this.d.random ?? webCrypto().random;
    if (r) return r(n);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return out;
  }

  async load(): Promise<BridgePairing | null> {
    this.pairing = await this.d.store.get<BridgePairing>(bridgeStoreKey(this.d.role)).catch(() => null);
    if (this.pairing && (typeof this.pairing.pairingId !== 'string' || typeof this.pairing.secret !== 'string')) this.pairing = null;
    return this.pairing;
  }

  get paired(): boolean {
    return !!this.pairing;
  }

  /** WebCrypto is there (a secure context: https, or the dev dashboard on localhost). */
  get canSign(): boolean {
    return !!this.subtle();
  }

  private async raw(method: string, path: string, init: { body?: string; headers?: Record<string, string>; timeoutMs: number }) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), init.timeoutMs) : null;
    try {
      const res = await this.d.fetchFn(`${this.base}${path}`, {
        method,
        headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) },
        body: init.body,
        signal: ctrl?.signal,
        cache: 'no-store',
        credentials: 'omit',
        mode: 'cors',
        targetAddressSpace: 'loopback',
      });
      const text = await res.text().catch(() => '');
      let body: unknown = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** `GET /health` (no secret); null when no bridge answers (or it is not ours). */
  async health(timeoutMs = 2_000): Promise<BridgeHealth | null> {
    try {
      const r = await this.raw('GET', '/health', { timeoutMs });
      const b = r.body as Partial<BridgeHealth> | null;
      if (!r.ok || !b || b.bridge !== 'r2m' || typeof b.api !== 'number') return null;
      return {
        bridge: 'r2m',
        api: b.api,
        version: typeof b.version === 'string' ? b.version : '',
        paired: b.paired === true,
        pairingId: typeof b.pairingId === 'string' ? b.pairingId : null,
        role: (b.role as BridgeRole | null) ?? null,
        ready: { card: b.ready?.card === true, print: b.ready?.print === true, drawer: b.ready?.drawer === true },
      };
    } catch {
      return null;
    }
  }

  /** The 6 digits from the bridge's window: the pairing kept here. */
  async pair(code: string, info: { url: string | null; device: Record<string, string> }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.canSign) return { ok: false, error: 'הדפדפן לא מאפשר חתימה (נדרש https)' };
    let r: { ok: boolean; status: number; body: unknown };
    try {
      r = await this.raw('POST', '/pair', { body: JSON.stringify({ code: code.replace(/[\s-]+/g, ''), role: this.d.role, url: info.url, device: info.device }), timeoutMs: 8_000 });
    } catch (e) {
      return { ok: false, error: `הגשר לא עונה (${e instanceof Error ? e.message : String(e)})` };
    }
    const b = (r.body ?? {}) as { pairingId?: unknown; secret?: unknown; version?: unknown; message?: unknown; api?: unknown };
    if (!r.ok) return { ok: false, error: typeof b.message === 'string' ? b.message : `הצימוד נכשל (${r.status})` };
    if (typeof b.pairingId !== 'string' || typeof b.secret !== 'string') return { ok: false, error: 'תשובת צימוד לא תקינה' };
    if (typeof b.api === 'number' && b.api !== BRIDGE_API) return { ok: false, error: 'גרסת הגשר אינה תואמת — עדכנו את R2M POS ל-Windows' };
    this.pairing = { pairingId: b.pairingId, secret: b.secret, role: this.d.role, pairedAt: new Date(this.now()).toISOString(), version: typeof b.version === 'string' ? b.version : null };
    await this.d.store.set(bridgeStoreKey(this.d.role), this.pairing);
    return { ok: true };
  }

  /** This page forgets the pairing (the bridge's own is dropped with `unpair`). */
  async forget(): Promise<void> {
    this.pairing = null;
    await this.d.store.del(bridgeStoreKey(this.d.role)).catch(() => undefined);
  }

  private async sign(method: string, path: string, body: string): Promise<Record<string, string> | null> {
    const p = this.pairing;
    const subtle = this.subtle();
    if (!p || !subtle) return null;
    const enc = new TextEncoder();
    const ts = String(this.now());
    const nonce = base64url(this.random(18));
    const bodyHash = hex(await subtle.digest('SHA-256', enc.encode(body)));
    const key = await subtle.importKey('raw', fromBase64url(p.secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = base64url(new Uint8Array(await subtle.sign('HMAC', key, enc.encode(canonical(method, path, ts, nonce, bodyHash)))));
    return { 'X-R2M-Bridge-Key': p.pairingId, 'X-R2M-Ts': ts, 'X-R2M-Nonce': nonce, 'X-R2M-Sig': sig };
  }

  /** A signed call. A bridge that no longer knows this page's pairing → the pairing is forgotten here too. */
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<BridgeReply<T>> {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = await this.sign(method, path, text);
    if (!headers) return { kind: 'refused', status: 0, body: null, error: 'not_paired', message: 'הדפדפן אינו מצומד לגשר' };
    let r: { ok: boolean; status: number; body: unknown };
    try {
      r = await this.raw(method, path, { body: method === 'POST' ? text : undefined, headers, timeoutMs });
    } catch (e) {
      return { kind: 'offline', reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
    if (r.ok) return { kind: 'ok', status: r.status, body: r.body as T };
    const b = (r.body ?? {}) as { error?: unknown; why?: unknown; message?: unknown };
    if (r.status === 401 && b.error === 'auth' && b.why === 'unknown_key') await this.forget();
    return { kind: 'refused', status: r.status, body: r.body, error: typeof b.error === 'string' ? b.error : null, message: typeof b.message === 'string' ? b.message : null };
  }

  /** The event stream's address (`ws://…/events?…`, signed like a GET with an empty body), or null. */
  async eventsUrl(): Promise<string | null> {
    const h = await this.sign('GET', '/events', '');
    if (!h) return null;
    const q = new URLSearchParams({ key: h['X-R2M-Bridge-Key'], ts: h['X-R2M-Ts'], nonce: h['X-R2M-Nonce'], sig: h['X-R2M-Sig'] });
    return `${this.base.replace(/^http/, 'ws')}/events?${q.toString()}`;
  }
}

/* -------------------------------------------------------------------- agent */

export interface BridgeState {
  /** A bridge answered `/health` lately. */
  present: boolean;
  version: string | null;
  /** This page is paired with it (the bridge confirms our pairing id). */
  paired: boolean;
  /** The bridge is paired with another page (this one must pair again to use it). */
  otherPage: boolean;
  ready: BridgeCaps;
  status: BridgeStatus | null;
  error: string | null;
  checkedAt: number | null;
  lastOkAt: number | null;
}

export const NO_BRIDGE: BridgeState = { present: false, version: null, paired: false, otherPage: false, ready: NO_CAPS, status: null, error: null, checkedAt: null, lastOkAt: null };

/** The machine the page hands the bridge (the kiosk's own credentials, kioskWebApi KioskCredentials). */
export interface BridgeMachine {
  serverUrl: string;
  machineId: string;
  accessToken: string;
  machineName: string | null;
}

/** Whether the bridge takes this kiosk's cards now: paired, linked to THIS machine, card ready. */
export function bridgeCardReady(s: BridgeState, machineId: string | null): boolean {
  return s.paired && !!machineId && s.status?.link?.machineId === machineId && s.status.link.role === 'kiosk' && s.ready.card;
}

/** Whether the bridge holds this kiosk's fiscal side (its shift, documents and heartbeat). */
export function bridgeFiscalFor(s: BridgeState, machineId: string | null): boolean {
  return s.paired && !!machineId && s.status?.link?.machineId === machineId && s.status.link.role === 'kiosk';
}

/** Why the card tile is grey with a bridge (null: it is not). */
export function bridgeCardReason(s: BridgeState, machineId: string | null): string | null {
  if (!s.present) return s.paired ? 'הגשר ל-Windows לא עונה' : null;
  if (!s.paired) return s.otherPage ? 'הגשר מצומד לדף אחר' : 'הגשר ל-Windows לא מצומד';
  if (!s.status?.link || s.status.link.machineId !== machineId) return 'הגשר מתחבר לקיוסק…';
  if (!s.ready.card) return s.status.card?.reason ?? 'מסופון האשראי לא זמין כרגע';
  return null;
}

/** The flow event a payment's progress moves the kiosk with (as the Windows kiosk's KioskApp). */
export function payFlowEvent(p: Pick<BridgePayProgress, 'phase'>): 'paymentCharging' | 'paymentApproved' | 'paymentDeclined' | 'paymentUnknown' | null {
  if (p.phase === 'charging') return 'paymentCharging';
  if (p.phase === 'approved') return 'paymentApproved';
  if (p.phase === 'declined') return 'paymentDeclined';
  if (p.phase === 'unknown') return 'paymentUnknown';
  return null;
}

/** Whether to look for a bridge at all: Windows (where it runs), or a pairing / a code already held. */
export function bridgeWorthProbing(input: { userAgent: string; hasPairing: boolean; hasCode: boolean }): boolean {
  return input.hasPairing || input.hasCode || /Windows NT/i.test(input.userAgent);
}

/** `#bridge=123456` (the bridge opened this page) → the code, else null. */
export function bridgeCodeFromHash(hash: string): string | null {
  const m = /(?:^#|&)bridge=([0-9]{6})(?:&|$)/.exec(hash);
  return m ? m[1] : null;
}

/** The fragment without its `bridge=` part (the code is used once and never stays in the address). */
export function hashWithoutBridgeCode(hash: string): string {
  const rest = hash.replace(/^#/, '').split('&').filter((p) => p && !p.startsWith('bridge='));
  return rest.length > 0 ? `#${rest.join('&')}` : '';
}

interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

interface WsLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

type WsCtor = new (url: string) => WsLike;

export const POLL_PAIRED_MS = 5_000;
export const POLL_IDLE_MS = 20_000;
export const PAY_POLL_MS = 800;

/**
 * Keeps the bridge's state for a page: `/health` (and, paired, `/status`) on a timer, the machine
 * linked when it differs, the flow reported, and a payment followed (pushed over the event stream,
 * and asked every 0.8 s besides — whichever comes first).
 */
export class BridgeAgent {
  state: BridgeState = NO_BRIDGE;
  private timer: unknown = null;
  private running = false;
  private stopped = true;
  private listeners = new Set<(s: BridgeState) => void>();
  private lastLinkTry = 0;
  private flowSent = '';
  private pendingCode: string | null = null;

  constructor(
    readonly client: BridgeClient,
    private readonly d: {
      machine?: () => BridgeMachine | null;
      pageUrl?: () => string | null;
      device?: () => Record<string, string>;
      timers?: Timers;
      now?: () => number;
      log?: (m: string) => void;
      WebSocket?: WsCtor | null;
    } = {},
  ) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private setT(fn: () => void, ms: number): unknown {
    return this.d.timers ? this.d.timers.set(fn, ms) : setTimeout(fn, ms);
  }

  private clearT(id: unknown) {
    if (this.d.timers) this.d.timers.clear(id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  }

  on(fn: (s: BridgeState) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(next: BridgeState) {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) for (const fn of this.listeners) fn(next);
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer !== null) this.clearT(this.timer);
    this.timer = this.setT(() => void this.tick(), ms);
  }

  private async tick() {
    await this.refresh();
    this.schedule(this.state.present ? POLL_PAIRED_MS : POLL_IDLE_MS);
  }

  /** A code to pair with as soon as the bridge answers (the bridge opened this page with `#bridge=`). */
  pairWhenFound(code: string | null) {
    this.pendingCode = code;
  }

  /** One look: health, then (paired) status, the machine linked when needed. */
  async refresh(): Promise<BridgeState> {
    if (this.running) return this.state;
    this.running = true;
    try {
      const now = this.now();
      const h = await this.client.health();
      if (!h) {
        this.set({ ...this.state, present: false, ready: NO_CAPS, checkedAt: now, error: null });
        return this.state;
      }
      if (h.api !== BRIDGE_API) {
        this.set({ ...NO_BRIDGE, present: true, version: h.version, checkedAt: now, lastOkAt: now, error: 'גרסת הגשר אינה תואמת' });
        return this.state;
      }
      const ours = this.client.pairing;
      if (ours && (!h.paired || h.pairingId !== ours.pairingId)) {
        // The bridge was paired again (or reset): our secret is worth nothing now.
        await this.client.forget();
      }
      if (!this.client.paired && !h.paired && this.pendingCode) {
        const code = this.pendingCode;
        this.pendingCode = null;
        const r = await this.client.pair(code, { url: this.d.pageUrl?.() ?? null, device: this.d.device?.() ?? {} });
        this.d.log?.(r.ok ? 'bridge: paired with the code it opened this page with' : `bridge: ${r.error}`);
      }
      if (!this.client.paired) {
        this.set({ ...NO_BRIDGE, present: true, version: h.version, otherPage: h.paired, checkedAt: now, lastOkAt: now });
        return this.state;
      }
      let status = await this.statusNow();
      const m = this.d.machine?.() ?? null;
      if (status && m && (status.link?.machineId !== m.machineId || status.link.role !== this.client.role) && now - this.lastLinkTry > 30_000) {
        this.lastLinkTry = now;
        const r = await this.client.request<BridgeStatus>('POST', '/link', m, 120_000);
        if (r.kind === 'ok') status = r.body;
        else this.d.log?.(`bridge link: ${r.kind === 'refused' ? (r.message ?? r.status) : r.reason}`);
      }
      if (!this.client.paired) {
        this.set({ ...NO_BRIDGE, present: true, version: h.version, checkedAt: now, lastOkAt: now });
        return this.state;
      }
      this.set({
        present: true,
        version: h.version,
        paired: true,
        otherPage: false,
        ready: status?.ready ?? h.ready,
        status,
        error: status ? null : 'הגשר לא ענה לבקשת המצב',
        checkedAt: now,
        lastOkAt: now,
      });
      return this.state;
    } finally {
      this.running = false;
    }
  }

  private async statusNow(): Promise<BridgeStatus | null> {
    const r = await this.client.request<BridgeStatus>('GET', '/status', undefined, 6_000);
    return r.kind === 'ok' ? r.body : null;
  }

  /** "צימוד לגשר": the code typed by the staff. */
  async pair(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const r = await this.client.pair(code, { url: this.d.pageUrl?.() ?? null, device: this.d.device?.() ?? {} });
    if (r.ok) {
      this.lastLinkTry = 0;
      await this.refresh();
    }
    return r;
  }

  /** "ביטול הצימוד": the bridge forgets this page, and this page the bridge. */
  async unpair(): Promise<void> {
    if (this.client.paired) await this.client.request('POST', '/unpair', {}).catch(() => undefined);
    await this.client.forget();
    await this.refresh();
  }

  /** The kiosk's flow, when it changes (the bridge's updater and its automatic close wait for a quiet kiosk). */
  reportFlow(f: { flowState: string; screen: string; busy: boolean; idle: boolean }) {
    const key = JSON.stringify(f);
    if (key === this.flowSent || !this.client.paired || !this.state.present) return;
    this.flowSent = key;
    void this.client.request('POST', '/flow', f, 4_000).catch(() => undefined);
  }

  /**
   * Follows one payment: every progress of `orderId` once (pushed by the event stream when the
   * browser opens it, and asked every 0.8 s besides). Returns the stop.
   */
  followPayment(orderId: string, onProgress: (p: BridgePayProgress) => void): () => void {
    let stopped = false;
    let last = '';
    let ws: WsLike | null = null;
    let timer: unknown = null;
    const deliver = (p: BridgePayProgress | null | undefined) => {
      if (stopped || !p || p.orderId !== orderId) return;
      const key = JSON.stringify(p);
      if (key === last) return;
      last = key;
      onProgress(p);
    };
    const poll = async () => {
      if (stopped) return;
      const r = await this.client.request<{ pay: BridgePayProgress | null }>('GET', '/pay/status', undefined, 5_000).catch(() => null);
      if (r && r.kind === 'ok') deliver(r.body?.pay);
      if (!stopped) timer = this.setT(() => void poll(), PAY_POLL_MS);
    };
    const Ws = this.d.WebSocket === undefined ? ((globalThis as unknown as { WebSocket?: WsCtor }).WebSocket ?? null) : this.d.WebSocket;
    if (Ws) {
      void this.client.eventsUrl().then((url) => {
        if (!url || stopped) return;
        try {
          ws = new Ws(url);
          ws.onmessage = (e) => {
            try {
              const msg = JSON.parse(String(e.data)) as { type?: string; progress?: BridgePayProgress };
              if (msg.type === 'pay') deliver(msg.progress);
            } catch {
              /* not ours */
            }
          };
          ws.onerror = () => undefined;
        } catch {
          ws = null;
        }
      });
    }
    void poll();
    return () => {
      stopped = true;
      if (timer !== null) this.clearT(timer);
      try {
        ws?.close();
      } catch {
        /* closed */
      }
    };
  }

  /* ------------------------------------------------------------ the calls */

  startPayment(input: BridgeStartPayment) {
    return this.client.request<StartPaymentOut>('POST', '/pay/start', input, 60_000);
  }

  cancelPayment() {
    return this.client.request('POST', '/pay/cancel', {}, 30_000);
  }

  receiptChoice(orderId: string, print: boolean) {
    return this.client.request('POST', '/pay/receipt', { orderId, print });
  }

  closeRequest(id: string) {
    return this.client.request<{ state: 'done' | 'failed' | 'pending'; shiftId: string | null; zNumber: number | null; detail: string | null }>('POST', '/close-request', { id }, 120_000);
  }

  adminUnlock(pin: string) {
    return this.client.request<{ ok: boolean; name?: string; error?: string }>('POST', '/admin/unlock', { pin });
  }

  adminAction(action: Record<string, unknown> & { type: string }) {
    return this.client.request<{ ok: boolean; message?: string }>('POST', '/admin/action', action, 60_000);
  }

  /** A page to print: a bon or a slip (kiosk-desktop core/printDocs.ts), a reprint of a kiosk order, or a test page. */
  print(input: { kind: 'bon' | 'slip'; doc: Record<string, unknown>; refId?: string | null } | { reprint: 'bon' | 'receipt'; orderId: string } | { test: true }) {
    return this.client.request<{ ok: boolean; jobs: string[] }>('POST', '/print', input);
  }

  openDrawer() {
    return this.client.request('POST', '/drawer', {});
  }

  exitKioskMode(pin: string) {
    return this.client.request('POST', '/launcher/exit', { pin });
  }
}
