/**
 * The kiosk's part of the main till's local shop Z, closed through the cloud (pos-server
 * docs/SPEC_INDEPENDENT_TILL.md §8.13–8.14; pos-android domain/LanShopClose.kt,
 * data/sync/CloseShiftCoordinator.closeForLan, data/repo/LocalShopZRepository.handleRemote):
 *
 *  - in local mode the main till closes every participant itself; the Windows kiosk has no LAN
 *    client, so the cloud always lists it as remote ("מרוחק (דרך הענן)") and the main till asks
 *    through it: the request arrives on the heartbeat (`pendingShopZPart`) until it is answered;
 *  - the close is the LAN close's: unattended, its request id on the shift (asked again, the kiosk
 *    answers "closed" without closing anything); a customer paying is waited out (the charge's own
 *    timeout, "ממתינה לסיום חיוב אשראי" meanwhile), a payment still pending refuses it;
 *  - the answer is the kiosk's section — its closed shifts no Z names, every one of them — with
 *    the part's manifest built from its own committed documents after the close (shopZManifest.ts),
 *    the section's figures the manifest's, named as a kiosk with its system operator; sent with
 *    `POST /sync/{m}/shop-z/remote-part`;
 *  - the main till numbers the shop Z (strictly in sequence) and the heartbeat's `recentShiftZs`
 *    then marks these shifts as in it, so no later Z of this kiosk takes them again.
 *
 * Pure: the ledger's rows in, the report's JSON out.
 */

import { formatDocNumber } from '../../core/documentNumbers';
import { ofShekels, toShekels } from '../../core/money';
import type { DocDraft, ShiftRow } from './ledger';
import { agorotOfDecimal, manifestDocumentOf, manifestOf, money, type ShopZManifest } from './shopZManifest';

/** What a till did with the main till's close (LanCloseOutcome). */
export type LanCloseOutcome = 'closed' | 'no_open_shift' | 'waiting_card' | 'blocked_payment' | 'blocked_tables' | 'failed';

export const FINAL_OUTCOMES: ReadonlySet<LanCloseOutcome> = new Set(['closed', 'no_open_shift', 'blocked_payment', 'blocked_tables', 'failed']);

/** How long a customer's payment is waited out — a card charge's own timeout (DEVICE_PAYING_WAIT_MS). */
export const DEVICE_PAYING_WAIT_MS = 155_000;

/** The message the main till shows beside the kiosk (lanOutcomeMessage). */
export function lanOutcomeMessage(outcome: LanCloseOutcome, detail?: string | null): string {
  switch (outcome) {
    case 'closed':
      return 'נסגרה';
    case 'no_open_shift':
      return 'אין משמרת פתוחה';
    case 'waiting_card':
      return 'ממתינה לסיום חיוב אשראי';
    case 'blocked_payment':
      return 'תשלום בתהליך — לא נסגרה';
    case 'blocked_tables':
      return `שולחנות פתוחים${detail ? `: ${detail}` : ''}`;
    case 'failed':
      return `לא נסגרה${detail ? `: ${detail}` : ''}`;
  }
}

export interface LanCloseRequest {
  requestId: string;
  roundId: string;
  force: boolean;
}

/** planLanClose: answer at once, wait for a payment, or close the open shift. */
export type LanClosePlan =
  | { kind: 'answer'; outcome: LanCloseOutcome; shiftId: string | null; detail?: string }
  | { kind: 'wait' }
  | { kind: 'close'; shiftId: string };

export function planLanClose(input: {
  /** The shift this request already closed (its close carries the request id), if any. */
  closedForRequest: string | null;
  openShiftId: string | null;
  /** A customer is paying on the kiosk now (a card on the terminal). */
  devicePaying: boolean;
  /** Since when the payment has been waited out for this request (null: not yet). */
  payingSinceMs: number | null;
  nowMs: number;
  pendingDocuments: number;
}): LanClosePlan {
  if (input.closedForRequest) return { kind: 'answer', outcome: 'closed', shiftId: input.closedForRequest };
  if (!input.openShiftId) return { kind: 'answer', outcome: 'no_open_shift', shiftId: null };
  if (input.devicePaying) {
    if (input.payingSinceMs !== null && input.nowMs - input.payingSinceMs >= DEVICE_PAYING_WAIT_MS) {
      return { kind: 'answer', outcome: 'blocked_payment', shiftId: input.openShiftId };
    }
    return { kind: 'wait' };
  }
  if (input.pendingDocuments > 0) return { kind: 'answer', outcome: 'blocked_payment', shiftId: input.openShiftId };
  return { kind: 'close', shiftId: input.openShiftId };
}

