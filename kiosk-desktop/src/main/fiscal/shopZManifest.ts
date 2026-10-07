/**
 * The manifest of this kiosk's part of a local shop Z — one computation, here, on the Android till
 * and in the cloud (pos-server app/services/shop_z_manifest.py, pos-android domain/ShopZManifest.kt;
 * pos-server docs/SPEC_INDEPENDENT_TILL.md §8.12).
 *
 * The owner: a mismatch between the main till's paper and the cloud must be impossible — "רק במצב
 * שהקופה מתה". So when the kiosk closes for the main till's shop Z it describes its part from its
 * own committed documents, after its shift is closed: which documents (by id), per type how many
 * and from which number to which, the totals, and a digest over them. The main till builds the Z
 * only from those parts, and the cloud runs the same computation over the same documents once they
 * have all arrived. All three run the shared golden fixtures (`shop_z_manifest_golden.json`, the
 * same bytes in the three repositories' tests, pinned by SHA-256).
 *
 * Money in agorot inside, decimal strings on the wire. Counted: completed, refunded,
 * partial_refund. A credit: 330 / -400, or a document naming the sale it refunds. A document with
 * no tender rows has one leg, by its payment method (`other` when none), for its collectable
 * amount — the leg the cloud writes on ingest. Pure but for the SHA-256 (node:crypto).
 */

import { createHash } from 'node:crypto';
import type { DocDraft } from './ledger';

export const MANIFEST_VERSION = 1;

const COUNTED = new Set(['completed', 'refunded', 'partial_refund']);
const CREDIT_TYPES = new Set([330, -400]);
const UNKNOWN_METHOD = 'other';
const DIGITS = /^[0-9]+$/;

/** A document as the manifest reads it — the amounts exactly as the sync sends them, in agorot. */
export interface ManifestDocument {
  id: string;
  /** The bare counter, as the wire's `transactionNumber` (the prefix apart). */
  number: string;
  type: number | null;
  status: string;
  refundOf: string | null;
  /** Σ line totals — the wire's `totalAmount`. */
  total: number;
  discount: number | null;
  vat: number | null;
  tip: number;
  paymentMethod: string | null;
  payments: Array<{ method: string | null; amount: number }>;
}

export interface ManifestRange {
  count: number;
  first: string;
  last: string;
}

/** The manifest as the cloud reads it (`manifest_of`), plus whose part it is. */
export interface ShopZManifest {
  version: number;
  documents: number;
  documentIds: string[];
  types: Record<string, ManifestRange>;
  totals: {
    documents: number;
    gross: string;
    discounts: string;
    refunds: string;
    net: string;
    cash: string;
    card: string;
    exchange: string;
    tips: string;
    vat: string | null;
    payments: Record<string, string>;
  };
  digest: string;
  machineId?: string;
  shiftIds?: string[];
}

/** Agorot as a decimal string, "12.30", "-0.50". */
export function money(agorot: number): string {
  const sign = agorot < 0 ? '-' : '';
  const a = Math.abs(agorot);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

/** A decimal string ("12.345", "-0.5") to agorot, half away from zero — Python's ROUND_HALF_UP. */
export function agorotOfDecimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(3, '0');
  let n = Number(m[2] || '0') * 100 + Number(frac.slice(0, 2));
  if (frac.charCodeAt(2) >= 53 /* '5' */) n += 1;
  return m[1] === '-' && n !== 0 ? -n : n;
}

const method = (m: string | null | undefined) => (m ?? '').trim().toLowerCase() || UNKNOWN_METHOD;
const typeKey = (t: number | null) => (t === null ? 'none' : String(Math.trunc(t)));
/** Code-unit order, as Python's and Kotlin's string comparison (never the locale's). */
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Numbers in order: numerically where they are digits, then the rest as text. */
export function numberOrder(a: string, b: string): number {
  const da = DIGITS.test(a);
  const db = DIGITS.test(b);
  if (da && db) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : textOrder(a, b);
  }
  if (da) return -1;
  if (db) return 1;
  return textOrder(a, b);
}

export function isCredit(d: ManifestDocument): boolean {
  return (d.type !== null && CREDIT_TYPES.has(d.type)) || !!(d.refundOf ?? '').trim();
}

export function isCounted(d: ManifestDocument): boolean {
  return COUNTED.has(d.status.trim().toLowerCase());
}

/** The tender legs as (method, agorot), sorted — one synthesised when it has none. */
export function legsOf(d: ManifestDocument): Array<[string, number]> {
  const legs: Array<[string, number]> =
    d.payments.length > 0
      ? d.payments.map((p) => [method(p.method), p.amount])
      : [[method(d.paymentMethod), isCredit(d) ? d.total : d.total - (d.discount ?? 0)]];
  return legs.sort((a, b) => textOrder(a[0], b[0]) || a[1] - b[1]);
}

