/**
 * "סניף לא פעיל" on the Windows kiosk (P:/specs/shop-code-and-inactive.md §3): the rules are the
 * shared ones (client lib/shopActive.ts — the Android till's domain/ShopLock.kt); here is what only
 * this kiosk does — "סגירת משמרת ו-Z" from the lock screen with a manager's code (decision 1):
 *
 *  - who: a manager of this shop — the kiosk's "קוד מנהל" (`KIOSK_UNLOCK`, the manager's menu) —
 *    whose role also allows the close itself: "סגירת Z בקופה" (`Z`) for the kiosk's own Z,
 *    "סגירת משמרת" (`SHIFT_CLOSE`) for the shift's close in the cloud's Z mode;
 *  - what: the kiosk's own close, as its automatic close does it (main/fiscal/tillZService.ts) —
 *    the open shift closed with the manager named, then in zMode = till the Z produced (owed on
 *    disk first, so a Z the cloud cannot make now is made by the 30-second tick later);
 *  - the code opens nothing: the lock stays until the shop is active again.
 */

import { closeDayPermission, type CloseDayKind } from '@dash-lib/shopActive';
import { KIOSK_UNLOCK, permissionState, usersAllowed, type RosterUser } from './desktopExit';

/** The permission's name as the dashboard's roles page shows it (till_permissions.py). */
export const CLOSE_DAY_LABEL: Record<CloseDayKind, string> = {
  till_z: 'סגירת Z בקופה',
  shift_close: 'סגירת משמרת',
};

/** Who may close the day here with their own code: a kiosk manager whose role allows the close. */
export function closeDayCandidates(users: readonly RosterUser[], shopId: string | null | undefined, kind: CloseDayKind): RosterUser[] {
  const code = closeDayPermission(kind);
  return usersAllowed(users, shopId, KIOSK_UNLOCK).filter((u) => permissionState(u, code) === 'allow');
}

/** What the till Z service answered (main/fiscal/tillZService.ts ZOutcome), as far as the words go. */
export type CloseDayZ =
  | { kind: 'produced'; z: Record<string, unknown> }
  | { kind: 'refused'; refusal: string }
  | { kind: 'waiting'; why: string }
  | { kind: 'offline' }
  | { kind: 'failed'; status: number; detail: string | null };

export const CLOSE_DAY_TEXT = {
  noManager: (kind: CloseDayKind) => `אין בסניף מנהל עם הרשאת "${CLOSE_DAY_LABEL[kind]}"`,
  wrongCode: 'קוד שגוי',
  active: 'הסניף פעיל שוב — אין נעילה',
  running: 'הסגירה כבר מתבצעת',
  pending: 'תשלום במשמרת עוד לא הסתיים — נסו שוב בעוד רגע',
  shiftClosed: 'המשמרת נסגרה. ה-Z של הסניף מופק בסגירת Z סניפי.',
} as const;

/** The manager's close of the kiosk's own Z, in words: done, done later by itself, or why not. */
export function closeDayZText(z: CloseDayZ | null): { ok: boolean; message: string } {
  if (!z) return { ok: false, message: CLOSE_DAY_TEXT.running };
  switch (z.kind) {
    case 'produced': {
      const n = Number(z.z.machineSequenceNumber ?? z.z.zNumber);
      return { ok: true, message: Number.isFinite(n) && n > 0 ? `Z מס׳ ${n} הופק` : 'ה-Z הופק' };
    }
    case 'offline':
      return { ok: true, message: 'המשמרת נסגרה. אין חיבור לענן — ה-Z יופק לבד כשהחיבור יחזור.' };
    case 'waiting':
      return { ok: true, message: 'המשמרת נסגרה. ה-Z יופק לבד אחרי שהסגירות יעלו לענן.' };
    case 'refused':
      if (z.refusal === 'nothing_to_report' || z.refusal === 'empty_z') return { ok: true, message: 'אין מה להפיק: כל המשמרות כבר ב-Z.' };
      return { ok: false, message: `הענן לא הפיק Z (${z.refusal}) — יש לפנות לתמיכה` };
    case 'failed':
      return { ok: false, message: `הפקת ה-Z נכשלה (HTTP ${z.status}) — היא תנוסה שוב לבד` };
  }
}
