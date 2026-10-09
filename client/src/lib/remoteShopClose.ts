/**
 * "סגירת יום סניפית" from remote control (pos-server app/services/remote_till_z.py shop_preview /
 * shop_request, behind the server's REMOTE_TILL_Z_ENABLED). The server decides everything from the
 * shop's configuration — where its Z is produced, which tills are in it, which have their own Z — and
 * says why an action is not available; these are the pure parts the panel shows.
 */
import type { RemoteClosePreview } from './remoteTillZ';

export interface ShopCloseAction {
  kind: 'close_shift' | 'till_z';
  label: string;
  available: boolean;
  whyNot: string | null;
}

export interface ShopCloseRow {
  machineId: string;
  name: string;
  posNumber: string | null;
  seated: boolean;
  isKiosk: boolean;
  kindLabel: string;
  openShift: boolean;
  shiftsAwaitingZ: number;
  net: number;
  online: boolean | null;
  pendingDocuments: number | null;
  action: ShopCloseAction;
  /** An own-Z kiosk set "סגירה יחד עם ה-Z הסניפי". */
  closesWithShopZ?: boolean;
  runItem?: { status: string; errorCode: string | null; words: string };
}

/** Each till's request in the shape of every remote command (device_commands.command_out). */
export interface ShopCloseCommand {
  id: string;
  machineId: string;
  batchId: string | null;
  action: string;
  message: string | null;
  status: string;
  detail: string | null;
  source: string;
  createdBy: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  doneAt: string | null;
  expiresAt: string | null;
}

export interface ShopCloseRunItem {
  id: string;
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  status: string;
  errorCode: string | null;
  words: string;
  online: boolean | null;
}

export interface ShopCloseRun {
  id: string;
  shopId: string;
  status: string;
  zNumber: number | null;
  words: string;
  waitForRest: boolean;
  leaveOutAllowed: boolean;
  leaveOutWhyNot: string | null;
  /** Support's force past "חסימת Z כשיש משמרות פתוחות": the super admin only (the server decides). */
  forceAllowed: boolean;
  items: ShopCloseRunItem[];
  commands: ShopCloseCommand[];
}

export interface ShiftGuardBlocker {
  machineId: string;
  name: string;
  posNumber: string | null;
  status: 'open_shift' | 'pending_acceptance';
  online: boolean;
  words: string;
}

export interface ShiftGuard {
  label: string;
  required: boolean;
  blockers: ShiftGuardBlocker[];
}

/** The force's reason, as the server takes it: typed, at least 5 characters. */
export function forceReasonOk(reason: string): boolean {
  return reason.trim().length >= 5;
}

export interface ShopClosePreview {
  shopId: string;
  shopName: string;
  source: { kind: 'cloud' | 'main_till'; label: string; machineId: string | null; available: boolean; whyNot: string | null };
  inShopZ: ShopCloseRow[];
  ownZ: ShopCloseRow[];
  totals: RemoteClosePreview['totals'];
  lastShopZNumber: number;
  nextShopZNumber: number;
  run: ShopCloseRun | null;
  /** "חסימת Z כשיש משמרות פתוחות": on here, and the tills holding the Z now (מנותקת / משמרת פתוחה / ממתין לקבלה). */
  shiftGuard: ShiftGuard;
  shopClose: { label: string; available: boolean; whyNot: string | null };
  totalsKey: string;
}

/** The run is still going (tills closing / the Z being built). */
export function runActive(status: string | null | undefined): boolean {
  return status === 'waiting' || status === 'building';
}

/** "1/3 נסגרו": the tills closed out of those the run waits for (left-out ones not counted). */
export function runCounts(run: Pick<ShopCloseRun, 'items'>): { closed: number; total: number } {
  const counted = run.items.filter((i) => i.status !== 'excluded');
  return { closed: counted.filter((i) => i.status === 'ready').length, total: counted.length };
}

/** The tills the manager could build without ("בנה בלי"): not closed yet, still in the run. */
export function notClosedIds(run: Pick<ShopCloseRun, 'items'>): string[] {
  return run.items.filter((i) => i.status !== 'ready' && i.status !== 'excluded').map((i) => i.machineId);
}

/** The tone of a till's state in the run. */
export function itemTone(status: string, errorCode: string | null | undefined): 'ok' | 'wait' | 'bad' | 'muted' {
  if (status === 'ready') return 'ok';
  if (status === 'failed' || status === 'expired') return 'bad';
  if (status === 'excluded') return 'muted';
  return errorCode || status === 'waiting_close' || status === 'closing' ? 'wait' : 'muted';
}

/**
 * A refusal the wizard's flow asks the manager to confirm, by its code: the flag to send again
 * with, and what is confirmed. Null for any other refusal.
 */
export function confirmationAsked(code: string | null | undefined): { flag: 'confirmCloudData' | 'confirmOpenTills'; text: string } | null {
  if (code === 'cloud_data_confirmation_required') {
    return { flag: 'confirmCloudData', text: 'אני מאשר/ת שהנתונים בענן הם הנתונים הקיימים' };
  }
  if (code === 'open_tills_need_confirmation') {
    return { flag: 'confirmOpenTills', text: 'אני מאשר/ת להפיק את ה-Z בלי הקופות שברשימה — הן ייכנסו ל-Z הבא' };
  }
  return null;
}

/** The confirm button's words: "סגור את היום · Z 42". */
export function shopConfirmLabel(p: Pick<ShopClosePreview, 'nextShopZNumber'>): string {
  return `סגור את היום · Z ${p.nextShopZNumber}`;
}
