/**
 * A till engine over a REAL KioskService (temp data dir, fake cloud, fake card terminal, fake printer transport) — what the
 * till tests drive. Tests only: nothing here reaches a real server, terminal or printer.
 */

import bcrypt from 'bcryptjs';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KioskCoreTillEngine, type TillWorkMode } from '../src/main/till/engine';
import { KioskService } from '../src/main/service';
import type { ApprovedCard, PaymentProvider, SaleRequest, SaleResult, Resolution } from '../src/main/payment/provider';
import type { Transport } from '../src/main/printer/transports';
import type { EngineEvent, EngineReply, TillOp, TillState } from '../src/shared/till/protocol';

export const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
export const SHOP = '11111111-2222-4333-8444-555555555555';

export const noPrinter: Transport & { sent: Uint8Array[] } = {
  sent: [],
  send: async function (_t, bytes) {
    this.sent.push(bytes);
  },
  status: async () => ({ health: 'ok', detail: null }),
  list: async () => [],
  dispose: () => undefined,
};

export function card(over: Partial<ApprovedCard> = {}): ApprovedCard {
  return { brand: 'visa', last4: '4580', authNum: '123456', uid: 'uid-1', payments: 1, firstPaymentAgorot: null, chargedAgorot: null, meta: { vuid: 'v' }, ...over };
}

/** A terminal that answers what the test says. */
export class FakeTerminal implements PaymentProvider {
  readonly kind = 'nayax_lan';
  sales: SaleRequest[] = [];
  next: () => SaleResult = () => ({ answer: 'APPROVED', card: card(), raw: '' });
  resolveWith: () => Resolution = () => ({ kind: 'unknown', message: 'לא ידוע' });
  private n = 0;
  describe() {
    return { kind: this.kind, address: '192.168.0.50' };
  }
  newReference() {
    this.n += 1;
    return `ref-${this.n}`;
  }
  async check() {
    return { ok: true, detail: null };
  }
  async sale(req: SaleRequest): Promise<SaleResult> {
    this.sales.push(req);
    return this.next();
  }
  async resolve(): Promise<Resolution> {
    return this.resolveWith();
  }
  async abort() {}
}

export interface Harness {
  svc: KioskService;
  engine: KioskCoreTillEngine;
  terminal: FakeTerminal;
  printer: typeof noPrinter;
  sent: Array<{ method: string; path: string; body: unknown }>;
  states: TillState[];
  events: EngineEvent[];
  call(op: TillOp, args?: Record<string, unknown>): Promise<EngineReply>;
  ok<T = unknown>(op: TillOp, args?: Record<string, unknown>): Promise<T>;
  fail(op: TillOp, args?: Record<string, unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }>;
  state(): TillState;
  stop(): void;
}

export interface HarnessOptions {
  products?: Array<Record<string, unknown>>;
  /** A whole catalog (categories and the menu with it), e.g. the pricing corpus's. */
  catalog?: { products: Array<Record<string, unknown>>; categories: Array<Record<string, unknown>>; menu: Record<string, unknown> | null };
  promotions?: Array<Record<string, unknown>>;
  users?: Array<Record<string, unknown>>;
  settings?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  zMode?: 'till' | 'cloud';
  /** The cloud's `independentTill` (heartbeat). */
  independent?: boolean;
  workMode?: TillWorkMode | null;
  /** The fake cloud's answers by `METHOD path` (a `…/*` key matches a prefix); a function gets the request's JSON body. */
  answers?: Record<string, (body: Record<string, unknown> | null) => unknown>;
  dealerType?: string;
  now?: () => number;
}

