/**
 * The browser kiosk's local service (`/k`, docs/SPEC_KIOSK.md §27) — what the Windows kiosk's
 * main process is to its screens (kiosk-desktop/src/main/service.ts behind the `window.kiosk`
 * bridge), for a browser: no disk, no pinpad, no printer, no fiscal ledger.
 *
 *  - pairing with a code from the dashboard (the device is a kiosk because the code says so; the
 *    browser tells the cloud it is "web"), the machine token kept in IndexedDB / localStorage;
 *  - the cloud's last word kept the same way (kiosk snapshot, catalog, settings), so a reload or a
 *    network drop shows the kiosk at once from what it had — the screens only ever read the view;
 *  - the Windows kiosk's cadence: kiosk/sync every 15 s (its status and flow up, the config, the
 *    pause and the help request's answer down), a heartbeat every 30 s, the catalog's delta every
 *    minute, everything in full every 15 minutes;
 *  - payment: what a browser can do honestly — "מזומן בקופה" (an open order the shop's tills
 *    collect, no tax document here) and prepaid vouchers redeemed online; never a card
 *    (`usableMethods`). An order is written here before it is sent, and sent again until the cloud
 *    has it (the screen then says "הזמנה ממתינה לסנכרון");
 *  - "עזרה": a help alert on the next kiosk/sync, as the Windows kiosk.
 *
 * Pure of React and of the DOM (the browser's facts come in through `deps`), so the node tests
 * drive it with a fake fetch and a memory store.
 */

import { resolveKioskConfig, singleCardPayMethods, type KioskConfig, type PaymentMethod } from './kioskConfig';
import { KioskApi, pairWithCode, tokenRevoked, type ApiReply, type FetchFn, type KioskCredentials } from './kioskWebApi';
import { applyCatalogPull, buildWebCatalog, configMediaUrls, sizedImage, type CatalogIn, type WebCatalog, type WebGroup } from './kioskWebCatalog';
import { chosenOptions, defaultPicks, localDateTimeOf, priceKioskBasket, promotionsOf, type MenuGroup, type OptionPick } from './kioskMoney';
import {
  CLOUD_CHECK_TIMEOUT_MS,
  PRICE_CHANGED,
  PROMOTIONS_PULL_TIMEOUT_MS,
  checkedBasePrice,
  cloudCheckRequest,
  overridesLive,
  overridesOf,
  priceChangesOf,
  totalChanged,
  type CloudOverrides,
  type CloudVerdict,
} from './kioskBasketCheck';
import {
  answeredOrder,
  goodsAgorot,
  localDate,
  newId,
  nextPickup,
  offlinePickupLabel,
  openOrderWire,
  orderDue,
  orderNeedsUpload,
  pickupLabelOf,
  voucherAmount,
  voucherForfeits,
  voucherTake,
  type OpenOrder,
  type OpenOrdersAnswer,
  type VoucherItem,
  type VoucherLeg,
  type VoucherTaken,
  type WebOrderLine,
} from './kioskWebOrders';
import { KV, type KvStore } from './kioskWebStore';
import { bridgeCardReady, bridgeCardReason, bridgeFiscalFor, type BridgeAgent, type BridgeMachine, type BridgeState } from './kioskBridge';

export const KIOSK_SYNC_MS = 15_000;
export const BEAT_MS = 30_000;
export const CATALOG_MS = 60_000;
export const FULL_SYNC_MS = 15 * 60_000;
export const HELP_MS = 10 * 60_000;
export const SHOP_PICKUP_TIMEOUT_MS = 3_000;
/** After the cloud refused an order's prices, the catalog is pulled for at most this long before the customer is asked again. */
export const CATALOG_CATCH_UP_MS = 8_000;

export type WebKioskPhase = 'loading' | 'unpaired' | 'waiting' | 'kiosk';

export interface WebKioskView {
  phase: WebKioskPhase;
  appVersion: string;
  machine: {
    machineId: string;
    name: string | null;
    shopName: string | null;
    companyName: string | null;
    posNumber: string | null;
    serverUrl: string;
  } | null;
  /** The effective config (the cloud's, completed by the defaults); media as the cloud's URLs. */
  config: KioskConfig | null;
  configVersion: string | null;
  fontFace: string | null;
  fontFamily: string | null;
  brandName: string;
  /** `promotions`: as the cloud sent them (kioskMoney.ts promotionsOf reads them) — the basket is priced with them. */
  catalog: WebCatalog & { categoryImages: Record<string, string>; promotions: Array<Record<string, unknown>> };
  state: {
    paused: boolean;
    pausedMessage: string | null;
    pausedUntil: string | null;
    /** Nothing this browser can take money with: the kiosk rests on "התשלום אינו זמין כרגע". */
    noPayment: boolean;
    offline: boolean;
    offlineSince: number | null;
  };
  pay: {
    /** As configured (`payment.methods`), as a kiosk of one card per document takes them (singleCardPayMethods: never split_card). */
    methods: PaymentMethod[];
    /** What this browser can take: the card only through a paired bridge (§28); a voucher only online. */
    usable: PaymentMethod[];
    /** Why the card's tile is grey: the bridge's reason, or 'browser' (no bridge here); null when the bridge takes cards now. */
    cardOff: string | null;
  };
  /** "גשר לדפדפן" (§28): the Windows bridge on this PC, when this page looks for one. */
  bridge: {
    present: boolean;
    paired: boolean;
    otherPage: boolean;
    version: string | null;
    /** The bridge holds this kiosk's shift and documents (it is linked to this machine). */
    fiscal: boolean;
    cardReady: boolean;
    print: boolean;
    drawer: boolean;
    lastOkAt: number | null;
  } | null;
  staff: {
    pendingOrders: number;
    pendingReversals: number;
    storage: string;
    lastSyncOkAt: number | null;
    lastError: string | null;
    /** Not a kiosk (or disabled) in the cloud. */
    notKiosk: boolean;
  };
  /** The parameter `technicianCode` (a PBKDF2 hash) when the cloud set one. */
  technicianCode: string | null;
}

export interface WebKioskDeps {
  store: KvStore;
  fetchFn: FetchFn;
  /** The dashboard's own API (NEXT_PUBLIC_API_URL): pairing asks only the code. */
  defaultServer: string;
  appVersion: string;
  deviceInfo: () => Record<string, string>;
  now?: () => number;
  online?: () => boolean;
  /** The media the kiosk shows (config, font, catalog pictures): the service worker keeps them. */
  onMedia?: (urls: string[]) => void;
  /** "גשר לדפדפן" (lib/kioskBridge.ts): the card terminal and the printer of a Windows bridge on this PC. */
  bridge?: BridgeAgent | null;
  log?: (msg: string) => void;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
}

export interface FlowReport {
  flowState: string;
  screen: string;
  busy: boolean;
  idle: boolean;
}

export type BasketChange =
  | { kind: 'removed'; productId: string; name: string; key: string }
  | { kind: 'repriced'; productId: string; name: string; key: string; from: number; to: number };

