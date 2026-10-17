/**
 * "מדפסות" — the one printer picker of the technician's screen, on every role and both Windows builds (the owner,
 * 17.10.2026: the app finds the printers by itself and staff pick them; "אותה מדפסת יכולה להיות הכל").
 *
 *  - Found together, refreshed while the screen is open: the Windows queues (the spooler — Windows 7 through PowerShell 2 /
 *    WMI), a USB printer plugged in with no driver (usbPrinters.ts), the COM ports (an all-in-one's built-in printer — the
 *    serial transport's list where this build has it), the network printers answering on 9100 (the LAN scan) and the
 *    addresses already saved — each with its connection, its state (ready / no paper / offline…) and "בדיקה".
 *  - ONE printer is the device's printer: receipts, copies, credit notes, X / Z, slips, the kiosk's bon, item tickets, test
 *    pages and the drawer's pulse all go to it. "מדפסת נפרדת לבונים" / "מדפסת נפרדת לשוברים" are optional overrides: unset,
 *    those pages print on the device's printer (never dropped for want of a printer of their own).
 *  - The choice is kept on the device (local settings); a chosen printer that is no longer found is said, plainly.
 *
 * Pure: the lists come in, the view goes out (main/service.ts gathers them; renderer/technician/PrinterPicker.tsx shows it).
 */

/** A printer the device can send to — the shape of main/printer/transports.ts PrinterTarget (kept here: pure, renderer-safe). */
export interface PickTarget {
  transport: string;
  queueName?: string | null;
  host?: string | null;
  port?: number | null;
  comPort?: string | null;
  baudRate?: number | null;
  widthDots?: number | null;
}

export type PickConnection = 'windows' | 'usb' | 'usb_no_driver' | 'serial' | 'network';
export type PickStatus = 'ready' | 'no_paper' | 'paper_low' | 'cover_open' | 'offline' | 'error' | 'unknown' | 'no_driver';

/** A role a page prints for: the device's printer, or an optional override. */
export type PickRole = 'receipt' | 'bon' | 'ticket';

export const PICK_ROLES: readonly PickRole[] = ['receipt', 'bon', 'ticket'];

export interface PickCandidate {
  /** Stable across looks: "win:<queue>", "tcp:<host>:<port>", "com:<port>", "usb:<device id>". */
  id: string;
  name: string;
  connection: PickConnection;
  /** "USB001", "192.168.1.50:9100", "COM3 · 9600"… */
  detail: string;
  status: PickStatus;
  /** Where a page goes when picked; null — cannot be picked (a USB printer with no driver: install one first). */
  target: PickTarget | null;
  /** The roles it is chosen for now. */
  roles: PickRole[];
  /** Kept from before (a saved address, a chosen queue), not found in this look. */
  missing: boolean;
}

export interface PickerInput {
  queues: ReadonlyArray<{ name: string; port: string | null; health: string }>;
  /** USB printers present with no queue (usbPrinters.ts pickUsbPrinter → no_driver), by name. */
  usbNoDriver: ReadonlyArray<{ name: string; id: string }>;
  /** The COM ports (the serial transport's list; none where this build has no serial printing). */
  serial: ReadonlyArray<{ path: string; name?: string | null; likely?: boolean }>;
  /** Answered on 9100 in the LAN scan. */
  network: ReadonlyArray<{ host: string; port: number; health: string }>;
  /** Network addresses kept (the device's own choices, the shop's kitchen printers): asked for their status. */
  saved: ReadonlyArray<{ host: string; port: number; health: string; name?: string | null }>;
  /** The choices now: the device's printer (null — "אוטומטי") and the overrides (null — the device's printer). */
  chosen: Record<PickRole, PickTarget | null>;
  /** "אוטומטי": the queue it resolves to now (null: none found). */
  autoQueue: string | null;
}

