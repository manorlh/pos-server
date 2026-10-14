/**
 * "עמדות מזומן" — the kiosks' cash stations on the dashboard (P:/specs/cash-paylink.md §5, §6, §9, §11, §12;
 * pos-server app/routers/cash_stations.py, app/services/cash_station_admin.py, cash_station_drawer.py,
 * cash_params.py). A station is one PayLink unit (by its USB serial), run by a "שרת מזומן" (device role
 * `cash_host`); kiosks are assigned to it by the till parameters `cashEnabled` + `cashStation`.
 *
 * The shapes the server answers, and the pure rules the pages use: money in agorot as words, the state
 * pills, the reconciliation's difference, the maintenance commands' bodies, the station settings form
 * (overrides ⇄ body) and the kiosk assignment's parameter values.
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own (lib/cashStations.test.ts).
 */

// ── Money ────────────────────────────────────────────────────────────────────

/** The shekel's coins and notes, in agorot (cash_params.py ILS_COINS / ILS_NOTES). */
export const ILS_COINS = [10, 50, 100, 200, 500, 1000] as const;
export const ILS_NOTES = [2000, 5000, 10000, 20000] as const;
export const ILS_DENOMINATIONS: readonly number[] = [...ILS_COINS, ...ILS_NOTES];

function groupThousands(whole: number): string {
  return String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Agorot as the spec writes money ("הוכנסו 70 ₪ מתוך 57 ₪"): whole shekels without decimals, else two
 * decimals; thousands grouped. '—' for none.
 */
export function agorotText(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined || !Number.isFinite(agorot)) return '—';
  const n = Math.round(agorot);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  const text = cents === 0 ? groupThousands(whole) : `${groupThousands(whole)}.${String(cents).padStart(2, '0')}`;
  return `${sign}${text} ₪`;
}

/** A difference: "+1.50 ₪", "-3 ₪", "0 ₪". */
export function signedAgorotText(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined || !Number.isFinite(agorot)) return '—';
  const text = agorotText(agorot);
  return agorot > 0 ? `+${text}` : text;
}

/** A coin or a note by its value: "10 אג'", "1 ₪", "200 ₪". */
export function denominationText(valueAgorot: number): string {
  if (valueAgorot < 100) return `${valueAgorot} אג'`;
  return agorotText(valueAgorot);
}

