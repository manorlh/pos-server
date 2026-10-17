/**
 * "כשמתנתק אני לא יודע לאיזה קופה לצמד מחדש" (P:/specs/foreign-records-upload.md §5): what the device remembers of its
 * last pairing after an unpair — never a secret (no token) — and the words the pairing screen and the unpair dialog say
 * with it; the bound re-pair code's check (§5.2); the "קוד מכשיר" of the pairing from the cloud (§6.1).
 */

export interface LastPairing {
  machineId: string;
  tenantId: string | null;
  machineName: string | null;
  posNumber: string | null;
  shopName: string | null;
  companyName: string | null;
  serverUrl: string | null;
  /** ISO time of the unpair. */
  unpairedAt: string;
  /** Who unpaired it (a name, "טכנאי", or the cloud). */
  unpairedBy: string | null;
  /** manual | forced | revoked | cloud_move. */
  reason: string;
  /** The rows still on the device for that pairing, per kind. */
  pending: Record<string, number>;
}

/** "קופה 3" — the till's number, else its name, else the start of its id. */
export function tillLabel(p: { posNumber?: string | null; machineName?: string | null; machineId?: string | null }): string {
  if (p.posNumber) return `קופה ${p.posNumber}`;
  if (p.machineName) return p.machineName;
  return p.machineId ? `מכשיר ${p.machineId.slice(0, 8)}` : 'מכשיר';
}

/** "המכשיר הזה הוא קופה 3 · סניף X" (the unpair dialog). */
export function deviceLine(p: { posNumber?: string | null; machineName?: string | null; machineId?: string | null; shopName?: string | null }): string {
  return `המכשיר הזה הוא ${tillLabel(p)}${p.shopName ? ` · סניף ${p.shopName}` : ''}`;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const PAIRING_TEXT = {
  hint: 'בדשבורד: דף המכשיר ← קוד צימוד מחדש לקופה הזו',
  deviceCode: 'קוד מכשיר',
  deviceCodeHint: 'בדשבורד: דף המכשיר ← "צימוד מכשיר לקופה הזו", או "הוספת מכשיר" — והקלידו את הקוד',
  deviceCodeWaiting: 'ממתין לצימוד מהענן…',
  confirm: (was: LastPairing, target: { posNumber?: string | null; machineName?: string | null; machineId?: string | null }) =>
    `המכשיר הזה היה ${tillLabel(was)} — לצמד אותו כ${tillLabel(target)}?`,
} as const;

/** "המכשיר היה: קופה 3 · סניף X · נותק ב-17.10.2026 21:04 ע״י טכנאי" (the pairing screen's card). */
export function lastPairingLine(p: LastPairing): string {
  return `המכשיר היה: ${tillLabel(p)}${p.shopName ? ` · סניף ${p.shopName}` : ''} · נותק ב-${when(p.unpairedAt)}${p.unpairedBy ? ` ע״י ${p.unpairedBy}` : ''}`;
}

/** A bound code (§5.2 code-preview) for another machine than the one remembered: the confirmation's words (null — none). */
export function boundCodeQuestion(last: LastPairing | null, preview: { bound?: unknown; machineId?: unknown; machineName?: unknown; posNumber?: unknown } | null): string | null {
  if (!last || !preview || preview.bound !== true || typeof preview.machineId !== 'string') return null;
  if (preview.machineId === last.machineId) return null;
  return PAIRING_TEXT.confirm(last, {
    machineId: preview.machineId,
    machineName: typeof preview.machineName === 'string' ? preview.machineName : null,
    posNumber: typeof preview.posNumber === 'string' || typeof preview.posNumber === 'number' ? String(preview.posNumber) : null,
  });
}

/** "ABC-DEF" — the device code as shown (6 characters in two groups). */
export function showDeviceCode(code: string): string {
  const c = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}