export const PICK_TEXT = {
  title: 'מדפסות',
  hint: 'מדפסת אחת מדפיסה הכול: קבלות, חשבוניות, דוחות X/Z, בונים, שוברי פריט ופתיחת מגירה. מדפסת נפרדת לבונים או לשוברים — רשות.',
  refresh: 'רענון',
  scanLan: 'חיפוש ברשת',
  scanning: 'מחפש…',
  test: 'בדיקה',
  choose: 'בחר',
  chosen: 'נבחרה',
  auto: 'אוטומטי (USB)',
  none: 'לא נמצאו מדפסות',
  role: { receipt: 'המדפסת של המכשיר', bon: 'מדפסת נפרדת לבונים', ticket: 'מדפסת נפרדת לשוברי פריט' } as Record<PickRole, string>,
  sameAsMain: 'כמו המדפסת של המכשיר',
  connection: { windows: 'Windows', usb: 'USB', usb_no_driver: 'USB — בלי דרייבר', serial: 'סריאלי (COM)', network: 'רשת' } as Record<PickConnection, string>,
  status: {
    ready: 'מוכנה',
    no_paper: 'אין נייר',
    paper_low: 'הנייר עומד להיגמר',
    cover_open: 'המכסה פתוח',
    offline: 'לא מחוברת',
    error: 'תקלה',
    unknown: 'לא ידוע',
    no_driver: 'צריך להתקין דרייבר (Generic / Text Only)',
  } as Record<PickStatus, string>,
  missing: (role: string, name: string) => `${role}: "${name}" לא נמצאה — בדקו שהיא דולקת ומחוברת, או בחרו מדפסת אחרת`,
  silent: (role: string, name: string) => `${role}: "${name}" לא עונה — בדקו שהיא דולקת ומחוברת לרשת, או בחרו מדפסת אחרת`,
  width: 'רוחב הדפסה',
} as const;

/** A transport's health word (transports.ts PrinterHealth) as the picker's status. */
export function pickStatusOf(health: string | null | undefined): PickStatus {
  switch (health) {
    case 'ok':
      return 'ready';
    case 'no_paper':
    case 'paper_low':
    case 'cover_open':
    case 'offline':
    case 'error':
      return health;
    case 'unavailable':
      return 'offline';
    default:
      return 'unknown';
  }
}

/** The candidate id of a target (the same printer found and chosen → one row). */
export function targetId(t: PickTarget | null | undefined): string | null {
  if (!t) return null;
  if (t.transport === 'spooler') return t.queueName?.trim() ? `win:${t.queueName.trim()}` : null;
  if (t.transport === 'tcp') return t.host?.trim() ? `tcp:${t.host.trim()}:${t.port ?? 9100}` : null;
  if (t.transport === 'serial') return t.comPort?.trim() ? `com:${t.comPort.trim().toUpperCase()}` : null;
  return null;
}

const USB_PORT = /usb/i;

/** Every printer found and chosen, one row each: chosen first, then by connection and name. */
export function pickerCandidates(i: PickerInput): PickCandidate[] {
  const rows = new Map<string, PickCandidate>();
  const put = (c: Omit<PickCandidate, 'roles' | 'missing'>) => {
    if (!rows.has(c.id)) rows.set(c.id, { ...c, roles: [], missing: false });
  };
  for (const q of i.queues) {
    if (!q.name) continue;
    const usb = USB_PORT.test(q.port ?? '') && !/^(IP_|WSD|TCP|HTTP)/i.test(q.port ?? '');
    put({ id: `win:${q.name}`, name: q.name, connection: usb ? 'usb' : 'windows', detail: q.port ?? '', status: pickStatusOf(q.health), target: { transport: 'spooler', queueName: q.name } });
  }
  for (const d of i.usbNoDriver) put({ id: `usb:${d.id}`, name: d.name || 'מדפסת USB', connection: 'usb_no_driver', detail: d.id, status: 'no_driver', target: null });
  for (const p of i.serial) {
    const port = p.path.toUpperCase();
    put({ id: `com:${port}`, name: p.name?.trim() || port, connection: 'serial', detail: port, status: 'unknown', target: { transport: 'serial', comPort: port } });
  }
  // A saved address first: its name (the shop's "מטבח חם") over the scan's bare address.
  for (const n of [...i.saved, ...i.network]) {
    const name = 'name' in n && typeof n.name === 'string' && n.name.trim() ? n.name.trim() : `מדפסת רשת ${n.host}`;
    put({ id: `tcp:${n.host}:${n.port}`, name, connection: 'network', detail: `${n.host}:${n.port}`, status: pickStatusOf(n.health), target: { transport: 'tcp', host: n.host, port: n.port } });
  }
  // The choices: marked on their row, or a row of their own when not found now.
  const effective = (role: PickRole): PickTarget | null => {
    if (role !== 'receipt' && i.chosen[role]) return i.chosen[role];
    if (role !== 'receipt') return null;
    return i.chosen.receipt ?? (i.autoQueue ? { transport: 'spooler', queueName: i.autoQueue } : null);
  };
  for (const role of PICK_ROLES) {
    const t = effective(role);
    const id = targetId(t);
    if (!t || !id) continue;
    if (!rows.has(id)) {
      const name = t.transport === 'spooler' ? (t.queueName ?? '') : t.transport === 'tcp' ? `מדפסת רשת ${t.host}` : (t.comPort ?? '');
      const detail = t.transport === 'tcp' ? `${t.host}:${t.port ?? 9100}` : t.transport === 'serial' ? (t.comPort ?? '') : '';
      const connection: PickConnection = t.transport === 'tcp' ? 'network' : t.transport === 'serial' ? 'serial' : 'windows';
      rows.set(id, { id, name, connection, detail, status: 'offline', target: t, roles: [], missing: true });
    }
    rows.get(id)!.roles.push(role);
  }
  const order: Record<PickConnection, number> = { usb: 0, windows: 1, network: 2, serial: 3, usb_no_driver: 4 };
  return [...rows.values()].sort((a, b) => Number(b.roles.length > 0) - Number(a.roles.length > 0) || order[a.connection] - order[b.connection] || a.name.localeCompare(b.name));
}

