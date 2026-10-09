/**
 * "אפליקציה אחת לכל פלטפורמה, וכל תפקיד בה" (web-till spec v2 §6): the device's ROLE, the MODE it
 * shows now and the ROLES ALLOWED to it — one pure state machine for every host (the browser's
 * `/app`, the Windows app, the APK, the iOS shell). Pinned by server/tests/fixtures/
 * device_mode_golden.json (deviceMode.test.ts here; the APK passes the same corpus in P6-8).
 *
 *  - `role` is the owner's (super admin / distributor, at pairing and on the dashboard);
 *  - `rolesAllowed` too: `deviceRolesAllowed`, plus {till, kiosk} when `kioskTillModeEnabled` —
 *    empty (or only the role itself) = the feature does not exist: no button, no menu, no switch;
 *  - `mode` is the business's choice inside `rolesAllowed` ∪ {role}; it starts as the role, is
 *    persisted (`persisted`), survives restarts, and resets to the new role when the owner changes
 *    the role.
 *
 * A switch (spec v2 §6.6, kiosk-landscape-till-mode.md §5.4–§5.9):
 *  - on the device: always a manager code with KIOSK_TILL_MODE (checked by the engine; here the
 *    caller says `managerOk`), after the checks;
 *  - never mid-order or mid-payment, either way (`mode_switch_busy`);
 *  - held sales never block — a switch away from the till asks to confirm "N held sales wait";
 *  - to a non-fiscal role (KDS, board, customer display) only with the shift closed, no document
 *    left to upload and no undecided card (`role_switch_open_shift`);
 *  - from the dashboard: a non-blocking command — done at once when the device is at rest, else
 *    pending until it is (`rest`), expired after 24 h;
 *  - a kiosk in till mode goes back by itself after `idleReturnMinutes` without a touch (0 =
 *    never), at rest only, with 30 s of warning; a device whose role is till never does;
 *  - `rolesAllowed` narrowed under the device's feet: back to the role at the next rest
 *    ("המעבר בוטל ע״י מנהל המערכת").
 *
 * Pure: no clock, no storage, no `@/` imports — the time comes in as `now` (ms). The node tests
 * compile it on its own.
 */

export type DeviceRole = 'till' | 'kiosk' | 'kds' | 'board' | 'display';

/** Every role, in the order lists are given. */
export const DEVICE_ROLES: readonly DeviceRole[] = ['till', 'kiosk', 'kds', 'board', 'display'];
/** The roles that issue documents (shift, X, Z, payments); the others never do. */
export const FISCAL_ROLES: readonly DeviceRole[] = ['till', 'kiosk'];

export const DEFAULT_IDLE_RETURN_MINUTES = 3;
export const IDLE_WARNING_MS = 30_000;
export const COMMAND_EXPIRY_MS = 24 * 60 * 60 * 1000;

export function isFiscalRole(role: DeviceRole): boolean {
  return FISCAL_ROLES.includes(role);
}

/** A role as the cloud, the Windows app or the bundle spells it; null when it is none. */
export function normalizeRole(raw: unknown): DeviceRole | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim().toLowerCase().replace(/[-\s]/g, '_');
  if (r === 'till' || r === 'pos' || r === 'cashier') return 'till';
  if (r === 'kiosk') return 'kiosk';
  if (r === 'kds' || r === 'kitchen' || r === 'kitchen_display') return 'kds';
  if (r === 'board' || r === 'order_status_board' || r === 'status_board' || r === 'pickup' || r === 'pickup_board' || r === 'ready_board') return 'board';
  if (r === 'display' || r === 'customer_display') return 'display';
  return null;
}

/** The owner's word for this device, as the cloud sends it (machines/me, heartbeat). */
export interface OwnerConfig {
  role: DeviceRole;
  /** The parameter `deviceRolesAllowed` (layered company → shop → area → device); null = not set. */
  deviceRolesAllowed?: readonly unknown[] | null;
  kioskTillModeEnabled?: boolean;
  /** `kioskTillModeIdleReturnMinutes` (0..240, default 3; 0 = never). */
  idleReturnMinutes?: number | null;
}

/**
 * The effective `rolesAllowed`: `deviceRolesAllowed` (unknown names dropped) and {till, kiosk}
 * when `kioskTillModeEnabled` — one list, in `DEVICE_ROLES` order.
 */
export function rolesAllowed(config: OwnerConfig): DeviceRole[] {
  const set = new Set<DeviceRole>();
  for (const raw of config.deviceRolesAllowed ?? []) {
    const role = normalizeRole(raw);
    if (role) set.add(role);
  }
  if (config.kioskTillModeEnabled) {
    set.add('till');
    set.add('kiosk');
  }
  return DEVICE_ROLES.filter((r) => set.has(r));
}