/** Shekels typed by staff ("12.5", "12,50") → agorot; null when not a non-negative amount. '' → null. */
export function shekelsToAgorot(text: string | null | undefined): number | null {
  const raw = (text ?? '').trim().replace(',', '.');
  if (!raw) return null;
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const [whole, frac = ''] = raw.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Agorot → the text a shekel field shows ("57.35", "70"). */
export function agorotToShekelsText(agorot: number | null | undefined): string {
  if (agorot === null || agorot === undefined || !Number.isFinite(agorot)) return '';
  const n = Math.round(agorot);
  return n % 100 === 0 ? String(n / 100) : (n / 100).toFixed(2);
}

export interface Pieces {
  valueAgorot: number;
  kind?: 'coin' | 'note' | string;
  count: number;
}

/** Σ value × count. */
export function piecesTotal(pieces: readonly Pieces[] | null | undefined): number {
  return (pieces ?? []).reduce((sum, p) => sum + (Number(p.valueAgorot) || 0) * (Number(p.count) || 0), 0);
}

/** "2 × 50 ₪ · 1 × 10 ₪" (largest first); '' for none. */
export function piecesText(pieces: readonly Pieces[] | null | undefined): string {
  return [...(pieces ?? [])]
    .filter((p) => p.count > 0)
    .sort((a, b) => b.valueAgorot - a.valueAgorot)
    .map((p) => `${p.count} × ${denominationText(p.valueAgorot)}`)
    .join(' · ');
}

// ── The server's shapes (API: GET /cash-stations…) ───────────────────────────

export const STATION_STATES = ['ready', 'busy', 'maintenance', 'fault', 'starting'] as const;
export type StationState = (typeof STATION_STATES)[number];

export const TX_STATES = ['LEASED', 'ACCEPTING', 'SETTLING', 'PAYING_CHANGE', 'REFUNDING', 'DONE', 'HELD'] as const;
export type TxState = (typeof TX_STATES)[number];
export const TX_OUTCOMES = ['paid', 'refunded', 'nothing_inserted'] as const;
export type TxOutcome = (typeof TX_OUTCOMES)[number];
export const HELD_REASONS = ['power_loss', 'refund_short', 'client_gone_short', 'unacked', 'device_fault', 'consistency'] as const;
export const MOVEMENT_KINDS = ['float', 'refill', 'collect', 'count', 'dump', 'adjust'] as const;
export type MovementKind = (typeof MOVEMENT_KINDS)[number];
export const OWED_FILTERS = ['open', 'resolved', 'any'] as const;
export type OwedFilter = (typeof OWED_FILTERS)[number];
export const OWED_KINDS = ['change_owed', 'held_credit'] as const;
export type OwedKind = (typeof OWED_KINDS)[number];
/** What the dashboard may close an owed item as (cash_station_admin.py RESOLVE_CHOICES). */
export const RESOLVE_CHOICES = ['paid_out', 'applied', 'written_off'] as const;
export type ResolveChoice = (typeof RESOLVE_CHOICES)[number];
/** Every resolution the server writes (the two last by itself). */
export const RESOLUTIONS = ['paid_out', 'applied', 'written_off', 'matched_document', 'host_resolved'] as const;
export const COMMAND_STATUSES = ['pending', 'done', 'refused', 'failed'] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/**
 * The maintenance commands the dashboard sends to the station's host — the cloud's COMMAND_OPS
 * (app/models/cash_station.py), each run by the host (kiosk-desktop src/main/cash/host.ts `runCommand`).
 * `ext_return` / `ext_stack`: a recycler's bill held in extended escrow, given back / taken in.
 */
export const COMMAND_OPS = [
  'float',
  'refill',
  'count',
  'collect',
  'dump',
  'deliver_pending',
  'ext_return',
  'ext_stack',
  'maintenance_on',
  'maintenance_off',
  'reset_alerts',
] as const;
export type CommandOp = (typeof COMMAND_OPS)[number];
/** The ops the cloud keeps no arguments of (app/models/cash_station.py NO_ARG_OPS) — not even a note. */
export const NO_ARG_OPS: readonly CommandOp[] = [
  'deliver_pending',
  'maintenance_on',
  'maintenance_off',
  'reset_alerts',
  'ext_return',
  'ext_stack',
];

export interface CashStationHost {
  machineId: string;
  name: string | null;
  online: boolean;
  lastHeartbeatAt: string | null;
  lanAddress: string | null;
  port: number | null;
  version: string | null;
  reportedAt: string | null;
}

export interface CashStationClient {
  machineId: string;
  name: string | null;
  kind: 'kiosk' | 'till' | string;
}

export interface CashDenomination {
  valueAgorot: number;
  kind: 'coin' | 'note' | string;
  count: number;
  accurate: boolean;
  level: 'low' | 'mid' | 'high' | 'full' | string | null;
  isLow: boolean;
}

export interface CashCashbox {
  notes: number;
  coins: number;
  valueAgorot: number;
  nearFull: boolean;
  full: boolean;
}

export interface CashReportedAlert {
  code: string;
  unit?: string | null;
  message?: string | null;
  since?: number | string | null;
}

export interface CashStationStatus {
  state: StationState | string | null;
  ready: boolean;
  reason: string | null;
  changeAvailableAgorot: number | null;
  exactOnly: boolean | null;
  queue: number | null;
  activeTxId: string | null;
  heldCount: number | null;
  deviceSerial: string | null;
  firmware: string | null;
  reportedAt: string | null;
  stale: boolean;
  // Detail only.
  denominations?: CashDenomination[];
  cashbox?: CashCashbox | null;
  driver?: number | null;
  des?: number | null;
  alerts?: CashReportedAlert[];
}

export interface CashStationAlert {
  id: string;
  code: string;
  unit: string | null;
  text: string;
  severity: string | null;
  source: 'heartbeat' | 'journal' | 'watch' | string | null;
  since: string | null;
  txId: string | null;
  acknowledgedBy: string | null;
}

export interface CashCommandRecord {
  id: string;
  stationId: string;
  op: string;
  args: Record<string, unknown>;
  by: { userId?: string | null; name?: string | null } | null;
  createdAt: string | null;
  status: CommandStatus | string;
  message: string | null;
  movementId: string | null;
  ackedAt: string | null;
}

/** The station's own overrides of the §11.10 station parameters, typed (null / absent: inherit). */
export type StationSettings = Partial<Record<StationSettingKey, unknown>>;

export interface CashStation {
  stationId: string;
  shopId: string;
  shopName: string | null;
  companyId: string | null;
  name: string;
  location: string | null;
  label: string;
  serial: string;
  isActive: boolean;
  host: CashStationHost | null;
  clients: CashStationClient[];
  status: CashStationStatus | null;
  alerts: CashStationAlert[];
  owed: { count: number; amountAgorot: number };
  settings: StationSettings;
  createdAt: string | null;
  updatedAt: string | null;
  // Detail only.
  effectiveSettings?: Record<string, unknown>;
  alertTills?: { machineId: string; name: string | null; posNumber: string | number | null }[];
  commands?: CashCommandRecord[];
}

export interface CashOwedState {
  status: 'open' | 'resolved' | string;
  kind: OwedKind | string;
  amountAgorot: number;
  openedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  resolvedBy: string | null;
  note: string | null;
  movementId: string | null;
}

export interface CashTx {
  txId: string;
  stationId: string;
  hostId: string | null;
  clientId: string | null;
  clientName: string | null;
  state: TxState | string;
  outcome: TxOutcome | string | null;
  amountAgorot: number | null;
  dueAgorot: number | null;
  roundingAgorot: number | null;
  insertedAgorot: number | null;
  changeDueAgorot: number | null;
  changePaidAgorot: number | null;
  changeOwedAgorot: number | null;
  refundDueAgorot: number | null;
  refundPaidAgorot: number | null;
  heldAgorot: number | null;
  heldReason: string | null;
  cancelReason: string | null;
  slipCode: string | null;
  orderRef: string | null;
  orderLabel: string | null;
  deviceSerial: string | null;
  documentId: string | null;
  documentNumber: string | number | null;
  acked: boolean;
  seq: number | null;
  inserted: Pieces[];
  paidOut: Pieces[];
  error: { code?: string; message?: string } | string | null;
  createdAt: string | null;
  doneAt: string | null;
  owed: CashOwedState | null;
  zReportId: string | null;
}

export interface CashMovement {
  id: string;
  stationId: string;
  kind: MovementKind | string;
  amountAgorot: number;
  expectedAgorot: number | null;
  countedAgorot: number | null;
  pieces: Pieces[];
  by: { userId?: string | null; name?: string | null } | null;
  note: string | null;
  at: string | null;
  zReportId: string | null;
}

export interface CashOwedItem {
  id: string;
  kind: OwedKind | string;
  stationId: string;
  stationName: string | null;
  txId: string;
  slipCode: string | null;
  amountAgorot: number;
  orderLabel: string | null;
  clientName: string | null;
  createdAt: string | null;
  resolvedAt?: string | null;
  resolution?: string | null;
  resolvedBy?: string | null;
  movementId?: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CashReconciliation {
  kioskCashAgorot: number;
  kioskDocuments: number;
  stationNetAgorot: number;
  changeOwedAgorot: number;
  heldAgorot: number;
  expectedNetAgorot: number;
  differenceAgorot: number;
}

export interface CashDrawerSummary {
  acceptedAgorot: number;
  changeAgorot: number;
  refundsAgorot: number;
  netAgorot: number;
  floatAgorot: number;
  refillsAgorot: number;
  collectionsAgorot: number;
  adjustmentsAgorot: number;
  expectedAgorot: number;
  heldAgorot: number;
  changeOwedAgorot: number;
  txCount: number;
  paidCount: number;
  refundedCount: number;
  heldCount: number;
  nothingInsertedCount: number;
  lastCount: {
    at: string | null;
    expectedAgorot: number | null;
    countedAgorot: number | null;
    varianceAgorot: number | null;
    by: { name?: string | null } | null;
  } | null;
}

/** A shop Z's block for one station (cash_station_drawer.py `station_block`). */
export type CashZBlock = CashDrawerSummary & {
  stationId: string;
  name: string;
  location: string | null;
  serial: string;
  hostId: string | null;
  hostName: string | null;
  reconciliation: CashReconciliation;
};

export interface CashDrawer {
  stationId: string;
  from: string | null;
  to: string | null;
  summary: CashDrawerSummary;
  reconciliation: CashReconciliation;
  balanceAgorot: number;
  zReports: { zReportId: string; zNumber: number | string | null; closedAt: string | null; station: CashZBlock | null }[];
}

// ── States and tones ─────────────────────────────────────────────────────────

export type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'muted';

/**
 * What a station's pill says: its reported state, or why there is none — taken out of use, no host chosen,
 * the host never reported it, or the report is old / the host is offline ("offline").
 */
export type StationPill = StationState | 'offline' | 'no_host' | 'no_report' | 'inactive' | 'unknown';

export function stationPillOf(s: Pick<CashStation, 'isActive' | 'host' | 'status'>): StationPill {
  if (!s.isActive) return 'inactive';
  if (!s.host) return 'no_host';
  if (!s.status) return 'no_report';
  if (s.status.stale || !s.host.online) return 'offline';
  const state = s.status.state;
  return (STATION_STATES as readonly string[]).includes(state ?? '') ? (state as StationState) : 'unknown';
}

export function stationPillTone(pill: StationPill): Tone {
  switch (pill) {
    case 'ready':
      return 'ok';
    case 'busy':
      return 'info';
    case 'maintenance':
    case 'starting':
    case 'no_report':
      return 'warn';
    case 'fault':
    case 'offline':
    case 'unknown':
      return 'bad';
    default:
      return 'muted';
  }
}

/** A journal row's tone: paid (ok), refunded (info), nothing inserted (muted), held (bad), still open (warn). */
export function txTone(tx: Pick<CashTx, 'state' | 'outcome'>): Tone {
  if (tx.state === 'HELD') return 'bad';
  if (tx.state !== 'DONE') return 'warn';
  if (tx.outcome === 'paid') return 'ok';
  if (tx.outcome === 'refunded') return 'info';
  return 'muted';
}

export function commandTone(status: string): Tone {
  if (status === 'done') return 'ok';
  if (status === 'pending') return 'info';
  if (status === 'refused') return 'warn';
  return 'bad';
}

/** The tx id as the kiosk's fault slip prints it (§11.6.6: its first 8 characters). */
export function shortTxId(txId: string | null | undefined): string {
  return (txId ?? '').slice(0, 8);
}

// ── The reconciliation ───────────────────────────────────────────────────────

/**
 * The station's net against what it should hold of the kiosks' cash: net − (Σ kiosk cash legs incl. rounding
 * + change owed + credits held) — the server's own rule (cash_station_drawer.py `reconciliation`), worked out
 * again from the figures so a page never shows a difference its figures do not add up to.
 */
export function reconciliationDifference(
  r: Pick<CashReconciliation, 'stationNetAgorot' | 'kioskCashAgorot' | 'changeOwedAgorot' | 'heldAgorot'>,
): number {
  return (r.stationNetAgorot || 0) - ((r.kioskCashAgorot || 0) + (r.changeOwedAgorot || 0) + (r.heldAgorot || 0));
}

/** 'ok' when the station and the kiosks agree; 'over' — more money in the station; 'short' — less. */
export function reconciliationState(differenceAgorot: number): 'ok' | 'over' | 'short' {
  if (differenceAgorot === 0) return 'ok';
  return differenceAgorot > 0 ? 'over' : 'short';
}

// ── Journal filters ──────────────────────────────────────────────────────────

export interface JournalFilters {
  /** "2026-10-14" ('' = open). Both ends inclusive days. */
  from: string;
  to: string;
  state: TxState | '';
  outcome: TxOutcome | '';
  owed: OwedFilter | '';
}

export const EMPTY_JOURNAL_FILTERS: JournalFilters = { from: '', to: '', state: '', outcome: '', owed: '' };
export const JOURNAL_PAGE = 50;

/** "2026-10-14" + n days. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().slice(0, 10);
}

/**
 * The query of `GET /cash-stations/{id}/journal` (or `/movements`, `/drawer`): `to` is exclusive on the
 * server, so the last day chosen is sent as the next day's start. Empty filters are left out.
 */
export function rangeParams(from: string, to: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) out.from = from;
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) out.to = addDays(to, 1);
  return out;
}

