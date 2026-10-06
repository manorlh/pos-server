/**
 * "תצורת עבודה לעמדה" (`workflow_mode`) — the dashboard card's pure rules
 * (pos-server docs/SPEC_KDS.md §1–2, app/services/kds_workflow.py). Tested by
 * workflowMode.test.ts (`npm test`); no imports, so the test build compiles it alone.
 *
 * The server is the authority: it validates on save (422 `workflow_invalid`) and
 * normalizes at run time. These helpers only decide what the card shows — which
 * fields are relevant to the chosen mode(s), what is set at this level versus
 * inherited, and which companion values a change has to bring along so the card
 * never offers a contradictory combination in the first place.
 */

export type WorkflowModeName = 'DIRECT_SALE' | 'ORDER_PROCESS';
export type WorkflowTarget = 'printer' | 'kds' | 'kds_view' | 'expo' | 'pickup_screen';
export type PaymentPolicy = 'AFTER_PAYMENT' | 'BEFORE_PAYMENT';
export type WorkflowSource = 'POS' | 'HANDHELD' | 'KIOSK';
export type WorkflowScopeType = 'company' | 'shop' | 'area' | 'machine';
export type WorkflowProfileName = 'kiosk_bon' | 'kiosk_kds' | 'counter' | 'counter_prep' | 'handheld_tables';
export type WorkflowStep =
  | 'select'
  | 'pay'
  | 'documents'
  | 'handover'
  | 'release'
  | 'queued'
  | 'preparing'
  | 'ready'
  | 'handed_over';

export const MODES: WorkflowModeName[] = ['DIRECT_SALE', 'ORDER_PROCESS'];
export const TARGETS: WorkflowTarget[] = ['printer', 'kds', 'kds_view', 'expo', 'pickup_screen'];
export const PAYMENT_POLICIES: PaymentPolicy[] = ['AFTER_PAYMENT', 'BEFORE_PAYMENT'];
export const SOURCES: WorkflowSource[] = ['POS', 'HANDHELD', 'KIOSK'];
export const PROFILE_NAMES: WorkflowProfileName[] = [
  'kiosk_bon',
  'kiosk_kds',
  'counter',
  'counter_prep',
  'handheld_tables',
];
export const INACTIVITY_MIN = 15;
export const INACTIVITY_MAX = 3600;

/** One field per till parameter (kdsEnabled, workflowMode, …) — the server's `PARAM_KEYS`. */
export interface WorkflowConfig {
  enabled: boolean;
  defaultMode: WorkflowModeName;
  allowedModes: WorkflowModeName[];
  workerCanSwitch: boolean;
  targets: WorkflowTarget[];
  paymentPolicy: PaymentPolicy;
  requireStartPreparation: boolean;
  requireExpo: boolean;
  trackHandover: boolean;
  readyNotification: boolean;
  printerFallback: boolean;
  source: WorkflowSource;
  inactivityTable: number | null;
  inactivityQuick: number | null;
  inactivityKiosk: number | null;
}

export type WorkflowField = keyof WorkflowConfig;

/** The card's order. */
export const WORKFLOW_FIELDS: WorkflowField[] = [
  'enabled',
  'defaultMode',
  'allowedModes',
  'workerCanSwitch',
  'source',
  'targets',
  'paymentPolicy',
  'requireStartPreparation',
  'requireExpo',
  'trackHandover',
  'readyNotification',
  'printerFallback',
  'inactivityTable',
  'inactivityQuick',
  'inactivityKiosk',
];

export const INACTIVITY_FIELDS: WorkflowField[] = ['inactivityTable', 'inactivityQuick', 'inactivityKiosk'];

/** The server's `DEFAULTS` — the legacy behaviour. */
export const WORKFLOW_DEFAULTS: WorkflowConfig = {
  enabled: false,
  defaultMode: 'DIRECT_SALE',
  allowedModes: ['DIRECT_SALE'],
  workerCanSwitch: false,
  targets: ['printer'],
  paymentPolicy: 'AFTER_PAYMENT',
  requireStartPreparation: false,
  requireExpo: false,
  trackHandover: true,
  readyNotification: false,
  printerFallback: true,
  source: 'POS',
  inactivityTable: null,
  inactivityQuick: null,
  inactivityKiosk: null,
};

/** `describe()`: the normalized configuration and what is derived from it. */
export interface EffectiveWorkflow extends WorkflowConfig {
  configVersion: string;
  profile: WorkflowProfileName | null;
  steps: Partial<Record<WorkflowModeName, WorkflowStep[]>>;
  /** Only for a kiosk: BON ⇔ DIRECT_SALE + printer, KDS ⇔ ORDER_PROCESS + KDS. */
  kioskFulfillmentMode?: 'BON' | 'KDS';
}

