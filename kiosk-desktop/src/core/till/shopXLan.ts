/**
 * "דוח X סניפי" built over the LAN (P:/specs/shop-x-report.md §2.4–§2.5, §7) — the participating till's side (pos-android
 * domain/ShopXLan.kt, data/repo/LocalShopZRepository.kt `LanShopCloseClient.pollOnce` / `answerShopX`,
 * data/repo/ShopXLocal.kt `ownShopXPart`):
 *
 *  - the shop's main till builds the shop X itself when the shop Z is made locally (`remote_shop_z`, no cloud); it never calls
 *    the other tills — it asks on the shop-close board every till already polls: `GET /shop-close/pending?machineId=…` answers
 *    `shopX: {requestId}` while a round is live, and each till posts its part to `POST /shop-x/v1/part`;
 *  - the part is this till's figures since its last Z — the closed shifts no Z took and the open shift's interim X — as one
 *    LanTillSection (`till` in shekels, as the local shop Z sums it); nothing is stored, nothing closed;
 *  - the Windows till closes through the cloud in every shop Z (pos-server `closes_through_cloud`: a Windows device is always
 *    "remote"), so the board never hands it a LAN close: it polls only while the cloud's history lists it so, and answers only
 *    the shop X's ask.
 *
 * Pure: the board's answer in, the part out.
 */

/** The board's path, with who asks (blank fields left out). */
export function pendingPath(machineId: string, posNumber: string | null, name: string | null): string {
  const q = [`machineId=${encodeURIComponent(machineId)}`];
  if (posNumber && posNumber.trim()) q.push(`posNumber=${encodeURIComponent(posNumber.trim())}`);
  if (name && name.trim()) q.push(`name=${encodeURIComponent(name.trim())}`);
  return `/shop-close/pending?${q.join('&')}`;
}

export const SHOP_X_PART_PATH = '/shop-x/v1/part';

/** The board's `shopX.requestId` (the round's id), when a round is asking. */
export function shopXAskOf(body: unknown): string | null {
  const x = body && typeof body === 'object' ? (body as { shopX?: unknown }).shopX : null;
  const id = x && typeof x === 'object' ? (x as { requestId?: unknown }).requestId : null;
  return typeof id === 'string' && id.trim() ? id.trim() : null;
}

/**
 * The cloud's shop-Z history says this till answers the main till's shop X over the LAN: the shop's Z is local, the main till
 * is another, and this till is one of its participants set to close through the cloud (never a LAN close).
 */
export function answersShopXOverLan(history: unknown, me: string | null): boolean {
  if (!me || !history || typeof history !== 'object') return false;
  const h = history as Record<string, unknown>;
  if (h.localMode !== true) return false;
  const main = h.mainTill && typeof h.mainTill === 'object' ? (h.mainTill as { machineId?: unknown }).machineId : null;
  if (typeof main !== 'string' || !main || main === me) return false;
  const parts = Array.isArray(h.participants) ? h.participants : [];
  return parts.some((p) => !!p && typeof p === 'object' && (p as { machineId?: unknown }).machineId === me && (p as { remote?: unknown }).remote === true);
}

/** One shift's figures, in shekels, as a close (`close_payload.till`) or an interim X has them. */
export interface TillFigures {
  totalSales?: number;
  totalDiscounts?: number;
  totalRefunds?: number;
  totalCash?: number;
  totalCard?: number;
  totalExchange?: number;
  totalTips?: number;
  vatTotal?: number;
  transactionsCount?: number;
}

const ag = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) : 0);

/** The figures of [tills] summed as the local shop Z sums them (to agorot first, HALF_UP), back in shekels. */
export function sumFigures(tills: readonly TillFigures[]): Required<TillFigures> {
  const sum = (k: keyof TillFigures) => tills.reduce((a, t) => a + ag(t[k]), 0) / 100;
  return {
    totalSales: sum('totalSales'),
    totalDiscounts: sum('totalDiscounts'),
    totalRefunds: sum('totalRefunds'),
    totalCash: sum('totalCash'),
    totalCard: sum('totalCard'),
    totalExchange: sum('totalExchange'),
    totalTips: sum('totalTips'),
    vatTotal: sum('vatTotal'),
    transactionsCount: tills.reduce((a, t) => a + (typeof t.transactionsCount === 'number' ? Math.trunc(t.transactionsCount) : 0), 0),
  };
}

/** This till's part (LanTillSection): its shifts since the last Z; no shift — `till: null`. */
export function ownShopXSection(
  me: { machineId: string; posNumber: string | null; machineName: string | null },
  shifts: ReadonlyArray<{ id: string; businessDate: string | null; till: TillFigures }>,
): Record<string, unknown> {
  const dates = shifts.map((s) => s.businessDate).filter((d): d is string => !!d).sort();
  return {
    machineId: me.machineId,
    posNumber: me.posNumber,
    machineName: me.machineName,
    shiftIds: shifts.map((s) => s.id),
    firstBusinessDate: dates[0] ?? null,
    lastBusinessDate: dates[dates.length - 1] ?? null,
    firstDocumentNumber: null,
    lastDocumentNumber: null,
    till: shifts.length === 0 ? null : sumFigures(shifts.map((s) => s.till)),
    report: { machineId: me.machineId, posNumber: me.posNumber, machineName: me.machineName, shiftIds: shifts.map((s) => s.id), shiftCount: shifts.length },
    manifest: null,
    late: false,
    label: null,
  };
}

/** The answer posted to the board (LanShopXPart.toJson). */
export function shopXPart(requestId: string, machineId: string, section: Record<string, unknown> | null, error: string | null): Record<string, unknown> {
  return { requestId, machineId, section, error: error && error.trim() ? error : null };
}
