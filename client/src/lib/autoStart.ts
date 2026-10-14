/**
 * "פתיחה אוטומטית": whether a device opens by itself when it is switched on (pos-server
 * app/services/autostart.py, P:/specs/autostart-default.md §3). The till parameter
 * `autoStartOnBoot` is on by default; Android lets the till open on boot only once the permission
 * was approved on the device, or when the till is the home app, or in "נעילת קופה".
 *
 * The server sends `autoStart` on each device ("תקינות מכשירים", the devices list and page):
 * `{state: ready | missing | off, via: lock | home | permission | null, reportedAt}`, or null while
 * the device never reported (an older APK): no indicator then.
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own. The texts are
 * here (Hebrew), with the rules, so the tests pin both.
 */

export type AutoStartState = 'ready' | 'missing' | 'off';
export type AutoStartVia = 'lock' | 'home' | 'permission';

/** `autoStart` as the server sends it. */
export interface AutoStartStatus {
  state: AutoStartState | string;
  via?: AutoStartVia | string | null;
  reportedAt?: string | null;
}

/** What a device row carries (absent on an older server; null: never reported). */
export interface WithAutoStart {
  autoStart?: AutoStartStatus | null;
}

/** green / yellow / grey. */
export type AutoStartTone = 'ok' | 'warn' | 'muted';

export const AUTO_START_TITLE = 'פתיחה אוטומטית';

const STATE_TEXT: Record<AutoStartState, string> = {
  ready: 'מוכן',
  missing: 'חסר אישור במכשיר',
  off: 'כבוי',
};

const STATE_TONE: Record<AutoStartState, AutoStartTone> = {
  ready: 'ok',
  missing: 'warn',
  off: 'muted',
};

const VIA_TEXT: Record<AutoStartVia, string> = {
  lock: 'נעילת קופה',
  home: 'מסך בית',
  permission: 'הרשאה',
};

const STATE_HINT: Record<AutoStartState, string> = {
  ready: 'המכשיר נפתח לבד כשהוא נדלק.',
  missing:
    'הקופה לא תיפתח לבד כשהמכשיר נדלק. מאשרים פעם אחת במכשיר ("הצגה מעל אפליקציות אחרות", במסך "הפעלה אוטומטית" או בהגדרות הקופה), או הופכים את הקופה למסך הבית.',
  off: 'הפרמטר "הפעלה אוטומטית כשהמכשיר נדלק" כבוי: הקופה לא נפתחת לבד כשהמכשיר נדלק.',
};

function isState(value: unknown): value is AutoStartState {
  return value === 'ready' || value === 'missing' || value === 'off';
}

function isVia(value: unknown): value is AutoStartVia {
  return value === 'lock' || value === 'home' || value === 'permission';
}

export interface AutoStartView {
  state: AutoStartState;
  tone: AutoStartTone;
  /** "מוכן · הרשאה" / "חסר אישור במכשיר" / "כבוי". */
  label: string;
  /** The tooltip: what it means and what to do. */
  hint: string;
}

/** How to show it, or null when unknown (no report, or a state this page does not know): no indicator. */
export function autoStartView(status: AutoStartStatus | null | undefined): AutoStartView | null {
  if (!status || !isState(status.state)) return null;
  const state = status.state;
  const via = state === 'ready' && isVia(status.via) ? VIA_TEXT[status.via] : null;
  return {
    state,
    tone: STATE_TONE[state],
    label: via ? `${STATE_TEXT[state]} · ${via}` : STATE_TEXT[state],
    hint: STATE_HINT[state],
  };
}