export interface WorkflowIssue {
  code: string;
  field: WorkflowField | null;
}

/** Changes at one level: a value sets it here, null returns it to inheritance. */
export type WorkflowValues = { [K in WorkflowField]?: WorkflowConfig[K] | null };

/** `GET /workflow/config` and its preview (`level_view`). */
export interface WorkflowLevelView {
  scopeType: WorkflowScopeType;
  scopeId: string;
  shopId: string | null;
  /** Set exactly at this level (lists already split). */
  own: Partial<WorkflowConfig>;
  /** What the levels above give (defaults filled in). */
  inherited: WorkflowConfig;
  /** This level's configuration before normalization (with the preview's changes). */
  raw: WorkflowConfig;
  effective: EffectiveWorkflow;
  errors: WorkflowIssue[];
  warnings: WorkflowIssue[];
  /** Active KDS screens of the shop by role; null at company level. */
  devices: Record<string, number> | null;
  profiles: Partial<Record<WorkflowProfileName, Partial<WorkflowConfig>>>;
  defaults: WorkflowConfig;
}

// ── Values ──────────────────────────────────────────────────────────────────────

function has(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function sameValue(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (Array.isArray(x) && Array.isArray(y)) {
    return x.length === y.length && x.every((v, i) => v === y[i]);
  }
  return x === y;
}

function copy<T>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T;
}

/** The value of each field at this level with the draft applied (null in the draft → inherited). */
export function currentValues(
  view: Pick<WorkflowLevelView, 'own' | 'inherited'>,
  draft: WorkflowValues = {},
): WorkflowConfig {
  const out = { ...WORKFLOW_DEFAULTS } as Record<WorkflowField, unknown>;
  for (const field of WORKFLOW_FIELDS) {
    const inherited = has(view.inherited, field) ? view.inherited[field] : WORKFLOW_DEFAULTS[field];
    if (has(draft, field)) {
      const v = draft[field];
      out[field] = copy(v === null || v === undefined ? inherited : v);
    } else if (has(view.own, field) && view.own[field] !== null && view.own[field] !== undefined) {
      out[field] = copy(view.own[field]);
    } else {
      out[field] = copy(inherited);
    }
  }
  return out as unknown as WorkflowConfig;
}

/** Whether the field is set at this level (after the draft) rather than inherited. */
export function isSetHere(field: WorkflowField, own: Partial<WorkflowConfig>, draft: WorkflowValues = {}): boolean {
  if (has(draft, field)) return draft[field] !== null && draft[field] !== undefined;
  return has(own, field) && own[field] !== null && own[field] !== undefined;
}

/** The draft entries that differ from what is stored at this level — the body of the save. */
export function pendingChanges(own: Partial<WorkflowConfig>, draft: WorkflowValues): WorkflowValues {
  const out: WorkflowValues = {};
  for (const field of WORKFLOW_FIELDS) {
    if (!has(draft, field)) continue;
    const before = has(own, field) ? own[field] : null;
    const after = draft[field];
    if (!sameValue(before, after)) (out as Record<string, unknown>)[field] = copy(after ?? null);
  }
  return out;
}

// ── Relevance ───────────────────────────────────────────────────────────────────

const PROCESS_ONLY: WorkflowField[] = ['requireStartPreparation', 'trackHandover', 'readyNotification'];

/**
 * The fields the card shows for this configuration: off — the master switch (and the
 * inactivity timers, which apply either way); DIRECT_SALE only — no preparation
 * fields; ORDER_PROCESS — the lifecycle; requireExpo only with the Expo target; the
 * payment policy only for a till or handheld (a kiosk always releases after payment);
 * the worker switch only with two modes. A field with an issue is always shown, so an
 * error is never hidden from the person who has to fix it.
 */
export function visibleFields(config: WorkflowConfig, issues: WorkflowIssue[] = []): WorkflowField[] {
  const show = new Set<WorkflowField>(['enabled']);
  const kiosk = config.source === 'KIOSK';
  if (config.enabled) {
    const allowed = config.allowedModes ?? [];
    const targets = config.targets ?? [];
    const process = allowed.includes('ORDER_PROCESS');
    show.add('defaultMode');
    show.add('allowedModes');
    show.add('source');
    show.add('targets');
    if (allowed.length > 1) show.add('workerCanSwitch');
    if (!kiosk) show.add('paymentPolicy');
    if (process) for (const f of PROCESS_ONLY) show.add(f);
    if (process && targets.includes('expo')) show.add('requireExpo');
    const screens = targets.some((t) => t === 'kds' || t === 'kds_view' || t === 'expo');
    if (screens && !targets.includes('printer')) show.add('printerFallback');
    if (kiosk) show.add('inactivityKiosk');
    else {
      show.add('inactivityTable');
      show.add('inactivityQuick');
    }
  } else {
    for (const f of INACTIVITY_FIELDS) show.add(f);
  }
  for (const f of INACTIVITY_FIELDS) if (config[f] !== null && config[f] !== undefined) show.add(f);
  for (const issue of issues) if (issue.field && has(WORKFLOW_DEFAULTS, issue.field)) show.add(issue.field);
  return WORKFLOW_FIELDS.filter((f) => show.has(f));
}