export function idleMinutesOf(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_IDLE_RETURN_MINUTES;
  const m = Math.trunc(raw);
  return m < 0 || m > 240 ? DEFAULT_IDLE_RETURN_MINUTES : m;
}

export type SwitchReason = 'manual' | 'idle' | 'remote' | 'cloud';

export interface PendingSwitch {
  to: DeviceRole;
  /** `remote`: a dashboard command (`commandId`); `cloud`: the owner narrowed `rolesAllowed`. */
  reason: 'remote' | 'cloud';
  commandId: string | null;
  requestedAt: number;
}

export interface DeviceModeState {
  role: DeviceRole;
  mode: DeviceRole;
  allowed: DeviceRole[];
  idleReturnMinutes: number;
  /** When `mode` was entered (ms); null before the first switch. */
  since: number | null;
  pending: PendingSwitch | null;
}

/** What the device is doing now — every fact a switch is checked against. */
export interface DeviceFacts {
  /** A sale / order on the till screen. */
  basketOpen: boolean;
  /** The payment screen, a tender held, a card at the terminal. */
  paymentOpen: boolean;
  /** A table order open on the screen. */
  tableOpen: boolean;
  /** A kiosk payment on its way, the customer reading its result, a card at the terminal. */
  kioskPayment: boolean;
  /** A kiosk customer in the middle of an order. */
  customerOrdering: boolean;
  shiftOpen: boolean;
  unsyncedDocuments: boolean;
  undecidedCard: boolean;
  heldSales: number;
  /** The last touch (ms); null = none since start. */
  lastTouchAt: number | null;
}

export const AT_REST: DeviceFacts = {
  basketOpen: false,
  paymentOpen: false,
  tableOpen: false,
  kioskPayment: false,
  customerOrdering: false,
  shiftOpen: false,
  unsyncedDocuments: false,
  undecidedCard: false,
  heldSales: 0,
  lastTouchAt: null,
};

export type RefusalCode = 'role_not_allowed' | 'mode_switch_busy' | 'role_switch_open_shift' | 'manager_required';

export type Outcome =
  | { kind: 'none' }
  | { kind: 'switched'; from: DeviceRole; to: DeviceRole; reason: SwitchReason; heldSales: number; commandId: string | null; message: string | null }
  | { kind: 'refused'; code: RefusalCode; reason: string | null; message: string }
  | { kind: 'confirm'; dialog: 'held_sales_wait'; count: number; message: string }
  | { kind: 'pending'; to: DeviceRole; blockedBy: string; message: string }
  | { kind: 'done'; commandId: string | null }
  | { kind: 'expired'; commandId: string | null }
  | { kind: 'warn'; to: DeviceRole; inMs: number; message: string }
  | { kind: 'reset'; from: DeviceRole; to: DeviceRole };

export interface Step {
  state: DeviceModeState;
  outcome: Outcome;
}

/** Hebrew, shown as is (spec v2 §6, kiosk-landscape-till-mode.md §5). */
export const MESSAGES = {
  role_not_allowed: 'המעבר לתפקיד הזה לא הותר למכשיר.',
  disabled: 'מעבר בין תפקידים לא הופעל למכשיר הזה.',
  basket_open: 'יש מכירה פתוחה — סיימו או השהו אותה',
  payment_open: 'יש תשלום פתוח — סיימו אותו לפני המעבר',
  table_open: 'הזמנת שולחן פתוחה במסך — סגרו אותה לפני המעבר',
  kiosk_payment: 'יש תשלום בתהליך בקיוסק — אי אפשר לעבור עכשיו',
  customer_ordering: "לקוח באמצע הזמנה — אפשר 'איפוס מסך לקוח' ואז לעבור",
  open_shift: 'יש משמרת פתוחה — סגרו אותה לפני המעבר',
  unsynced_documents: 'יש מסמכים שעוד לא עלו לענן — חכו לסנכרון לפני המעבר',
  undecided_card: 'יש עסקת אשראי שתוצאתה לא ידועה — הכריעו אותה לפני המעבר',
  manager_required: 'המעבר דורש קוד מנהל עם הרשאת מעבר בין מצבים',
  cancelled_by_admin: 'המעבר בוטל ע״י מנהל המערכת',
  pending: 'ממתין — יש הזמנה או תשלום פתוחים',
} as const;

export function heldSalesMessage(count: number): string {
  return `יש ${count} מכירות מושהות — יחכו במצב קופה`;
}

export function idleWarningMessage(inMs: number): string {
  return `חוזר לקיוסק בעוד ${Math.ceil(inMs / 1000)} שניות`;
}

/* ------------------------------------------------------------ state */

/** A new device (or a role the owner just set): the mode is the role. */
export function initialState(config: OwnerConfig): DeviceModeState {
  return {
    role: config.role,
    mode: config.role,
    allowed: rolesAllowed(config),
    idleReturnMinutes: idleMinutesOf(config.idleReturnMinutes),
    since: null,
    pending: null,
  };
}