export function journalParams(f: JournalFilters, page: number, limit = JOURNAL_PAGE): Record<string, string | number> {
  return {
    ...rangeParams(f.from, f.to),
    ...(f.state ? { state: f.state } : {}),
    ...(f.outcome ? { outcome: f.outcome } : {}),
    ...(f.owed ? { owed: f.owed } : {}),
    limit,
    offset: Math.max(0, page) * limit,
  };
}

/** "1–50 מתוך 132" parts: the rows shown and whether there is a page before / after. */
export function pageInfo(p: Pick<Page<unknown>, 'total' | 'limit' | 'offset'> & { count: number }): {
  first: number;
  last: number;
  hasPrev: boolean;
  hasNext: boolean;
} {
  const first = p.count === 0 ? 0 : p.offset + 1;
  const last = p.offset + p.count;
  return { first, last, hasPrev: p.offset > 0, hasNext: last < p.total };
}

// ── Commands ─────────────────────────────────────────────────────────────────

export interface CommandDraft {
  op: CommandOp;
  /** Counts typed per denomination (agorot → text). */
  counts: Record<number, string>;
  /** "count": the cashbox as counted; "collect": the amount taken out (₪ text; '' = not given). */
  counted: string;
  /** "dump": null = everything that can dump; else one denomination. */
  dumpValue: number | null;
  /** "dump" of one denomination: how many notes ('' = all of it). */
  dumpNotes: string;
  note: string;
}

