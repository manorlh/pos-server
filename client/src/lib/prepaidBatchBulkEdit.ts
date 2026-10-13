/**
 * "שינוי הגדרות לסדרות שנבחרו" — the same change for many batches (the cloud's
 * app/services/prepaid_voucher_bulk_edit.py; each batch goes through "ערוך סדרה").
 *
 * The dialog lists the settings that make sense for many batches; each has its own "שנה" box and
 * only the ticked ones are sent ([bulkChanges]) — an unticked setting stays as it is on every batch.
 * The cloud previews each batch (ok / unchanged / refused with the single edit's reason) and applies
 * them under one `clientRequestId`, so a retry after a lost answer never applies anything twice.
 */
import type { PrepaidBatchEditChange, PrepaidBatchEditEffects } from './prepaidBatchEdit';
import { commonVoucherFields, type VoucherField } from './voucherFields';

/** The cloud's cap (app/schemas/prepaid_voucher.py MAX_BULK_BATCHES). */
export const MAX_BULK_BATCHES = 200;

export type BulkField =
  | 'validFrom' | 'validUntil' | 'shopIds' | 'offlineAllowed'
  | 'stacking' | 'promotionPolicy' | 'maxUsesPerSale' | 'maxUsesPerDay'
  | 'splitAllowed' | 'includeExtras' | 'pricing' | 'tillValue' | 'allowTopUp' | 'redemptionAccounting' | 'discountBlockPolicy'
  | 'showCode' | 'showItems' | 'showValidity' | 'showCredit' | 'printTillValue' | 'barcodeType'
  | 'totalQty'
  // "מצב בדיקה" (every kind; each batch's own audit line).
  | 'testMode'
  // "סדרה פעילה" (every kind; each batch's own audit line, the reason with it).
  | 'active';

/**
 * Which batches a setting is for: every one, goods only (a discount is a discount on the document),
 * a discount only (its rules of use), a package's groups.
 */
export type BulkScope = 'all' | 'goods' | 'discount' | 'groups';

export type BulkSection = 'validity' | 'where' | 'rules' | 'accounting' | 'contents' | 'print' | 'test' | 'active';

export interface BulkFieldDef {
  field: BulkField;
  scope: BulkScope;
  section: BulkSection;
}

/** In the dialog's order. */
export const BULK_FIELDS: readonly BulkFieldDef[] = [
  { field: 'validFrom', scope: 'all', section: 'validity' },
  { field: 'validUntil', scope: 'all', section: 'validity' },
  { field: 'shopIds', scope: 'all', section: 'where' },
  { field: 'offlineAllowed', scope: 'all', section: 'where' },
  { field: 'stacking', scope: 'all', section: 'rules' },
  { field: 'promotionPolicy', scope: 'discount', section: 'rules' },
  { field: 'maxUsesPerSale', scope: 'discount', section: 'rules' },
  { field: 'maxUsesPerDay', scope: 'discount', section: 'rules' },
  { field: 'splitAllowed', scope: 'goods', section: 'contents' },
  { field: 'includeExtras', scope: 'goods', section: 'contents' },
  { field: 'totalQty', scope: 'groups', section: 'contents' },
  { field: 'pricing', scope: 'goods', section: 'accounting' },
  { field: 'tillValue', scope: 'goods', section: 'accounting' },
  { field: 'allowTopUp', scope: 'goods', section: 'accounting' },
  { field: 'redemptionAccounting', scope: 'goods', section: 'accounting' },
  { field: 'discountBlockPolicy', scope: 'goods', section: 'accounting' },
  { field: 'showCode', scope: 'all', section: 'print' },
  { field: 'showItems', scope: 'all', section: 'print' },
  { field: 'showValidity', scope: 'all', section: 'print' },
  { field: 'showCredit', scope: 'all', section: 'print' },
  { field: 'printTillValue', scope: 'goods', section: 'print' },
  { field: 'barcodeType', scope: 'all', section: 'print' },
  { field: 'testMode', scope: 'all', section: 'test' },
  { field: 'active', scope: 'all', section: 'active' },
];

export const BULK_SECTIONS: readonly BulkSection[] = ['active', 'validity', 'where', 'rules', 'contents', 'accounting', 'print', 'test'];

/** Settings of a batch, not of what its vouchers give (lib/voucherFields.ts knows nothing of them): always offered. */
const BATCH_ONLY_FIELDS: ReadonlySet<BulkField> = new Set<BulkField>(['testMode', 'active']);

/** The part of a batch the scope reads. */
export interface BulkBatchKind {
  kind?: string | null;
  selection?: string | null;
}

const DISCOUNT_KINDS = new Set(['order_discount', 'item_discount']);

export function scopeOf(field: BulkField): BulkScope {
  return BULK_FIELDS.find((f) => f.field === field)?.scope ?? 'all';
}

/** Whether [field] is one of [batch]'s settings (the cloud refuses the batch otherwise). */
export function fieldApplies(field: BulkField, batch: BulkBatchKind): boolean {
  const scope = scopeOf(field);
  const discount = DISCOUNT_KINDS.has(batch.kind ?? 'items');
  if (scope === 'goods') return !discount;
  if (scope === 'discount') return discount;
  if (scope === 'groups') return !discount && batch.selection === 'groups';
  return true;
}

/**
 * The settings the dialog offers for [batches]: only those every one of them has (lib/voucherFields.ts),
 * and whether they are of different kinds ("נבחרו סדרות מסוגים שונים — מוצגים רק השדות המשותפים").
 */