/** The warnings: a chosen printer (the device's, or an override) that is not found now. "אוטומטי" with nothing: said too. */
export function pickerAlerts(rows: readonly PickCandidate[], chosen: PickerInput['chosen'], autoQueue: string | null): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (r.missing) for (const role of r.roles) out.push(PICK_TEXT.missing(PICK_TEXT.role[role], r.name));
    else if (r.status === 'offline') for (const role of r.roles) out.push(PICK_TEXT.silent(PICK_TEXT.role[role], r.name));
  }
  if (!chosen.receipt && !autoQueue) out.push(`${PICK_TEXT.role.receipt}: אוטומטי — לא נמצאה מדפסת USB. חברו מדפסת או בחרו אחת מהרשימה`);
  return out;
}

export interface PickerView {
  title: string;
  hint: string;
  rows: Array<PickCandidate & { connectionText: string; statusText: string; roleTexts: string[] }>;
  alerts: string[];
  /** Per role: what prints there now, in words. */
  roles: Array<{ role: PickRole; label: string; value: string; auto: boolean }>;
  widthDots: number;
  widths: number[];
  scannedAt: number | null;
  lanScanning: boolean;
  subnet: string | null;
}

export function pickerView(i: PickerInput, o: { widthDots: number; widths: readonly number[]; scannedAt: number | null; lanScanning: boolean; subnet: string | null }): PickerView {
  const rows = pickerCandidates(i);
  const nameOf = (t: PickTarget | null) => {
    const id = targetId(t);
    return rows.find((r) => r.id === id)?.name ?? null;
  };
  return {
    title: PICK_TEXT.title,
    hint: PICK_TEXT.hint,
    rows: rows.map((r) => ({ ...r, connectionText: PICK_TEXT.connection[r.connection], statusText: r.missing ? 'לא נמצאה' : PICK_TEXT.status[r.status], roleTexts: r.roles.map((x) => PICK_TEXT.role[x]) })),
    alerts: pickerAlerts(rows, i.chosen, i.autoQueue),
    roles: PICK_ROLES.map((role) => {
      if (role === 'receipt') {
        const auto = !i.chosen.receipt;
        return { role, label: PICK_TEXT.role.receipt, value: auto ? `${PICK_TEXT.auto}${i.autoQueue ? ` — ${i.autoQueue}` : ' — לא נמצאה'}` : (nameOf(i.chosen.receipt) ?? '—'), auto };
      }
      const own = i.chosen[role];
      return { role, label: PICK_TEXT.role[role], value: own ? (nameOf(own) ?? '—') : PICK_TEXT.sameAsMain, auto: !own };
    }),
    widthDots: o.widthDots,
    widths: [...o.widths],
    scannedAt: o.scannedAt,
    lanScanning: o.lanScanning,
    subnet: o.subnet,
  };
}
