/**
 * "מסופונים — מצב לא מקוון" — every card terminal of a shop to the deferred (offline) mode and back,
 * from the dashboard (P:/specs/nayax-deferred-all.md §8, §9; pos-server app/services/deferred_control.py,
 * app/routers/deferred_terminals.py).
 *
 * The pure half (no React, no `@/` imports — tested by node:test): the API's shapes and how the page
 * says each thing in Hebrew — the terminal, why a till is left out (§8.2), the terminal's mode, the last
 * command (§8.5: ממתין / התקבל / בוצע / נכשל / בוטל) and its outcome — "אושרו X · נדחו Y" on the way back
 * online, who won a conflict (§8.7: "בוטל ע״י …", "הוחלפה ע״י … ב-20:14", "אין קו — נשאר לא מקוון", "כבר
 * במצב הזה") — and the order the till last carried out (`lastApplied`). The API calls are
 * lib/deferredTerminalsApi.ts; the page is app/dashboard/deferred-terminals/page.tsx.
 */

export type CommandState = 'pending' | 'received' | 'done' | 'failed' | 'cancelled';
export type TerminalMode = 'offline' | 'online' | 'unknown';

/** `by` / `from` as a till writes it: a name, or `{id | machineId, name}` (the switch's body). */
export type Party = string | { id?: string | null; machineId?: string | null; name?: string | null } | null | undefined;

/** An order as the till names one (§8.7 `supersededBy`, `lastApplied`). */
export interface OrderRef {
  requestId?: string | null;
  on?: boolean | null;
  source?: string | null;
  from?: Party;
  by?: Party;
  issuedAt?: string | null;
  doneAt?: string | null;
}

export interface Authorization {
  ok?: boolean | null;
  statusCode?: number | null;
  approved?: number | null;
  declined?: number | null;
  approvedAmount?: string | number | null;
}

export interface CommandResult {
  working?: boolean | null;
  pending?: number | null;
  authorization?: Authorization | null;
  error?: string | null;
  supersededBy?: OrderRef | null;
  unchanged?: boolean | null;
}

/** A till's last `terminal_offline` command as the dashboard reads it. */
export interface LastCommand {
  id: string;
  on: boolean | null;
  /** The command's own status (pending, delivered, done, refused, failed, expired, cancelled). */
  status: string;
  /** §8.5's words for it. */
  state: CommandState;
  receivedAt: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  doneAt: string | null;
  expiresAt: string | null;
  createdBy: string | null;
  detail: string | null;
  result: CommandResult | null;
}

export interface DeferredTill {
  machineId: string;
  name: string;
  posNumber: string | null;
  label: string;
  isKiosk: boolean;
  online: boolean;
  lastSeenAt: string | null;
  /** Its build takes the command (`deferred_control_v1`). */
  capable: boolean;
  isController: boolean;
  kind: string | null;
  model: string | null;
  /** True: included; false: not (`reason`); null: not known yet. */
  eligible: boolean | null;
  reason: string | null;
  reasonText: string | null;
  mode: TerminalMode;
  pending: number | null;
  txLimit: number | null;
  txLeft: number | null;
  lastApplied: OrderRef | null;
  reportedAt: string | null;
  lastCommand: LastCommand | null;
}

export interface DeferredSettings {
  includeKiosks: boolean;
  autoOff: 'ask' | 'auto' | 'never';
  autoOffMinutes: number;
  allowUnknownNayax: boolean;
  ttlMinutes: number;
  autoOn?: 'offer' | 'auto' | 'off';
  autoOnFailures?: number;
  autoOnSeconds?: number;
  autoOnAll?: boolean;
  conflictWindowSec?: number;
  onlineRequiresLine?: boolean;
}

/** `GET /shops/{id}/deferred-terminals`. */
export interface DeferredShopView {
  shopId: string;
  shopName: string;
  serverTime: string;
  settings: DeferredSettings;
  /** The tills that show the screen on the till ("קופות מנהלות"). */
  controllers: string[];
  canSwitch: boolean;
  /** A command is still on its way: poll. */
  open: boolean;
  tills: DeferredTill[];
}

/** `POST /shops/{id}/deferred-terminals/switch`. */
export interface SwitchResult {
  batchId: string | null;
  on: boolean;
  created: { machineId: string; commandId: string }[];
  skipped: { machineId: string; reason: string }[];
}

/** One of the device page's values (`GET /machines/{id}/deferred-settings`). */
export interface DeviceDeferredKey {
  key: string;
  label: string;
  description: string | null;
  valueType: 'enum' | 'integer' | 'boolean' | 'string';
  enumOptions: string[] | null;
  enumLabels: Record<string, string> | null;
  min: number | null;
  max: number | null;
  own: string | number | boolean | null;
  inherited: string | number | boolean | null;
  effective: string | number | boolean | null;
}