export function digestLine(d: ManifestDocument): string {
  return [
    d.id.trim().toLowerCase(),
    typeKey(d.type),
    d.number.trim(),
    isCredit(d) ? '1' : '0',
    String(d.total),
    String(d.discount ?? 0),
    d.vat === null ? '-' : String(d.vat),
    String(d.tip),
    legsOf(d)
      .map(([m, a]) => `${m}=${a}`)
      .join(','),
  ].join('|');
}

/** The manifest of a set of documents; `machineId` / `shiftIds` say whose part it is. */
export function manifestOf(documents: readonly ManifestDocument[], machineId?: string, shiftIds?: readonly string[]): ShopZManifest {
  const counted = documents.filter(isCounted).sort((a, b) => textOrder(a.id.trim().toLowerCase(), b.id.trim().toLowerCase()));
  let gross = 0;
  let discounts = 0;
  let refunds = 0;
  let tips = 0;
  let vat = 0;
  let vatKnown = true;
  const payments: Record<string, number> = {};
  const types: Record<string, ManifestRange> = {};
  for (const d of counted) {
    const credit = isCredit(d);
    if (credit) refunds += d.total;
    else {
      gross += d.total;
      discounts += d.discount ?? 0;
    }
    const sign = credit ? -1 : 1;
    if (d.vat === null) vatKnown = false;
    else vat += sign * d.vat;
    tips += d.tip;
    for (const [m, a] of legsOf(d)) payments[m] = (payments[m] ?? 0) + sign * a;
    const number = d.number.trim();
    const key = typeKey(d.type);
    const was = types[key];
    types[key] = was
      ? { count: was.count + 1, first: numberOrder(number, was.first) < 0 ? number : was.first, last: numberOrder(number, was.last) > 0 ? number : was.last }
      : { count: 1, first: number, last: number };
  }
  const digest = createHash('sha256')
    .update(counted.map(digestLine).join('\n'), 'utf8')
    .digest('hex');
  const sortedPayments: Record<string, string> = {};
  for (const m of Object.keys(payments).sort(textOrder)) sortedPayments[m] = money(payments[m]);
  const sortedTypes: Record<string, ManifestRange> = {};
  for (const k of Object.keys(types).sort(textOrder)) sortedTypes[k] = types[k];
  const out: ShopZManifest = {
    version: MANIFEST_VERSION,
    documents: counted.length,
    documentIds: counted.map((d) => d.id.trim().toLowerCase()),
    types: sortedTypes,
    totals: {
      documents: counted.length,
      gross: money(gross),
      discounts: money(discounts),
      refunds: money(refunds),
      net: money(gross - discounts - refunds),
      cash: money(payments.cash ?? 0),
      card: money(payments.card ?? 0),
      exchange: money(payments.exchange ?? 0),
      tips: money(tips),
      vat: vatKnown ? money(vat) : null,
      payments: sortedPayments,
    },
    digest,
  };
  if (machineId) out.machineId = machineId;
  if (shiftIds && shiftIds.length > 0) out.shiftIds = [...shiftIds].sort(textOrder);
  return out;
}

/** A document in the fixtures' canonical form (money as decimal strings). */
export function documentOfJson(o: Record<string, unknown>): ManifestDocument {
  const str = (k: string) => (o[k] === null || o[k] === undefined ? null : String(o[k]));
  return {
    id: String(o.id),
    number: str('number') ?? '',
    type: o.type === null || o.type === undefined ? null : Number(o.type),
    status: str('status') ?? '',
    refundOf: str('refundOf'),
    total: agorotOfDecimal(str('total')) ?? 0,
    discount: agorotOfDecimal(str('discount')),
    vat: agorotOfDecimal(str('vat')),
    tip: agorotOfDecimal(str('tip')) ?? 0,
    paymentMethod: str('paymentMethod'),
    payments: ((o.payments as Array<Record<string, unknown>> | undefined) ?? []).map((p) => ({
      method: p.method === null || p.method === undefined ? null : String(p.method),
      amount: agorotOfDecimal(p.amount === null || p.amount === undefined ? null : String(p.amount)) ?? 0,
    })),
  };
}

/**
 * A kiosk document as the cloud will hold it (ledger.ts documentWire → the cloud's row): the bare
 * number, `totalAmount` = the gross, the discount only when there is one, the card leg of a
 * completed sale for the goods (the tip apart, in `tipAmount`).
 */
export function manifestDocumentOf(d: DocDraft): ManifestDocument {
  return {
    id: d.id,
    number: String(d.number),
    type: d.documentType,
    status: d.status,
    refundOf: null,
    total: d.totals.grossAgorot,
    discount: d.totals.discountAgorot > 0 ? d.totals.discountAgorot : null,
    vat: d.totals.vatAgorot,
    tip: d.totals.tipAgorot,
    paymentMethod: 'card',
    payments: d.status === 'completed' && d.card ? [{ method: 'card', amount: d.totals.totalAgorot }] : [],
  };
}