export type VoucherResult =
  | { kind: 'ok'; leg: VoucherLeg }
  | { kind: 'forfeit' }
  | { kind: 'no_match' }
  | { kind: 'offline' }
  | { kind: 'refused'; reason: string };

export type PlaceResult =
  | { ok: true; order: OpenOrder; dueAgorot: number; pending: boolean }
  /** The cloud prices the basket otherwise (`price_changed`): nothing placed — shown, then asked again. */
  | { ok: false; reason: 'changed'; changes: BasketChange[] }
  | { ok: false; reason: 'empty' | 'rejected' | 'error'; message: string };

/** The pre-payment check's answer: what changed, the goods' total now, and whether the cloud had its say. */
export interface BasketCheck {
  changes: BasketChange[];
  totalAgorot: number;
  /** The goods' total moved (a promotion began or ended) though no line did. */
  totalMoved: boolean;
  source: 'cloud' | 'local';
  /** The promotions changed in the cloud and were pulled first. */
  promotions: boolean;
}

export interface PlaceInput {
  lines: WebOrderLine[];
  /** Null: "ללא סוג שירות" — the order has none. */
  service: 'take_away' | 'eat_in' | null;
  tableRef: string | null;
  customerName: string | null;
  customerPhone: string | null;
  tipAgorot: number;
  vouchers: VoucherLeg[];
}

interface SnapshotState {
  paused?: boolean;
  message?: string | null;
  until?: string | null;
}

type CatalogStore = CatalogIn & { serverTime: string | null };

const EMPTY_CATALOG: CatalogStore = { products: [], categories: [], menu: null, machineCatalog: null, serverTime: null };

interface HelpRequest {
  requestId: string;
  at: number;
  screen: string;
  pings: number;
}

/**
 * What the browser can take of the configured methods: the card only through a paired Windows
 * bridge that takes cards now (it sells offline too, as the Windows kiosk); a voucher only online.
 */
export function usableMethods(methods: readonly PaymentMethod[], online: boolean, cardReady = false): PaymentMethod[] {
  return methods.filter((m) => m === 'cash_at_till' || (m === 'voucher' && online) || (m === 'card' && cardReady));
}

/** The browser kiosk sells when its customers can pay at the till, or by card through the bridge (a voucher never pays it all for sure). */
export function webSells(methods: readonly PaymentMethod[], cardReady = false): boolean {
  return methods.includes('cash_at_till') || (cardReady && methods.includes('card'));
}

/** "איך תרצו לשלם?" is asked unless the card (through the bridge) is the only way (then straight to the pinpad, as the Windows kiosk). */
export function asksPayMethod(methods: readonly PaymentMethod[], cardReady: boolean): boolean {
  if (!webSells(methods, cardReady)) return false;
  return !(cardReady && methods.length === 1 && methods[0] === 'card');
}

/** A catalog group as the shared money rules read it (kioskMoney.ts MenuGroup). */
export function webMoneyGroup(g: WebGroup): MenuGroup {
  return {
    id: g.id,
    name: g.name,
    kind: g.kind,
    minSelect: g.min,
    maxSelect: g.max,
    freeCount: g.freeCount,
    allowQuantity: g.allowQuantity,
    allowPre: g.allowPre,
    options: g.options.map((o) => ({ id: o.id, name: o.name, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty })),
  };
}

export class WebKioskService {
  private creds: KioskCredentials | null = null;
  private machine: Record<string, unknown> | null = null;
  private snapshot: Record<string, unknown> | null = null;
  private catalog: CatalogStore = EMPTY_CATALOG;
  private promotions: { etag: string | null; list: Array<Record<string, unknown>> } = { etag: null, list: [] };
  private settings: { settings: Record<string, unknown>; businessInfo: Record<string, unknown> | null; settingsUpdatedAt: string | null } = {
    settings: {},
    businessInfo: null,
    settingsUpdatedAt: null,
  };
  private parameters: Record<string, unknown> = {};
  private orders = new Map<string, OpenOrder>();
  private reversals = new Set<string>();
  /** The cloud's word on the basket a moment ago (kioskBasketCheck.ts), until the catalog catches up. */
  private cloudBasket: CloudOverrides | null = null;
  private help: HelpRequest | null = null;
  private flow: FlowReport = { flowState: 'attract', screen: 'attract', busy: false, idle: true };
  private loaded = false;
  private offline = false;
  private offlineSince: number | null = null;
  private lastSyncOkAt: number | null = null;
  private lastError: string | null = null;
  private lastBeatAt = 0;
  private lastCatalogAt = 0;
  private lastFullAt = 0;
  private timer: unknown = null;
  private running = false;
  private stopped = true;
  private readonly listeners = new Set<(v: WebKioskView) => void>();
  private cached: WebKioskView | null = null;
  private lastMedia = '';
  readonly api: KioskApi;

  constructor(private readonly deps: WebKioskDeps) {
    this.api = new KioskApi(deps.defaultServer ? normalizedBase(deps.defaultServer) : 'https://invalid.local/api/v1/', () => this.creds?.accessToken ?? null, deps.fetchFn);
    // The bridge's state is part of the view (the card's tile, the staff screen).
    deps.bridge?.on(() => this.dirty());
  }

  /* ------------------------------------------------------- "גשר לדפדפן" */

  /** The bridge on this PC (null: not looked for). */
  get bridge(): BridgeAgent | null {
    return this.deps.bridge ?? null;
  }

  private bridgeState(): BridgeState | null {
    return this.deps.bridge?.state ?? null;
  }

  /** The machine the bridge serves: this kiosk's own (its token never leaves this PC). */
  bridgeMachine(): BridgeMachine | null {
    if (!this.creds) return null;
    const name = (this.snapshot?.name as string | undefined) ?? (this.machine?.machineName as string | undefined) ?? null;
    return { serverUrl: this.creds.serverUrl, machineId: this.creds.machineId, accessToken: this.creds.accessToken, machineName: name };
  }

  /** The bridge holds this kiosk's fiscal side: its shift, its documents, the machine's heartbeat. */
  private bridgeFiscal(): boolean {
    const s = this.bridgeState();
    return !!s && bridgeFiscalFor(s, this.creds?.machineId ?? null);
  }

