/**
 * "מצב הדרכה" in a shop (docs/SPEC_TRAINING_MODE.md) — the shapes the server sends and the
 * small rules the dashboard applies to them. No imports, so `npm test` compiles it alone.
 *
 * The API calls are in lib/trainingModeApi.ts and lib/demoMenuApi.ts.
 */

// ── Training mode ───────────────────────────────────────────────────────────────

export interface TrainingUserRef {
  id: string;
  name: string;
}

/** What sits in the quarantine table now (`training_documents`), by kind. */
export interface TrainingCounts {
  transaction: number;
  shift: number;
  z: number;
  x: number;
  other: number;
}

export interface TrainingLogEntry {
  id: string;
  /** `dropped`: a training document from a till that arrived after the mode was turned off. */
  action: 'enabled' | 'disabled' | 'dropped';
  at: string;
  userName: string | null;
  machineName: string | null;
  details: Record<string, unknown> | null;
}

export interface TrainingModeStatus {
  shopId: string;
  shopName: string;
  trainingMode: boolean;
  startedAt: string | null;
  startedBy: TrainingUserRef | null;
  endedAt: string | null;
  endedBy: TrainingUserRef | null;
  /** May turn it on and off (super admin, dealer, or a manager who manages the shop). */
  canManage: boolean;
  /**
   * False while no device implements training mode (server `training_mode.AVAILABLE`): it
   * cannot be turned on — 409 `training_not_available` — since a practice sale would be a
   * real tax document. Turning it off stays open.
   */
  available?: boolean;
  counts: TrainingCounts;
  /** Newest first, at most 20. */
  log: TrainingLogEntry[];
}

/**
 * Whether a new shop may open in training mode: false while no device implements it (as the
 * server's `training_mode.AVAILABLE`, which refuses it with 409 `training_not_available`).
 */
export const TRAINING_MODE_AVAILABLE = false;

/** Whether "הפעל מצב הדרכה" may be offered: only a server that says so. */
export function trainingCanBeEnabled(data: Pick<TrainingModeStatus, 'available'>): boolean {
  return data.available === true;
}

export interface TrainingTillRef {
  machineId: string;
  name: string;
  posNumber: number | null;
}

export interface UnsyncedTillBlocker extends TrainingTillRef {
  code: 'unsynced_till';
  pendingDocuments: number | null;
  pendingCount: number | null;
  /** When the till last reported its queue. */
  asOf: string | null;
}

export interface OpenTablesBlocker {
  code: 'open_tables';
  count: number;
  tables: { number: number | null; name: string | null }[];
}

export type TrainingBlocker = UnsyncedTillBlocker | OpenTablesBlocker;

/** What the disable would delete — the quarantine plus the shop's open table orders. */
export interface TrainingDeletionCounts {
  transactions: number;
  shifts: number;
  zReports: number;
  xReports: number;
  other: number;
  tableOrders: number;
}

export interface DemoMenuLoad {
  loadId: string;
  template: string;
  templateName: string;
  /** Null: loaded for the whole company. */
  shopId: string | null;
  createdAt: string;
  /** Per entity type (`category`, `product`, `modifier_group`, …). */
  counts: Record<string, number>;
}

export interface TrainingDisablePreview {
  shopId: string;
  shopName: string;
  trainingMode: boolean;
  counts: TrainingDeletionCounts & { openTables: number };
  blockers: TrainingBlocker[];
  demoMenu: { loaded: boolean; loads: DemoMenuLoad[] };
}

export interface TrainingDisableBody {
  confirmName: string;
  removeDemoMenu: boolean;
  force: boolean;
}

export interface DemoMenuRemoveResult {
  deleted: Record<string, number>;
  /** Products already sold in a real sale: made inactive, not deleted. */
  deactivated: Record<string, number>;
  kept: Record<string, number>;
}

export interface TrainingDisableResult {
  status: TrainingModeStatus;
  deleted: TrainingDeletionCounts;
  demoMenu: DemoMenuRemoveResult | null;
}

export interface TrainingReport {
  count: number;
  total: number;
  refunds: { count: number; total: number };
  firstAt: string | null;
  lastAt: string | null;
  shifts: number;
  zReports: number;
  byTill: (TrainingTillRef & { count: number; total: number })[];
  topItems: { name: string; quantity: number; total: number }[];
  /** `method` is the till's raw tender code (`cash`, `card`, `credit`, …). */
  byPayment: { method: string; count: number; amount: number }[];
}

// ── Demo menu ───────────────────────────────────────────────────────────────────

export type DemoTemplateKey = 'restaurant' | 'bar' | 'cafe' | 'restaurant_bar';

/** A template's contents, as the templates list counts them. */
export interface DemoTemplateCounts {
  categories: number;
  products: number;
  groups: number;
  meals: number;
  upsells: number;
  notes: number;
  courses: number;
}

export interface DemoTemplate {
  key: DemoTemplateKey | string;
  name: string;
  description: string;
  counts: DemoTemplateCounts;
}

export interface DemoMenuStatus {
  companyId: string;
  shopId: string | null;
  canManage: boolean;
  loaded: boolean;
  /** The loads that reach this shop: scoped to it, or company-wide. */
  loads: DemoMenuLoad[];
}

