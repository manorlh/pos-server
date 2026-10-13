/**
 * The shop's local network (pos-server docs/SPEC_LAN_MODE.md): the main till card's switch
 * "רשת מקומית", its row per system, its "סנכרון רשת מקומית" row, and a device's "לא משמש
 * כשרת מקומי". Pure — `npm test` compiles it alone; the calls are in lib/lanServerApi.ts.
 */

/** A system of the shop, as the card lists it. */
export type LanSystem = 'tables' | 'print' | 'shop_z' | 'kds' | 'kiosk';

/**
 * `lan` — through the main till; `other_host` — on the LAN, through another till; `no_host` —
 * on the LAN, nobody to serve it; `cloud` — through the cloud; `off` — not in use; `soon` —
 * not on the LAN yet; `partial` — part of it; `none` — no such device in the shop.
 */
export type LanHealthState = 'lan' | 'other_host' | 'no_host' | 'cloud' | 'off' | 'soon' | 'partial' | 'none';

export interface LanTillRef {
  machineId: string;
  posNumber?: string | null;
  name?: string | null;
  /** "local_server" for a dedicated local server (P:/specs/dedicated-local-server.md); absent for a till. */
  deviceRole?: string | null;
}

export interface LanHealthRow {
  system: LanSystem | string;
  state: LanHealthState | string;
  host: LanTillRef | null;
}

/** "סנכרון רשת מקומית": the local server and what its cloud copy still lacks. */
export interface LanSyncState {
  state: 'synced' | 'syncing' | 'lagging' | 'offline' | 'unknown' | 'none' | string;
  host: LanTillRef | null;
  pending: number;
  oldestAgeSeconds: number | null;
  /** Online and a change older than a minute: the owner's real-time rule is broken. */
  alert: boolean;
  reportedAt?: string | null;
  systems?: Record<string, { pending: number; oldestAt: string | null }>;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export const LAN_SYSTEMS: readonly LanSystem[] = ['tables', 'print', 'shop_z', 'kds', 'kiosk'];

/** A row's tone: green through the main till, amber elsewhere on the LAN, grey otherwise. */
export function healthTone(state: string): Tone {
  if (state === 'lan') return 'ok';
  if (state === 'other_host' || state === 'partial') return 'warn';
  if (state === 'no_host') return 'bad';
  return 'muted';
}

/** The rows in the card's order, a system the server did not send shown as unknown. */
export function healthRows(rows: LanHealthRow[] | null | undefined): LanHealthRow[] {
  const by = new Map((rows ?? []).map((r) => [r.system, r]));
  return LAN_SYSTEMS.map((s) => by.get(s) ?? { system: s, state: 'none', host: null });
}

/** The sync row's tone: green synced, amber on its way or offline, red past a minute online. */
export function syncTone(s: Pick<LanSyncState, 'state' | 'alert'> | null | undefined): Tone {
  if (!s) return 'muted';
  if (s.alert || s.state === 'lagging') return 'bad';
  if (s.state === 'synced') return 'ok';
  if (s.state === 'syncing' || s.state === 'offline') return 'warn';
  return 'muted';
}

/** "לפני 2 דק׳" — whole minutes past a minute, seconds below. */
export function ageText(seconds: number | null | undefined): { key: 'seconds' | 'minutes'; values: { n: string } } | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return { key: 'seconds', values: { n: String(Math.round(seconds)) } };
  return { key: 'minutes', values: { n: String(Math.floor(seconds / 60)) } };
}

/** Whether the switch may be turned on now: it needs a main till. */
export function localNetworkBlock(state: { mainTill: LanTillRef | null; localNetwork: boolean }): 'needs_main_till' | null {
  return !state.localNetwork && !state.mainTill ? 'needs_main_till' : null;
}

/**
 * The switch as the card shows it: `on` (and the shop is in local mode), `inactive` (on, but
 * no main till to lean on — the shop works through the cloud), `off`.
 */
export function localNetworkView(state: { localNetwork: boolean; localMode: boolean }): 'on' | 'inactive' | 'off' {
  if (!state.localNetwork) return 'off';
  return state.localMode ? 'on' : 'inactive';
}