export interface DeviceDeferredView {
  machineId: string;
  shopId: string | null;
  isController: boolean;
  capable: boolean;
  canEdit: boolean;
  canEditController: boolean;
  keys: DeviceDeferredKey[];
}

// ── Words ─────────────────────────────────────────────────────────────────────

/** §8.2 "טקסטים" (`other_model` names the model — `reasonText`). */
export const REASON_TEXTS: Record<string, string> = {
  kiosk_excluded: 'קיוסק — לא נכלל',
  no_card: 'ללא אשראי',
  zcredit: 'Z-Credit — לא נתמך',
  synqpay: 'SynqPay — לא נתמך',
  tap_to_pay: 'Tap to Pay — לא נתמך',
  training: 'מצב הדרכה',
  unknown_model: 'דגם לא מזוהה — לא נכלל',
  other_model: 'דגם {model} — לא נתמך',
  not_allowed: 'Nayax לא התירו מצב לא מקוון במסוף',
  needs_update: 'הקופה צריכה עדכון',
};

export function reasonText(reason: string | null | undefined, model?: string | null): string | null {
  if (!reason) return null;
  if (reason === 'other_model') return REASON_TEXTS.other_model.replace('{model}', (model ?? '').trim() || 'אחר');
  return REASON_TEXTS[reason] ?? reason;
}

/** Why a switch left a till out (`skipped[].reason`). */
export function skipText(reason: string): string {
  if (reason.startsWith('not_eligible:')) return reasonText(reason.slice('not_eligible:'.length)) ?? 'לא נכלל';
  if (reason === 'not_found') return 'לא נמצאה בסניף';
  return reasonText(reason) ?? reason;
}

export const KIND_LABELS: Record<string, string> = {
  agamento: 'אשראי מובנה (Agamento)',
  nayax_lan: 'Nayax ברשת',
  nayax_usb: 'Nayax ב-USB',
  zcredit: 'Z-Credit',
  synqpay: 'SynqPay',
  tap_to_pay: 'Tap to Pay',
  none: 'ללא אשראי',
};

/** "Nayax ברשת · C4". */
export function terminalText(kind: string | null | undefined, model: string | null | undefined): string {
  const name = kind ? KIND_LABELS[kind] ?? kind : 'לא ידוע';
  return model ? `${name} · ${model}` : name;
}

export const MODE_LABELS: Record<TerminalMode, string> = {
  offline: 'לא מקוון',
  online: 'מקוון',
  unknown: 'לא ידוע',
};

/** §8.5 "מצב בדשבורד". */
export const STATE_LABELS: Record<CommandState, string> = {
  pending: 'ממתין',
  received: 'התקבל',
  done: 'בוצע',
  failed: 'נכשל',
  cancelled: 'בוטל',
};

export function isOpenCommand(cmd: LastCommand | null | undefined): boolean {
  return !!cmd && (cmd.state === 'pending' || cmd.state === 'received');
}

export function partyName(party: Party): string | null {
  if (!party) return null;
  if (typeof party === 'string') return party.trim() || null;
  return (party.name ?? '').trim() || null;
}

/** §8.7: where an order came from — cloud "דשבורד", lan <the till>, auto "אוטומטי", local "מנהל בקופה", direct. */
export function sourceLabel(source: string | null | undefined, from?: Party): string {
  switch (source) {
    case 'cloud':
      return 'דשבורד';
    case 'lan':
      return partyName(from) ?? 'קופה מנהלת';
    case 'auto':
      return 'אוטומטי';
    case 'local':
      return 'מנהל בקופה';
    case 'direct':
      return 'ישירות במסופון';
    default:
      return partyName(from) ?? source ?? 'לא ידוע';
  }
}

/** "20:14" in Israel's time (the till's and the owner's clock). */
export function formatHm(iso: string | null | undefined, timeZone = 'Asia/Jerusalem'): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(at);
}

/** "אושרו 5 · נדחו 1" — what the terminal sent for approval on its way back online; null when it said nothing. */
export function authorizationText(auth: Authorization | null | undefined): string | null {
  if (!auth) return null;
  const approved = typeof auth.approved === 'number' ? auth.approved : null;
  const declined = typeof auth.declined === 'number' ? auth.declined : null;
  if (approved == null && declined == null) return auth.ok === false ? 'שליחת העסקאות לאישור נכשלה' : null;
  return `אושרו ${approved ?? 0} · נדחו ${declined ?? 0}`;
}

/** Declined deferred sales: money that will not be collected — shown in red, bold (§5). */
export function declinedCount(cmd: LastCommand | null | undefined): number {
  const declined = cmd?.result?.authorization?.declined;
  return typeof declined === 'number' && declined > 0 ? declined : 0;
}

