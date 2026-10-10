/**
 * "כפה סגירה" — a remote close or Z forced from the moment the manager sends it (pos-server
 * app/services/remote_close_force.py; the owner, 09.10.2026). The till parameter
 * `remoteCloseForceByDefault` (on by default) decides each till's mode; the dialog shows it and the
 * manager may untick (or tick) "כפה סגירה" for that one request. The pure parts.
 */

/** A till's mode as the server's preview gives it (`force`). */
export interface ForceMode {
  key: string;
  label: string;
  /** The till's `remoteCloseForceByDefault`, resolved company → shop → area → till. */
  forceByDefault: boolean;
  /** The till's build can force (`remote_close_force_v1`); false: it waits for rest whatever is asked. */
  supported: boolean;
  /** Why the mode differs for this device (an old build, a kiosk's own rules), or null. */
  note: string | null;
}

export const FORCE_LABEL = 'כפה סגירה';

/** The words a forced close is done with ("נסגר בכפייה מרחוק ע״י דנה"). */
export const FORCED_WORDS = 'נסגר בכפייה מרחוק';

export function forcedWords(by: string | null | undefined): string {
  const who = (by ?? '').trim();
  return who ? `${FORCED_WORDS} ע״י ${who}` : FORCED_WORDS;
}

/** The request's mode: the manager's tick (true / false), else the till's default. */
export function effectiveForce(defaultOn: boolean, tick: boolean | null | undefined): boolean {
  return tick == null ? defaultOn : tick;
}

/** What the till will do in each mode — the dialog's explanation. */
export function forceExplain(forced: boolean, kind: 'till_z' | 'close_shift'): string {
  const what = kind === 'till_z' ? 'תסגור את המשמרת ותפיק Z' : 'תסגור את המשמרת';
  if (forced) {
    return (
      `הקופה ${what} מיד: עגלה פתוחה תישמר כמכירה מושהית, מסך תשלום שלא נשלח בו דבר למסוף יבוטל, ` +
      'ומכירות מושהות יישארו למשמרת הבאה. עסקת אשראי בדרך ומסמכים שטרם נכתבו — הקופה ממתינה להם.'
    );
  }
  return `הקופה ${what} רק כשאין בה מכירה או תשלום פתוחים.`;
}

/** The toast after sending. */
export function sentToast(forced: boolean): string {
  return forced ? 'נשלח לקופה — ייסגר בכפייה (עסקת אשראי בדרך תמתין)' : 'נשלח לקופה — ייסגר כשאין בה מכירה או תשלום פתוחים';
}

/** Several tills' defaults, as one checkbox shows them: all on, all off, or mixed. */
export function defaultsOf(modes: (ForceMode | null | undefined)[]): 'on' | 'off' | 'mixed' {
  const known = modes.filter((m): m is ForceMode => !!m);
  if (known.length === 0) return 'on';
  const on = known.filter((m) => m.forceByDefault).length;
  if (on === known.length) return 'on';
  if (on === 0) return 'off';
  return 'mixed';
}

/**
 * The checkbox for several tills: checked / unchecked by the tick, else by their defaults
 * (indeterminate when mixed). What is sent: the tick, or nothing (each till's own default).
 */
export function groupCheckbox(
  modes: (ForceMode | null | undefined)[],
  tick: boolean | null,
): { checked: boolean; indeterminate: boolean; send: boolean | undefined } {
  if (tick != null) return { checked: tick, indeterminate: false, send: tick };
  const d = defaultsOf(modes);
  return { checked: d === 'on', indeterminate: d === 'mixed', send: undefined };
}

/** One till's line in a group dialog: forced or waiting, by the tick or its own default. */
export function rowModeWords(mode: ForceMode | null | undefined, tick: boolean | null): string | null {
  if (!mode) return null;
  if (mode.note) return mode.note;
  return effectiveForce(mode.forceByDefault, tick) ? 'ייסגר בכפייה' : 'ימתין שהקופה תתפנה';
}
