/**
 * "עדכון שקט" — device owner, silent updates, factory-reset (QR) provisioning and "הפעל מחדש"
 * (pos-server docs/SPEC_UPDATES.md §5, server app/services/device_management.py). The owner:
 * "אני רוצה שתעדכן ספריות לבד כשאנחנו מוסיפים פיצ'ר חדש, אני לא רוצה לבקש אישור מהאנדרואיד".
 *
 * Self-contained on purpose (no `@/` imports): `npm test` compiles it on its own. The texts are
 * here (Hebrew), with the rules, so the tests pin both.
 */

/** The heartbeat's `deviceManagement` block as the machine page / list carry it. */
export interface DeviceManagementReport {
  deviceOwner?: boolean;
  /** device_owner | self_update | urovo | pax — silent; tap — someone confirms on screen. */
  updatePath?: string;
  silentUpdate?: boolean;
  sdk?: number;
  canRequestInstalls?: boolean;
  /** full | pinned | none. */
  kioskLock?: string;
  lockTaskPermitted?: boolean;
  vendorInstaller?: string;
  permissionsGranted?: string[];
  permissionsMissing?: string[];
  provisionedBy?: string;
  ownerReleasedAt?: string;
  ownerReleasedBy?: string;
  ownerSessionFailed?: boolean;
}

/** `rebootRequest` on the machine: the dashboard's "הפעל מחדש" as it stands. */
export interface RebootRequest {
  id: string;
  status: 'pending' | 'deferred' | 'rebooting' | 'refused' | 'expired' | 'cancelled' | string;
  requestedAt?: string | null;
  requestedBy?: string | null;
  updatedAt?: string | null;
  reason?: string | null;
}

/** What a machine / rollout row carries for this feature (both optional on an older server). */
export interface WithDeviceManagement {
  deviceManagement?: DeviceManagementReport | null;
  deviceManagementReportedAt?: string | null;
  rebootRequest?: RebootRequest | null;
}

export const COMPONENT_NAME = 'il.co.runnersys.pos/.system.PosDeviceAdmin';
export const ADB_COMMAND = `adb shell dpm set-device-owner ${COMPONENT_NAME}`;
/** Checks before the adb command: Android refuses a device owner on a device with accounts. */
export const ADB_ACCOUNTS_CHECK = 'adb shell dumpsys account';
export const ADB_USERS_CHECK = 'adb shell pm list users';
export const ADB_OWNER_CHECK = 'adb shell dumpsys device_policy';

// ── Status ───────────────────────────────────────────────────────────────────

export type SilentState = 'silent' | 'tap' | 'unknown';

const PATH_TEXT: Record<string, string> = {
  device_owner: 'בעלות מכשיר',
  self_update: 'אנדרואיד 12 ומעלה',
  urovo: 'המתקין של Urovo',
  pax: 'המתקין של PAX',
  tap: 'דורש לחיצה',
};

export function silentState(dm?: DeviceManagementReport | null): SilentState {
  if (!dm || typeof dm.silentUpdate !== 'boolean') return 'unknown';
  return dm.silentUpdate ? 'silent' : 'tap';
}

/** "עדכון שקט: פעיל" / "דורש לחיצה" / "לא ידוע" — and the path, when silent. */
export function silentLabel(dm?: DeviceManagementReport | null): string {
  const state = silentState(dm);
  if (state === 'unknown') return 'לא ידוע (גרסה ישנה)';
  if (state === 'tap') return 'דורש לחיצה';
  const path = dm?.updatePath ? PATH_TEXT[dm.updatePath] : undefined;
  return path ? `פעיל · ${path}` : 'פעיל';
}

export function pathLabel(path?: string | null): string {
  return (path && PATH_TEXT[path]) || '—';
}

export function kioskLockLabel(lock?: string | null): string {
  if (lock === 'full') return 'מלאה';
  if (lock === 'pinned') return 'הצמדת אפליקציה';
  if (lock === 'none') return 'לא נעול';
  return '—';
}

/** "Android 10" for an API level the devices in the field run. */
export function androidVersion(sdk?: number | null): string {
  const names: Record<number, string> = {
    24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15',
  };
  if (!sdk) return '—';
  return `Android ${names[sdk] ?? `API ${sdk}`}`;
}

