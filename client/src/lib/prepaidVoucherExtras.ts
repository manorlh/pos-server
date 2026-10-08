/**
 * Production vouchers after redemption — settlement, deliveries, replacement vouchers, the §15
 * reports and the §18 controls (pause, quota, test batches, the simulator): the dashboard's pure
 * rules (the contract: P:\specs\production-vouchers-api.md, section H). Free of React and Next so
 * `npm test` covers it (lib/prepaidVoucherExtras.test.ts); the texts live in messages/he.json.
 */

// ── Refusal codes ─────────────────────────────────────────────────────────────

/** A refusal's `detail`: the code, and the facts some carry after it (`code:<a>:<b>`). */
export interface ErrorCode {
  code: string;
  facts: string[];
}

/** `prepaid_settlement_over_invoiced:<batchId>:<left>` → the code and its facts; null when not a code. */
export function splitErrorCode(detail: unknown): ErrorCode | null {
  if (typeof detail !== 'string') return null;
  const s = detail.trim();
  if (!/^[a-z][a-z0-9_]*(?::|$)/.test(s)) return null;
  const [code, ...facts] = s.split(':');
  return { code, facts };
}

/** The refusal code of an axios error (its `response.data.detail`), or null. */
export function errorCodeOf(err: unknown): ErrorCode | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  return splitErrorCode(detail);
}

export const OVER_INVOICED = 'prepaid_settlement_over_invoiced';

/** 409 `prepaid_settlement_over_invoiced:<batchId>:<left>` — which batch, and how many vouchers are left to invoice. */
export function parseOverInvoiced(detail: unknown): { batchId: string; left: number } | null {
  const e = splitErrorCode(detail);
  if (!e || e.code !== OVER_INVOICED || e.facts.length < 2) return null;
  const left = Number(e.facts[1]);
  if (!e.facts[0] || !Number.isFinite(left)) return null;
  return { batchId: e.facts[0], left: Math.max(0, Math.trunc(left)) };
}

/** The over-invoiced refusal of an axios error, or null. */
export function overInvoicedOf(err: unknown): { batchId: string; left: number } | null {
  return parseOverInvoiced((err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail);
}

/** 409 `prepaid_voucher_delivery_overlap:<from>-<to>` — the delivery already holding those serials. */
export function parseDeliveryOverlap(detail: unknown): { from: number; to: number } | null {
  const e = splitErrorCode(detail);
  if (!e || e.code !== 'prepaid_voucher_delivery_overlap' || !e.facts[0]) return null;
  const m = /^(\d+)-(\d+)$/.exec(e.facts[0]);
  return m ? { from: Number(m[1]), to: Number(m[2]) } : null;
}

// ── Serial ranges (deliveries) ───────────────────────────────────────────────

export interface SerialRange {
  from: number;
  to: number;
}

/** "#12" for one voucher, "#1–#50" for a range. */
export function rangeText(from: number, to: number): string {
  return from === to ? `#${from}` : `#${from}–#${to}`;
}

/** The ranges joined ("#1–#50, #61–#100"); '' for none. */
export function rangesText(ranges: readonly SerialRange[]): string {
  return ranges.map((r) => rangeText(r.from, r.to)).join(', ');
}

/** How many serials the ranges hold. */
export function rangesCount(ranges: readonly SerialRange[]): number {
  return ranges.reduce((n, r) => n + Math.max(0, r.to - r.from + 1), 0);
}

export type RangeProblem = 'from' | 'to' | 'order' | 'beyond' | 'overlap';

/**
 * What is wrong with a delivery of serials [fromText]–[toText] of a batch whose last serial is
 * [lastSerial] (the server checks the same: `prepaid_voucher_delivery_bad_range` / `_overlap`);
 * null when it can be sent. [taken] are the live deliveries' ranges.
 */
export function deliveryRangeProblem(
  fromText: string,
  toText: string,
  lastSerial: number,
  taken: readonly SerialRange[] = [],
): RangeProblem | null {
  const from = wholeNumber(fromText);
  const to = toText.trim() === '' ? from : wholeNumber(toText);
  if (from === null || from < 1) return 'from';
  if (to === null || to < 1) return 'to';
  if (to < from) return 'order';
  if (to > lastSerial) return 'beyond';
  if (taken.some((r) => !(to < r.from || from > r.to))) return 'overlap';
  return null;
}

/** A positive whole number typed by a person ("12", " 12 "); null otherwise. */
export function wholeNumber(text: string): number | null {
  const s = text.trim();
  if (!/^\d{1,9}$/.test(s)) return null;
  return Number(s);
}

// ── Money ────────────────────────────────────────────────────────────────────

/** ₪ as typed ("4,200.50", "4200") → a number of shekels; null when not a valid amount. */
export function shekelsFromText(text: string): number | null {
  const s = text.trim().replace(/[₪\s]/g, '').replace(/,(?=\d{3}(?:\D|$))/g, '');
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(s)) return null;
  return Number(s.replace(',', '.'));
}