export function emptyCommandDraft(op: CommandOp): CommandDraft {
  return { op, counts: {}, counted: '', dumpValue: null, dumpNotes: '', note: '' };
}

/** The ops with per-denomination counts. */
export function commandHasPieces(op: CommandOp): boolean {
  return op === 'float' || op === 'refill' || op === 'count';
}

export type CommandDraftError = 'pieces' | 'count' | 'counted' | 'dumpNotes' | 'nothing';

function countOf(text: string | undefined): number | null | 'bad' {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return 'bad';
  const n = Number(raw);
  return n <= 1_000_000 ? n : 'bad';
}

function draftPieces(d: CommandDraft): { pieces: { valueAgorot: number; count: number }[]; bad: boolean } {
  const pieces: { valueAgorot: number; count: number }[] = [];
  let bad = false;
  for (const value of ILS_DENOMINATIONS) {
    const c = countOf(d.counts[value]);
    if (c === 'bad') bad = true;
    else if (c !== null) pieces.push({ valueAgorot: value, count: c });
  }
  return { pieces, bad };
}

/** What is still wrong with the draft, or null. */
export function commandDraftError(d: CommandDraft): CommandDraftError | null {
  if (commandHasPieces(d.op)) {
    const { pieces, bad } = draftPieces(d);
    if (bad) return 'count';
    if (d.op === 'count') {
      if (d.counted.trim() && shekelsToAgorot(d.counted) === null) return 'counted';
      if (pieces.length === 0 && !d.counted.trim()) return 'nothing';
      return null;
    }
    // A float / refill loads something.
    if (!pieces.some((p) => p.count > 0)) return 'pieces';
    return null;
  }
  if (d.op === 'collect' && d.counted.trim() && shekelsToAgorot(d.counted) === null) return 'counted';
  if (d.op === 'dump' && d.dumpValue !== null) {
    const n = countOf(d.dumpNotes);
    if (n === 'bad' || n === 0 || (typeof n === 'number' && n > DUMP_NOTES_MAX)) return 'dumpNotes';
  }
  return null;
}

