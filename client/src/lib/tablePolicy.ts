/**
 * Table policies ("סוגי שולחנות") — pos-server app/services/table_policies.py.
 *
 * A table is regular, staff ("שולחן עובדים": staff meals, the employee picked at the
 * till) or managers ("שולחן מנהלים": a reason and a manager's PIN at the till, up to
 * 100% — "הוצאת מנהלים"), with a discount % ("הנחת שולחן") applied at the till through
 * its ordinary basket discount. A table names a type (reusable across tables) or has its
 * own kind and discount. Pure, so the editor's rules are tested with `npm test`.
 */

export const TABLE_KINDS = ['regular', 'staff', 'managers'] as const;
export type TableKind = (typeof TABLE_KINDS)[number];

export const STAFF_MODES = ['percent', 'price_list', 'allowance'] as const;
export type StaffMode = (typeof STAFF_MODES)[number];

/** What the till applies on a table (the server's resolved `policy`). */
export interface TablePolicy {
  kind: TableKind;
  discountPercent: number;
  typeId: string | null;
  typeName: string | null;
  requireEmployee: boolean;
  requireApproval: boolean;
  requireReason: boolean;
  staffMode: StaffMode;
  staffAllowance: number | null;
}

/** A table type ("סוג שולחן"). */
export interface TableType {
  id: string;
  shopId: string;
  name: string;
  kind: TableKind;
  discountPercent: number;
  requireApproval: boolean;
  requireReason: boolean;
  staffMode: StaffMode;
  staffAllowance: number | null;
  sortOrder: number;
}

/** The policy part of a table's form, as typed. */
export interface PolicyDraft {
  /** A type's id, or '' for the table's own policy. */
  typeId: string;
  kind: TableKind;
  /** As typed: '' is none. */
  discount: string;
}

export type PolicyError = 'discount_invalid' | 'kind_invalid' | 'type_missing';

/** A discount as typed: a number 0–100 with at most two decimals; '' is none (0). */
export function parseDiscount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 100 ? value : null;
}

/** What is wrong with a table's policy as typed (none: []), against the shop's live [types]. */
export function validatePolicyDraft(draft: PolicyDraft, types: readonly TableType[]): PolicyError[] {
  const errors: PolicyError[] = [];
  if (draft.typeId) {
    if (!types.some((t) => t.id === draft.typeId)) errors.push('type_missing');
    return errors;
  }
  if (!(TABLE_KINDS as readonly string[]).includes(draft.kind)) errors.push('kind_invalid');
  if (parseDiscount(draft.discount) === null) errors.push('discount_invalid');
  return errors;
}

/**
 * The body fields of a table create / update from its draft: a type, or the table's own
 * kind and discount (a type set keeps the table's own fields as they were; 0 clears the discount).
 */
export function policyBody(draft: PolicyDraft): { typeId: string | null; kind?: TableKind; discountPercent?: number | null } {
  if (draft.typeId) return { typeId: draft.typeId };
  const discount = parseDiscount(draft.discount) ?? 0;
  return { typeId: null, kind: draft.kind, discountPercent: discount > 0 ? discount : null };
}

/** The draft of a table as stored. */
export function draftOf(table: { typeId?: string | null; kind?: TableKind | null; discountPercent?: number | null } | null): PolicyDraft {
  return {
    typeId: table?.typeId ?? '',
    kind: table?.kind ?? 'regular',
    discount: table?.discountPercent ? String(table.discountPercent) : '',
  };
}

/** The policy the till will apply for a draft — as the server resolves it. */
export function resolveDraft(draft: PolicyDraft, types: readonly TableType[]): TablePolicy {
  const t = draft.typeId ? types.find((x) => x.id === draft.typeId) : undefined;
  if (t) {
    return {
      kind: t.kind,
      discountPercent: t.discountPercent,
      typeId: t.id,
      typeName: t.name,
      requireEmployee: t.kind === 'staff',
      requireApproval: t.requireApproval || t.kind === 'managers',
      requireReason: t.requireReason,
      staffMode: t.staffMode,
      staffAllowance: t.staffAllowance,
    };
  }
  const kind = (TABLE_KINDS as readonly string[]).includes(draft.kind) ? draft.kind : 'regular';
  return {
    kind,
    discountPercent: parseDiscount(draft.discount) ?? 0,
    typeId: null,
    typeName: null,
    requireEmployee: kind === 'staff',
    requireApproval: kind === 'managers',
    requireReason: kind === 'managers',
    staffMode: 'percent',
    staffAllowance: null,
  };
}