  private cardReady(): boolean {
    const s = this.bridgeState();
    return !!s && bridgeCardReady(s, this.creds?.machineId ?? null);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(msg: string) {
    this.deps.log?.(msg);
  }

  /* ------------------------------------------------------------------- life */

  /** Loads what the kiosk kept, shows it, and starts the sync when paired. */
  async init(): Promise<WebKioskView> {
    const s = this.deps.store;
    this.creds = await s.get<KioskCredentials>(KV.credentials);
    this.machine = await s.get<Record<string, unknown>>(KV.machine);
    this.snapshot = await s.get<Record<string, unknown>>(KV.snapshot);
    this.catalog = (await s.get<CatalogStore>(KV.catalog)) ?? EMPTY_CATALOG;
    this.promotions = (await s.get<WebKioskService['promotions']>(KV.promotions)) ?? this.promotions;
    this.settings = (await s.get<WebKioskService['settings']>(KV.settings)) ?? this.settings;
    this.parameters = (await s.get<Record<string, unknown>>(KV.parameters)) ?? {};
    for (const key of await s.keys(KV.orderPrefix)) {
      const o = await s.get<OpenOrder>(key);
      if (o) this.orders.set(o.localId, o);
    }
    for (const key of await s.keys(KV.reversePrefix)) this.reversals.add(key.slice(KV.reversePrefix.length));
    if (this.creds) this.api.setBase(this.creds.serverUrl);
    this.loaded = true;
    this.dirty();
    if (this.creds) this.start();
    return this.view();
  }

  start() {
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.timers ? this.deps.timers.set(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(id: unknown) {
    if (this.deps.timers) this.deps.timers.clear(id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.tick(), ms);
  }

  on(fn: (v: WebKioskView) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private dirty() {
    this.cached = null;
    const v = this.view();
    for (const fn of this.listeners) fn(v);
    this.announceMedia(v);
  }

  /** The browser went on / off line (its own events): the next sync now. */
  networkChanged() {
    if (this.creds) this.schedule(0);
  }

  /* ------------------------------------------------------------------- view */

  config(): KioskConfig {
    const raw = this.snapshot?.config;
    return resolveKioskConfig(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null);
  }

  private pausedState(): { paused: boolean; message: string | null; until: string | null } {
    const st = (this.snapshot?.state ?? {}) as SnapshotState;
    let paused = st.paused === true;
    // A timed lock is lifted here at its time, without waiting for the cloud.
    if (paused && st.until && Date.parse(st.until) <= this.now()) paused = false;
    return { paused, message: paused ? (st.message ?? null) : null, until: paused ? (st.until ?? null) : null };
  }

  private fontFace(): { css: string | null; family: string | null } {
    const font = this.snapshot?.font as { cssFamily?: string; regular?: string | null; bold?: string | null; variable?: boolean } | undefined;
    if (!font?.cssFamily || font.cssFamily === 'system-ui' || !font.regular) return { css: null, family: null };
    const fam = font.cssFamily.replace(/"/g, '');
    const src = (u: string) => `url("${u.replace(/"/g, '%22')}")`;
    const css = font.variable
      ? `@font-face{font-family:"${fam}";src:${src(font.regular)};font-weight:100 900;font-display:swap;}`
      : `@font-face{font-family:"${fam}";src:${src(font.regular)};font-weight:400;font-display:swap;}${font.bold ? `@font-face{font-family:"${fam}";src:${src(font.bold)};font-weight:700;font-display:swap;}` : ''}`;
    return { css, family: fam };
  }

  view(): WebKioskView {
    if (this.cached) return this.cached;
    const creds = this.creds;
    const kiosk = this.snapshot?.kiosk === true;
    const phase: WebKioskPhase = !this.loaded ? 'loading' : !creds ? 'unpaired' : kiosk ? 'kiosk' : 'waiting';
    const cfg = phase === 'kiosk' ? this.config() : null;
    const cat = phase === 'kiosk' ? buildWebCatalog(this.catalog, this.settings.settings) : { categories: [], products: [], groups: {}, meals: {}, quickNotes: {}, upsells: [] };
    const categoryImages: Record<string, string> = {};
    if (cfg) {
      for (const [id, ref] of Object.entries(cfg.catalog.categoryImages ?? {})) {
        const url = sizedImage(ref?.url ?? null, 480);
        if (url) categoryImages[id] = url;
      }
    }
    // One card per document here (and through the bridge): never "split_card" (singleCardPayMethods).
    const methods = cfg ? singleCardPayMethods(cfg.payment.methods) : (['card'] as PaymentMethod[]);
    const bs = this.bridgeState();
    const cardReady = this.cardReady();
    const paused = this.pausedState();
    const font = this.fontFace();
    const me = this.machine ?? {};
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    this.cached = {
      phase,
      appVersion: this.deps.appVersion,
      machine: creds
        ? {
            machineId: creds.machineId,
            name: s(this.snapshot?.name) ?? s(me.machineName),
            shopName: s(me.shopName),
            companyName: s(me.companyName),
            posNumber: s(me.posNumber),
            serverUrl: creds.serverUrl,
          }
        : null,
      config: cfg,
      configVersion: s(this.snapshot?.configVersion),
      fontFace: font.css,
      fontFamily: font.family,
      brandName: s(this.settings.businessInfo?.companyName) ?? s(me.companyName) ?? 'R2M',
      catalog: { ...cat, categoryImages, promotions: phase === 'kiosk' ? this.promotions.list : [] },
      state: {
        paused: paused.paused,
        pausedMessage: paused.message,
        pausedUntil: paused.until,
        noPayment: !webSells(methods, cardReady),
        offline: this.offline,
        offlineSince: this.offlineSince,
      },
      pay: {
        methods,
        usable: usableMethods(methods, !this.offline, cardReady),
        cardOff: cardReady ? null : ((bs ? bridgeCardReason(bs, creds?.machineId ?? null) : null) ?? 'browser'),
      },
      bridge: bs
        ? {
            present: bs.present,
            paired: bs.paired,
            otherPage: bs.otherPage,
            version: bs.version,
            fiscal: this.bridgeFiscal(),
            cardReady,
            print: bs.paired && bs.ready.print,
            drawer: bs.paired && bs.ready.drawer,
            lastOkAt: bs.lastOkAt,
          }
        : null,
      staff: {
        pendingOrders: [...this.orders.values()].filter(orderNeedsUpload).length,
        pendingReversals: this.reversals.size,
        storage: this.deps.store.kind,
        lastSyncOkAt: this.lastSyncOkAt,
        lastError: this.lastError,
        notKiosk: !!creds && !!this.snapshot && !kiosk,
      },
      technicianCode: s(this.parameters.technicianCode),
    };
    return this.cached;
  }

  private announceMedia(v: WebKioskView) {
    if (!this.deps.onMedia || v.phase !== 'kiosk') return;
    const urls = new Set<string>(configMediaUrls(this.snapshot?.config));
    const font = this.snapshot?.font as { regular?: string | null; bold?: string | null } | undefined;
    for (const u of [font?.regular, font?.bold]) if (typeof u === 'string' && /^https?:/i.test(u)) urls.add(u);
    for (const u of Object.values(v.catalog.categoryImages)) urls.add(u);
    for (const c of v.catalog.categories) if (c.imageUrl) urls.add(c.imageUrl);
    for (const p of v.catalog.products) {
      if (p.imageUrl) urls.add(p.imageUrl);
      if (p.imageLarge) urls.add(p.imageLarge);
    }
    const list = [...urls].sort();
    const key = list.join('\n');
    if (key === this.lastMedia) return;
    this.lastMedia = key;
    this.deps.onMedia(list);
  }

  /* ---------------------------------------------------------------- pairing */

  async pair(input: { code: string; machineName: string; serverUrl?: string | null }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.creds) return { ok: false, error: 'הקיוסק כבר מצומד' };
    const serverUrl = input.serverUrl?.trim() || this.deps.defaultServer;
    if (!serverUrl) return { ok: false, error: 'חסרה כתובת השרת' };
    const r = await pairWithCode(this.api, { serverUrl, code: input.code, machineName: input.machineName, deviceInfo: this.deps.deviceInfo() }, new Date(this.now()));
    if (!r.ok) return { ok: false, error: r.error };
    this.creds = r.credentials;
    await this.deps.store.set(KV.credentials, r.credentials);
    this.api.setBase(r.credentials.serverUrl);
    await this.fullSync();
    this.lastFullAt = this.now();
    this.dirty();
    this.start();
    return { ok: true };
  }

  /** "ניתוק": this browser forgets the kiosk (the cloud keeps the machine; a new code pairs again). */
  async unpair(): Promise<void> {
    this.stop();
    this.creds = null;
    this.machine = null;
    this.snapshot = null;
    this.catalog = EMPTY_CATALOG;
    this.promotions = { etag: null, list: [] };
    this.parameters = {};
    this.help = null;
    for (const key of [KV.credentials, KV.machine, KV.snapshot, KV.snapshotAt, KV.catalog, KV.promotions, KV.settings, KV.parameters]) await this.deps.store.del(key);
    this.dirty();
  }

  /* ------------------------------------------------------------------- sync */

  private machinePath(rest: string): string {
    return `sync/${this.creds?.machineId}/${rest}`;
  }

  /** Every reply goes through here: online / offline, and a revoked token ends the pairing. */
  private async seen<T>(reply: ApiReply<T>): Promise<ApiReply<T>> {
    if (reply.kind === 'offline') {
      if (!this.offline) {
        this.offline = true;
        this.offlineSince = this.now();
        this.dirty();
      }
      this.lastError = reply.reason;
      return reply;
    }
    if (this.offline) {
      this.offline = false;
      this.offlineSince = null;
      this.dirty();
    }
    if (tokenRevoked(reply)) {
      this.log('machine token revoked: back to pairing');
      await this.unpair();
    } else if (reply.kind === 'refused') {
      this.lastError = `HTTP ${reply.status} ${reply.detail ?? ''}`.trim();
    }
    return reply;
  }

  /** One cycle (never two at once): kiosk/sync, the outbox, and the pulls when due. */
  async tick(): Promise<void> {
    if (this.running || !this.creds) return;
    this.running = true;
    try {
      const now = this.now();
      if (now - this.lastFullAt >= FULL_SYNC_MS) {
        this.lastFullAt = now;
        await this.fullSync();
      } else {
        if (now - this.lastBeatAt >= BEAT_MS) await this.heartbeat();
        await this.kioskSync();
        if (this.creds && now - this.lastCatalogAt >= CATALOG_MS) {
          await this.pullSettings(false);
          await this.pullCatalog(false);
          await this.pullPromotions();
        }
      }
      if (this.creds && !this.offline) await this.flush();
    } catch (e) {
      this.log(`kiosk sync: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
      this.schedule(KIOSK_SYNC_MS);
    }
  }

  /** "סנכרון עכשיו". */
  async syncNow(): Promise<void> {
    this.lastCatalogAt = 0;
    this.lastBeatAt = 0;
    await this.tick();
  }

  async fullSync(): Promise<void> {
    if (!this.creds) return;
    await this.pullMachine();
    if (!this.creds) return;
    await this.heartbeat();
    await this.kioskSync();
    await this.pullSettings(true);
    await this.pullParameters();
    await this.pullCatalog(true);
    await this.pullPromotions();
  }

  private async pullMachine() {
    const r = await this.seen(await this.api.get<Record<string, unknown>>('machines/me', { timeoutMs: 20_000 }));
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object') return;
    this.machine = r.body;
    await this.deps.store.set(KV.machine, r.body);
    this.dirty();
  }

  private async heartbeat() {
    this.lastBeatAt = this.now();
    // With a bridge linked to this machine, ITS heartbeat is the machine's (its open shift, its
    // counters, the remote close / Z it carries out) — a second beat without them would say "no shift".
    if (this.bridgeFiscal()) return;
    const pending = [...this.orders.values()].filter(orderNeedsUpload).length;
    const r = await this.seen(await this.api.post('machines/me/heartbeat', { appVersion: this.deps.appVersion, pendingCount: pending, realtimeConnected: false }, { timeoutMs: 15_000 }));
    if (r.kind === 'ok') this.lastSyncOkAt = this.now();
  }

  /** What `kiosk/sync` reports: the flow, the orders, the help request, the browser's own health. */
  kioskStatus(): Record<string, unknown> {
    const now = this.now();
    const today = localDate(now);
    const todays = [...this.orders.values()].filter((o) => o.businessDate === today && o.rejected === null);
    const pending = [...this.orders.values()].filter(orderNeedsUpload);
    const alerts: Array<Record<string, unknown>> = [];
    if (this.help && now - this.help.at < HELP_MS) {
      alerts.push({ kind: 'help', key: 'help', reason: 'help', requestId: this.help.requestId, pings: this.help.pings, detail: { screen: this.help.screen } });
    }
    const status: Record<string, unknown> = {
      flowState: this.flow.flowState,
      shiftOpen: false,
      appliedConfigVersion: (this.snapshot?.configVersion as string) ?? undefined,
      mediaReady: true,
      mediaMissing: 0,
      bonPrinter: 'none',
      receiptPrinter: 'none',
      ordersToday: todays.length,
      salesTodayAgorot: todays.reduce((s, o) => s + goodsAgorot(o.lines) + o.tipAgorot, 0),
      lastOrderAt: todays.length > 0 ? new Date(todays[todays.length - 1].createdAtMs).toISOString() : undefined,
      pendingOrders: pending.length,
      unprintedBons: 0,
      appVersion: this.deps.appVersion,
      alerts,
      health: {
        platform: 'web',
        screen: this.flow.screen,
        terminal: { state: 'none' },
        printer: { state: 'none' },
        tillLink: { mode: 'cloud', ok: !this.offline, at: this.lastSyncOkAt ? new Date(this.lastSyncOkAt).toISOString() : undefined },
        network: { online: !this.offline, since: this.offlineSince ? new Date(this.offlineSince).toISOString() : undefined },
        pending: {
          orders: pending.length,
          documents: 0,
          events: 0,
          oldestAt: pending.length > 0 ? new Date(Math.min(...pending.map((o) => o.createdAtMs))).toISOString() : undefined,
        },
      },
    };
    const bridgeHealth = this.bridgeHealth();
    if (bridgeHealth) (status.health as Record<string, unknown>).bridge = bridgeHealth;
    const fiscal = this.bridgeFiscal();
    if (fiscal) mergeBridgePart(status, this.bridgeState()?.status?.statusPart ?? null);
    const close = this.snapshot?.closeRequest as { id?: unknown } | null | undefined;
    if (close && typeof close.id === 'string') {
      if (fiscal) {
        // The bridge holds the shift: it closes it (never under a customer), the answer goes up once it has one.
        if (this.closeAnswer?.id === close.id) status.closeResult = this.closeAnswer;
        else void this.forwardClose(close.id);
      } else {
        // "סגירת משמרת" asked of a kiosk that has no shift: said so, so the request does not hang.
        status.closeResult = { id: close.id, state: 'done', shiftId: null, zNumber: null, detail: 'קיוסק בדפדפן: אין משמרת ואין מסמכים — הקופה שגובה את ההזמנות מפיקה אותם' };
      }
    }
    return status;
  }

  private closeAnswer: { id: string; state: 'done' | 'failed'; shiftId: string | null; zNumber: number | null; detail: string | null } | null = null;
  private closing: string | null = null;

  /** "סגירה יחד עם ה-Z הסניפי" handed to the bridge; its answer reported on the next kiosk/sync. */
  private async forwardClose(id: string) {
    const bridge = this.deps.bridge;
    if (!bridge || this.closing === id) return;
    this.closing = id;
    try {
      const r = await bridge.closeRequest(id);
      if (r.kind === 'ok' && (r.body.state === 'done' || r.body.state === 'failed')) {
        this.closeAnswer = { id, state: r.body.state, shiftId: r.body.shiftId, zNumber: r.body.zNumber, detail: r.body.detail };
        if (this.creds) this.schedule(0);
      }
    } finally {
      this.closing = null;
    }
  }

  /** `health.bridge` (§28): only while this page holds a pairing — paired, answering, what it can do. */
  private bridgeHealth(): Record<string, unknown> | null {
    const s = this.bridgeState();
    if (!s || (!s.paired && !this.deps.bridge?.client.paired)) return null;
    return {
      paired: s.paired,
      present: s.present,
      version: s.version ?? undefined,
      at: s.lastOkAt ? new Date(s.lastOkAt).toISOString() : undefined,
      linked: this.bridgeFiscal(),
      card: this.cardReady(),
      print: s.ready.print,
      drawer: s.ready.drawer,
    };
  }

  async kioskSync(): Promise<boolean> {
    if (!this.creds) return false;
    const r = await this.seen(await this.api.post<Record<string, unknown>>(this.machinePath('kiosk/sync'), { status: this.kioskStatus() }, { timeoutMs: 15_000 }));
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object') return false;
    this.lastSyncOkAt = this.now();
    this.lastError = null;
    const prevVersion = this.snapshot?.configVersion;
    const prevState = JSON.stringify(this.snapshot?.state ?? null);
    this.snapshot = r.body;
    await this.deps.store.set(KV.snapshot, r.body);
    await this.deps.store.set(KV.snapshotAt, this.now());
    // The tills answered the help request (or it ran out): the kiosk stops asking.
    const help = (r.body.alerts as { help?: { requestId?: string; state?: string } | null } | undefined)?.help;
    if (this.help && help && help.requestId === this.help.requestId && (help.state === 'acknowledged' || help.state === 'expired')) this.help = null;
    if (this.help && this.now() - this.help.at >= HELP_MS) this.help = null;
    if (prevVersion !== r.body.configVersion || prevState !== JSON.stringify(r.body.state ?? null) || r.body.kiosk !== true) this.dirty();
    else this.cached = null;
    return true;
  }

  private async pullSettings(full: boolean) {
    if (!this.creds) return;
    const since = !full && this.settings.settingsUpdatedAt ? `?since=${encodeURIComponent(this.settings.settingsUpdatedAt)}` : '';
    const r = await this.seen(await this.api.get<Record<string, unknown>>(this.machinePath(`settings${since}`), { timeoutMs: 20_000 }));
    if (r.kind !== 'ok' || !r.body || r.body.syncType === 'unchanged') return;
    this.settings = {
      settings: (r.body.settings as Record<string, unknown>) ?? {},
      businessInfo: (r.body.businessInfo as Record<string, unknown>) ?? null,
      settingsUpdatedAt: typeof r.body.settingsUpdatedAt === 'string' ? r.body.settingsUpdatedAt : null,
    };
    await this.deps.store.set(KV.settings, this.settings);
    this.dirty();
  }

  private async pullParameters() {
    if (!this.creds) return;
    const r = await this.seen(await this.api.get<{ parameters?: Record<string, unknown> }>(this.machinePath('parameters'), { timeoutMs: 20_000 }));
    if (r.kind !== 'ok' || !r.body?.parameters || typeof r.body.parameters !== 'object') return;
    this.parameters = r.body.parameters;
    await this.deps.store.set(KV.parameters, this.parameters);
    this.cached = null;
  }

  private async pullCatalog(full: boolean) {
    if (!this.creds) return;
    this.lastCatalogAt = this.now();
    const since = !full && this.catalog.serverTime ? `?since=${encodeURIComponent(this.catalog.serverTime)}` : '';
    const r = await this.seen(await this.api.get<Record<string, unknown>>(this.machinePath(`catalog${since}`), { timeoutMs: 60_000 }));
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object') return;
    const b = r.body;
    const changed = b.syncType === 'full' || (Array.isArray(b.products) && b.products.length > 0) || (Array.isArray(b.categories) && b.categories.length > 0) || !!b.menu;
    this.catalog = applyCatalogPull(this.catalog, b);
    await this.deps.store.set(KV.catalog, this.catalog);
    if (changed) this.dirty();
  }

  /** "מבצעים": the till's promotions (`GET /sync/{m}/promotions`, ETag); offline, the last ones stay. */
  private async pullPromotions() {
    if (!this.creds) return;
    const q = this.promotions.etag ? `?etag=${encodeURIComponent(this.promotions.etag)}` : '';
    const r = await this.seen(await this.api.get<{ syncType?: string; etag?: string; promotions?: unknown }>(this.machinePath(`promotions${q}`), { timeoutMs: 20_000 }));
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object' || r.body.syncType === 'unchanged') return;
    const list = Array.isArray(r.body.promotions) ? (r.body.promotions as unknown[]).filter((p): p is Record<string, unknown> => !!p && typeof p === 'object') : [];
    this.promotions = { etag: typeof r.body.etag === 'string' ? r.body.etag : null, list };
    await this.deps.store.set(KV.promotions, this.promotions);
    this.dirty();
  }

  /* ------------------------------------------------------------ the screens */

  reportFlow(f: FlowReport) {
    const changed = f.flowState !== this.flow.flowState;
    this.flow = f;
    // The bridge's updater and its close wait for a quiet kiosk (§28).
    this.deps.bridge?.reportFlow(f);
    // The cloud's status (and the dashboard's "בהזמנה" / "בתשלום") follows at once.
    if (changed && this.creds && !this.running) this.schedule(400);
  }

  /** "עזרה": a help alert to the tills on the next kiosk/sync (again: a new ping). */
  helpRequest() {
    const now = this.now();
    if (this.help && now - this.help.at < HELP_MS) this.help = { ...this.help, pings: this.help.pings + 1, screen: this.flow.screen };
    else this.help = { requestId: newId(), at: now, screen: this.flow.screen, pings: 1 };
    if (this.creds) this.schedule(0);
  }

  /**
   * The cloud's word on the basket before the order goes out (`POST /sync/{m}/kiosk/basket-check`,
   * at most 3 s; the Android kiosk's KioskViewModel.cloudBasketCheck): what is no longer sold here
   * and the base prices now, kept as overrides for the check that follows; a difference pulls the
   * catalog; a changed set of promotions is pulled now (true). Offline, or no answer in time:
   * nothing — the kiosk's own catalog and promotions decide.
   */
  private async cloudBasketCheck(lines: ReadonlyArray<{ productId: string; qty?: number }>): Promise<boolean> {
    if (!this.creds || this.offline || lines.length === 0) return false;
    const byId = new Map(this.view().catalog.products.map((p) => [p.id, p]));
    const body = cloudCheckRequest(lines, (id) => byId.get(id)?.priceAgorot, this.promotions.etag);
    const raw = await this.api.post<CloudVerdict>(this.machinePath('kiosk/basket-check'), body, { timeoutMs: CLOUD_CHECK_TIMEOUT_MS });
    // A slow answer is not an outage: only an answer goes through `seen`.
    if (raw.kind === 'offline') return false;
    const r = await this.seen(raw);
    if (r.kind !== 'ok' || !r.body || !Array.isArray(r.body.lines)) return false;
    const o = overridesOf(r.body, this.now());
    this.cloudBasket = o.gone.size > 0 || o.prices.size > 0 ? o : null;
    if (!r.body.ok) void this.pullCatalog(false).catch(() => undefined);
    if (r.body.promotions?.changed) {
      await this.within(this.pullPromotions(), PROMOTIONS_PULL_TIMEOUT_MS);
      return true;
    }
    return false;
  }

  /** [p], waited for at most [ms] (it goes on by itself after). */
  private within(p: Promise<unknown>, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const id = this.setTimer(resolve, ms);
      void p.catch(() => undefined).then(() => {
        this.clearTimer(id);
        resolve();
      });
    });
  }

  /**
   * The basket before the order goes out (kioskBasketCheck.ts) — even after a voucher: the cloud's
   * word first, then against the catalog as it is now: what went out, what changed price — each
   * line priced with the shared money rules (kioskMoney.ts: charged choices, a meal's components on
   * their defaults) — and the total after the promotions, as the till will charge it.
   */
  async checkBasket(
    lines: ReadonlyArray<{
      key: string;
      productId: string;
      unitAgorot: number;
      qty?: number;
      options: ReadonlyArray<{ groupId: string; optionId: string; qty?: number; pre?: 'lite' | 'extra' | 'side' | null }>;
      meal?: { components: ReadonlyArray<{ slotId: string; productId: string }> } | null;
    }>,
    shownAgorot: number | null = null,
    now: Date | null = null,
  ): Promise<BasketCheck> {
    const promotions = await this.cloudBasketCheck(lines).catch(() => false);
    const cloud = overridesLive(this.cloudBasket, this.now());
    const v = this.view();
    const byId = new Map(v.catalog.products.map((p) => [p.id, p]));
    const sold = (id: string) => {
      const p = byId.get(id);
      return p && !p.soldOut && !cloud?.gone.has(id) ? p : null;
    };
    const changes: BasketChange[] = [];
    const priced: Array<{ key: string; productId: string; categoryId: string | null; unitAgorot: number; qty: number; noDiscount: boolean }> = [];
    for (const l of lines) {
      const p = sold(l.productId);
      const slots = v.catalog.meals[l.productId] ?? [];
      const parts = l.meal?.components ?? [];
      const brokenMeal = parts.some((c) => {
        const slot = slots.find((s) => s.id === c.slotId);
        return !slot || !slot.choices.some((x) => x.productId === c.productId) || !sold(c.productId);
      });
      const groups = (p ? (v.catalog.groups[p.id] ?? []) : []).map(webMoneyGroup);
      const missing = l.options.some((o) => !groups.find((g) => g.id === o.groupId)?.options.some((x) => x.id === o.optionId));
      if (!p || brokenMeal || missing) {
        changes.push({ kind: 'removed', productId: l.productId, name: byId.get(l.productId)?.name ?? '', key: l.key });
        continue;
      }
      const picks: Record<string, OptionPick[]> = {};
      for (const o of l.options) {
        const g = groups.find((x) => x.id === o.groupId)!;
        const pre = g.allowPre && (o.pre === 'lite' || o.pre === 'extra' || o.pre === 'side') ? o.pre : null;
        (picks[g.id] ??= []).push({ optionId: o.optionId, qty: Math.max(1, Math.trunc(o.qty ?? 1)), pre });
      }
      let unit = checkedBasePrice(p.id, p.priceAgorot, cloud) + chosenOptions(groups, picks).reduce((s, o) => s + o.chargedAgorot, 0);
      for (const c of parts) {
        const slot = slots.find((s) => s.id === c.slotId)!;
        const cg = (v.catalog.groups[c.productId] ?? []).map(webMoneyGroup);
        unit += slot.choices.find((x) => x.productId === c.productId)!.upchargeAgorot + chosenOptions(cg, Object.fromEntries(cg.map((g) => [g.id, defaultPicks(g)]))).reduce((s, o) => s + o.chargedAgorot, 0);
      }
      if (unit !== l.unitAgorot) changes.push({ kind: 'repriced', productId: l.productId, name: p.name, key: l.key, from: l.unitAgorot, to: unit });
      priced.push({ key: l.key, productId: p.id, categoryId: p.categoryId, unitAgorot: unit, qty: l.qty ?? 1, noDiscount: p.noDiscount });
    }
    const basket = priceKioskBasket(
      priced.map((x) => ({ id: x.key, productIds: [x.productId], categoryId: x.categoryId, unitAgorot: x.unitAgorot, qty: x.qty, noDiscount: x.noDiscount })),
      promotionsOf(v.catalog.promotions),
      localDateTimeOf(now ?? new Date(this.now())),
    );
    return { changes, totalAgorot: basket.totalAgorot, totalMoved: totalChanged(shownAgorot, basket.totalAgorot), source: cloud ? 'cloud' : 'local', promotions };
  }

  /* --------------------------------------------------------------- vouchers */

  private operator(): { id: string; name: string } {
    const op = this.snapshot?.operator as { id?: unknown; name?: unknown } | undefined;
    const id = typeof op?.id === 'string' ? op.id : `kiosk:${this.creds?.machineId ?? ''}`;
    const name = (typeof op?.name === 'string' && op.name.trim()) || (this.snapshot?.name as string) || 'קיוסק';
    return { id, name };
  }

  /**
   * A voucher scanned or typed: looked up, then redeemed online against what the basket holds that
   * earlier vouchers did not take (`clientRequestId`: a retry never redeems twice).
   */
  async redeemVoucher(input: { code: string; lines: readonly WebOrderLine[]; earlier: readonly VoucherLeg[]; forfeitRest?: boolean; clientRequestId: string }): Promise<VoucherResult> {
    if (!this.creds) return { kind: 'offline' };
    const looked = await this.seen(await this.api.post<Record<string, unknown>>(this.machinePath('prepaid-vouchers/lookup'), { code: input.code }, { timeoutMs: 12_000 }));
    if (looked.kind === 'offline') return { kind: 'offline' };
    if (looked.kind === 'refused') return { kind: 'refused', reason: looked.detail ?? (looked.status === 404 ? 'prepaid_voucher_not_found' : `http_${looked.status}`) };
    const dto = looked.body ?? {};
    if (dto.redeemable === false) return { kind: 'refused', reason: typeof dto.reason === 'string' ? dto.reason : typeof dto.status === 'string' ? `prepaid_voucher_${dto.status}` : 'not_redeemable' };
    const items: VoucherItem[] = (Array.isArray(dto.items) ? (dto.items as Array<Record<string, unknown>>) : [])
      .filter((it) => typeof it.productId === 'string')
      .map((it) => ({
        productId: String(it.productId),
        tillProductId: typeof it.tillProductId === 'string' ? it.tillProductId : null,
        name: String(it.name ?? ''),
        quantity: Number(it.quantity) || 0,
        remaining: Number(it.remaining) || 0,
      }));
    const take = voucherTake(items, input.lines, input.earlier);
    if (take.size === 0) return { kind: 'no_match' };
    if (!input.forfeitRest && voucherForfeits(dto.splitAllowed === true, items, take)) return { kind: 'forfeit' };
    const op = this.operator();
    const r = await this.seen(
      await this.api.post<Record<string, unknown>>(
        this.machinePath('prepaid-vouchers/redeem'),
        {
          code: input.code,
          items: [...take.entries()].map(([productId, quantity]) => ({ productId, quantity })),
          clientRequestId: input.clientRequestId,
          forfeitRest: input.forfeitRest === true,
          posUserId: op.id,
          posUserName: op.name,
        },
        { timeoutMs: 15_000 },
      ),
    );
    if (r.kind === 'offline') return { kind: 'offline' };
    if (r.kind === 'refused') return { kind: 'refused', reason: r.detail ?? `http_${r.status}` };
    const res = r.body ?? {};
    const redemptionId = typeof res.redemptionId === 'string' ? res.redemptionId : null;
    if (!redemptionId) return { kind: 'refused', reason: 'bad_answer' };
    const redeemed: VoucherTaken[] = (Array.isArray(res.redeemed) ? (res.redeemed as Array<Record<string, unknown>>) : [])
      .filter((x) => typeof x.productId === 'string')
      .map((x) => ({ productId: String(x.productId), tillProductId: typeof x.tillProductId === 'string' ? x.tillProductId : null, name: typeof x.name === 'string' ? x.name : null, quantity: Number(x.quantity) || 0 }));
    const amount = voucherAmount([...input.lines], [...input.earlier], redeemed);
    if (amount <= 0) {
      // Nothing of the basket it could pay: never kept for nothing.
      await this.reverseVoucher(redemptionId);
      return { kind: 'no_match' };
    }
    const voucher = (res.voucher ?? dto) as { serial?: unknown; eventName?: unknown };
    return {
      kind: 'ok',
      leg: {
        redemptionId,
        serial: typeof voucher.serial === 'number' ? voucher.serial : 0,
        amountAgorot: amount,
        eventName: typeof voucher.eventName === 'string' ? voucher.eventName : null,
        redeemed,
      },
    };
  }

  /** The voucher goes back on itself (removed, the order left, the kiosk reset); kept until the cloud answers. */
  async reverseVoucher(redemptionId: string): Promise<void> {
    this.reversals.add(redemptionId);
    await this.deps.store.set(`${KV.reversePrefix}${redemptionId}`, { at: this.now() });
    await this.flushReversal(redemptionId);
    this.dirty();
  }

  private async flushReversal(id: string): Promise<boolean> {
    if (!this.creds) return false;
    const r = await this.seen(await this.api.post(this.machinePath(`prepaid-vouchers/redemptions/${encodeURIComponent(id)}/reverse`), {}, { timeoutMs: 12_000 }));
    if (r.kind === 'offline') return false;
    // Reversed, or nothing to reverse (404): either way it is done.
    if (r.kind === 'ok' || r.status === 404 || r.status === 409) {
      this.reversals.delete(id);
      await this.deps.store.del(`${KV.reversePrefix}${id}`);
      return true;
    }
    return false;
  }

  /* ----------------------------------------------------------------- orders */

  private async allocatePickup(localId: string, businessDate: string): Promise<{ number: number; label: string }> {
    const cfg = this.config();
    const rules = cfg.pickup;
    const local = async (key: string) => {
      const kept = await this.deps.store.get<{ date: string; last: number }>(key);
      const n = nextPickup(kept?.date ?? null, kept?.last ?? null, businessDate, rules);
      // Saved before it is handed out: never the same number twice after a reload.
      await this.deps.store.set(key, { date: businessDate, last: n });
      return n;
    };
    if (rules.scope === 'shop' && this.creds) {
      const r = await this.seen(await this.api.post<{ number?: number; label?: string }>(this.machinePath('kiosk/pickup-number'), { orderKey: localId, businessDate }, { timeoutMs: SHOP_PICKUP_TIMEOUT_MS }));
      if (r.kind === 'ok' && typeof r.body?.number === 'number' && r.body.number > 0) {
        return { number: r.body.number, label: r.body.label?.trim() || pickupLabelOf(rules.prefix, r.body.number, rules.labelFormat) };
      }
      const n = await local(KV.pickupFallback);
      return { number: n, label: offlinePickupLabel(rules.prefix, n) };
    }
    // "מספר בלבד" never shows a number it drew alone bare (another kiosk may say the same): tagged.
    if (rules.labelFormat === 'number') {
      const n = await local(KV.pickupFallback);
      return { number: n, label: offlinePickupLabel(rules.prefix, n) };
    }
    const n = await local(KV.pickup);
    return { number: n, label: pickupLabelOf(rules.prefix, n, rules.labelFormat) };
  }

  /**
   * "מזומן בקופה": the order (with its vouchers, pending) goes to the shop's tills. Written here
   * first; a cloud that does not answer leaves it pending (sent again on every sync), the screen
   * saying so. No tax document is written here — the till that takes the money writes it.
   */
  async placeOpenOrder(input: PlaceInput): Promise<PlaceResult> {
    if (!this.creds) return { ok: false, reason: 'error', message: 'הקיוסק אינו מצומד' };
    if (input.lines.length === 0) return { ok: false, reason: 'empty', message: '' };
    const cfg = this.config();
    const now = this.now();
    const localId = newId();
    const businessDate = localDate(now);
    const pickup = await this.allocatePickup(localId, businessDate);
    const order: OpenOrder = {
      localId,
      createdAtMs: now,
      businessDate,
      serviceType: input.service,
      tableRef: input.tableRef,
      fulfillmentMode: cfg.general.fulfillmentMode === 'KDS' ? 'KDS' : 'BON',
      configVersion: (this.snapshot?.configVersion as string) ?? null,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      lines: input.lines,
      tipAgorot: Math.max(0, Math.trunc(input.tipAgorot)),
      vouchers: input.vouchers,
      pickupNumber: pickup.number,
      pickupLabel: pickup.label,
      bon: { mode: cfg.printing.bonMode === 'single' ? 'single' : 'routing', printerId: cfg.printing.bonPrinterId ?? null, copies: Math.max(1, Math.min(5, cfg.printing.bonCopies || 1)) },
      kitchenSent: false,
      cloudState: null,
      rejected: null,
    };
    if (cfg.payment.cashAtTillKitchenBeforePay) order.kitchenSent = await this.relayBon(order);
    this.orders.set(localId, order);
    await this.deps.store.set(`${KV.orderPrefix}${localId}`, order);
    const sent = await this.sendOrders([order], true);
    const now2 = this.orders.get(localId) ?? order;
    this.dirty();
    if (now2.rejected === PRICE_CHANGED) {
      // The cloud prices it otherwise: never placed. Forgotten (unless the kitchen has its bon — then
      // the staff screen keeps it), the catalog caught up, and the customer shown the change.
      if (!now2.kitchenSent) {
        this.orders.delete(localId);
        await this.deps.store.del(`${KV.orderPrefix}${localId}`);
      }
      await this.within(this.pullCatalog(false), CATALOG_CATCH_UP_MS);
      this.dirty();
      return { ok: false, reason: 'changed', changes: priceChangesOf(now2.refusedLines).map((c) => ({ ...c, key: c.key ?? '' })) };
    }
    if (now2.rejected) {
      return { ok: false, reason: 'rejected', message: `ההזמנה לא נקלטה (${now2.rejected}). אנא פנו לצוות.` };
    }
    return { ok: true, order: now2, dueAgorot: orderDue(now2), pending: !sent || now2.cloudState === null };
  }

  /**
   * "שלח למטבח לפני תשלום": the bon to the shop's bon printer through the cloud (the host till prints
   * it, kitchen_printers ticket). Only a single bon printer (`printing.bonMode` single); with the
   * kitchen's routing the till that collects sends it. True when the cloud took the job.
   */
  private async relayBon(o: OpenOrder): Promise<boolean> {
    if (o.fulfillmentMode !== 'BON' || o.bon.mode !== 'single' || !o.bon.printerId || !this.creds) return false;
    const ticket = {
      source: 'sale',
      createdAt: new Date(o.createdAtMs).toISOString(),
      orderRef: o.pickupLabel,
      sourceName: this.operator().name,
      customerName: o.customerName,
      // "ללא סוג שירות": no band on the bon.
      dining: o.serviceType ?? null,
      tableName: o.tableRef,
      notice: 'ממתין לתשלום בקופה',
      isAddition: false,
      lines: o.lines.map((l) => ({
        productId: l.productId,
        categoryId: l.categoryId,
        name: l.name,
        quantity: l.qty,
        mods: [...l.options.filter((x) => x.kind !== 'removal').map((x) => x.name), ...(l.meal?.components ?? []).map((c) => c.name)],
        removals: l.options.filter((x) => x.kind === 'removal').map((x) => x.name),
        notes: l.note ?? undefined,
      })),
    };
    let ok = false;
    for (let copy = 0; copy < o.bon.copies; copy++) {
      const r = await this.seen(await this.api.post(this.machinePath('print-jobs'), { id: newId(), printerId: o.bon.printerId, ticket }, { timeoutMs: 10_000 }));
      if (r.kind === 'ok') ok = true;
      else break;
    }
    return ok;
  }

  /**
   * To the cloud; true when it answered. Each order's state (or its refusal) is kept. [customerWaiting]:
   * the first sending, while the customer waits for the slip (openOrderWire).
   */
  private async sendOrders(list: OpenOrder[], customerWaiting = false): Promise<boolean> {
    if (!this.creds || list.length === 0) return false;
    const r = await this.seen(await this.api.post<OpenOrdersAnswer>(
      this.machinePath('kiosk/open-orders'),
      { orders: list.map((o) => openOrderWire(o, customerWaiting)) },
      { timeoutMs: 12_000 },
    ));
    if (r.kind !== 'ok') return false;
    for (const o of list) {
      const next = answeredOrder(o, r.body);
      if (!next) continue;
      this.orders.set(o.localId, next);
      await this.deps.store.set(`${KV.orderPrefix}${o.localId}`, next);
    }
    return true;
  }

  /** The outbox: orders the cloud does not have, vouchers to give back; old delivered orders pruned. */
  private async flush() {
    const due = [...this.orders.values()].filter(orderNeedsUpload).sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let i = 0; i < due.length; i += 50) {
      if (!(await this.sendOrders(due.slice(i, i + 50)))) break;
    }
    for (const id of [...this.reversals]) if (!(await this.flushReversal(id))) break;
    const keepFrom = this.now() - 2 * 86_400_000;
    for (const o of [...this.orders.values()]) {
      if (!orderNeedsUpload(o) && o.createdAtMs < keepFrom) {
        this.orders.delete(o.localId);
        await this.deps.store.del(`${KV.orderPrefix}${o.localId}`);
      }
    }
    if (due.length > 0) this.dirty();
  }

  /** Orders placed today (newest first), for the staff screen. */
  todaysOrders(): OpenOrder[] {
    const today = localDate(this.now());
    return [...this.orders.values()].filter((o) => o.businessDate === today).sort((a, b) => b.createdAtMs - a.createdAtMs);
  }
}

/**
 * The bridge's part of the kiosk's status (kiosk-desktop KioskService.bridgePart): its shift, its
 * printer and terminal, its card orders of today and its documents waiting, merged into the page's.
 */
export function mergeBridgePart(status: Record<string, unknown>, part: Record<string, unknown> | null): Record<string, unknown> {
  if (!part) return status;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  for (const k of ['shiftOpen', 'bonPrinter', 'receiptPrinter'] as const) if (part[k] !== undefined) status[k] = part[k];
  status.unprintedBons = num(status.unprintedBons) + num(part.unprintedBons);
  status.ordersToday = num(status.ordersToday) + num(part.ordersToday);
  status.salesTodayAgorot = num(status.salesTodayAgorot) + num(part.salesTodayAgorot);
  status.pendingOrders = num(status.pendingOrders) + num(part.pendingOrders);
  const last = [status.lastOrderAt, part.lastOrderAt].filter((x): x is string => typeof x === 'string').sort().pop();
  if (last) status.lastOrderAt = last;
  status.alerts = [...((status.alerts as unknown[]) ?? []), ...((part.alerts as unknown[]) ?? [])];
  const health = (status.health ?? {}) as Record<string, unknown>;
  const ph = (part.health ?? {}) as Record<string, unknown>;
  if (ph.terminal) health.terminal = ph.terminal;
  if (ph.printer) health.printer = ph.printer;
  const pending = (health.pending ?? {}) as Record<string, unknown>;
  const pp = (ph.pending ?? {}) as Record<string, unknown>;
  health.pending = {
    ...pending,
    orders: num(pending.orders) + num(pp.orders),
    documents: num(pending.documents) + num(pp.documents),
    oldestAt: [pending.oldestAt, pp.oldestAt].filter((x): x is string => typeof x === 'string').sort()[0],
  };
  status.health = health;
  return status;
}

function normalizedBase(server: string): string {
  let s = server.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!/\/api\/v\d+$/i.test(s)) s = `${s}/api/v1`;
  return `${s}/`;
}