/** A partial dump's count: 1–100000 notes (the server's `notes`). */
export const DUMP_NOTES_MAX = 100_000;

/**
 * `POST /cash-stations/{id}/commands`'s body for the draft (null while `commandDraftError`):
 * `{op, args: {pieces?, countedAgorot?, note?}}`. A dump of one denomination: `valueAgorot` (that coin / note)
 * and, for a partial one, `notes` — as the cloud keeps them and the host reads them; no `pieces`.
 */
export function commandBody(d: CommandDraft): { op: CommandOp; args: Record<string, unknown> } | null {
  if (commandDraftError(d)) return null;
  const args: Record<string, unknown> = {};
  if (NO_ARG_OPS.includes(d.op)) return { op: d.op, args };
  if (commandHasPieces(d.op)) {
    const { pieces } = draftPieces(d);
    const kept = d.op === 'count' ? pieces : pieces.filter((p) => p.count > 0);
    if (kept.length) args.pieces = kept;
    if (d.op === 'count') {
      const counted = shekelsToAgorot(d.counted);
      if (counted !== null) args.countedAgorot = counted;
    }
  } else if (d.op === 'collect') {
    const counted = shekelsToAgorot(d.counted);
    if (counted !== null) args.countedAgorot = counted;
  } else if (d.op === 'dump' && d.dumpValue !== null) {
    const n = countOf(d.dumpNotes);
    const notes = typeof n === 'number' ? n : null;
    args.valueAgorot = d.dumpValue;
    if (notes !== null) args.notes = notes;
  }
  const note = d.note.trim().replace(/\s+/g, ' ').slice(0, 300);
  if (note) args.note = note;
  return { op: d.op, args };
}

/** Σ of the draft's counted pieces (a float / refill / count's total), in agorot. */
export function commandDraftTotal(d: CommandDraft): number {
  return piecesTotal(draftPieces(d).pieces);
}

// ── Station settings (the station's own overrides of §11.10) ─────────────────

/** cash_params.py STATION_KEYS — what a station may override. */
export const STATION_SETTING_KEYS = [
  'cashCoinsAccepted',
  'cashNotesAccepted',
  'cashMaxChangeAgorot',
  'cashExactChangeBelowAgorot',
  'cashChangeShortfall',
  'cashAlertTills',
  'cashRounding',
  'cashFloatLevels',
  'cashCashboxCapacity',
  'cashLampMap',
  'cashSwitchMap',
  'cashSimulator',
  'cashSettleMs',
  'cashPayoutTimeoutSec',
  'cashExtendedEscrow',
  'cashHopperFeeds',
  'cashUnackedHoldMin',
  'cashInsertTimeoutSec',
  'cashIdleTimeoutSec',
  'cashQueueTimeoutSec',
  'cashRefundGraceSec',
] as const;
export type StationSettingKey = (typeof STATION_SETTING_KEYS)[number];

