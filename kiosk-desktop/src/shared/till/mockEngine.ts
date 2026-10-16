/**
 * The mock till engine (S0-2 / S0-6): what the screens and the shells talk to until the real
 * engine (`:pos-core` + `:till-engine`, P0) speaks the protocol. It keeps the protocol's rules —
 * the state comes from here with a rising `seq`, every changing op needs a `clientOpId` and is
 * never applied twice, an engine dialog is part of the state, hardware is asked of the HOST
 * (`hw` events) — but it is NOT fiscal: in demo mode nothing it issues is a document, and it never
 * produces a Z.
 *
 * Pure TypeScript (no DOM, no Node): the browser demo runs it in the page, the Windows shell in
 * its main process behind IPC (main/roles/till.ts).
 */

import { job, type MonoBitmap } from '../../core/escpos';
import { bytesToBase64 } from './bytes';
import { demoCatalog } from './catalogDemo';
import {
  engineError,
  MUTATING_OPS,
  TILL_OPS,
  TILL_PROTOCOL,
  type CartLine,
  type Catalog,
  type DeviceRoleName,
  type EngineCall,
  type EngineEndpoint,
  type EngineError,
  type EngineEvent,
  type EngineReply,
  type HelloReply,
  type HwJobKind,
  type HwRequest,
  type HwResult,
  type OpArgs,
  type TillErrorCode,
  type TillOp,
  type TillState,
  type XReport,
  tillBusy,
} from './protocol';

export const DEMO_MANAGER_PIN = '1234';
/** A line discount above this needs a manager (as the till's DISCOUNT limit would). */
export const CASHIER_DISCOUNT_MAX_PCT = 20;
export const VAT_PCT = 18;
const REMEMBER_OPS = 500;

export interface MockEngineOptions {
  catalog?: Catalog;
  /** A (simulated) card terminal is there; without one `checkout.card` is refused. */
  terminal?: boolean;
  /** Where receipts go (`hw.print`); null: no printer. */
  printerTarget?: string | null;
  /** The drawer's printer (`hw.drawer`); null: no drawer. */
  drawerTarget?: string | null;
  cardDelayMs?: number;
  role?: DeviceRoleName;
  rolesAllowed?: DeviceRoleName[];
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => void;
}

class Refusal extends Error {
  constructor(readonly error: EngineError) {
    super(error.code);
  }
}

const refuse = (code: TillErrorCode, details?: Record<string, unknown>): never => {
  throw new Refusal(engineError(code, details));
};

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/** VAT inside a total (agorot), half up. */
export function vatOf(totalAgorot: number, pct = VAT_PCT): number {
  return Math.floor((totalAgorot * pct) / (100 + pct) + 0.5);
}

export function lineTotal(qty: number, unitAgorot: number, discountPct: number): number {
  return Math.floor((qty * unitAgorot * (100 - discountPct)) / 100 + 0.5);
}

/** A small recognisable raster for the demo receipt (the real engine draws the receipt, §3.5). */
function demoReceiptBitmap(lines: number): MonoBitmap {
  const width = 576;
  const height = 48 + lines * 24;
  const rowBytes = width / 8;
  const data = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const border = y < 4 || y >= height - 4;
    for (let b = 0; b < rowBytes; b++) {
      if (border || b === 0 || b === rowBytes - 1) data[y * rowBytes + b] = 0xff;
      else if (y >= 24 && (y - 24) % 24 < 3 && b > 4 && b < rowBytes - 5) data[y * rowBytes + b] = 0xff;
    }
  }
  return { width, height, rowBytes, data };
}