/** What a host keeps across restarts (the engine's DB; a non-fiscal role: the host's storage). */
export interface PersistedMode {
  role: DeviceRole;
  mode: DeviceRole;
  since: number | null;
}

export function persisted(state: DeviceModeState): PersistedMode {
  return { role: state.role, mode: state.mode, since: state.since };
}

/** The roles a switch may go to now: `rolesAllowed` ∪ {role}, but the mode itself; none when nothing is allowed. */
export function switchTargets(state: DeviceModeState): DeviceRole[] {
  const others = state.allowed.filter((r) => r !== state.role);
  if (others.length === 0) {
    // The feature does not exist for this device — unless it stands somewhere it is no longer
    // allowed, when the way home is the only one.
    return state.mode !== state.role ? [state.role] : [];
  }
  const set = new Set<DeviceRole>([...state.allowed, state.role]);
  return DEVICE_ROLES.filter((r) => set.has(r) && r !== state.mode);
}

/** Whether the switch UI exists at all (button, menu, dashboard switch). */
export function canSwitch(state: DeviceModeState): boolean {
  return state.allowed.some((r) => r !== state.role);
}

/**
 * After a restart: the persisted mode, unless the owner changed the role meanwhile (then the new
 * role); a mode no longer allowed returns to the role at the next rest.
 */
export function restore(saved: PersistedMode | null, config: OwnerConfig): Step {
  const fresh = initialState(config);
  if (!saved || saved.role !== config.role || !DEVICE_ROLES.includes(saved.mode)) {
    return { state: fresh, outcome: saved && saved.role !== config.role ? { kind: 'reset', from: saved.mode, to: config.role } : { kind: 'none' } };
  }
  const state: DeviceModeState = { ...fresh, mode: saved.mode, since: saved.since };
  return { state: withAllowedChecked(state, null), outcome: { kind: 'none' } };
}

/** The owner's word arrived (heartbeat / machines/me / push). */
export function onConfig(state: DeviceModeState, config: OwnerConfig, now: number): Step {
  if (config.role !== state.role) {
    const next = initialState(config);
    return { state: { ...next, since: now }, outcome: { kind: 'reset', from: state.mode, to: config.role } };
  }
  const next: DeviceModeState = {
    ...state,
    allowed: rolesAllowed(config),
    idleReturnMinutes: idleMinutesOf(config.idleReturnMinutes),
  };
  return { state: withAllowedChecked(next, now), outcome: { kind: 'none' } };
}

function allowedHere(state: DeviceModeState, role: DeviceRole): boolean {
  return role === state.role || (canSwitch(state) && state.allowed.includes(role));
}

/** A mode the owner no longer allows: back to the role at the next rest (unless already going). */
function withAllowedChecked(state: DeviceModeState, now: number | null): DeviceModeState {
  if (allowedHere(state, state.mode)) {
    if (state.pending && !allowedHere(state, state.pending.to)) return { ...state, pending: null };
    return state;
  }
  if (state.pending && state.pending.to === state.role) return state;
  return { ...state, pending: { to: state.role, reason: 'cloud', commandId: null, requestedAt: now ?? 0 } };
}

/* ------------------------------------------------------------ checks */

/** Why the device cannot leave `mode` now (first that applies), else null. */
export function busyReason(mode: DeviceRole, f: DeviceFacts): string | null {
  if (mode === 'kiosk') {
    if (f.kioskPayment) return 'kiosk_payment';
    if (f.customerOrdering) return 'customer_ordering';
    return null;
  }
  if (mode === 'till') {
    if (f.paymentOpen) return 'payment_open';
    if (f.basketOpen) return 'basket_open';
    if (f.tableOpen) return 'table_open';
  }
  return null;
}

/** Why a fiscal device cannot become a non-fiscal one now, else null. */
export function fiscalExitReason(from: DeviceRole, to: DeviceRole, f: DeviceFacts): string | null {
  if (!isFiscalRole(from) || isFiscalRole(to)) return null;
  if (f.shiftOpen) return 'open_shift';
  if (f.unsyncedDocuments) return 'unsynced_documents';
  if (f.undecidedCard) return 'undecided_card';
  return null;
}

function refused(code: RefusalCode, reason: string | null): Outcome {
  const key = (reason ?? code) as keyof typeof MESSAGES;
  return { kind: 'refused', code, reason, message: MESSAGES[key] ?? MESSAGES.role_not_allowed };
}

function switched(state: DeviceModeState, to: DeviceRole, reason: SwitchReason, f: DeviceFacts, now: number, commandId: string | null, message: string | null = null): Step {
  return {
    state: { ...state, mode: to, since: now, pending: null },
    outcome: {
      kind: 'switched',
      from: state.mode,
      to,
      reason,
      heldSales: state.mode === 'till' ? f.heldSales : 0,
      commandId,
      message,
    },
  };
}