// ── A device: "לא משמש כשרת מקומי" ─────────────────────────────────────────────

export interface MachineLanServer {
  machineId: string;
  lanServerExcluded: boolean;
  lanServerExcludedReason: 'set' | 'kds_screen' | null;
  lanServerExcludedAuto: boolean;
  lanServerExcludedSuggested: boolean;
  lanServerExcludedChosen: boolean;
  isMainTill: boolean;
  /** False for a display device or an independent till: outside the LAN group already. */
  applies: boolean;
  canEdit: boolean;
}

/** Why the machine page's switch cannot change now, or null. */
export function machineSwitchBlock(m: MachineLanServer): 'read_only' | 'kds_screen' | 'main_till' | 'not_applicable' | null {
  if (!m.applies) return 'not_applicable';
  if (!m.canEdit) return 'read_only';
  if (m.lanServerExcludedAuto) return 'kds_screen';
  if (m.isMainTill && !m.lanServerExcluded) return 'main_till';
  return null;
}

/** The hint under the switch: suggested and never chosen. */
export function machineSuggests(m: MachineLanServer): boolean {
  return m.lanServerExcludedSuggested && !m.lanServerExcludedChosen && !m.lanServerExcluded;
}

// ── "העברת שרת מקומי" (pos-server app/services/local_server_switch.py) ─────────────────────────
// The local server moves from the cloud only: the wizard on the main till card, and "סגירת משמרת
// מהענן" on a device page for a till the cloud has not heard for 5 minutes.

/** The server's `closeFromCloudAfterSeconds`: a till not heard this long may have its shift closed from the cloud. */
export const CLOSE_FROM_CLOUD_AFTER_SECONDS = 300;

export interface LocalServerShiftRef {
  shiftId: string;
  sequenceNumber?: number | null;
  openedAt?: string | null;
  businessDate?: string | null;
}

/** A till as the wizard and the device dialog show it before acting on it. */
export interface LocalServerTill extends LanTillRef {
  platform?: string | null;
  online: boolean;
  lastHeartbeatAt: string | null;
  /** Seconds since the cloud last heard it, by the server's clock; null — never heard. */
  silentSeconds: number | null;
  canCloseFromCloud: boolean;
  openShift: LocalServerShiftRef | null;
  reportedOpenShiftId?: string | null;
  reportedOpenShiftInCloud?: boolean;
  /** What it last said it still holds (undelivered sales). */
  pendingDocuments: number | null;
  pendingAt?: string | null;
  /** A local server's changes the cloud copy lacks. */
  lanPending?: number | null;
  lanReportedAt?: string | null;
  /** False for a dedicated local server: it has no shift (nothing to close from the cloud). */
  hasShifts?: boolean;
}

export type LocalServerIneligible =
  | 'not_assigned'
  | 'independent'
  | 'remote'
  | 'lan_excluded'
  | 'not_fiscal'
  | 'kiosk'
  | 'not_android'
  | 'offline';

export interface LocalServerCandidate extends LanTillRef {
  online: boolean;
  lastHeartbeatAt: string | null;
  eligible: boolean;
  reason: LocalServerIneligible | string | null;
  reasonText: string | null;
}