/** The target checkboxes offered: Expo and the pickup screen only with ORDER_PROCESS (or when already chosen). */
export function visibleTargets(config: WorkflowConfig): WorkflowTarget[] {
  const process = (config.allowedModes ?? []).includes('ORDER_PROCESS');
  const chosen = config.targets ?? [];
  return TARGETS.filter((t) => t === 'printer' || t === 'kds' || t === 'kds_view' || process || chosen.includes(t));
}

/**
 * The companion values a configuration needs so it is not contradictory (§7): without
 * ORDER_PROCESS no preparation fields, no Expo and no pickup screen; one mode — no
 * worker switch; no Expo — no "ready only from the Expo"; a kiosk — after payment.
 * Only the values that actually conflict are returned.
 */
export function fixesFor(config: WorkflowConfig): WorkflowValues {
  const out: WorkflowValues = {};
  const allowed = config.allowedModes ?? [];
  let targets = config.targets ?? [];
  const process = allowed.includes('ORDER_PROCESS');
  if (!process) {
    if (config.requireStartPreparation) out.requireStartPreparation = false;
    if (config.requireExpo) out.requireExpo = false;
    if (config.readyNotification) out.readyNotification = false;
    const kept = targets.filter((t) => t !== 'expo' && t !== 'pickup_screen');
    if (kept.length !== targets.length) {
      targets = kept.length ? kept : ['printer'];
      out.targets = targets;
    }
  }
  if (allowed.length < 2 && config.workerCanSwitch) out.workerCanSwitch = false;
  if (!targets.includes('expo') && config.requireExpo && out.requireExpo === undefined) out.requireExpo = false;
  if (config.source === 'KIOSK' && config.paymentPolicy === 'BEFORE_PAYMENT') out.paymentPolicy = 'AFTER_PAYMENT';
  return out;
}

/** A patch plus the companion fixes it needs, given the values it lands on. */
export function withFixes(
  view: Pick<WorkflowLevelView, 'own' | 'inherited'>,
  draft: WorkflowValues,
  patch: WorkflowValues,
): WorkflowValues {
  const merged = currentValues(view, { ...draft, ...patch });
  return { ...patch, ...fixesFor(merged) };
}

/** Picking a default mode: it must be allowed — with one mode allowed, the choice replaces it. */
export function chooseDefaultMode(config: WorkflowConfig, mode: WorkflowModeName): WorkflowValues {
  const allowed = config.allowedModes ?? [];
  return {
    defaultMode: mode,
    allowedModes: allowed.includes(mode) ? [...allowed] : [mode],
  };
}

/** Allowing / disallowing a mode; the default mode cannot be removed. Kept in the server's order. */
export function toggleMode(config: WorkflowConfig, mode: WorkflowModeName, on: boolean): WorkflowModeName[] {
  const allowed = new Set(config.allowedModes ?? []);
  if (on) allowed.add(mode);
  else if (mode !== config.defaultMode) allowed.delete(mode);
  return MODES.filter((m) => allowed.has(m));
}

/** Checking / unchecking a target; the last one stays (an empty list is refused). */
export function toggleTarget(targets: WorkflowTarget[], target: WorkflowTarget, on: boolean): WorkflowTarget[] {
  const set = new Set(targets ?? []);
  if (on) set.add(target);
  else if (set.size > 1) set.delete(target);
  return TARGETS.filter((t) => set.has(t));
}

/**
 * A profile ("פרופיל") as a patch: its own values, plus the companion fixes for the
 * fields it does not mention, when `current` is given. Unknown name → empty patch.
 */
export function applyProfile(
  name: string,
  profiles: Partial<Record<string, Partial<WorkflowConfig>>>,
  current?: WorkflowConfig,
): WorkflowValues {
  const preset = profiles[name];
  if (!preset) return {};
  const patch: WorkflowValues = { enabled: true };
  for (const field of WORKFLOW_FIELDS) {
    if (has(preset, field)) (patch as Record<string, unknown>)[field] = copy(preset[field]);
  }
  if (!current) return patch;
  const merged = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) merged[k] = v;
  return { ...patch, ...fixesFor(merged as unknown as WorkflowConfig) };
}