/** The checks a switch must pass now (the device's state, not who asks): a refusal, else null. */
function blocker(state: DeviceModeState, to: DeviceRole, f: DeviceFacts): { code: RefusalCode; reason: string } | null {
  const busy = busyReason(state.mode, f);
  if (busy) return { code: 'mode_switch_busy', reason: busy };
  const fiscal = fiscalExitReason(state.mode, to, f);
  if (fiscal) return { code: 'role_switch_open_shift', reason: fiscal };
  return null;
}

/* ------------------------------------------------------------ events */

export interface DeviceRequest {
  to: DeviceRole;
  /** A manager code with KIOSK_TILL_MODE was given and checked (the engine's answer). */
  managerOk: boolean;
  /** The "N held sales wait" question was answered "switch". */
  heldSalesConfirmed?: boolean;
}

/**
 * A switch asked on the device (the kiosk's management corner, the till's menu). The first check
 * that fails is said; the manager code is asked last.
 */
export function requestOnDevice(state: DeviceModeState, req: DeviceRequest, f: DeviceFacts, now: number): Step {
  const to = req.to;
  if (!canSwitch(state) && !(to === state.role && state.mode !== state.role)) {
    return { state, outcome: refused('role_not_allowed', 'disabled') };
  }
  if (to === state.mode) return { state, outcome: { kind: 'none' } };
  if (!switchTargets(state).includes(to)) return { state, outcome: refused('role_not_allowed', null) };
  const block = blocker(state, to, f);
  if (block) return { state, outcome: refused(block.code, block.reason) };
  if (state.mode === 'till' && f.heldSales > 0 && !req.heldSalesConfirmed) {
    return { state, outcome: { kind: 'confirm', dialog: 'held_sales_wait', count: f.heldSales, message: heldSalesMessage(f.heldSales) } };
  }
  if (!req.managerOk) return { state, outcome: refused('manager_required', null) };
  return switched(state, to, 'manual', f, now, null);
}

/**
 * A dashboard command (`enter_till`, `return_kiosk`, `switch_role {to}`): never blocks the device —
 * done now when it is at rest, else pending until `rest`; to the mode it is in already: done.
 */
export function commandFromDashboard(state: DeviceModeState, to: DeviceRole, commandId: string, f: DeviceFacts, now: number): Step {
  if (to === state.mode) {
    // Already there: done, and an older command still waiting is overtaken (not the owner's own return).
    const pending = state.pending?.reason === 'remote' ? null : state.pending;
    return { state: { ...state, pending }, outcome: { kind: 'done', commandId } };
  }
  if (!switchTargets(state).includes(to)) return { state, outcome: refused('role_not_allowed', canSwitch(state) ? null : 'disabled') };
  const block = blocker(state, to, f);
  if (block) {
    return {
      state: { ...state, pending: { to, reason: 'remote', commandId, requestedAt: now } },
      outcome: { kind: 'pending', to, blockedBy: block.reason, message: MESSAGES.pending },
    };
  }
  return switched(state, to, 'remote', f, now, commandId);
}

/**
 * Called while the device runs (every ~2 s): a pending switch is done once the checks pass (a
 * dashboard command expires after 24 h); a kiosk in till mode goes back after its idle minutes.
 */
export function rest(state: DeviceModeState, f: DeviceFacts, now: number): Step {
  const pending = state.pending;
  if (pending) {
    if (pending.reason === 'remote' && now - pending.requestedAt >= COMMAND_EXPIRY_MS) {
      return { state: { ...state, pending: null }, outcome: { kind: 'expired', commandId: pending.commandId } };
    }
    if (blocker(state, pending.to, f)) return { state, outcome: { kind: 'none' } };
    const message = pending.reason === 'cloud' ? MESSAGES.cancelled_by_admin : null;
    return switched(state, pending.to, pending.reason, f, now, pending.commandId, message);
  }
  if (state.role !== 'kiosk' || state.mode !== 'till' || state.idleReturnMinutes <= 0) return { state, outcome: { kind: 'none' } };
  const since = Math.max(f.lastTouchAt ?? 0, state.since ?? 0);
  const dueAt = since + state.idleReturnMinutes * 60_000;
  if (now < dueAt - IDLE_WARNING_MS) return { state, outcome: { kind: 'none' } };
  if (busyReason('till', f)) return { state, outcome: { kind: 'none' } };
  if (now < dueAt) {
    const inMs = dueAt - now;
    return { state, outcome: { kind: 'warn', to: 'kiosk', inMs, message: idleWarningMessage(inMs) } };
  }
  return switched(state, 'kiosk', 'idle', f, now, null);
}