/** Agorot → shekels for a spreadsheet cell (a real number); null stays null. */
export function shekelsOf(agorot: number | null | undefined): number | null {
  if (agorot === null || agorot === undefined) return null;
  return Math.round(agorot) / 100;
}

/** The invoices against the report: + the invoices say more than the report, − less. */
export type GapState = 'unknown' | 'none' | 'over' | 'under';

export function gapState(gapAgorot: number | null | undefined): GapState {
  if (gapAgorot === null || gapAgorot === undefined) return 'unknown';
  if (gapAgorot === 0) return 'none';
  return gapAgorot > 0 ? 'over' : 'under';
}

// ── Invoices ─────────────────────────────────────────────────────────────────

/** A batch an invoice may cover: how many vouchers are charged and not yet on an invoice. */
export interface InvoiceableBatch {
  batchId: string;
  uninvoiced: number;
  productionPriceAgorot: number | null;
}

/** The quantities typed per batch → the invoice's lines (the empty / zero ones left out). */
export function invoiceLines(draft: Record<string, string>): { batchId: string; quantity: number }[] {
  const out: { batchId: string; quantity: number }[] = [];
  for (const [batchId, text] of Object.entries(draft)) {
    const q = wholeNumber(text);
    if (q && q > 0) out.push({ batchId, quantity: q });
  }
  return out;
}

/** The batches whose typed quantity is not a whole number or more than is left to invoice. */
export function invoiceLineProblems(draft: Record<string, string>, batches: readonly InvoiceableBatch[]): string[] {
  const out: string[] = [];
  for (const b of batches) {
    const text = (draft[b.batchId] ?? '').trim();
    if (!text) continue;
    const q = wholeNumber(text);
    if (q === null || q > Math.max(0, b.uninvoiced)) out.push(b.batchId);
  }
  return out;
}

/** What the typed quantities come to at the batches' production prices (agorot); null without prices. */
export function invoiceLinesAmount(draft: Record<string, string>, batches: readonly InvoiceableBatch[]): number | null {
  let total = 0;
  for (const line of invoiceLines(draft)) {
    const b = batches.find((x) => x.batchId === line.batchId);
    if (!b || b.productionPriceAgorot === null) return null;
    total += line.quantity * b.productionPriceAgorot;
  }
  return total;
}

// ── Quotas ───────────────────────────────────────────────────────────────────

export type QuotaState = 'off' | 'ok' | 'warning' | 'reached';

/** A quota's state as its bar shows it: off (inactive), ok, warning (≥ warnPercent), reached. */
export function quotaState(q: { active: boolean; used: number | null; maxRedemptions: number; warnPercent: number }): QuotaState {
  if (!q.active || q.used === null) return 'off';
  if (q.used >= q.maxRedemptions) return 'reached';
  if (q.maxRedemptions > 0 && q.used * 100 >= q.maxRedemptions * q.warnPercent) return 'warning';
  return 'ok';
}

/** The bar's width, 0–100 (whole percent); 100 when the maximum is 0. */
export function quotaBarPercent(used: number | null, max: number): number {
  if (used === null || used <= 0) return max <= 0 && used !== null ? 100 : 0;
  if (max <= 0) return 100;
  return Math.min(100, Math.round((used / max) * 100));
}

export const QUOTA_PERIODS = ['overall', 'day', 'range'] as const;
export type QuotaPeriod = (typeof QUOTA_PERIODS)[number];