export function offeredFields(batches: readonly BulkBatchKind[]): { fields: BulkField[]; mixed: boolean } {
  const common = commonVoucherFields(batches.map((b) => ({ kind: b.kind, selection: b.selection })));
  const fields = BULK_FIELDS
    .map((d) => d.field)
    .filter((f) => (BATCH_ONLY_FIELDS.has(f) || common.visible.has(f as VoucherField)) && batches.every((b) => fieldApplies(f, b)));
  return { fields, mixed: common.mixed };
}

/**
 * A refusal of the single edit worded in English by the cloud's checks, as the dialog says it in
 * Hebrew — with the limit: "totalQty must be between 2 and 4", "tillValue is required for a fixed value".
 */
export function knownRefusal(reason: string | null | undefined):
  | { key: 'reasonTotalQty'; min: number; max: number }
  | { key: 'reasonFixedValue' }
  | null {
  const r = (reason ?? '').trim();
  const between = /^totalQty must be between (\d+) and (\d+)$/.exec(r);
  if (between) return { key: 'reasonTotalQty', min: Number(between[1]), max: Number(between[2]) };
  if (r === 'tillValue is required for a fixed value') return { key: 'reasonFixedValue' };
  return null;
}

/** How many of [batches] do not have [field] (0: every one does). */
export function notApplicableCount(field: BulkField, batches: readonly BulkBatchKind[]): number {
  return batches.filter((b) => !fieldApplies(field, b)).length;
}

/**
 * The `changes` body: each ticked setting's wire values, nothing else. [parts] holds every setting's
 * values as the form has them (a setting may be several wire fields — stacking and its maximum).
 */
export function bulkChanges(
  parts: Partial<Record<BulkField, Record<string, unknown>>>,
  ticked: ReadonlySet<BulkField>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const def of BULK_FIELDS) {
    if (!ticked.has(def.field)) continue;
    Object.assign(out, parts[def.field] ?? {});
  }
  return Object.keys(out).length ? { ...out, ...extra } : out;
}

// ── The selection on the batches list ────────────────────────────────────────

/** The picked batches still on the list (the filters decide what "all" is). */
export function selectedShown(selected: ReadonlySet<string>, shownIds: readonly string[]): string[] {
  return shownIds.filter((id) => selected.has(id));
}

/** "בחר הכל": every batch shown is picked; when they all are already, they are all un-picked. */
export function toggleAll(selected: ReadonlySet<string>, shownIds: readonly string[]): Set<string> {
  const next = new Set(selected);
  const all = shownIds.length > 0 && shownIds.every((id) => next.has(id));
  for (const id of shownIds) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

export function toggleOne(selected: ReadonlySet<string>, id: string, on: boolean): Set<string> {
  const next = new Set(selected);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

/** The "בחר הכל" box: on, off or partly. */
export function allState(selected: ReadonlySet<string>, shownIds: readonly string[]): 'all' | 'some' | 'none' {
  const n = selectedShown(selected, shownIds).length;
  if (n === 0) return 'none';
  return n === shownIds.length ? 'all' : 'some';
}

// ── The cloud's answer ───────────────────────────────────────────────────────

export type BulkPreviewStatus = 'ok' | 'unchanged' | 'refused';
export type BulkApplyStatus = 'applied' | 'unchanged' | 'refused';

export interface BulkBatchOutcome<S extends string = BulkPreviewStatus | BulkApplyStatus> {
  batchId: string;
  /** Null for a batch the user may not edit (nothing of it is told back). */
  name: string | null;
  customerName?: string | null;
  eventName?: string | null;
  kind?: string;
  status: S;
  /** The single edit's reason: a code (`prepaid_voucher_forbidden`) or its sentence. */
  reason?: string;
  message?: string;
  statusCode?: number;
  /** `prepaid_voucher_bulk_not_applicable`: the settings this batch does not have. */
  fields?: string[];
  changes?: PrepaidBatchEditChange[];
  effects?: PrepaidBatchEditEffects;
  confirm?: boolean;
  /** Sent, yet the same after (already so, or the single edit's own rule). */
  unchangedFields?: string[];
}

export interface BulkPreviewResult {
  items: BulkBatchOutcome<BulkPreviewStatus>[];
  summary: { total: number; ok: number; unchanged: number; refused: number };
  fields: string[];
}

export interface BulkApplyResult {
  items: BulkBatchOutcome<BulkApplyStatus>[];
  summary: { total: number; applied: number; unchanged: number; refused: number };
  fields: string[];
  clientRequestId: string;
  replayed: boolean;
}

export const NOT_APPLICABLE = 'prepaid_voucher_bulk_not_applicable';
export const BULK_FAILED = 'prepaid_voucher_bulk_failed';

/** The batches the apply will change (the preview's "ok"). */
export function willChange(preview: Pick<BulkPreviewResult, 'items'> | null | undefined): number {
  return (preview?.items ?? []).filter((i) => i.status === 'ok').length;
}

/** Refused first (to read), then changed, then unchanged — each in the order picked. */
export function outcomeOrder<T extends BulkBatchOutcome>(items: readonly T[]): T[] {
  const rank = (s: string) => (s === 'refused' ? 0 : s === 'unchanged' ? 2 : 1);
  return items.map((it, n) => ({ it, n })).sort((a, b) => rank(a.it.status) - rank(b.it.status) || a.n - b.n).map((x) => x.it);
}