/** One order the old server changed that the cloud had changed too: kept, not applied (gap 1). */
export interface FormerHostChange {
  id: string;
  at: string;
  switchedAt: string | null;
  machine: LanTillRef | null;
  orderId: string;
  tableId: string;
  tableNumber: number | null;
  tableName: string | null;
  till: { status: string; version: number; total: number | null; itemCount: number; updatedAt: string | null };
  cloud: { status: string | null; version: number | null; total: number | null; updatedAt: string | null };
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface LocalServerSwitchRecord {
  id: string;
  at: string;
  by: string;
  from: LanTillRef | null;
  to: LanTillRef | null;
  moved: string[];
  forced: boolean;
  closedShift: { shiftId: string; closedAt: string | null; countedCash: string | null } | null;
  releasedShopZ: boolean;
  /**
   * `cloud`: this wizard; `till`: the till's own button (`tillServerTakeover` = manager), `approvedBy` its
   * manager; `auto_failover`: "גיבוי אוטומטי"; `work_profile`: the work profile's dedicated server.
   */
  source?: 'cloud' | 'till' | 'auto_failover' | 'work_profile' | 'roles';
  approvedBy?: string | null;
  /** The automatic failover's N minutes. */
  failoverMinutes?: number;
}

/** The till parameter `tillServerTakeover` ("העברת שרת מקומי מהקופה"): `off` — the cloud only. */
export const TILL_TAKEOVER_MODES = ['off', 'manager'] as const;
export type TillTakeoverMode = (typeof TILL_TAKEOVER_MODES)[number];

/** The wizard's line on it: the message key under `localServer.wizard` (an unknown value reads as off). */
export function tillTakeoverKey(mode: string | null | undefined): 'tillTakeoverOff' | 'tillTakeoverManager' {
  return mode === 'manager' ? 'tillTakeoverManager' : 'tillTakeoverOff';
}

/**
 * "העברה אחרונה" as said: from this wizard, from a till with its manager's approval, by the automatic
 * failover, or by the work profile's dedicated server.
 */
export function lastSwitchKey(
  record: Pick<LocalServerSwitchRecord, 'source'>,
): 'lastSwitch' | 'lastSwitchFromTill' | 'lastSwitchFailover' | 'lastSwitchWorkProfile' | 'lastSwitchRoles' {
  if (record.source === 'till') return 'lastSwitchFromTill';
  if (record.source === 'roles') return 'lastSwitchRoles';
  if (record.source === 'auto_failover') return 'lastSwitchFailover';
  if (record.source === 'work_profile') return 'lastSwitchWorkProfile';
  return 'lastSwitch';
}

export interface LocalServerState {
  shopId: string;
  server: LocalServerTill | null;
  candidates: LocalServerCandidate[];
  tablesLan: boolean;
  localMode: boolean;
  shopZ: {
    producer: { kind: 'local' | 'cloud'; machine: LanTillRef | null; since: string | null };
    handover: { reason?: string; message?: string; to?: { kind: string; machine: LanTillRef | null } } | null;
  };
  closeFromCloudAfterSeconds: number;
  canSwitch: boolean;
  canForce: boolean;
  canReleaseShopZ: boolean;
  /** `tillServerTakeover` as the shop resolves it (a till may hold its own value). */
  tillTakeover?: TillTakeoverMode;
  lastSwitch: LocalServerSwitchRecord | null;
  switches: LocalServerSwitchRecord[];
  formerHostChanges: { count: number; items: FormerHostChange[]; checked: FormerHostChange[] };
  /** The shop's dedicated local servers (absent from an older server). */
  servers?: LocalServerSummary[];
  /** "גיבוי אוטומטי לשרת המקומי" (absent from an older server). */
  failover?: LocalServerFailover;
}

// ── "שרת מקומי ייעודי" (P:/specs/dedicated-local-server.md §11) ───────────────────

/** The host roles a device holds: the main till, the tables, the printing, the shop Z. */
export interface LocalServerHosting {
  mainTill: boolean;
  tables: boolean;
  print: boolean;
  shopZ: boolean;
}

export const HOSTING_ROLES: readonly (keyof LocalServerHosting)[] = ['mainTill', 'tables', 'print', 'shopZ'];

/** The roles held, in order ([] — a standby server, serving nothing now). */
export function hostingRoles(h: Partial<LocalServerHosting> | null | undefined): (keyof LocalServerHosting)[] {
  return HOSTING_ROLES.filter((k) => h?.[k] === true);
}

export const PRINTER_STATES = ['ok', 'offline', 'error', 'no_paper', 'unknown'] as const;
export type PrinterState = (typeof PRINTER_STATES)[number];

/** A printer state as reported; anything else is `unknown` (the server's own rule). */
export function printerStateOf(value: unknown): PrinterState {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (PRINTER_STATES as readonly string[]).includes(s) ? (s as PrinterState) : 'unknown';
}

export function printerTone(state: unknown): Tone {
  const s = printerStateOf(state);
  if (s === 'ok') return 'ok';
  if (s === 'unknown') return 'muted';
  return s === 'no_paper' ? 'warn' : 'bad';
}

export interface LocalServerPrintQueue {
  pending: number | null;
  failed: number | null;
  oldestPendingAgeMs?: number | null;
}

/** The queue's tone: failed jobs are bad, a job waiting over a minute a warning. */
export function printQueueTone(q: LocalServerPrintQueue | null | undefined): Tone {
  if (!q || q.pending === null || q.pending === undefined) return 'muted';
  if ((q.failed ?? 0) > 0) return 'bad';
  if ((q.oldestPendingAgeMs ?? 0) > 60_000) return 'warn';
  return 'ok';
}

export interface LocalServerPrinter {
  printerId: string | null;
  name: string | null;
  state: PrinterState | string;
  message: string | null;
  lastOkAgeMs: number | null;
}

/** A shop's local server on the shop page. */
export interface LocalServerSummary {
  machineId: string;
  name: string;
  online: boolean;
  lastHeartbeatAt: string | null;
  isHost: boolean;
  hosting: LocalServerHosting;
  connectedTills: number | null;
  openOrders: number | null;
  printQueue: LocalServerPrintQueue | null;
  mirror: LanSyncState;
  appVersion: string | null;
}

/** The device page's "שרת מקומי" card (`GET /machines/{id}/local-server`). */
export interface LocalServerCardData extends LocalServerSummary {
  shopId: string | null;
  deviceRole: 'local_server';
  serialNumber: string | null;
  lanIp: string | null;
  lastIp: string | null;
  reportedAt: string | null;
  /** The report is under 5 minutes old (else shown "as of"). */
  fresh: boolean;
  tills: { machineId: string; name: string | null; posNumber: string | null; ageMs: number | null }[];
  printers: LocalServerPrinter[];
  uptimeMs: number | null;
  identity: { registered: boolean; keyId: string | null; at: string | null };
  countsAsTillLicense: false;
  actions: string[];
  commands: { id: string; action: string; status: string; createdAt: string | null; createdBy: string | null; detail: string | null }[];
}

/** The server's remote commands (§11.5): two existing, two of its own. */
export const SERVER_ACTIONS = ['restart_app', 'upload_logs', 'print_test_page', 'clear_print_queue'] as const;
export type ServerAction = (typeof SERVER_ACTIONS)[number];

/** "ניקוי תור תקוע" deletes jobs not printed: sent only once the user confirmed. */
export function serverCommandNeedsConfirm(action: string): boolean {
  return action === 'clear_print_queue';
}

/** The body of `POST /machines/{id}/local-server/commands`. */
export function serverCommandBody(
  action: ServerAction,
  opts: { printerId?: string | null; minutes?: number; scope?: 'failed' | 'all'; confirmed?: boolean } = {},
): { action: ServerAction; params?: Record<string, unknown>; confirm?: boolean } {
  if (action === 'print_test_page') return { action, params: { printerId: opts.printerId ?? null } };
  if (action === 'upload_logs') return { action, params: { minutes: opts.minutes ?? 120 } };
  if (action === 'clear_print_queue') {
    return { action, params: { printerId: opts.printerId ?? null, scope: opts.scope ?? 'failed' }, confirm: !!opts.confirmed };
  }
  return { action };
}

// ── "תפקידי השרת המקומי" (§11.9) ─────────────────────────────────────────────────

export const SERVER_ROLES = ['tables', 'print', 'shopZ'] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];
/** "ללא שרת הדפסות — כל קופה מדפיסה בעצמה". */
export const NO_PRINT_HOST = 'none' as const;