export const CONTROL_SCOPES = ['event', 'production', 'type', 'batch'] as const;
export type ControlScope = (typeof CONTROL_SCOPES)[number];

/** A `datetime-local` value (the browser's wall clock) → ISO; '' → null; unreadable → undefined. */
export function localDateTimeIso(value: string): string | null | undefined {
  const s = value.trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(s)) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** An ISO instant → the `datetime-local` value of the browser's wall clock ('' for none). */
export function isoToLocalDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** A quota's create form: what is missing or wrong (keys under `prepaidVouchers.extras.quotas.problem`). */
export function quotaFormProblems(f: {
  scopeValue: string;
  max: string;
  period: QuotaPeriod;
  from: string;
  to: string;
  warn: string;
}): string[] {
  const out: string[] = [];
  if (!f.scopeValue.trim()) out.push('scope');
  const max = wholeNumber(f.max);
  if (max === null) out.push('max');
  const warn = wholeNumber(f.warn);
  if (warn === null || warn < 1 || warn > 100) out.push('warn');
  if (f.period === 'range') {
    const a = localDateTimeIso(f.from);
    const b = localDateTimeIso(f.to);
    if (a === undefined || b === undefined || (a === null && b === null)) out.push('period');
    else if (a && b && Date.parse(b) <= Date.parse(a)) out.push('period');
  }
  return out;
}

// ── Agreements ───────────────────────────────────────────────────────────────

/** The agreement form: what is missing or wrong (keys under `prepaidVouchers.settlement.problem`). */
export function agreementFormProblems(f: {
  name: string;
  companyId: string;
  productionName: string;
  eventName: string;
  batchIds: readonly string[];
  periodFrom: string;
  periodTo: string;
}): string[] {
  const out: string[] = [];
  if (!f.name.trim()) out.push('name');
  if (!f.companyId) out.push('company');
  if (!f.productionName.trim() && !f.eventName.trim() && f.batchIds.length === 0) out.push('scope');
  if (f.periodFrom && f.periodTo && f.periodTo < f.periodFrom) out.push('period');
  return out;
}

// ── Replacement ──────────────────────────────────────────────────────────────

export const REPLACEMENT_REASONS = ['lost', 'damaged', 'cancelled', 'other'] as const;
export type ReplacementReason = (typeof REPLACEMENT_REASONS)[number];

/** The server wants a reason of at least 2 characters (and a known kind). */
export function replacementReady(kind: string, reason: string): boolean {
  return (REPLACEMENT_REASONS as readonly string[]).includes(kind) && reason.trim().length >= 2;
}

/** A voucher that can be replaced: not cancelled and not used up (the server re-checks). */
export function replaceable(status: string | null | undefined): boolean {
  return status === 'active' || status === 'partially_used';
}

// ── Test batches ─────────────────────────────────────────────────────────────

/** What a test batch's name and type name start with (the server adds it). */
export const TEST_LABEL = 'שובר בדיקה';

export function isTestName(name: string | null | undefined): boolean {
  return !!name && (name === TEST_LABEL || name.startsWith(`${TEST_LABEL} · `));
}

// ── Reports ──────────────────────────────────────────────────────────────────

/** The exceptions' kinds by count, most first (ties by name) — the chips' order. */
export function kindsByCount(counts: Record<string, number>): { kind: string; count: number }[] {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

// ── Simulator ────────────────────────────────────────────────────────────────

export interface BasketLine {
  productId: string;
  quantity: string;
  /** ₪ per unit; '' = the shop's / catalog's price. */
  price: string;
}

/** The basket → the simulate request's lines; a line with a bad quantity or price is left out. */
export function simulateLines(basket: readonly BasketLine[]): { productId: string; quantity: number; price: number | null }[] {
  const out: { productId: string; quantity: number; price: number | null }[] = [];
  for (const l of basket) {
    const q = Number(l.quantity.trim().replace(',', '.'));
    if (!Number.isFinite(q) || q <= 0 || q > 1000) continue;
    const price = l.price.trim() ? shekelsFromText(l.price) : null;
    if (l.price.trim() && price === null) continue;
    out.push({ productId: l.productId, quantity: q, price });
  }
  return out;
}