export const SHORTFALL_OPTIONS = ['prevent', 'notify', 'ask'] as const;
export const ROUNDING_OPTIONS = ['none', 'nearest_10'] as const;
export const HOPPER_FEEDS_OPTIONS = ['auto', 'all', 'none'] as const;
export const DOOR_MEANS = ['closed', 'open'] as const;
export const CASHBOX_MEANS = ['present', 'removed'] as const;
/** A PayLink's inputs / outputs as the driver numbers them (cash_params.py IO_MAX). */
export const IO_MAX = 63;

/** Integer keys and their ranges (cash_params.py RANGES); the money ones are typed in ₪ (`MONEY_KEYS`). */
export const INT_RANGES: Partial<Record<StationSettingKey, [number, number]>> = {
  cashMaxChangeAgorot: [0, 1_000_000],
  cashExactChangeBelowAgorot: [0, 1_000_000],
  cashInsertTimeoutSec: [20, 1800],
  cashIdleTimeoutSec: [10, 600],
  cashQueueTimeoutSec: [10, 1800],
  cashRefundGraceSec: [10, 1800],
  cashSettleMs: [0, 10_000],
  cashPayoutTimeoutSec: [5, 600],
  cashUnackedHoldMin: [1, 1440],
};
export const MONEY_KEYS: readonly StationSettingKey[] = ['cashMaxChangeAgorot', 'cashExactChangeBelowAgorot'];
export const BOOL_KEYS: readonly StationSettingKey[] = ['cashSimulator', 'cashExtendedEscrow'];
export const ENUM_KEYS: Partial<Record<StationSettingKey, readonly string[]>> = {
  cashChangeShortfall: SHORTFALL_OPTIONS,
  cashRounding: ROUNDING_OPTIONS,
  cashHopperFeeds: HOPPER_FEEDS_OPTIONS,
};

export interface LevelDraft {
  target: string;
  low: string;
}
export interface SwitchDraft {
  n: string;
  closedMeans: string;
}

/** The form's value of every key: text for numbers, lists of numbers / ids, the maps' own fields. */
export interface SettingsValues {
  cashCoinsAccepted: number[];
  cashNotesAccepted: number[];
  cashAlertTills: string[];
  cashFloatLevels: Record<number, LevelDraft>;
  cashCashboxCapacity: { notes: string; coins: string };
  cashLampMap: { busy: string; fault: string; ready: string; clients: Record<string, string> };
  cashSwitchMap: { door: SwitchDraft; cashbox: SwitchDraft };
  /** Every other key: a number as text, an enum code, a boolean. */
  scalar: Partial<Record<StationSettingKey, string | boolean>>;
}

export interface SettingsDraft {
  /** The keys the station overrides; the others inherit. */
  on: Partial<Record<StationSettingKey, boolean>>;
  values: SettingsValues;
}