export function initialState(o: { role: DeviceRoleName; rolesAllowed: DeviceRoleName[]; terminal: boolean; printer: boolean; catalogVersion: number; nowIso: string }): TillState {
  return {
    protocol: TILL_PROTOCOL,
    session: { cashier: { id: 'demo-cashier', name: 'קופאי הדגמה' }, locked: false, permissions: ['SELL', 'SHIFT_OPEN', 'SHIFT_CLOSE', 'REPORT_X'], demo: true },
    sell: { catalogVersion: o.catalogVersion, departmentId: null, search: '', lines: [], itemCount: 0, totalAgorot: 0, vatAgorot: 0 },
    checkout: { phase: 'idle', totalAgorot: 0, paidAgorot: 0, dueAgorot: 0, changeAgorot: 0, legs: [], documentRef: null },
    shift: { open: true, number: 1, openedAt: o.nowIso, openingCashAgorot: 20_000, salesCount: 0, salesAgorot: 0, cashAgorot: 0, cardAgorot: 0 },
    z: { lastNumber: null, canProduce: false, reason: 'Z לא מופק במצב הדגמה — רק במנוע אמיתי, אחרי אישור הבעלים' },
    health: { cloud: 'demo', printer: o.printer ? 'ok' : 'none', terminal: o.terminal ? 'ok' : 'none', outbox: 0 },
    dialog: null,
    mode: { role: o.role, current: o.role, rolesAllowed: o.rolesAllowed.slice() },
  };
}

export class MockTillEngine implements EngineEndpoint {
  private seq = 1;
  private st: TillState;
  private readonly catalog: Catalog;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly applied = new Map<string, EngineReply>();
  private dirty = false;
  private lineSeq = 0;
  private docSeq = 0;
  private dialogSeq = 0;
  private hwSeq = 0;
  private pendingDiscount: { lineId: string; pct: number } | null = null;
  private readonly hwPending = new Map<string, HwRequest>();
  private readonly docs: Array<{ id: string; ref: string; totalAgorot: number; at: string }> = [];
  /** The host's answers to `hw.*`, last first (tests, the technician view). */
  readonly hwResults: HwResult[] = [];
  private hostIdle = { idle: true, busy: false };

