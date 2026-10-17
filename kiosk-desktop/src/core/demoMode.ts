/**
 * "מצב הדגמה — קופה / קיוסק" of the INSTALLED app (the owner, 17.10.2026: "חשוב שיהיה מצב הדגמה גם לקיוסק וגם
 * לקופה"). Until now the demo ran only in a browser (`npm run dev:web`, `?demo`): the installed app had no way to it.
 *
 * From the pairing screen of an UNPAIRED device, "מצב הדגמה" restarts the app as a demo of the chosen role:
 *
 *  - its own data folder — `<userData>\demo` (Electron's profile, its storage, its logs) — and no local service at all:
 *    no SQLite, no pairing, no cloud, no updater, no real terminal. The screens run on the demos the web demo already
 *    has: the kiosk on the fake bridge (renderer/bridge.ts webBridge, renderer/roles/shellBridge.ts webShell), the till
 *    on the mock engine (shared/till/mockEngine.ts, through renderer/host/browser/browserHost.ts);
 *  - "מצב הדגמה" on every screen (the ribbon, preload/demo.ts; the till also says so itself);
 *  - kiosk ↔ till as a combined licence ("משולב", kiosk_till): "מצב עבודה" in the manager's menu, "מעבר לקיוסק" in the
 *    till's;
 *  - a card is never charged: the ribbon picks what the simulated terminal answers — approved, declined, no answer;
 *  - out of it: the manager's corner (two seconds top-right, the demo manager's code) → "יציאה ממצב הדגמה" — the app
 *    restarts as itself, at the real (still unpaired) pairing screen; the real data folder was never opened.
 *
 * Electron-free (tested): main/demo/demoShell.ts holds the windows.
 */

export type DemoRole = 'kiosk' | 'till';
/** What the simulated card terminal answers. */
export type DemoCardOutcome = 'approve' | 'decline' | 'timeout';

export const DEMO_ROLES: readonly DemoRole[] = ['kiosk', 'till'];
export const DEMO_CARD_OUTCOMES: readonly DemoCardOutcome[] = ['approve', 'decline', 'timeout'];

/** The command line flag of a demo start: `--demo=kiosk` / `--demo=till`. */
export const DEMO_ARG = '--demo';
/** The demo's own data folder, under the real one (never the real one). */
export const DEMO_DIR_NAME = 'demo';
/** The demo's manager code (renderer/bridge.ts webBridge adminUnlock) — said on the pairing screen. */
export const DEMO_MANAGER_CODE = '1234';

export const DEMO_TEXT = {
  ribbon: 'מצב הדגמה',
  start: 'מצב הדגמה',
  startHint: 'נסו את הקופה או את הקיוסק בלי צימוד — בלי ענן, בלי חיוב אמיתי ובלי לגעת בנתונים של המכשיר.',
  till: 'קופה',
  kiosk: 'קיוסק',
  exitHint: `יציאה: החזיקו 2 שניות בפינה הימנית העליונה, קוד ${DEMO_MANAGER_CODE} ← "יציאה ממצב הדגמה".`,
  exit: 'יציאה ממצב הדגמה',
  exitBody: 'האפליקציה תופעל מחדש במסך הצימוד. נתוני ההדגמה לא נשמרים במכשיר.',
  pairedRefused: 'המכשיר מצומד — מצב הדגמה זמין רק במכשיר לא מצומד',
  card: { approve: 'אשראי: אישור', decline: 'אשראי: דחייה', timeout: 'אשראי: אין תשובה' } as Record<DemoCardOutcome, string>,
  declined: 'העסקה נדחתה במסוף (הדגמה)',
  timedOut: 'המסוף לא ענה בזמן (הדגמה)',
} as const;

export function isDemoRole(v: unknown): v is DemoRole {
  return v === 'kiosk' || v === 'till';
}

/** The demo this start runs, from the command line (`--demo=kiosk|till`); null: the real app. */
export function demoRoleOf(argv: readonly string[]): DemoRole | null {
  for (const a of argv) {
    if (!a.startsWith(`${DEMO_ARG}=`)) continue;
    const r = a.slice(DEMO_ARG.length + 1);
    return isDemoRole(r) ? r : null;
  }
  return null;
}

/** The demo's data folder: a child of the real one — the real one's files are never opened by the demo. */
export function demoUserDataOf(realUserData: string, join: (...p: string[]) => string): string {
  return join(realUserData, DEMO_DIR_NAME);
}