/** Why a device that is not silent is so, in one line — what the dialog leads with. */
export function tapReason(dm?: DeviceManagementReport | null): string | null {
  if (!dm || silentState(dm) !== 'tap') return null;
  if (dm.ownerSessionFailed) return 'ההתקנה השקטה נכשלה בגרסה הנוכחית — היא תותקן במסך האישור של אנדרואיד.';
  if ((dm.sdk ?? 0) >= 31) return 'יש לאשר פעם אחת "התקנת אפליקציות לא מוכרות" לקופה, או להגדיר בעלות מכשיר.';
  return 'באנדרואיד 11 ומטה רק בעלות מכשיר (או מתקין של היצרן) מאפשרת עדכון בלי לחיצה.';
}

/** A rollout row's flat "עדכון שקט" columns as a report (null: the device has not said). */
export function reportOfRolloutRow(row: {
  deviceOwner?: boolean | null;
  silentUpdate?: boolean | null;
  updatePath?: string | null;
  kioskLock?: string | null;
}): DeviceManagementReport | null {
  if (typeof row.silentUpdate !== 'boolean' && typeof row.deviceOwner !== 'boolean') return null;
  return {
    deviceOwner: row.deviceOwner ?? undefined,
    silentUpdate: row.silentUpdate ?? undefined,
    updatePath: row.updatePath ?? undefined,
    kioskLock: row.kioskLock ?? undefined,
  };
}

// ── Reboot ───────────────────────────────────────────────────────────────────

const REBOOT_PENDING = new Set(['pending', 'deferred']);

export function rebootPending(req?: RebootRequest | null): boolean {
  return !!req && REBOOT_PENDING.has(req.status);
}

/** "הפעל מחדש" is offered for a device-owner Android device only (the cloud refuses others). */
export function canReboot(m: WithDeviceManagement & { platform?: string | null }): boolean {
  return m.deviceManagement?.deviceOwner === true && (m.platform ?? 'android') !== 'windows';
}

const REBOOT_REASON: Record<string, string> = {
  busy_card: 'פעולת אשראי פתוחה',
  busy_payment: 'מסך תשלום פתוח',
  busy_sale: 'מכירה פתוחה',
  busy_table: 'שולחן פתוח',
  busy_kiosk: 'לקוח בקיוסק',
  updating: 'עדכון גרסה בהתקנה',
  in_use: 'מישהו עובד על המכשיר',
  not_owner: 'האפליקציה אינה בעלת המכשיר',
  restarted: 'המכשיר הופעל מחדש',
  no_restart: 'אנדרואיד לא הפעיל מחדש',
};

export function rebootStatusLabel(req?: RebootRequest | null): string | null {
  if (!req) return null;
  const reason = req.reason ? REBOOT_REASON[req.reason] ?? req.reason : null;
  switch (req.status) {
    case 'pending':
      return 'ממתין להפעלה מחדש (בפעימה הבאה של המכשיר)';
    case 'deferred':
      return `נדחה — ${reason ?? 'המכשיר עסוק'}; ינסה שוב בפעימה הבאה`;
    case 'rebooting':
      return 'הופעל מחדש';
    case 'refused':
      return `לא בוצע — ${reason ?? 'המכשיר סירב'}`;
    case 'expired':
      return 'פג תוקף (30 דק׳ בלי הפעלה מחדש)';
    case 'cancelled':
      return 'בוטל';
    default:
      return req.status;
  }
}

// ── The device types (the adb dialog) ────────────────────────────────────────

export interface DeviceType {
  id: string;
  name: string;
  android: string;
  sdk: number;
  /** Notes on this type, in order, beside the general conditions. */
  notes: string[];
  /** Matches the machine's model / reported device info (lower-case contains). */
  match: string[];
}