  constructor(private readonly o: MockEngineOptions = {}) {
    this.catalog = o.catalog ?? demoCatalog();
    this.st = initialState({
      role: o.role ?? 'till',
      rolesAllowed: o.rolesAllowed ?? [],
      terminal: o.terminal === true,
      printer: !!o.printerTarget,
      catalogVersion: this.catalog.version,
      nowIso: new Date(this.now()).toISOString(),
    });
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private schedule(fn: () => void, ms: number) {
    if (this.o.schedule) this.o.schedule(fn, ms);
    else setTimeout(fn, ms);
  }

  /* ----------------------------------------------------------- the endpoint */

  hello(_since?: number): HelloReply {
    // A mock keeps no history: always the full state (the protocol allows it).
    return { protocol: TILL_PROTOCOL, seq: this.seq, state: this.snapshot() };
  }

  snapshot(): TillState {
    return JSON.parse(JSON.stringify(this.st)) as TillState;
  }

  get currentSeq(): number {
    return this.seq;
  }

  get hostReportsIdle(): { idle: boolean; busy: boolean } {
    return { ...this.hostIdle };
  }

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(ev: EngineEvent['ev'], data: unknown) {
    const e: EngineEvent = { ev, seq: this.seq, data };
    for (const fn of Array.from(this.listeners)) fn(e);
  }

  private commit() {
    if (!this.dirty) return;
    this.dirty = false;
    this.seq += 1;
    this.emit('state', this.snapshot());
  }

  async call(c: EngineCall): Promise<EngineReply> {
    if (!(TILL_OPS as readonly string[]).includes(c.op)) return { id: c.id, ok: false, error: engineError('unknown_op') };
    const mutating = MUTATING_OPS.has(c.op);
    if (mutating) {
      if (!c.clientOpId) return { id: c.id, ok: false, error: engineError('missing_client_op_id') };
      const before = this.applied.get(c.clientOpId);
      if (before) return { ...before, id: c.id };
    }
    let reply: EngineReply;
    try {
      const value = this.apply(c.op, (c.args ?? {}) as Record<string, unknown>);
      reply = value === undefined ? { id: c.id, ok: true } : { id: c.id, ok: true, value };
    } catch (e) {
      reply = { id: c.id, ok: false, error: e instanceof Refusal ? e.error : engineError('invalid_args') };
    }
    if (mutating && c.clientOpId) {
      this.applied.set(c.clientOpId, reply);
      if (this.applied.size > REMEMBER_OPS) this.applied.delete(this.applied.keys().next().value as string);
    }
    this.commit();
    return reply;
  }

  /* -------------------------------------------------------------- the ops */

  private apply(op: TillOp, a: Record<string, unknown>): unknown {
    switch (op) {
      case 'session.hello':
        return this.hello(typeof a.since === 'number' ? a.since : undefined);
      case 'session.login':
        return this.login(a as unknown as OpArgs['session.login']);
      case 'session.logout':
        if (tillBusy(this.st)) refuse('checkout_busy');
        this.st.session = { ...this.st.session, cashier: null, locked: true, permissions: [] };
        this.dirty = true;
        return undefined;
      case 'catalog.snapshot':
        return JSON.parse(JSON.stringify(this.catalog)) as Catalog;
      case 'sell.add':
        return this.add(a as unknown as OpArgs['sell.add']);
      case 'sell.setQty':
        return this.setQty(a as unknown as OpArgs['sell.setQty']);
      case 'sell.remove':
        this.editable();
        this.st.sell.lines = this.st.sell.lines.filter((l) => l.lineId !== a.lineId);
        this.retotal();
        return undefined;
      case 'sell.discount':
        return this.discount(a as unknown as OpArgs['sell.discount']);
      case 'sell.clear':
        this.editable();
        this.st.sell.lines = [];
        this.retotal();
        return undefined;
      case 'sell.department':
        if (a.departmentId !== null && !this.catalog.departments.some((d) => d.id === a.departmentId)) refuse('invalid_args');
        this.st.sell.departmentId = (a.departmentId as string | null) ?? null;
        this.dirty = true;
        return undefined;
      case 'sell.search':
        if (typeof a.text !== 'string' || a.text.length > 60) refuse('invalid_args');
        this.st.sell.search = a.text as string;
        this.dirty = true;
        return undefined;
      case 'checkout.start':
        return this.checkoutStart();
      case 'checkout.cash':
        return this.cash(a as unknown as OpArgs['checkout.cash']);
      case 'checkout.card':
        return this.card(a as unknown as OpArgs['checkout.card']);
      case 'checkout.cancel':
        return this.checkoutCancel();
      case 'checkout.finish':
        if (this.st.checkout.phase !== 'done') refuse('invalid_args');
        this.st.sell.lines = [];
        this.retotal();
        this.st.checkout = { phase: 'idle', totalAgorot: 0, paidAgorot: 0, dueAgorot: 0, changeAgorot: 0, legs: [], documentRef: null };
        return undefined;
      case 'dialog.answer':
        return this.answer(a as unknown as OpArgs['dialog.answer']);
      case 'doc.history':
        return this.docs.slice(-50).reverse();
      case 'doc.reprint': {
        const doc = this.docs.find((d) => d.id === a.documentId);
        if (!doc) refuse('invalid_args');
        this.print('receipt', 6);
        return undefined;
      }
      case 'doc.refund':
        return refuse('not_implemented');
      case 'shift.open':
        return this.shiftOpen(a as unknown as OpArgs['shift.open']);
      case 'shift.close':
        return this.shiftClose(a as unknown as OpArgs['shift.close']);
      case 'report.x': {
        const x = this.xReport();
        this.print('report', 8);
        return x;
      }
      case 'z.produce':
        return refuse('z_not_in_demo');
      case 'mode.switch':
        return this.modeSwitch(a as unknown as OpArgs['mode.switch']);
      case 'host.idle':
        this.hostIdle = { idle: a.idle === true, busy: a.busy === true };
        return undefined;
      case 'hw.result':
        return this.hwResult(a as unknown as HwResult);
    }
    return refuse('unknown_op');
  }

  private signedIn() {
    if (!this.st.session.cashier || this.st.session.locked) refuse('permission_denied');
  }

  /** The cart may change: signed in, no payment open. */
  private editable() {
    this.signedIn();
    if (this.st.checkout.phase !== 'idle') refuse('checkout_busy');
  }

  private login(a: OpArgs['session.login']) {
    if (typeof a.pin !== 'string' || !/^\d{4,8}$/.test(a.pin)) refuse('wrong_pin');
    const manager = a.pin === DEMO_MANAGER_PIN;
    this.st.session = {
      cashier: manager ? { id: 'demo-manager', name: 'מנהלת הדגמה' } : { id: 'demo-cashier', name: 'קופאי הדגמה' },
      locked: false,
      permissions: manager ? ['SELL', 'SHIFT_OPEN', 'SHIFT_CLOSE', 'REPORT_X', 'DISCOUNT_ANY'] : ['SELL', 'SHIFT_OPEN', 'SHIFT_CLOSE', 'REPORT_X'],
      demo: true,
    };
    this.dirty = true;
    return { cashier: this.st.session.cashier };
  }

  private add(a: OpArgs['sell.add']) {
    this.editable();
    const qty = a.qty ?? 1;
    if (!isInt(qty, 1, 999)) refuse('invalid_args');
    const p = this.catalog.products.find((x) => x.id === a.productId);
    if (!p) return refuse('invalid_args');
    const same = this.st.sell.lines.find((l) => l.productId === p.id && l.discountPct === 0);
    if (same) same.qty = Math.min(999, same.qty + qty);
    else {
      this.lineSeq += 1;
      const line: CartLine = { lineId: `l${this.lineSeq}`, productId: p.id, name: p.name, qty, unitAgorot: p.priceAgorot, discountPct: 0, totalAgorot: 0 };
      this.st.sell.lines.push(line);
    }
    this.retotal();
    return undefined;
  }

  private setQty(a: OpArgs['sell.setQty']) {
    this.editable();
    if (!isInt(a.qty, 0, 999)) refuse('invalid_args');
    const line = this.st.sell.lines.find((l) => l.lineId === a.lineId);
    if (!line) refuse('invalid_args');
    if (a.qty === 0) this.st.sell.lines = this.st.sell.lines.filter((l) => l.lineId !== a.lineId);
    else line!.qty = a.qty;
    this.retotal();
    return undefined;
  }

  private discount(a: OpArgs['sell.discount']) {
    this.editable();
    if (!isInt(a.pct, 0, 100)) refuse('invalid_args');
    const line = this.st.sell.lines.find((l) => l.lineId === a.lineId);
    if (!line) refuse('invalid_args');
    if (a.pct > CASHIER_DISCOUNT_MAX_PCT && !this.st.session.permissions.includes('DISCOUNT_ANY')) {
      // The flow stays the engine's: it asks for the manager, the screen only shows the dialog.
      this.dialogSeq += 1;
      this.pendingDiscount = { lineId: a.lineId, pct: a.pct };
      this.st.dialog = {
        id: `d${this.dialogSeq}`,
        kind: 'manager_approval',
        title: 'נדרש אישור מנהל',
        body: `הנחה של ${a.pct}% על "${line!.name}" — מעל ${CASHIER_DISCOUNT_MAX_PCT}% שמותרים לקופאי`,
        fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
        actions: [
          { id: 'approve', label: 'אישור', primary: true },
          { id: 'cancel', label: 'ביטול' },
        ],
      };
      this.dirty = true;
      return { dialogId: this.st.dialog.id };
    }
    line!.discountPct = a.pct;
    this.retotal();
    return undefined;
  }

  private answer(a: OpArgs['dialog.answer']) {
    const d = this.st.dialog;
    if (!d || d.id !== a.dialogId) refuse('invalid_args');
    if (a.action === 'cancel') {
      this.st.dialog = null;
      this.pendingDiscount = null;
      this.dirty = true;
      return undefined;
    }
    if (a.action !== 'approve') refuse('invalid_args');
    if (a.answers?.pin !== DEMO_MANAGER_PIN) refuse('wrong_pin');
    const p = this.pendingDiscount;
    const line = p ? this.st.sell.lines.find((l) => l.lineId === p.lineId) : undefined;
    if (p && line) line.discountPct = p.pct;
    this.pendingDiscount = null;
    this.st.dialog = null;
    this.retotal();
    return undefined;
  }

  private retotal() {
    let total = 0;
    let count = 0;
    for (const l of this.st.sell.lines) {
      l.totalAgorot = lineTotal(l.qty, l.unitAgorot, l.discountPct);
      total += l.totalAgorot;
      count += l.qty;
    }
    this.st.sell.totalAgorot = total;
    this.st.sell.itemCount = count;
    this.st.sell.vatAgorot = vatOf(total);
    this.dirty = true;
  }

  private checkoutStart() {
    this.signedIn();
    if (this.st.sell.lines.length === 0) refuse('cart_empty');
    if (!this.st.shift.open) refuse('shift_closed');
    if (this.st.checkout.phase !== 'idle') refuse('checkout_busy');
    const total = this.st.sell.totalAgorot;
    this.st.checkout = { phase: 'tender', totalAgorot: total, paidAgorot: 0, dueAgorot: total, changeAgorot: 0, legs: [], documentRef: null };
    this.dirty = true;
    return undefined;
  }

  private cash(a: OpArgs['checkout.cash']) {
    if (this.st.checkout.phase !== 'tender') refuse('invalid_args');
    if (!isInt(a.amountAgorot, 1, 100_000_000)) refuse('invalid_args');
    const c = this.st.checkout;
    c.legs.push({ method: 'cash', amountAgorot: a.amountAgorot, status: 'approved' });
    c.paidAgorot += a.amountAgorot;
    this.settle();
    return undefined;
  }

  private card(a: OpArgs['checkout.card']) {
    if (this.st.checkout.phase !== 'tender') refuse('invalid_args');
    if (this.st.health.terminal === 'none') refuse('terminal_unavailable');
    const c = this.st.checkout;
    const amount = a.amountAgorot ?? c.dueAgorot;
    if (!isInt(amount, 1, c.dueAgorot)) refuse('invalid_args');
    // The pending leg is in the state before the terminal is asked (no charge without a trace).
    c.legs.push({ method: 'card', amountAgorot: amount, status: 'pending' });
    c.phase = 'card_waiting';
    this.st.health.terminal = 'busy';
    this.dirty = true;
    this.schedule(() => {
      const leg = this.st.checkout.legs.find((l) => l.method === 'card' && l.status === 'pending');
      if (!leg) return;
      leg.status = 'approved';
      this.st.checkout.paidAgorot += leg.amountAgorot;
      this.st.checkout.phase = 'tender';
      this.st.health.terminal = 'ok';
      this.settle();
      this.commit();
    }, this.o.cardDelayMs ?? 1500);
    return undefined;
  }

  private settle() {
    const c = this.st.checkout;
    c.dueAgorot = Math.max(0, c.totalAgorot - c.paidAgorot);
    this.dirty = true;
    if (c.paidAgorot < c.totalAgorot) return;
    c.changeAgorot = c.paidAgorot - c.totalAgorot;
    c.phase = 'done';
    this.docSeq += 1;
    c.documentRef = `הדגמה-${this.docSeq}`;
    const card = c.legs.filter((l) => l.method === 'card').reduce((s, l) => s + l.amountAgorot, 0);
    const s = this.st.shift;
    s.salesCount += 1;
    s.salesAgorot += c.totalAgorot;
    s.cardAgorot += card;
    s.cashAgorot += c.totalAgorot - card;
    this.docs.push({ id: `doc${this.docSeq}`, ref: c.documentRef, totalAgorot: c.totalAgorot, at: new Date(this.now()).toISOString() });
    if (c.legs.some((l) => l.method === 'cash') && this.o.drawerTarget) this.hw({ type: 'hw.drawer', requestId: this.nextHw(), target: this.o.drawerTarget });
    this.print('receipt', Math.min(20, this.st.sell.lines.length + 4));
  }

  private checkoutCancel() {
    const c = this.st.checkout;
    if (c.phase === 'card_waiting') refuse('card_in_flight');
    if (c.phase !== 'tender') refuse('invalid_args');
    if (c.legs.some((l) => l.method === 'card')) refuse('card_in_flight');
    this.st.checkout = { phase: 'idle', totalAgorot: 0, paidAgorot: 0, dueAgorot: 0, changeAgorot: 0, legs: [], documentRef: null };
    this.dirty = true;
    return undefined;
  }

  private shiftOpen(a: OpArgs['shift.open']) {
    this.signedIn();
    if (this.st.shift.open) refuse('shift_open');
    if (!isInt(a.openingCashAgorot, 0, 100_000_000)) refuse('invalid_args');
    this.st.shift = {
      open: true,
      number: (this.st.shift.number ?? 0) + 1,
      openedAt: new Date(this.now()).toISOString(),
      openingCashAgorot: a.openingCashAgorot,
      salesCount: 0,
      salesAgorot: 0,
      cashAgorot: 0,
      cardAgorot: 0,
    };
    this.dirty = true;
    return undefined;
  }

  private shiftClose(a: OpArgs['shift.close']) {
    this.signedIn();
    if (!this.st.shift.open) refuse('shift_closed');
    if (tillBusy(this.st)) refuse('checkout_busy');
    if (!isInt(a.countedCashAgorot, 0, 100_000_000)) refuse('invalid_args');
    const x = this.xReport();
    this.st.shift = { ...this.st.shift, open: false };
    this.dirty = true;
    return { ...x, countedCashAgorot: a.countedCashAgorot, differenceAgorot: a.countedCashAgorot - x.expectedCashAgorot };
  }

  private xReport(): XReport {
    const s = this.st.shift;
    return {
      shiftNumber: s.number,
      salesCount: s.salesCount,
      salesAgorot: s.salesAgorot,
      cashAgorot: s.cashAgorot,
      cardAgorot: s.cardAgorot,
      expectedCashAgorot: s.openingCashAgorot + s.cashAgorot,
      demo: true,
    };
  }

  private modeSwitch(a: OpArgs['mode.switch']) {
    const to = a.to;
    if (!this.st.mode.rolesAllowed.includes(to)) refuse('role_not_allowed');
    if (tillBusy(this.st)) refuse('mode_switch_busy');
    const fiscal = to === 'till' || to === 'kiosk';
    if (!fiscal && this.st.shift.open) refuse('role_switch_open_shift');
    this.st.mode = { ...this.st.mode, current: to };
    this.dirty = true;
    return undefined;
  }

  /* ------------------------------------------------------------- hardware */

  private nextHw(): string {
    this.hwSeq += 1;
    return `hw${this.hwSeq}`;
  }

  private hw(req: HwRequest) {
    this.hwPending.set(req.requestId, req);
    this.emit('hw', req);
  }

  private print(kind: HwJobKind, lines: number) {
    if (!this.o.printerTarget) return;
    const requestId = this.nextHw();
    this.hw({ type: 'hw.print', requestId, jobId: `job-${requestId}`, target: this.o.printerTarget, kind, bytesB64: bytesToBase64(job(demoReceiptBitmap(lines))) });
  }

  private hwResult(r: HwResult) {
    if (!r || typeof r.requestId !== 'string') refuse('invalid_args');
    const req = this.hwPending.get(r.requestId);
    if (!req) return undefined;
    this.hwPending.delete(r.requestId);
    this.hwResults.unshift(r);
    if (this.hwResults.length > 50) this.hwResults.pop();
    if (req.type === 'hw.print' || req.type === 'hw.drawer') {
      const next = r.ok ? 'ok' : 'error';
      if (this.st.health.printer !== next) {
        this.st.health.printer = next;
        this.dirty = true;
      }
      if (!r.ok) this.emit('toast', { tone: 'error', text: `${req.type === 'hw.drawer' ? 'המגירה' : 'ההדפסה'} נכשלה: ${r.message ?? r.code ?? ''}`.trim() });
    }
    return undefined;
  }
}