export interface LocalServerRoleChoice extends LanTillRef {
  deviceRole: 'local_server' | 'till' | string;
  online: boolean;
  eligible: boolean;
  reason: string | null;
  reasonText: string | null;
}

/** `GET /shops/{id}/local-server/roles`. */
export interface LocalServerRolesView {
  shopId: string;
  applies: boolean;
  server: LanTillRef | null;
  localMode: boolean;
  roles: {
    tables: { holder: LanTillRef | null; onServer: boolean };
    print: { holder: LanTillRef | null; none: boolean; onServer: boolean };
    shopZ: { holder: LanTillRef | null; onServer: boolean; applies: boolean };
  };
  choices: LocalServerRoleChoice[];
  noPrintHostSupported: boolean;
  noPrintHostAllowed: boolean;
  remoteDevices?: LanTillRef[];
  canEdit: boolean;
  changed?: ServerRole[];
}

/** What the editor holds: a device id per role ('none' for printing with no print server). */
export interface RolesDraft {
  tables: string;
  print: string;
  shopZ: string;
}

export function rolesDraftOf(v: Pick<LocalServerRolesView, 'roles'> | null | undefined): RolesDraft {
  return {
    tables: v?.roles.tables.holder?.machineId ?? '',
    print: v?.roles.print.none ? NO_PRINT_HOST : (v?.roles.print.holder?.machineId ?? ''),
    shopZ: v?.roles.shopZ.holder?.machineId ?? '',
  };
}