/** The profile a configuration matches, as the server's `profile_of` does. */
export function profileOf(
  config: WorkflowConfig,
  profiles: Partial<Record<string, Partial<WorkflowConfig>>>,
): string | null {
  if (!config.enabled) return null;
  for (const [name, preset] of Object.entries(profiles)) {
    if (!preset) continue;
    const fields = Object.keys(preset) as WorkflowField[];
    if (fields.every((f) => sameValue(config[f], preset[f]))) return name;
  }
  return null;
}

// ── Steps, issues, input ────────────────────────────────────────────────────────

const STEPS: Record<WorkflowModeName, WorkflowStep[]> = {
  DIRECT_SALE: ['select', 'pay', 'documents', 'handover'],
  ORDER_PROCESS: ['select', 'release', 'queued', 'preparing', 'ready', 'handed_over'],
};

/** The steps a mode shows in the preview (the server's `STEPS`). */
export function stepsFor(mode: WorkflowModeName): WorkflowStep[] {
  return [...(STEPS[mode] ?? [])];
}

/** Every validation code of SPEC_KDS.md §2 → its key under `kds.issues`. */
const ISSUE_KEYS: Record<string, string> = {
  ready_notification_requires_order_process: 'readyNotificationRequiresOrderProcess',
  ready_notification_requires_ready_source: 'readyNotificationRequiresReadySource',
  pickup_screen_requires_order_process: 'pickupScreenRequiresOrderProcess',
  pickup_screen_requires_managed_state: 'pickupScreenRequiresManagedState',
  require_expo_requires_expo_target: 'requireExpoRequiresExpoTarget',
  order_process_field_in_direct_sale: 'orderProcessFieldInDirectSale',
  kiosk_releases_after_payment: 'kioskReleasesAfterPayment',
  default_mode_not_allowed: 'defaultModeNotAllowed',
  allowed_modes_empty: 'allowedModesEmpty',
  targets_empty: 'targetsEmpty',
  unknown_mode: 'unknownMode',
  unknown_target: 'unknownTarget',
  unknown_payment_policy: 'unknownPaymentPolicy',
  unknown_source: 'unknownSource',
  inactivity_out_of_range: 'inactivityOutOfRange',
  kds_target_without_device: 'kdsTargetWithoutDevice',
  expo_target_without_device: 'expoTargetWithoutDevice',
  pickup_screen_without_device: 'pickupScreenWithoutDevice',
  devices_checked_per_shop: 'devicesCheckedPerShop',
  switch_needs_two_modes: 'switchNeedsTwoModes',
  kds_view_only_in_direct_sale: 'kdsViewOnlyInDirectSale',
  process_managed_at_till: 'processManagedAtTill',
};

export const ISSUE_CODES = Object.keys(ISSUE_KEYS);

/** The `kds.issues.*` key of a validation code; `unknown` (shown with the code) for a new one. */
export function issueText(code: string): string {
  return ISSUE_KEYS[code] ?? 'unknown';
}

/** The issues of one field. */
export function issuesFor(field: WorkflowField, issues: WorkflowIssue[]): WorkflowIssue[] {
  return issues.filter((i) => i.field === field);
}

/** An inactivity input: empty → off (null); anything else as a number for the server to validate. */
export function secondsFromInput(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** A 422 `workflow_invalid` from the save: its errors and warnings, else null. */
export function workflowRejection(err: unknown): { errors: WorkflowIssue[]; warnings: WorkflowIssue[] } | null {
  const res = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
  const detail = res?.data?.detail as { code?: unknown; errors?: unknown; warnings?: unknown } | undefined;
  if (!detail || typeof detail !== 'object' || detail.code !== 'workflow_invalid') return null;
  const list = (v: unknown): WorkflowIssue[] =>
    Array.isArray(v)
      ? v
          .filter((i): i is { code: string; field?: unknown } => !!i && typeof (i as { code?: unknown }).code === 'string')
          .map((i) => ({ code: i.code, field: typeof i.field === 'string' ? (i.field as WorkflowField) : null }))
      : [];
  return { errors: list(detail.errors), warnings: list(detail.warnings) };
}

/** The `code` of a KDS refusal (`{"detail": {"code": …}}`), or a plain string detail. */
export function errorCodeOf(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (detail && typeof detail === 'object' && typeof (detail as { code?: unknown }).code === 'string') {
    return (detail as { code: string }).code;
  }
  return null;
}