const LIST_OR_MAP: readonly StationSettingKey[] = [
  'cashCoinsAccepted',
  'cashNotesAccepted',
  'cashAlertTills',
  'cashFloatLevels',
  'cashCashboxCapacity',
  'cashLampMap',
  'cashSwitchMap',
];

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function numberList(value: unknown, allowed: readonly number[]): number[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const out: number[] = [];
  for (const v of raw) {
    const n = Number(typeof v === 'string' ? v.trim() : v);
    if (Number.isInteger(n) && allowed.includes(n) && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** `cashAlertTills` as ids: a JSON list or the parameter's comma text. */
export function idList(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\n]/) : [];
  const out: string[] = [];
  for (const v of raw) {
    const id = String(v ?? '').trim().toLowerCase();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The parameter's comma text of a list of ids / agorot. */
export function listText(values: readonly (string | number)[]): string {
  return values.map(String).join(',');
}

/** `cashCoinsAccepted` / `cashNotesAccepted` as agorot (unknown values dropped). */
export function denominationList(value: unknown, kind: 'coins' | 'notes'): number[] {
  return numberList(value, kind === 'coins' ? ILS_COINS : ILS_NOTES);
}

const intText = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** One map / list of a settings source (an override, or the effective value) as the form's value. */
function valuesOf(source: Record<string, unknown>): SettingsValues {
  const levels: Record<number, LevelDraft> = {};
  for (const [denom, level] of Object.entries(asObject(source.cashFloatLevels))) {
    const n = Number(denom);
    if (!ILS_DENOMINATIONS.includes(n)) continue;
    const l = asObject(level);
    levels[n] = { target: intText(l.target), low: intText(l.low) };
  }
  const cashbox = asObject(source.cashCashboxCapacity);
  const lamps = asObject(source.cashLampMap);
  const lampClients: Record<string, string> = {};
  for (const [id, n] of Object.entries(asObject(lamps.clients))) lampClients[id.toLowerCase()] = intText(n);
  const switches = asObject(source.cashSwitchMap);
  const sw = (key: 'door' | 'cashbox', fallback: string): SwitchDraft => {
    const item = asObject(switches[key]);
    return { n: intText(item.n), closedMeans: typeof item.closedMeans === 'string' ? item.closedMeans : fallback };
  };
  const scalar: Partial<Record<StationSettingKey, string | boolean>> = {};
  for (const key of STATION_SETTING_KEYS) {
    if (LIST_OR_MAP.includes(key)) continue;
    const v = source[key];
    if (BOOL_KEYS.includes(key)) scalar[key] = v === true;
    else if (MONEY_KEYS.includes(key)) scalar[key] = typeof v === 'number' ? agorotToShekelsText(v) : '';
    else if (INT_RANGES[key]) scalar[key] = intText(v);
    else scalar[key] = typeof v === 'string' ? v : '';
  }
  return {
    cashCoinsAccepted: denominationList(source.cashCoinsAccepted, 'coins'),
    cashNotesAccepted: denominationList(source.cashNotesAccepted, 'notes'),
    cashAlertTills: idList(source.cashAlertTills),
    cashFloatLevels: levels,
    cashCashboxCapacity: { notes: intText(cashbox.notes), coins: intText(cashbox.coins) },
    cashLampMap: { busy: intText(lamps.busy), fault: intText(lamps.fault), ready: intText(lamps.ready), clients: lampClients },
    cashSwitchMap: { door: sw('door', 'closed'), cashbox: sw('cashbox', 'present') },
    scalar,
  };
}

/**
 * The form for a station: each key it overrides is "on" with its own value; each other key starts from
 * the effective value (what the station runs with now), so turning an override on begins from it.
 */
export function settingsDraftOf(overrides: Record<string, unknown> | null | undefined, effective: Record<string, unknown> | null | undefined): SettingsDraft {
  const own = overrides ?? {};
  const merged: Record<string, unknown> = { ...(effective ?? {}), ...own };
  const on: Partial<Record<StationSettingKey, boolean>> = {};
  for (const key of STATION_SETTING_KEYS) if (own[key] !== undefined && own[key] !== null) on[key] = true;
  return { on, values: valuesOf(merged) };
}

export type SettingsError = { key: StationSettingKey; problem: 'range' | 'number' | 'empty' | 'io' | 'option' };

function intIn(text: string, lo: number, hi: number): number | 'bad' | null {
  const raw = text.trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return 'bad';
  const n = Number(raw);
  return n >= lo && n <= hi ? n : 'bad';
}

/** One overridden key's value as the server takes it (typed), or an error. */
function overrideValue(key: StationSettingKey, v: SettingsValues): { value: unknown } | { problem: SettingsError['problem'] } {
  switch (key) {
    case 'cashCoinsAccepted':
      return { value: [...v.cashCoinsAccepted].sort((a, b) => a - b) };
    case 'cashNotesAccepted':
      return { value: [...v.cashNotesAccepted].sort((a, b) => a - b) };
    case 'cashAlertTills':
      return { value: [...v.cashAlertTills] };
    case 'cashFloatLevels': {
      const out: Record<string, { target?: number; low?: number }> = {};
      for (const denom of ILS_DENOMINATIONS) {
        const l = v.cashFloatLevels[denom];
        if (!l) continue;
        const target = intIn(l.target, 0, 100_000);
        const low = intIn(l.low, 0, 100_000);
        if (target === 'bad' || low === 'bad') return { problem: 'range' };
        if (target === null && low === null) continue;
        out[String(denom)] = { ...(target !== null ? { target } : {}), ...(low !== null ? { low } : {}) };
      }
      return { value: out };
    }
    case 'cashCashboxCapacity': {
      const out: Record<string, number> = {};
      for (const f of ['notes', 'coins'] as const) {
        const n = intIn(v.cashCashboxCapacity[f], 0, 1_000_000);
        if (n === 'bad') return { problem: 'range' };
        if (n !== null) out[f] = n;
      }
      return { value: out };
    }
    case 'cashLampMap': {
      const out: Record<string, unknown> = {};
      for (const f of ['busy', 'fault', 'ready'] as const) {
        const n = intIn(v.cashLampMap[f], 0, IO_MAX);
        if (n === 'bad') return { problem: 'io' };
        if (n !== null) out[f] = n;
      }
      const clients: Record<string, number> = {};
      for (const [id, text] of Object.entries(v.cashLampMap.clients)) {
        const n = intIn(text, 0, IO_MAX);
        if (n === 'bad') return { problem: 'io' };
        if (n !== null) clients[id] = n;
      }
      if (Object.keys(clients).length) out.clients = clients;
      return { value: out };
    }
    case 'cashSwitchMap': {
      const out: Record<string, unknown> = {};
      const pairs: [('door' | 'cashbox'), readonly string[]][] = [['door', DOOR_MEANS], ['cashbox', CASHBOX_MEANS]];
      for (const [f, means] of pairs) {
        const item = v.cashSwitchMap[f];
        const n = intIn(item.n, 0, IO_MAX);
        if (n === 'bad') return { problem: 'io' };
        if (n === null) continue;
        if (!means.includes(item.closedMeans)) return { problem: 'option' };
        out[f] = { n, closedMeans: item.closedMeans };
      }
      return { value: out };
    }
    default:
      break;
  }
  const raw = v.scalar[key];
  if (BOOL_KEYS.includes(key)) return { value: raw === true };
  if (MONEY_KEYS.includes(key)) {
    const agorot = shekelsToAgorot(typeof raw === 'string' ? raw : '');
    if (agorot === null) return { problem: typeof raw === 'string' && raw.trim() ? 'number' : 'empty' };
    const [lo, hi] = INT_RANGES[key] ?? [0, Number.MAX_SAFE_INTEGER];
    return agorot >= lo && agorot <= hi ? { value: agorot } : { problem: 'range' };
  }
  const range = INT_RANGES[key];
  if (range) {
    const text = typeof raw === 'string' ? raw : '';
    if (!text.trim()) return { problem: 'empty' };
    const n = intIn(text, range[0], range[1]);
    return n === 'bad' || n === null ? { problem: 'range' } : { value: n };
  }
  const options = ENUM_KEYS[key];
  if (options) return typeof raw === 'string' && options.includes(raw) ? { value: raw } : { problem: 'option' };
  return { value: raw };
}

/**
 * The station's `settings` for `PUT /cash-stations/{id}`: only the keys it overrides, typed as the server
 * stores them (a list as a list, a map as an object, money in agorot); every other key inherits. The errors
 * name the keys the server would refuse.
 */
export function settingsBody(d: SettingsDraft): { settings: Record<string, unknown>; errors: SettingsError[] } {
  const settings: Record<string, unknown> = {};
  const errors: SettingsError[] = [];
  for (const key of STATION_SETTING_KEYS) {
    if (!d.on[key]) continue;
    const r = overrideValue(key, d.values);
    if ('problem' in r) errors.push({ key, problem: r.problem });
    else settings[key] = r.value;
  }
  return { settings, errors };
}

/** An effective value in words for beside an override (lists of money, maps as JSON). */
export function effectiveText(key: string, value: unknown, labels: { yes: string; no: string } = { yes: 'כן', no: 'לא' }): string {
  if (value === null || value === undefined || value === '') return '—';
  if (key === 'cashCoinsAccepted' || key === 'cashNotesAccepted') {
    const list = denominationList(value, key === 'cashCoinsAccepted' ? 'coins' : 'notes');
    return list.length ? list.map(denominationText).join(', ') : '—';
  }
  if (key === 'cashMaxChangeAgorot' || key === 'cashExactChangeBelowAgorot') return typeof value === 'number' ? agorotText(value) : String(value);
  if (typeof value === 'boolean') return value ? labels.yes : labels.no;
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text === '{}' ? '—' : text;
  }
  return String(value);
}

// ── Kiosk assignment and the cash parameters' keys ───────────────────────────
// A kiosk is assigned by its own till parameters (`cashEnabled`, `cashStation`), which the server writes for
// "משויך לעמדה" (`PUT /cash-stations/{id}/clients/{machineId}`).

export const CASH_ENABLED_KEY = 'cashEnabled';
export const CASH_STATION_KEY = 'cashStation';
export const CASH_ALERT_TILLS_KEY = 'cashAlertTills';
export const CASH_COINS_KEY = 'cashCoinsAccepted';
export const CASH_NOTES_KEY = 'cashNotesAccepted';

/** Which station of `stations` a kiosk resolves to now (each station's `clients`), or null. */
export function stationOfClient(stations: readonly Pick<CashStation, 'stationId' | 'clients'>[], machineId: string): string | null {
  const id = machineId.toLowerCase();
  for (const s of stations) if (s.clients.some((c) => c.machineId.toLowerCase() === id)) return s.stationId;
  return null;
}

/** A station's "name (location)" when the server did not send `label`. */
export function stationLabel(s: Pick<CashStation, 'name' | 'location'> & { label?: string | null }): string {
  if (s.label) return s.label;
  return s.location ? `${s.name} (${s.location})` : s.name;
}