/** The devices a role may go to: the eligible ones, and whoever holds it now. */
export function roleChoices(v: Pick<LocalServerRolesView, 'choices'>, current: string): LocalServerRoleChoice[] {
  return v.choices.filter((c) => c.eligible || c.machineId === current);
}

/** Why the draft cannot be saved, or null. */
export function rolesDraftError(
  d: RolesDraft,
  v: Pick<LocalServerRolesView, 'localMode' | 'noPrintHostAllowed'>,
): 'tables' | 'print' | 'shopZ' | 'printNone' | null {
  if (!d.tables) return 'tables';
  if (!d.print) return 'print';
  if (d.print === NO_PRINT_HOST && !v.noPrintHostAllowed) return 'printNone';
  if (v.localMode && !d.shopZ) return 'shopZ';
  return null;
}

/** `PUT /shops/{id}/local-server/roles`'s body (the shop Z only in local mode). */
export function rolesBody(d: RolesDraft, localMode: boolean): { tables: string; print: string; shopZ?: string } {
  return { tables: d.tables, print: d.print, ...(localMode && d.shopZ ? { shopZ: d.shopZ } : {}) };
}

// ── "גיבוי אוטומטי לשרת המקומי" (§11.7) ─────────────────────────────────────────

export type FailoverStatusCode =
  | 'off'
  | 'no_target'
  | 'target_not_eligible'
  | 'target_offline'
  | 'no_host'
  | 'target_is_host'
  | 'host_heard'
  | 'target_not_heard_since'
  | 'fire';

export interface LocalServerFailover {
  enabled: boolean;
  targetMachineId: string | null;
  minutes: number;
  target: (LanTillRef & { online: boolean; lastHeartbeatAt: string | null }) | null;
  defaultMinutes: number;
  minMinutes: number;
  maxMinutes: number;
  canEdit: boolean;
  armed: boolean;
  status: { code: FailoverStatusCode | string; message: string };
  updatedAt: string | null;
  updatedBy: string | null;
  lastFired: { at: string; from: LanTillRef | null; to: LanTillRef | null; minutes: number } | null;
  history: { at: string; by: string; before: Record<string, unknown>; after: Record<string, unknown> }[];
}

/** Off, no target, 3 minutes — the owner's default ("לא יבצע לבד אם לא הדלקתי"). */
export const FAILOVER_DEFAULTS = { enabled: false, targetMachineId: null as string | null, minutes: 3 };

export interface FailoverDraft {
  enabled: boolean;
  targetMachineId: string;
  /** As typed. */
  minutes: string;
}

export function failoverDraftOf(f: Partial<LocalServerFailover> | null | undefined): FailoverDraft {
  return {
    enabled: f?.enabled === true,
    targetMachineId: f?.targetMachineId ?? '',
    minutes: String(f?.minutes ?? f?.defaultMinutes ?? FAILOVER_DEFAULTS.minutes),
  };
}

/** Why the draft cannot be saved (the server refuses the same), or null. */
export function failoverDraftError(
  d: FailoverDraft,
  limits: { minMinutes?: number; maxMinutes?: number } = {},
): 'target' | 'minutes' | null {
  const min = limits.minMinutes ?? 2;
  const max = limits.maxMinutes ?? 60;
  const n = Number(d.minutes.trim());
  if (!d.minutes.trim() || !Number.isInteger(n) || n < min || n > max) return 'minutes';
  if (d.enabled && !d.targetMachineId) return 'target';
  return null;
}