const PRODUCTS: Array<Record<string, unknown>> = [
  { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', sku: 'B1', barcode: '7290000000011' },
  { id: 'p-cola', name: 'קולה', price: 12.5, categoryId: 'c-drink', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-kiosk', name: 'ארוחת ילדים', price: 30, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'kiosk_only' },
  { id: 'p-pos', name: 'סטייק צוות', price: 80, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'pos_only' },
];

export const PIN = '1234';
export const MANAGER_PIN = '9876';

/** A cashier (SELL allow; the rest by the legacy role) and a shop manager. */
export function roster(): Array<Record<string, unknown>> {
  return [
    { id: 'u-cashier', username: 'dana', firstName: 'דנה', lastName: 'כהן', pinHash: bcrypt.hashSync(PIN, 4), role: 'cashier', isActive: true, shopId: null },
    { id: 'u-manager', username: 'avi', firstName: 'אבי', lastName: 'לוי', pinHash: bcrypt.hashSync(MANAGER_PIN, 4), role: 'shop_manager', isActive: true, shopId: null },
  ];
}

export function harness(o: HarnessOptions = {}): Harness {
  const sent: Harness['sent'] = [];
  const answers: Record<string, ((body: Record<string, unknown> | null) => unknown) | undefined> = { ...(o.answers ?? {}) };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const p = url.pathname.replace(/^\/(api\/v1\/)?/, '').replace(MACHINE, 'm');
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    sent.push({ method, path: p, body });
    const key = `${method} ${p}`;
    // An exact route first, then a `…/*` prefix.
    const a = answers[key] ?? Object.entries(answers).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    return new Response(JSON.stringify(a ? a(body) : {}), { status: a ? 200 : 404, headers: { 'Content-Type': 'application/json' } });
  };
  const terminal = new FakeTerminal();
  const printer = { ...noPrinter, sent: [] as Uint8Array[] };
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-till-')),
    appVersion: '0.5.0',
    deviceInfo: { platform: 'windows' },
    transport: printer,
    fetch: fetchFn,
    providers: [() => terminal],
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '' });
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קופה 2', posNumber: '2', documentPrefix: null, shopName: 'הרצליה', companyName: 'בדיקה בע״מ', deviceRole: 'till', fiscal: true, shopId: SHOP });
  svc.cloud.setSettings({ settings: { globalTaxRate: 18, ...(o.settings ?? {}) }, businessInfo: { companyName: 'בדיקה בע״מ', vatNumber: '514000000', dealerType: o.dealerType ?? 'company' }, settingsUpdatedAt: null, serverTime: null });
  svc.cloud.setParameters(o.parameters ?? {}, null);
  svc.cloud.setHeartbeat({ zMode: o.zMode ?? 'cloud', lastTillZNumber: null, tillZEpoch: 0, independentTill: o.independent === true, lastOkAt: Date.now(), serverTime: null });
  svc.cloud.applyCatalog({
    syncType: 'full',
    products: o.catalog?.products ?? o.products ?? PRODUCTS,
    categories: o.catalog?.categories ?? [
      { id: 'c-main', name: 'מנות', isActive: true },
      { id: 'c-drink', name: 'שתייה', isActive: true },
    ],
    menu: o.catalog?.menu ?? null,
    machineCatalog: { mode: 'all' },
    serverTime: 'x',
  });
  if (o.promotions) svc.cloud.setPromotions(o.promotions, null);
  svc.cloud.applyPosUsers({ syncType: 'full', users: o.users ?? roster(), serverTime: 't' });
  svc.applyProvider();
  const engine = new KioskCoreTillEngine({ svc, compare: (p, h) => bcrypt.compare(p, h), workMode: () => o.workMode ?? null, now: o.now });
  const states: TillState[] = [];
  const events: EngineEvent[] = [];
  engine.on((e) => {
    events.push(e);
    if (e.ev === 'state') states.push(e.data as TillState);
  });
  let n = 0;
  const call = (op: TillOp, args: Record<string, unknown> = {}) => {
    n += 1;
    return engine.call({ id: n, op, args, clientOpId: `op-${n}` });
  };
  return {
    svc,
    engine,
    terminal,
    printer,
    sent,
    states,
    events,
    call,
    ok: async <T,>(op: TillOp, args?: Record<string, unknown>) => {
      const r = await call(op, args);
      if (!r.ok) throw new Error(`${op} refused: ${r.error.code} ${r.error.message}`);
      return r.value as T;
    },
    fail: async (op, args) => {
      const r = await call(op, args);
      if (r.ok) throw new Error(`${op} was accepted`);
      return r.error;
    },
    state: () => engine.snapshot(),
    stop: () => {
      engine.stop();
      svc.stop();
    },
  };
}

/** Signed in as the cashier with a shift open (float ₪200). */
export async function readyTill(o: HarnessOptions = {}, pin = PIN, openingAgorot = 20_000): Promise<Harness> {
  const h = harness(o);
  await h.ok('session.login', { pin });
  await h.ok('shift.open', { openingCashAgorot: openingAgorot });
  return h;
}