export const DEVICE_TYPES: DeviceType[] = [
  {
    id: 'F20',
    name: 'Feitian F20 / Nova 55F',
    android: 'Android 10',
    sdk: 29,
    notes: [
      'בלי בעלות מכשיר כל עדכון דורש לחיצה על "התקן" (אנדרואיד 10).',
      'Agamento ושירות ה-FT הם אפליקציות מערכת — נשארים פעילים.',
    ],
    match: ['f20', 'n55f', '55f', 'feitian'],
  },
  {
    id: 'HIT_KIOSK',
    name: 'קיוסק HIT (RK3568)',
    android: 'Android 12',
    sdk: 31,
    notes: [
      'גם בלי בעלות מכשיר מתעדכן בשקט אחרי אישור חד-פעמי של "התקנת אפליקציות לא מוכרות"; בעלות מכשיר מוסיפה נעילת קיוסק מלאה.',
    ],
    match: ['hit', 'rk3568', 'kiosk'],
  },
  {
    id: 'P18',
    name: 'Kozen P18 (טאבלט)',
    android: 'Android 13',
    sdk: 33,
    notes: ['גם בלי בעלות מכשיר מתעדכן בשקט (אנדרואיד 13) אחרי אישור חד-פעמי של "התקנת אפליקציות לא מוכרות".'],
    match: ['p18', 'nebullar', 'kozen'],
  },
  {
    id: 'SUNMI_T2',
    name: 'SUNMI T2',
    android: 'Android 7.1',
    sdk: 25,
    notes: [
      'אנדרואיד 7.1: אין "התקנת אפליקציות לא מוכרות" לפי אפליקציה — בלי בעלות מכשיר כל עדכון דורש לחיצה.',
      'מכשירי SUNMI שמנוהלים ב-SUNMI Partner/MDM: בעלות המכשיר תפוסה — הסירו מהניהול או השתמשו בהתקנה דרכם.',
    ],
    match: ['sunmi', 't2'],
  },
  {
    id: 'PAX_A77',
    name: 'PAX A77',
    android: 'Android 8.1',
    sdk: 27,
    notes: [
      'מכשירי PAX מנוהלים בדרך כלל ב-PAXSTORE, ואז אי אפשר להגדיר בעלות מכשיר.',
      'חלופה: כשספריית PAX (NeptuneLite) בתוך האפליקציה — העדכון עובר בשקט דרך המתקין של PAX.',
    ],
    match: ['pax', 'a77'],
  },
  {
    id: 'UROVO_I9100',
    name: 'Urovo i9100',
    android: 'Android 8.1',
    sdk: 27,
    notes: [
      'כשבמערכת של Urovo יש DeviceManager — העדכון עובר בשקט דרך המתקין של Urovo גם בלי בעלות מכשיר.',
    ],
    match: ['urovo', 'i9100', 'ubx'],
  },
];

/** The type a machine most likely is, from its model and what it reported at pairing. */
export function deviceTypeFor(m: {
  deviceModel?: string | null;
  deviceInfo?: Record<string, unknown> | null;
}): DeviceType | null {
  const info = m.deviceInfo ?? {};
  const text = [m.deviceModel, info.model, info.manufacturer, info.brand]
    .filter((v): v is string => typeof v === 'string')
    .join(' ')
    .toLowerCase();
  if (!text.trim()) return null;
  // The most specific words first (a "kiosk" word alone should not win over a model).
  for (const type of DEVICE_TYPES) {
    if (type.match.some((w) => w.length > 2 && text.includes(w) && w !== 'kiosk')) return type;
  }
  return DEVICE_TYPES.find((t) => t.match.some((w) => text.includes(w))) ?? null;
}

/** The conditions every type shares, in order (shown with the command). */
export const ADB_CONDITIONS: string[] = [
  'אין במכשיר אף חשבון (Google או אחר): הגדרות ← חשבונות. לבדיקה: adb shell dumpsys account — "Accounts: 0".',
  'משתמש אחד בלבד במכשיר (adb shell pm list users) ואין כבר בעלות מכשיר אחרת (adb shell dumpsys device_policy).',
  'אפליקציית הקופה כבר מותקנת, ו"ניפוי באגים ב-USB" מופעל (אפשרויות מפתח).',
  'אם יש חשבון — מסירים אותו (או מאפסים להגדרות יצרן ומשתמשים ב-QR).',
  'אחרי הפקודה: בדשבורד יופיע "עדכון שקט: פעיל" בפעימה הבאה של הקופה (עד דקה).',
];

/** What changes on an owner device — the same list in the dialog and the spec. */
export const OWNER_EFFECTS: string[] = [
  'עדכוני גרסה מותקנים בלי לחיצה, בכל גרסת אנדרואיד.',
  'נעילת קיוסק מלאה (בלי יציאה במחווה), הקופה כמסך הבית, מסך דולק בטעינה — כשהפרמטר "נעילת קופה" מופעל.',
  'ההרשאות שהקופה צריכה (מצלמה, מצב טלפון, Bluetooth) ניתנות אוטומטית — בלי חלונות אישור.',
  'אפשר להפעיל את המכשיר מחדש מהדשבורד ("הפעל מחדש"), אף פעם לא באמצע מכירה או תשלום.',
  'הסרה בלי איפוס: מסך הטכנאי ← "שחרור בעלות מכשיר" (קוד טכנאי).',
];