const DETAIL_TEXTS: Record<string, string> = {
  no_line: 'אין קו — נשאר לא מקוון',
  timeout_busy: 'המסופון היה עסוק עד שפג תוקף הפקודה',
  interrupted: 'הופסק באמצע',
  expired: 'פג תוקף',
  bad_request: 'בקשה לא תקינה',
  not_active: 'הפיצ׳ר לא פעיל בקופה',
  not_answered: 'לא נענתה בזמן',
};

/**
 * The outcome of the last command in words (§8.5, §8.7) — what the till did with it, or why not:
 * "כבר במצב הזה", "אושרו 5 · נדחו 1", "בוטל ע״י קופה 1", "הוחלפה ע״י דשבורד ב-20:14", "אין קו — נשאר לא
 * מקוון", a reason of §8.2, the terminal's own error. Null while it waits.
 */
export function outcomeText(cmd: LastCommand | null | undefined, timeZone?: string): string | null {
  if (!cmd || isOpenCommand(cmd)) return null;
  const result = cmd.result ?? {};
  const detail = cmd.detail ?? '';
  const winner = result.supersededBy ?? null;
  if (cmd.state === 'done') {
    if (result.unchanged) return 'כבר במצב הזה';
    return (cmd.on === false ? authorizationText(result.authorization) : null) ?? 'בוצע';
  }
  if (detail === 'conflict') {
    return `בוטל ע״י ${partyName(winner?.from) ?? sourceLabel(winner?.source, winner?.from)}`;
  }
  if (detail === 'stale' || detail === 'superseded') {
    if (!winner) return 'הוחלפה בהוראה חדשה';
    const at = formatHm(winner.issuedAt, timeZone);
    const who = sourceLabel(winner.source, winner.from);
    return at ? `הוחלפה ע״י ${who} ב-${at}` : `הוחלפה ע״י ${who}`;
  }
  if (detail.startsWith('not_eligible:')) return reasonText(detail.slice('not_eligible:'.length));
  if (DETAIL_TEXTS[detail]) return DETAIL_TEXTS[detail];
  if (result.error) return result.error;
  if (detail) return detail;
  return cmd.state === 'cancelled' ? 'בוטל' : cmd.status === 'expired' ? 'פג תוקף' : null;
}

/** "לא מקוון · קופה 1 · 20:14" — the order the till last carried out (§8.7 `lastApplied`). */
export function lastAppliedText(order: OrderRef | null | undefined, timeZone?: string): string | null {
  if (!order || typeof order.on !== 'boolean') return null;
  const parts = [order.on ? 'לא מקוון' : 'מקוון', sourceLabel(order.source, order.from)];
  const at = formatHm(order.doneAt ?? order.issuedAt, timeZone);
  if (at) parts.push(at);
  return parts.join(' · ');
}

/** "3 מתוך 50" — deferred sales of the terminal's limit. */
export function pendingText(pending: number | null | undefined, txLimit: number | null | undefined): string {
  if (typeof pending !== 'number') return '—';
  return typeof txLimit === 'number' && txLimit > 0 ? `${pending} מתוך ${txLimit}` : String(pending);
}

/** The terminal is close to its limit (§4 "כשמתקרבים למגבלה"): 80% of it, or 5 left. */
export function nearLimit(till: Pick<DeferredTill, 'pending' | 'txLimit' | 'txLeft'>): boolean {
  if (typeof till.txLeft === 'number' && till.txLeft <= 5 && typeof till.txLimit === 'number') return true;
  if (typeof till.pending === 'number' && typeof till.txLimit === 'number' && till.txLimit > 0) {
    return till.pending >= till.txLimit * 0.8;
  }
  return false;
}

/** The rows shown: a kiosk left out while kiosks are not included is not listed (§8.2 step 1). */
export function visibleTills(tills: DeferredTill[]): DeferredTill[] {
  return tills.filter((t) => t.reason !== 'kiosk_excluded');
}

/** A till the switch reaches: included and its build takes the command. */
export function switchable(till: DeferredTill): boolean {
  return till.eligible === true && till.capable;
}

/** Poll quickly while a command is on its way, slowly otherwise. */
export function pollMs(view: Pick<DeferredShopView, 'open'> | null | undefined): number {
  return view?.open ? 3000 : 30000;
}

/** "מועבר: 3 · לא נשלח: 1 (Z-Credit — לא נתמך)" — what a switch did, for the toast. */
export function switchSummary(result: SwitchResult, nameOf: (machineId: string) => string): string {
  const sent = `נשלח ל-${result.created.length} ${result.created.length === 1 ? 'קופה' : 'קופות'}`;
  if (result.skipped.length === 0) return sent;
  const skipped = result.skipped.map((s) => `${nameOf(s.machineId)}: ${skipText(s.reason)}`).join(' · ');
  return `${sent} · לא נשלח — ${skipped}`;
}
