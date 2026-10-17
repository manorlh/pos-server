/**
 * "תשלום בקופה" with no cloud — the shop's LAN host (docs/SPEC_KIOSK.md §23; the Android kiosk's
 * KioskPayAtTillKiosk.lanRound / KioskLanOpenOrders, pos-android data/repo/KioskPayAtTill.kt):
 *
 *  - the cloud away (or refusing), an order to pay at the till is handed to the shop's print server
 *    ("שרת הדפסות", the till that runs the LAN server on 8399) — `POST /kiosk/open-orders` with the
 *    shop's print secret (`Authorization: Bearer …`), the body `{kioskMachineId, kioskName, orders}`;
 *    the host's till lists it, takes the money with its own document and tells the kiosk what it did
 *    (`states`: paid / cancelled there) on the next hand-over;
 *  - where the host is and the secret come from the cloud while it is there (`GET /sync/{m}/printers`:
 *    `printHost`, `printSecret`) and are kept for the offline days. An independent kiosk gets no LAN
 *    address there (printers.print_host_block), so it never hands anything over the LAN;
 *  - when the cloud is back the kiosk uploads the order with what the LAN till did with it, so a paid
 *    one is never listed open again (KioskOpenOrderIn `state` / `paidByName` / …).
 *
 * Pure: the shapes on the wire and the rules. The socket is main/kiosk/lanClient.ts.
 */

import { openOrderWire, type OpenOrder } from '@dash-lib/kioskWebOrders';

/** The LAN server's port when the cloud names none (pos-android KitchenLan.kt DEFAULT_LAN_PORT). */
export const DEFAULT_LAN_PORT = 8399;
/** The host's route for kiosks' open orders (KioskLanOpenOrders.PATH). */
export const LAN_OPEN_ORDERS_PATH = '/kiosk/open-orders';
/** As the Android kiosk asks it: a short knock, a short answer. */
export const LAN_CONNECT_MS = 1_200;
export const LAN_READ_MS = 4_000;

export interface LanHost {
  address: string;
  port: number;
  machineId: string | null;
  name: string | null;
}

export interface LanTarget extends LanHost {
  secret: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * The shop's LAN host as `GET /sync/{m}/printers` gives it to this kiosk: the print server — never this
 * device itself, and only with a LAN address (an independent kiosk's has none) — and the shop's secret.
 * Null: no LAN to hand orders to.
 */
export function lanTargetOf(printers: unknown): LanTarget | null {
  if (!printers || typeof printers !== 'object') return null;
  const p = printers as { printHost?: unknown; printSecret?: unknown };
  const secret = str(p.printSecret);
  const h = p.printHost && typeof p.printHost === 'object' ? (p.printHost as Record<string, unknown>) : null;
  if (!h || !secret || h.isSelf === true || h.offLan === true) return null;
  const address = str(h.lanAddress);
  if (!address) return null;
  const port = typeof h.port === 'number' && Number.isInteger(h.port) && h.port > 0 && h.port < 65536 ? h.port : DEFAULT_LAN_PORT;
  return { address, port, secret, machineId: str(h.machineId), name: str(h.name) };
}

/**
 * The body the LAN host takes: the cloud's shape of each order (it reads it as KioskOpenOrder.fromJson) and when it was taken.
 * `kioskAreaId`: the kiosk's point of sale — a till locked to its point of sale (`areaScopeLock`) lists only its own
 * kiosks' orders, as the Android kiosk says it (KioskPayAtTill.kt); null — the whole shop's.
 */
export function lanOrdersBody(
  kioskMachineId: string,
  kioskName: string | null,
  orders: readonly OpenOrder[],
  kioskAreaId: string | null = null,
): Record<string, unknown> {
  return {
    kioskMachineId,
    kioskName,
    kioskAreaId,
    orders: orders.map((o) => ({ ...openOrderWire(o), createdAtMs: o.createdAtMs })),
  };
}

export type LanOrderState = 'open' | 'paid' | 'cancelled';

/** What the LAN host's till did with an order, as it said (kept until the cloud has it). */
export interface LanRecord {
  /** When the host first took it. */
  at: number;
  state: LanOrderState;
  paidBy: string | null;
  transactionId: string | null;
  transactionNumber: string | null;
  paidAt: string | null;
  closeReason: string | null;
}

/** The host's answer (`{ok, states: {localId: {state, paidBy, transactionId, transactionNumber, paidAt, closeReason}}}`). */
export function lanStatesOf(body: unknown): Map<string, Omit<LanRecord, 'at'>> {
  const out = new Map<string, Omit<LanRecord, 'at'>>();
  const states = body && typeof body === 'object' ? (body as { states?: unknown }).states : null;
  if (!states || typeof states !== 'object') return out;
  for (const [id, raw] of Object.entries(states as Record<string, unknown>)) {
    const s = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const state = typeof s.state === 'string' ? s.state.trim().toLowerCase() : '';
    out.set(id, {
      // An expired order is open to the cloud (pos-android KioskOpenOrder.wire); anything unknown too.
      state: state === 'paid' || state === 'cancelled' ? state : 'open',
      paidBy: str(s.paidBy),
      transactionId: str(s.transactionId),
      transactionNumber: str(s.transactionNumber),
      paidAt: str(s.paidAt),
      closeReason: str(s.closeReason),
    });
  }
  return out;
}

/** The record after the host's word: a paid / cancelled order never goes back to open (the host keeps the first close). */
export function nextLanRecord(prev: LanRecord | null, said: Omit<LanRecord, 'at'> | null, nowMs: number): LanRecord {
  const base: LanRecord = prev ?? { at: nowMs, state: 'open', paidBy: null, transactionId: null, transactionNumber: null, paidAt: null, closeReason: null };
  if (!said || said.state === 'open' || base.state !== 'open') return base;
  return { ...base, ...said, at: base.at };
}

const cut = (v: string | null, max: number): string | null => (v ? v.slice(0, max) : null);

/**
 * The cloud's wire of an order a LAN till already took (KioskOpenOrderIn): `paid` / `cancelled` with what that till said,
 * within the schema's limits — a value the cloud would refuse (a malformed time) is left out, never the order refused for it.
 */
export function withLanState(wire: Record<string, unknown>, lan: LanRecord | null): Record<string, unknown> {
  if (!lan || lan.state === 'open') return wire;
  const paidAt = lan.paidAt && Number.isFinite(Date.parse(lan.paidAt)) ? lan.paidAt : null;
  return {
    ...wire,
    state: lan.state,
    paidByName: cut(lan.paidBy, 200),
    paidTransactionId: cut(lan.transactionId, 64),
    paidTransactionNumber: cut(lan.transactionNumber, 64),
    paidAt,
    closeReason: cut(lan.closeReason, 300),
  };
}