/** `PUT /shops/{id}/local-server/failover`'s body (call once `failoverDraftError` is null). */
export function failoverBody(d: FailoverDraft): { enabled: boolean; targetMachineId: string | null; minutes: number } {
  return { enabled: d.enabled, targetMachineId: d.targetMachineId || null, minutes: Number(d.minutes.trim()) };
}

/** The card's tone: off is quiet; armed and watching is fine; armed but unable to act is a warning. */
export function failoverTone(f: Pick<LocalServerFailover, 'enabled' | 'status'> | null | undefined): Tone {
  if (!f || !f.enabled) return 'muted';
  const code = f.status?.code;
  if (code === 'host_heard' || code === 'target_is_host') return 'ok';
  if (code === 'fire') return 'bad';
  return 'warn';
}

/** The switch's body (§8). */
export interface LocalServerSwitchBody {
  targetMachineId: string;
  closeOldShift?: boolean;
  countedCash?: number | null;
  force?: boolean;
  releaseShopZ?: boolean;
}

/** What the wizard's steps hold. */
export interface LocalServerSwitchForm {
  targetMachineId: string | null;
  closeOldShift: boolean;
  /** As typed: empty — not counted. */
  countedCash: string;
  force: boolean;
  releaseShopZ: boolean;
}

export const EMPTY_SWITCH_FORM: LocalServerSwitchForm = {
  targetMachineId: null,
  closeOldShift: false,
  countedCash: '',
  force: false,
  releaseShopZ: false,
};

/** Seconds since `lastHeartbeatAt` by the given clock; null — never heard (or unreadable). */
export function silentSecondsAt(lastHeartbeatAt: string | null | undefined, nowMs: number): number | null {
  if (!lastHeartbeatAt) return null;
  const at = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((nowMs - at) / 1000));
}

/** Not heard for the server's window (or never): its shift may be closed from the cloud. */
export function isSilent(
  lastHeartbeatAt: string | null | undefined,
  nowMs: number,
  afterSeconds: number = CLOSE_FROM_CLOUD_AFTER_SECONDS,
): boolean {
  const s = silentSecondsAt(lastHeartbeatAt, nowMs);
  return s === null || s >= afterSeconds;
}

/**
 * Why the device page does not offer "סגירת משמרת מהענן", or null: a till heard in the last 5
 * minutes uses the ordinary remote close; one with no open shift has nothing to close.
 */
export function closeFromCloudBlock(
  m: { lastHeartbeatAt?: string | null; hasOpenShift: boolean; removed?: boolean; display?: boolean },
  nowMs: number,
  afterSeconds: number = CLOSE_FROM_CLOUD_AFTER_SECONDS,
): 'removed' | 'display' | 'no_open_shift' | 'heard_recently' | null {
  if (m.removed) return 'removed';
  if (m.display) return 'display';
  if (!m.hasOpenShift) return 'no_open_shift';
  if (!isSilent(m.lastHeartbeatAt, nowMs, afterSeconds)) return 'heard_recently';
  return null;
}

/** A typed cash count: empty — not counted (null); a non-negative amount; anything else — invalid. */
export function parseCountedCash(text: string): number | null | 'invalid' {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return 'invalid';
  const n = Number(t);
  return Number.isFinite(n) && n <= 10_000_000 ? n : 'invalid';
}

/** The tills the wizard offers: online Android tills of the shop, never the server itself. */
export function eligibleTargets(state: Pick<LocalServerState, 'candidates' | 'server'>): LocalServerCandidate[] {
  return state.candidates.filter((c) => c.eligible && c.machineId !== state.server?.machineId);
}

/** The cloud still hears the old server: the switch is refused without "כפה העברה". */
export function hostOnline(state: Pick<LocalServerState, 'server'>): boolean {
  return !!state.server?.online;
}