export const QR_STEPS: string[] = [
  'מאפסים את המכשיר להגדרות יצרן (מוחק את כל הנתונים במכשיר — קודם לסגור משמרת, לשדר ולוודא שהכול הגיע לענן).',
  'במסך הפתיחה ("Welcome" / בחירת שפה) נוגעים 6 פעמים באותה נקודה ריקה במסך — נפתח סורק QR.',
  'באנדרואיד 7–8 ייתכן שהמכשיר יבקש קודם להתחבר ל-Wi-Fi כדי להוריד את קורא ה-QR.',
  'סורקים את הקוד. המכשיר מתחבר לרשת (אם הוגדרה), מוריד את אפליקציית הקופה מהענן ומתקין אותה כבעלת המכשיר.',
  'בסיום הקופה נפתחת במסך הצימוד, עם כתובת השרת כבר ממולאת — מצמידים בקוד כרגיל.',
];

// ── The QR ───────────────────────────────────────────────────────────────────

export type WifiSecurity = 'WPA' | 'WEP' | 'NONE';

export interface WifiSettings {
  ssid: string;
  password?: string;
  security?: WifiSecurity;
  hidden?: boolean;
}

const EXTRA = 'android.app.extra.';
export const QR_KEYS = {
  component: `${EXTRA}PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME`,
  download: `${EXTRA}PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION`,
  checksum: `${EXTRA}PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM`,
  systemApps: `${EXTRA}PROVISIONING_LEAVE_ALL_SYSTEM_APPS_ENABLED`,
  wifiSsid: `${EXTRA}PROVISIONING_WIFI_SSID`,
  wifiPassword: `${EXTRA}PROVISIONING_WIFI_PASSWORD`,
  wifiSecurity: `${EXTRA}PROVISIONING_WIFI_SECURITY_TYPE`,
  wifiHidden: `${EXTRA}PROVISIONING_WIFI_HIDDEN`,
} as const;

/**
 * The cloud's payload with the owner's Wi-Fi added — in the browser, so the password never goes
 * to the server. No SSID: the payload as it was. A password without a type is WPA.
 */
export function withWifi(payload: Record<string, unknown>, wifi?: WifiSettings | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ...payload };
  delete out[QR_KEYS.wifiSsid];
  delete out[QR_KEYS.wifiPassword];
  delete out[QR_KEYS.wifiSecurity];
  delete out[QR_KEYS.wifiHidden];
  const ssid = wifi?.ssid?.trim();
  if (!ssid) return out;
  const password = wifi?.password ?? '';
  const security: WifiSecurity = wifi?.security ?? (password ? 'WPA' : 'NONE');
  out[QR_KEYS.wifiSsid] = ssid;
  out[QR_KEYS.wifiSecurity] = security;
  if (security !== 'NONE' && password) out[QR_KEYS.wifiPassword] = password;
  if (wifi?.hidden) out[QR_KEYS.wifiHidden] = true;
  return out;
}

/** The text the QR encodes: compact JSON. */
export function qrText(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

/** The cloud's `warnings`, in Hebrew. */
export function qrWarning(code: string): string {
  switch (code) {
    case 'localhost':
      return 'כתובת ההורדה היא localhost — מכשיר שמתאפס לא יגיע אליה. צרו את הקוד מהענן (PUBLIC_API_BASE_URL).';
    case 'http':
      return 'כתובת ההורדה אינה HTTPS — מכשירים רבים יסרבו להוריד ממנה.';
    case 'debug_key':
      return 'ה-APK חתום במפתח debug של מחשב הבנייה. אסור להגדיר בעלות מכשיר עם מפתח זמני: החלפת מפתח מחייבת התקנה מחדש של כל מכשיר.';
    case 'not_assigned':
      return 'לסניף לא שויכה גרסת אנדרואיד — הקוד מתקין את הגרסה החדשה ביותר.';
    default:
      return code;
  }
}