export interface DemoMenuLoadBody {
  companyId: string;
  shopId: string | null;
  template: string;
}

export interface DemoMenuRemovePreview {
  loadId: string;
  template: string;
  templateName: string;
  counts: Record<string, number>;
  /** Products sold in a real sale — they are made inactive rather than deleted. */
  soldProducts: number;
  /** Tracked rows already gone (deleted by hand). */
  missing: number;
}

// ── Rules ───────────────────────────────────────────────────────────────────────

/** The entity types a demo menu creates, in the order they are listed. */
export const DEMO_ENTITY_ORDER = [
  'category',
  'product',
  'meal',
  'modifier_group',
  'upsell',
  'course',
  'prep_note',
] as const;

/** Entity → count pairs, in `DEMO_ENTITY_ORDER` then any other type by name; zeros dropped. */
export function entityCountEntries(counts: Record<string, number> | null | undefined): [string, number][] {
  const entries = Object.entries(counts ?? {}).filter(([, n]) => typeof n === 'number' && n > 0);
  const rank = (k: string) => {
    const i = (DEMO_ENTITY_ORDER as readonly string[]).indexOf(k);
    return i < 0 ? DEMO_ENTITY_ORDER.length : i;
  };
  return entries.sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/** A template's counts under the entity-type keys the loads and the removal use. */
export function templateCountsAsEntities(c: Partial<DemoTemplateCounts> | null | undefined): Record<string, number> {
  const v = c ?? {};
  return {
    category: v.categories ?? 0,
    product: v.products ?? 0,
    meal: v.meals ?? 0,
    modifier_group: v.groups ?? 0,
    upsell: v.upsells ?? 0,
    course: v.courses ?? 0,
    prep_note: v.notes ?? 0,
  };
}

export type DeletionKey = keyof TrainingDeletionCounts;

/**
 * The lines of "what will be / was deleted": sales, shifts, Z and X always (a zero says
 * so plainly), the rest only when there is something.
 */
export function deletionEntries(counts: Partial<TrainingDeletionCounts> | null | undefined): [DeletionKey, number][] {
  const c = counts ?? {};
  const always: DeletionKey[] = ['transactions', 'shifts', 'zReports', 'xReports'];
  const optional: DeletionKey[] = ['other', 'tableOrders'];
  return [
    ...always.map((k): [DeletionKey, number] => [k, c[k] ?? 0]),
    ...optional.filter((k) => (c[k] ?? 0) > 0).map((k): [DeletionKey, number] => [k, c[k] ?? 0]),
  ];
}

export function deletionTotal(counts: Partial<TrainingDeletionCounts> | null | undefined): number {
  return deletionEntries(counts).reduce((sum, [, n]) => sum + n, 0);
}

/** Anything in the quarantine — the training report is worth showing. */
export function hasQuarantinedData(counts: Partial<TrainingCounts> | null | undefined): boolean {
  const c = counts ?? {};
  return (c.transaction ?? 0) + (c.shift ?? 0) + (c.z ?? 0) + (c.x ?? 0) + (c.other ?? 0) > 0;
}

export function splitBlockers(blockers: TrainingBlocker[] | null | undefined): {
  unsyncedTills: UnsyncedTillBlocker[];
  openTables: OpenTablesBlocker | null;
} {
  const list = blockers ?? [];
  return {
    unsyncedTills: list.filter((b): b is UnsyncedTillBlocker => b.code === 'unsynced_till'),
    openTables: list.find((b): b is OpenTablesBlocker => b.code === 'open_tables') ?? null,
  };
}

/** Past the checks: nothing blocks, or the user ticked "הבנתי, להמשיך בכל זאת". */
export function canPassChecks(blockers: TrainingBlocker[] | null | undefined, force: boolean): boolean {
  return (blockers ?? []).length === 0 || force;
}

/** The typed confirmation: the shop's name exactly, spaces around it aside. */
export function confirmNameMatches(typed: string, shopName: string): boolean {
  const want = shopName.trim();
  return want.length > 0 && typed.trim() === want;
}

/** How many documents a till still has to send, as best it reported. */
export function pendingOf(b: UnsyncedTillBlocker): number | null {
  return b.pendingDocuments ?? b.pendingCount ?? null;
}

/** A table by its number, else its name. */
export function tableLabel(t: { number: number | null; name: string | null }): string | null {
  if (t.number !== null && t.number !== undefined) return String(t.number);
  const name = t.name?.trim();
  return name ? name : null;
}

/** An axios error's status and, for a structured FastAPI error, its `detail.code`. */
export function apiErrorInfo(err: unknown): {
  status: number | undefined;
  code: string | undefined;
  detail: Record<string, unknown> | undefined;
} {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
  const raw = res?.data?.detail;
  const detail = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  const code = typeof detail?.code === 'string' ? detail.code : typeof raw === 'string' ? raw : undefined;
  return { status: res?.status, code, detail };
}

/** A shop row without the training fields — an edit never sends them back. */
export function withoutTrainingFields<T extends { trainingMode?: unknown; trainingStartedAt?: unknown }>(
  v: T,
): Omit<T, 'trainingMode' | 'trainingStartedAt'> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { trainingMode, trainingStartedAt, ...rest } = v;
  return rest;
}