/** The old server's shift step: none open, closable (silent 5 minutes), or heard too recently. */
export function shiftStep(state: Pick<LocalServerState, 'server'>): 'none' | 'closable' | 'heard_recently' {
  const s = state.server;
  if (!s?.openShift) return 'none';
  return s.canCloseFromCloud ? 'closable' : 'heard_recently';
}

/** Why the wizard cannot confirm yet, or null. */
export function switchBlock(
  state: Pick<LocalServerState, 'server' | 'candidates' | 'canSwitch' | 'canForce' | 'canReleaseShopZ'>,
  form: LocalServerSwitchForm,
): 'forbidden' | 'no_target' | 'host_online' | 'bad_cash' | 'shift_not_closable' | 'release_forbidden' | null {
  if (!state.canSwitch) return 'forbidden';
  if (!form.targetMachineId || !eligibleTargets(state).some((c) => c.machineId === form.targetMachineId)) return 'no_target';
  if (hostOnline(state) && !(form.force && state.canForce)) return 'host_online';
  if (form.closeOldShift && shiftStep(state) !== 'closable') return 'shift_not_closable';
  if (form.closeOldShift && parseCountedCash(form.countedCash) === 'invalid') return 'bad_cash';
  if (form.releaseShopZ && !state.canReleaseShopZ) return 'release_forbidden';
  return null;
}

/** The body the wizard sends: only what applies (§8). */
export function switchBody(state: Pick<LocalServerState, 'server'>, form: LocalServerSwitchForm): LocalServerSwitchBody {
  const body: LocalServerSwitchBody = { targetMachineId: form.targetMachineId ?? '' };
  if (form.closeOldShift && shiftStep(state) === 'closable') {
    body.closeOldShift = true;
    const cash = parseCountedCash(form.countedCash);
    body.countedCash = typeof cash === 'number' ? cash : null;
  }
  if (form.force && hostOnline(state)) body.force = true;
  if (form.releaseShopZ) body.releaseShopZ = true;
  return body;
}

/** The summary step's lines: message keys under `localServer.summary`, with their values. */
export function switchSummary(
  state: Pick<LocalServerState, 'server' | 'candidates' | 'shopZ'>,
  form: LocalServerSwitchForm,
  label: (r: LanTillRef | null | undefined) => string,
): { key: string; values?: Record<string, string> }[] {
  const target = state.candidates.find((c) => c.machineId === form.targetMachineId) ?? null;
  const from = state.server;
  const lines: { key: string; values?: Record<string, string> }[] = [
    from ? { key: 'move', values: { from: label(from), to: label(target) } } : { key: 'first', values: { to: label(target) } },
    { key: 'roles' },
  ];
  if (form.closeOldShift && from?.openShift) {
    const cash = parseCountedCash(form.countedCash);
    lines.push(
      typeof cash === 'number'
        ? { key: 'closeShiftCounted', values: { till: label(from), cash: cash.toFixed(2) } }
        : { key: 'closeShift', values: { till: label(from) } },
    );
  } else if (from?.openShift) {
    lines.push({ key: 'shiftStays', values: { till: label(from) } });
  }
  const producer = state.shopZ?.producer;
  if (form.releaseShopZ) lines.push({ key: 'zReleased' });
  else if (producer?.kind === 'local' && from && producer.machine?.machineId === from.machineId) {
    lines.push({ key: 'zFrozen', values: { till: label(from) } });
  }
  if (form.force && from?.online) lines.push({ key: 'forced', values: { till: label(from) } });
  lines.push({ key: 'notice' });
  return lines;
}

/** The keys `switchSummary`, `switchBlock` and `closeFromCloudBlock` use — each needs its Hebrew. */
export const SWITCH_SUMMARY_KEYS = [
  'move', 'first', 'roles', 'closeShift', 'closeShiftCounted', 'shiftStays', 'zReleased', 'zFrozen', 'forced', 'notice',
] as const;
export const SWITCH_BLOCKS = [
  'forbidden', 'no_target', 'host_online', 'bad_cash', 'shift_not_closable', 'release_forbidden',
] as const;
export const CLOSE_FROM_CLOUD_BLOCKS = ['removed', 'display', 'no_open_shift', 'heard_recently'] as const;
