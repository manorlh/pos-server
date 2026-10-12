/**
 * "שכפול סדרה" and "שינוי שם" (P:\specs\voucher-batch-duplicate.md) — the dialogs' pure parts:
 *
 * - the new batch's default name, "{שם המקור} (עותק)", within the name's limit;
 * - the form as it opens from the source (the count issued, its validity, for whom, the event);
 * - what "שכפול" sends (POST /prepaid-vouchers/batches/{id}/duplicate): the name, the count and the
 *   test-mode switch always, and only the fields that differ from the source — an absent one is
 *   the source's on the server, a null clears it (server: app/services/prepaid_batch_duplicate.py);
 * - what stops "שכפול": an empty name, a count outside 1–5,000 (as at batch create), dates the wrong
 *   way round, and a validity already past ("התוקף עבר — עדכנו");
 * - the name a rename sends (PATCH `name`), or why not.
 *
 * Pure (no React, no axios): `npm test` covers it (lib/prepaidBatchDuplicate.test.ts).
 */
import { isoDate } from './format';

/** The batch name's limit and the count's, as the server's (app/schemas/prepaid_voucher.py). */
export const NAME_MAX = 200;
export const MAX_VOUCHERS = 5000;
export const COPY_SUFFIX = ' (עותק)';

/** "פסטיבל הקיץ" → "פסטיבל הקיץ (עותק)"; a long name is cut so the suffix still fits. */
export function defaultDuplicateName(name: string | null | undefined): string {
  const base = (name ?? '').trim();
  const room = NAME_MAX - COPY_SUFFIX.length;
  return `${base.length > room ? base.slice(0, room).trimEnd() : base}${COPY_SUFFIX}`;
}

/** What the dialog reads of the source batch. */
export interface DuplicateSource {
  name: string;
  validFrom: string | null;
  validUntil: string | null;
  customerName?: string | null;
  eventName?: string | null;
  production?: { id: string; name: string } | null;
  reportEvent?: { id: string; name: string } | null;
  issuedCount?: number;
  stats?: { total: number };
}

/** The dialog's fields as typed: days as "2026-10-07" ('' none), ids '' for none. */
export interface DuplicateForm {
  name: string;
  count: string;
  validFrom: string;
  validUntil: string;
  productionId: string;
  customerName: string;
  reportEventId: string;
  eventName: string;
  startInTestMode: boolean;
}

/** The day (Israel's) of a stored moment, as a date field holds it; '' for none. */
export function dayOf(iso: string | null | undefined): string {
  return iso ? isoDate(iso) : '';
}

/** How the dialog opens: the source's settings, its name with "(עותק)", as many vouchers, test mode off. */
export function duplicateFormOf(b: DuplicateSource): DuplicateForm {
  return {
    name: defaultDuplicateName(b.name),
    count: String(b.issuedCount ?? b.stats?.total ?? ''),
    validFrom: dayOf(b.validFrom),
    validUntil: dayOf(b.validUntil),
    productionId: b.production?.id ?? '',
    customerName: b.customerName ?? '',
    reportEventId: b.reportEvent?.id ?? '',
    eventName: b.eventName ?? '',
    startInTestMode: false,
  };
}

/** A whole number as typed ("40"), else null ("", "2.5", "abc"). */
export function parseCount(text: string): number | null {
  const s = (text ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** "בתוקף עד" is the last day the vouchers redeem: past when it is before today (both "2026-10-07"). */
export function isPastValidity(validUntil: string | null | undefined, today: string): boolean {
  return !!validUntil && !!today && validUntil < today;
}

/** Why "שכפול" is not available yet — each a key of `prepaidVouchers.duplicate.problem`. */
export type DuplicateProblem = 'name' | 'nameLong' | 'count' | 'dates' | 'expired';

export function duplicateProblems(f: DuplicateForm, today: string): DuplicateProblem[] {
  const out: DuplicateProblem[] = [];
  const name = f.name.trim();
  if (!name) out.push('name');
  else if (name.length > NAME_MAX) out.push('nameLong');
  const n = parseCount(f.count);
  if (n === null || n < 1 || n > MAX_VOUCHERS) out.push('count');
  if (f.validFrom && f.validUntil && f.validFrom > f.validUntil) out.push('dates');
  if (isPastValidity(f.validUntil, today)) out.push('expired');
  return out;
}

/** "2026-10-07" → the start / end of that day, local time, as ISO (as the batch form sends it). */
export function dayBoundIso(value: string, end: boolean): string | null {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const at = end ? new Date(y, m - 1, d, 23, 59, 59) : new Date(y, m - 1, d, 0, 0, 0);
  return at.toISOString();
}

/** The body of POST …/duplicate. Absent fields are the source's on the server; a null clears one. */
export interface DuplicateBody {
  name: string;
  count: number;
  startInTestMode: boolean;
  validFrom?: string | null;
  validUntil?: string | null;
  productionId?: string | null;
  customerName?: string | null;
  reportEventId?: string | null;
  eventName?: string | null;
}

/**
 * What "שכפול" sends for [f]: the name (trimmed), the count and the test-mode switch, and each other
 * field only when it differs from [source] — so a validity left as it is keeps the source's exact
 * moments, and a day changed is the start / end of that day. "עבור מי" is the production's name
 * when one is chosen (the server keeps them in step): sent only without a production.
 */
export function duplicateBody(f: DuplicateForm, source: DuplicateSource): DuplicateBody {
  const out: DuplicateBody = {
    name: f.name.trim(),
    count: parseCount(f.count) ?? 0,
    startInTestMode: f.startInTestMode,
  };
  if (f.validFrom !== dayOf(source.validFrom)) out.validFrom = dayBoundIso(f.validFrom, false);
  if (f.validUntil !== dayOf(source.validUntil)) out.validUntil = dayBoundIso(f.validUntil, true);
  if (f.productionId !== (source.production?.id ?? '')) out.productionId = f.productionId || null;
  const customer = f.customerName.trim();
  if (!f.productionId && customer !== (source.customerName ?? '').trim()) out.customerName = customer || null;
  if (f.reportEventId !== (source.reportEvent?.id ?? '')) out.reportEventId = f.reportEventId || null;
  const event = f.eventName.trim();
  if (event !== (source.eventName ?? '').trim()) out.eventName = event || null;
  return out;
}

/** What a duplicate's key is kept for (lib/prepaidBatchSubmit.ts): this source, this body. */
export function duplicateRequest(sourceId: string, body: DuplicateBody) {
  return { duplicateOf: sourceId, ...body };
}

/** "שינוי שם": why the name cannot be saved, or null. */
export function renameProblem(name: string): 'name' | 'nameLong' | null {
  const s = (name ?? '').trim();
  if (!s) return 'name';
  return s.length > NAME_MAX ? 'nameLong' : null;
}

/** The rename's PATCH body, or null when nothing changes (the same name, spaces aside). */
export function renameBody(name: string, current: string): { name: string } | null {
  const s = (name ?? '').trim();
  return s && s !== (current ?? '').trim() ? { name: s } : null;
}