/** "12.5", "10", "100" — a percent as the badge writes it. */
export function percentText(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
}

/**
 * The small badge on a table (as the till's map shows it): its kind when it is not
 * regular — the label comes from the caller's translations — and its discount.
 * Null for an ordinary table with no discount.
 */
export function policyBadge(
  policy: Pick<TablePolicy, 'kind' | 'discountPercent'> | null | undefined,
): { kind: Exclude<TableKind, 'regular'> | null; discount: string | null } | null {
  if (!policy) return null;
  const kind = policy.kind === 'staff' || policy.kind === 'managers' ? policy.kind : null;
  const discount = policy.discountPercent > 0 ? `-${percentText(policy.discountPercent)}%` : null;
  if (!kind && !discount) return null;
  return { kind, discount };
}

/** A type's form as typed. */
export interface TypeDraft {
  name: string;
  kind: TableKind;
  discount: string;
  requireApproval: boolean;
  requireReason: boolean;
  staffMode: StaffMode;
  allowance: string;
}

export type TypeError = 'name_required' | 'discount_invalid' | 'allowance_invalid';

export function validateTypeDraft(draft: TypeDraft): TypeError[] {
  const errors: TypeError[] = [];
  if (!draft.name.trim()) errors.push('name_required');
  if (draft.name.trim().length > 60) errors.push('name_required');
  if (parseDiscount(draft.discount) === null) errors.push('discount_invalid');
  if (draft.kind === 'staff' && draft.staffMode === 'allowance') {
    const a = draft.allowance.trim();
    if (a === '' || !/^\d{1,6}(\.\d{1,2})?$/.test(a)) errors.push('allowance_invalid');
  }
  return errors;
}

/** The type's create / update body from its draft. A managers' type always asks for a manager. */
export function typeBody(draft: TypeDraft): {
  name: string;
  kind: TableKind;
  discountPercent: number;
  requireApproval: boolean;
  requireReason: boolean;
  staffMode: StaffMode;
  staffAllowance: number | null;
} {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    discountPercent: parseDiscount(draft.discount) ?? 0,
    requireApproval: draft.kind === 'managers' ? true : draft.requireApproval,
    requireReason: draft.requireReason,
    staffMode: draft.kind === 'staff' ? draft.staffMode : 'percent',
    staffAllowance: draft.kind === 'staff' && draft.staffMode === 'allowance' ? Number(draft.allowance) : null,
  };
}

export function typeDraftOf(t: TableType | null): TypeDraft {
  return {
    name: t?.name ?? '',
    kind: t?.kind ?? 'regular',
    discount: t && t.discountPercent ? String(t.discountPercent) : '',
    requireApproval: t?.requireApproval ?? false,
    requireReason: t?.requireReason ?? false,
    staffMode: t?.staffMode ?? 'percent',
    allowance: t?.staffAllowance != null ? String(t.staffAllowance) : '',
  };
}

/** The meals report ("ארוחות עובדים ומנהלים", `/tables/meals-report`). */
export interface MealTotals {
  count: number;
  before: number;
  discount: number;
  paid: number;
}

export interface MealEmployeeRow extends MealTotals {
  kind: 'staff' | 'managers';
  employeeId: string | null;
  employee: string | null;
}

export interface MealRow {
  transactionId: string;
  transactionNumber: string;
  at: string | null;
  kind: 'staff' | 'managers';
  employeeId: string | null;
  employee: string | null;
  reason: string | null;
  approvedBy: string | null;
  before: number;
  discount: number;
  paid: number;
  percent: number | null;
}

export interface MealsReport {
  from: string;
  to: string;
  staff: MealTotals;
  managers: MealTotals;
  byEmployee: MealEmployeeRow[];
  meals: MealRow[];
}

/** The employees the report can be filtered by: each once, by name. */
export function mealEmployees(report: Pick<MealsReport, 'byEmployee'> | null | undefined): string[] {
  const names = new Set<string>();
  for (const r of report?.byEmployee ?? []) if (r.employee) names.add(r.employee);
  return [...names].sort((a, b) => a.localeCompare(b, 'he'));
}