/**
 * The restart's arguments: the same as this start's (`--windowed`, `--dev`, the app's path in development) without any
 * demo flag or the bridge's, and with `--demo=<role>` when going into a demo — `--app` too, so a bridge marker or
 * kiosk.json never turns a demo into the bridge. `role` null: back to the real app.
 */
export function demoRelaunchArgs(args: readonly string[], role: DemoRole | null): string[] {
  const kept = args.filter((a) => a !== DEMO_ARG && !a.startsWith(`${DEMO_ARG}=`) && a !== '--bridge' && a !== '--app');
  return role ? [...kept, '--app', `${DEMO_ARG}=${role}`] : kept;
}

/**
 * The demo's main window: the shell's screens with the web demo's bridges (`role` picks the screen, renderer/roles/
 * shellBridge.ts). The till's screens are a view laid over it (demoTillUrl), as in the real app.
 */
export function demoShellUrl(role: DemoRole): string {
  return `kiosk://app/index.html?demo=1&role=${role}`;
}

/** The till's screens of the demo: the app bundle with the mock engine and a simulated card terminal. */
export const DEMO_TILL_URL = 'r2m://app/index.html?demo=1&terminal=1';

/** Only the app's own pages, ever (no web page in the demo either). */
export function demoNavigationAllowed(url: string): boolean {
  return url.startsWith('kiosk://app/') || url.startsWith('r2m://app/');
}

/** Whether "מצב הדגמה" may start: never on a paired device (its pairing screen is the only way in). */
export function demoStartAllowed(paired: boolean): { ok: true } | { ok: false; message: string } {
  return paired ? { ok: false, message: DEMO_TEXT.pairedRefused } : { ok: true };
}

/** The ribbon's card choice, in turn: approved → declined → no answer → approved. */
export function nextCardOutcome(o: DemoCardOutcome): DemoCardOutcome {
  const i = DEMO_CARD_OUTCOMES.indexOf(o);
  return DEMO_CARD_OUTCOMES[(i + 1) % DEMO_CARD_OUTCOMES.length];
}

export function isCardOutcome(v: unknown): v is DemoCardOutcome {
  return v === 'approve' || v === 'decline' || v === 'timeout';
}

/** How long the simulated terminal takes: an answer in ~2 s, "no answer" after the wait a customer would see. */
export function demoCardDelayMs(o: DemoCardOutcome): number {
  return o === 'timeout' ? 8_000 : 2_000;
}

/** The kiosk's "מצב עבודה" in the demo's manager menu: a combined licence — the way to the other role is always open. */
export function demoWorkMode(role: DemoRole): { enabled: true; mode: DemoRole; toTill: boolean; toKiosk: boolean; openerHolds: true } {
  return { enabled: true, mode: role, toTill: role === 'kiosk', toKiosk: role === 'till', openerHolds: true };
}

/**
 * `window.r2mDemo` (preload/demo.ts) — the demo's only door to the shell; no `window.kiosk`, no `window.r2m`, no
 * `window.r2mApp` in a demo window, so the screens take the web demo's bridges.
 */
export interface R2mDemoBridge {
  /** Kiosk ↔ till (a combined licence's switch). */
  switchTo(role: DemoRole): void;
  /** Back to the real app: a restart at the pairing screen. */
  exit(): void;
  /** What the simulated card terminal answers now (the ribbon's choice). */
  cardOutcome(): DemoCardOutcome;
  /** The till's corner / six taps: the shell's manager menu over the till (as main/roles/tillElectron.ts). */
  openAdmin(screen: 'admin' | 'technician'): void;
  /** The shell's window: the till asked for the manager's menu. */
  onAdmin(fn: (p: { from: 'till'; screen: 'admin' | 'technician' }) => void): () => void;
  /** The manager's menu over the till is closed: the till's view comes back. */
  adminClosed(): void;
}

/** The demo's door, when this page runs in the installed app's demo. */
export function demoBridge(): R2mDemoBridge | null {
  const w = (globalThis as { r2mDemo?: R2mDemoBridge }).r2mDemo;
  return w ?? null;
}

/** The IPC channels of the demo (main/demo/demoShell.ts ↔ preload/demo.ts). */
export const DEMO_IPC = {
  switchTo: 'demo:switch',
  exit: 'demo:exit',
  openAdmin: 'demo:openAdmin',
  admin: 'demo:admin',
  adminClosed: 'demo:adminClosed',
} as const;