/* ------------------------------------------------------------- the section */

export interface PartIdentity {
  machineId: string;
  posNumber: string | null;
  machineName: string | null;
  /** The kiosk's system operator (SPEC_KIOSK §14): no employee closed it. */
  operator: { id: string; name: string };
}

export type SectionResult = { kind: 'ok'; section: Record<string, unknown> } | { kind: 'unreadable'; shiftId: string };

const MAIN_SERIES = [320, 400, 330];

/** The till totals of a close (`close_payload.till`), or null when the close cannot be read. */
function tillOf(s: ShiftRow): Record<string, unknown> | null {
  try {
    const till = (JSON.parse(s.close_payload ?? 'null') as Record<string, unknown> | null)?.till;
    return till && typeof till === 'object' ? (till as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A shekel figure of a close, in agorot (HALF_UP, as the till's Agorot.ofShekels). */
const ag = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? ofShekels(v) : 0);

/**
 * The kiosk's closed shifts no Z names, as one section of the shop Z (lanSectionOf +
 * withPartManifest + asKiosk): its figures the manifest's (the paper, the upload and the cloud's
 * check are one computation); no shift — an empty section with no manifest.
 */
export function kioskSection(me: PartIdentity, shifts: readonly ShiftRow[], docsOf: (shiftId: string) => DocDraft[]): SectionResult {
  const ordered = [...shifts].sort((a, b) => a.sequence_number - b.sequence_number || (a.closed_at ?? '').localeCompare(b.closed_at ?? ''));
  const dates = ordered.map((s) => s.business_date).filter((d) => !!d).sort();
  const shiftIds = ordered.map((s) => s.id);
  const kiosk = { deviceRole: 'kiosk', operator: { id: me.operator.id, name: me.operator.name }, closedByName: `קיוסק · ${me.operator.name}` };
  const report: Record<string, unknown> = {
    machineId: me.machineId,
    posNumber: me.posNumber,
    machineName: me.machineName,
    shiftIds,
    shiftCount: ordered.length,
    transactionsCount: 0,
  };
  if (ordered.length === 0) {
    return {
      kind: 'ok',
      section: sectionJson(me, [], null, null, null, null, null, { ...report, ...kiosk }, null),
    };
  }
  const tills = ordered.map(tillOf);
  const unreadable = ordered.find((_, i) => tills[i] === null);
  if (unreadable) return { kind: 'unreadable', shiftId: unreadable.id };

  // Committed documents only (a pending one cannot be in a closed shift; a voided one keeps its number).
  const docs = ordered.flatMap((s) => docsOf(s.id)).filter((d) => d.status !== 'pending');
  const manifest = manifestOf(docs.map(manifestDocumentOf), me.machineId, shiftIds);
  const counted = docs.filter((d) => d.status === 'completed');
  const credits = counted.filter((d) => d.documentType === 330 || d.documentType === -400);
  // The one range the Z names: the tax invoices', else an exempt dealer's receipts', else the credits' — as printed.
  const mainType = MAIN_SERIES.find((t) => docs.some((d) => d.documentType === t)) ?? docs[0]?.documentType;
  const mainNumbers = docs
    .filter((d) => d.documentType === mainType)
    .sort((a, b) => a.number - b.number)
    .map((d) => formatDocNumber(d.prefix, d.number));
  const seqs = ordered.map((s) => s.sequence_number);
  const sum = (k: string) => tills.reduce((acc, t) => acc + ag(t![k]), 0);
  const cashTips = sum('totalCashTips');
  // The drawer, as the cloud reckons it: the kiosk's float is 0 and its closes are counted = expected.
  const opening = ordered[0].opening_cash ?? 0; // agorot, as the ledger keeps it
  const countedOf = (s: ShiftRow) => {
    try {
      const c = (JSON.parse(s.close_payload ?? 'null') as Record<string, unknown> | null)?.countedCash;
      return typeof c === 'number' ? ag(c) : null;
    } catch {
      return null;
    }
  };
  const uncounted = ordered.filter((s) => countedOf(s) === null).length;
  const t = manifest.totals;
  const cash = agorotOfDecimal(t.cash) ?? 0;
  const expectedCash = opening + cash + cashTips;
  const lastCounted = countedOf(ordered[ordered.length - 1]);
  const breakdown: Record<string, string> = {};
  for (const [m, a] of Object.entries(t.payments)) breakdown[m] = a;
  const ranges: Record<string, { count: number; first: string; last: string }> = {};
  for (const [type, r] of Object.entries(manifest.types)) ranges[type] = { count: r.count, first: r.first, last: r.last };
  const section: Record<string, unknown> = {
    ...report,
    firstShiftSequence: seqs.length ? Math.min(...seqs) : null,
    lastShiftSequence: seqs.length ? Math.max(...seqs) : null,
    firstDocumentNumber: mainNumbers[0] ?? null,
    lastDocumentNumber: mainNumbers[mainNumbers.length - 1] ?? null,
    salesCount: counted.length - credits.length,
    creditNotesCount: credits.length,
    nonSaleDocumentsCount: docs.length - counted.length,
    totalCashTips: money(cashTips),
    totalCardTips: money(sum('totalCardTips')),
    openingCash: money(opening),
    expectedCash: money(expectedCash),
    countedCash: lastCounted === null ? null : money(lastCounted),
    overShort: uncounted > 0 ? null : money(ordered.reduce((acc, s, i) => acc + (countedOf(s) ?? 0) - ((s.opening_cash ?? 0) + ag(tills[i]!.totalCash) + ag(tills[i]!.totalCashTips)), 0)),
    cashSalesNet: t.cash,
    betweenShiftAdjustments: '0.00',
    uncountedShiftCount: uncounted,
    unattendedShiftCount: ordered.filter((s) => isUnattended(s)).length,
    // The manifest's figures (withManifest): the paper is the manifest.
    grossSales: t.gross,
    discountsTotal: t.discounts,
    totalSales: money((agorotOfDecimal(t.gross) ?? 0) - (agorotOfDecimal(t.discounts) ?? 0)),
    totalRefunds: t.refunds,
    netSales: t.net,
    totalCash: t.cash,
    totalCard: t.card,
    totalExchange: t.exchange,
    totalTips: t.tips,
    vatTotal: t.vat,
    transactionsCount: t.documents,
    paymentBreakdown: breakdown,
    documentRanges: ranges,
    manifestDigest: manifest.digest,
    ...kiosk,
  };
  return {
    kind: 'ok',
    section: sectionJson(me, shiftIds, dates[0] ?? null, dates[dates.length - 1] ?? null, mainNumbers[0] ?? null, mainNumbers[mainNumbers.length - 1] ?? null, tillTotals(manifest), section, manifest),
  };
}

function isUnattended(s: ShiftRow): boolean {
  try {
    return (JSON.parse(s.close_payload ?? 'null') as Record<string, unknown> | null)?.unattended === true;
  } catch {
    return false;
  }
}

/** The manifest's figures in the §3.3 shape of the section's `till` (ShopZManifest.tillTotals). */
function tillTotals(m: ShopZManifest): Record<string, unknown> {
  const sh = (v: string | null) => (v === null ? null : toShekels(agorotOfDecimal(v) ?? 0));
  return {
    totalSales: sh(m.totals.gross),
    totalDiscounts: sh(m.totals.discounts),
    totalRefunds: sh(m.totals.refunds),
    totalCash: sh(m.totals.cash),
    totalCard: sh(m.totals.card),
    totalExchange: sh(m.totals.exchange),
    totalTips: sh(m.totals.tips),
    vatTotal: sh(m.totals.vat),
    transactionsCount: m.totals.documents,
  };
}

function sectionJson(
  me: PartIdentity,
  shiftIds: string[],
  firstBusinessDate: string | null,
  lastBusinessDate: string | null,
  firstDocumentNumber: string | null,
  lastDocumentNumber: string | null,
  till: Record<string, unknown> | null,
  report: Record<string, unknown>,
  manifest: ShopZManifest | null,
): Record<string, unknown> {
  return {
    machineId: me.machineId,
    posNumber: me.posNumber,
    machineName: me.machineName,
    shiftIds,
    firstBusinessDate,
    lastBusinessDate,
    firstDocumentNumber,
    lastDocumentNumber,
    till,
    report,
    manifest,
    late: false,
    label: null,
  };
}

/** The answer the cloud keeps for the main till (LanCloseReport.toJson). */
export function lanCloseReport(
  r: LanCloseRequest,
  machineId: string,
  outcome: LanCloseOutcome,
  shiftId: string | null,
  message: string,
  section: Record<string, unknown> | null,
): Record<string, unknown> {
  return { requestId: r.requestId, roundId: r.roundId, machineId, outcome, shiftId, message, section };
}
