/**
 * The technician's setup on Windows — one screen for every role (renderer/technician/TechnicianScreen.tsx), the Android
 * technician screens' capabilities ported where a Windows PC can have them (P:/specs/windows-setup-parity.md):
 * pos-android ui/kiosk/KioskTechnician.kt ("בדיקות ומידע קיוסק"), ui/settings/DiagnosticsScreen.kt ("טכנאי"),
 * ui/settings/SettingsScreen.kt ("הגדרות") and ui/kitchen/PrintersScreen.kt ("מדפסות").
 *
 * The pure rules, pinned by test/technicianSetup.test.ts:
 *  - "כתובת שרת" — the address typed, tested and switched (Android domain/KioskTechnicianGate.kt KioskServerAddress);
 *  - "מגירת כסף" — the drawer's kick through the receipt printer (ESC p): its pin (2 / 5) and its pulse, set locally;
 *  - "בדיקת רוחב" — frames of 384 / 432 / 512 / 576 dots with their width in digits (Android PrintersScreen);
 *  - "סורק ברקוד" — what a scan looks like (its symbology, guessed from the digits as Android's KioskScanDiagnostics);
 *  - "מידע רשת" — Windows' own answers (netsh, CIM / wmic) read language-independently;
 *  - the summary lights, and "שליחת לוגים" ranges.
 */

import { ESC, type MonoBitmap } from './escpos';

/** Android's words (res/values/strings_kiosk_technician.xml, strings_kiosk_service.xml, strings.xml). */
export const TECH_TEXT = {
  titleKiosk: 'בדיקות ומידע קיוסק',
  titleTill: 'טכנאי',
  recheck: 'בדוק הכל שוב',
  back: 'חזרה',
  autoClose: 'המסך נסגר לבד אחרי 5 דקות בלי מגע',
  actions: 'פעולות',
  sync: 'סנכרון עכשיו',
  support: 'כניסה לתמיכה',
  pinpadCheck: 'בדיקת מסופון',
  pinpadRelink: 'קישור מסופון מחדש',
  printerTest: 'בדיקת מדפסת',
  z: 'הפקת Z / סגירת משמרת',
  restart: 'הפעלה מחדש של האפליקציה',
  restartConfirm: 'לחצו שוב להפעלה מחדש',
  quit: 'יציאה מהתוכנה',
  quitConfirm: 'לחצו שוב לסגירת התוכנה',
  blocked: 'לא בזמן הזמנה או תשלום',
  lightCloud: 'ענן',
  lightPinpad: 'מסופון',
  lightPrinter: 'מדפסת',
  lightMedia: (files: number, missing: number) => `מדיה · ${files} שמורים · ${missing} חסרים`,
  identity: 'שיוך',
  tenant: 'דייר',
  company: 'חברה',
  shop: 'סניף',
  branchCode: 'קוד סניף',
  area: 'נקודת מכירה',
  machineName: 'שם',
  machineId: 'מזהה מכונה',
  posNumber: 'מספר קופה',
  docPrefix: 'קידומת מסמכים',
  role: 'תפקיד',
  license: 'סוג רישיון',
  z_: 'Z',
  zIndependent: 'קופה עצמאית — Z משלה',
  zOwn: 'Z קופתי',
  zShop: 'Z סניפי',
  controllers: 'קופות שולטות',
  controllersNone: 'אין',
  unknownOffline: 'לא ידוע — הענן לא ענה',
  sourceCloud: 'לפי הענן, עכשיו',
  sourceLocal: 'לפי מה שנשמר במכשיר — הענן לא ענה',
  appVersion: 'גרסת אפליקציה',
  lastSync: 'סנכרון אחרון',
  configVersion: 'גרסת הגדרות',
  server: 'כתובת שרת',
  serverChange: 'שינוי',
  serverField: 'כתובת השרת החדשה',
  serverTest: 'בדיקת חיבור',
  serverSave: 'שמירה',
  serverHealth: 'חיבור לכתובת',
  serverSame: 'אותו ענן',
  serverSameYes: 'כן — הענן מכיר את המכשיר, הצימוד יישמר',
  serverSameNo: 'לא — ענן אחר: השמירה תנתק את המכשיר ותדרוש צימוד מחדש',
  serverInvalid: 'כתובת לא תקינה — כתובת מלאה עם http:// או https:// (למשל https://pos.example.com)',
  serverUnchanged: 'זו הכתובת הנוכחית',
  serverUntested: 'בדקו את החיבור לכתובת לפני השמירה',
  serverUnreachable: 'הכתובת לא ענתה לבדיקת החיבור — לא נשמר דבר',
  serverUnsynced: (n: number) => `ענן אחר, ויש ${n} מסמכים שעוד לא סונכרנו לענן הנוכחי — סנכרנו קודם`,
  serverConfirmNewCloud: 'זה ענן אחר: המכשיר ינותק מהענן הנוכחי ויצטרך צימוד מחדש. להמשיך?',
  serverConfirmUnpair: 'נתק ועבור לענן החדש',
  serverSwitched: (url: string) => `הכתובת עודכנה ל-${url} — אותו ענן, הצימוד נשמר`,
  serverSwitchedUnpaired: (url: string) => `הכתובת עודכנה ל-${url} — המכשיר נותק וצריך צימוד מחדש`,
  support_: 'חיבור מרחוק',
  supportButton: 'חיבור מרחוק (QuickSupport)',
  supportFound: (path: string) => `מותקן: ${path}`,
  supportMissing: 'QuickSupport לא מותקן במחשב',
  logsSend: 'שלח לוגים לתמיכה',
  logsNote: 'הערה לתמיכה (לא חובה)',
  network: 'מידע רשת',
  netConnection: 'חיבור',
  netWifi: 'Wi-Fi',
  netEthernet: 'Ethernet (כבל)',
  netOther: 'אחר',
  netNone: 'אין חיבור',
  netSsid: 'רשת Wi-Fi',
  netSignal: 'עוצמת אות',
  netIp: 'כתובת IP',
  netGateway: 'Gateway',
  netDns: 'DNS',
  netInternet: 'אינטרנט (בקשה לענן)',
  netApi: 'API הענן',
  netLan: 'קופה ראשית ב-LAN',
  httpOk: (code: number, ms: number) => `עונה · HTTP ${code} · ${ms} ms`,
  httpRefused: (code: number, ms: number) => `ענה בסירוב · HTTP ${code} · ${ms} ms`,
  httpFail: (why: string) => `לא עונה — ${why}`,
  printer: 'בדיקת מדפסת',
  printerBranch: 'מדפסת הסניף',
  printerPaper: 'נייר',
  printerWidth: (dots: number, cut: boolean) => `רוחב ${dots} נקודות · ${cut ? 'חותכת' : 'בלי חיתוך'}`,
  printerLastOk: 'הדפסה תקינה אחרונה',
  printerLastFailure: 'תקלה אחרונה',
  printTest: 'הדפסת דף בדיקה',
  widthTest: 'בדיקת רוחב',
  widthTestNote: 'מדפיס מסגרות ברוחב 384 / 432 / 512 / 576 נקודות — המסגרת הרחבה ביותר שמודפסת שלמה היא רוחב ההדפסה',
  discovery: 'חיפוש מדפסות ברשת',
  discoveryNone: 'לא נמצאה מדפסת ברשת (פורט 9100)',
  discoveryUse: 'הדפסה מהמחשב הזה',
  discoveryAdd: 'הוספה לסניף',
  drawer: 'מגירת כסף',
  drawerVia: 'דרך',
  drawerViaPrinter: (target: string) => `מדפסת הקבלות (חיבור RJ11) · ${target}`,
  drawerPin: 'פין המגירה',
  drawerPulse: 'אורך הפולס',
  drawerTest: 'פתח מגירה (בדיקה)',
  pinpad: 'בדיקת מסופון / תקשורת',
  pinpadReadonly: 'רק קריאות: getStatus, getRetailerInfo, getConfig. לעולם לא חיוב, זיכוי, ביטול או שינוי הגדרות',
  pinpadKind: 'סוג',
  pinpadAddress: 'כתובת',
  pinpadTcp: 'חיבור TCP',
  pinpadStatus: 'מצב המסופון',
  pinpadTerminal: 'מסוף ובית עסק',
  pinpadClearing: 'שרת סליקה',
  pinpadConfigTerminal: 'מסוף בהגדרות (tmsRetailer)',
  pinpadRecheck: 'בדוק שוב',
  pinpadSetup: 'כתובת המסופון',
  pinpadSetupHost: 'כתובת IP של המסופון',
  pinpadSetupPort: 'פורט',
  pinpadSetupSave: 'שמירה (קוד מנהל)',
  pinpadSetupUsb: 'חיבור USB (Nayax C4 בכבל) — קוד מנהל',
  relink: 'קישור מסופון מחדש',
  relinkHint: 'חיפוש המסופון ברשת המקומית — קריאות זהות בלבד (getStatus, getInfo, getRetailerInfo). שום הגדרה, הקמה או חיוב לא נשלחים למסופון.',
  relinkSearch: 'חיפוש מסופון ברשת',
  relinkNone: 'לא נמצא מסופון ברשת',
  relinkChoose: 'קשר את המסופון הזה',
  relinkSame: '✓ המסוף של המכשיר',
  relinkOther: (t: string) => `מסוף אחר — לא המסוף שהוגדר (${t})`,
  relinkAuto: 'חיפוש עצמי',
  relinkAutoOn: (t: string) => `אם המסופון לא עונה 2 דקות, המכשיר מחפש את מסוף ${t} ברשת ועובר אליו לבד`,
  relinkAutoUnknown: 'לא פעיל — מספר המסוף עוד לא ידוע (נקרא מהמסופון כשהוא עונה)',
  relinkLast: 'מעבר אחרון',
  scanner: 'סורק ברקוד',
  scannerSubtitle: 'סורק USB במצב מקלדת: סרקו ברקוד כדי לראות מה המחשב קיבל',
  scannerLast: 'סריקה אחרונה',
  scannerType: 'סוג ברקוד',
  scannerStart: 'סרוק לבדיקה',
  scannerStop: 'סיום בדיקה',
  scannerWaiting: 'ממתין לסריקה…',
  update: 'בדיקת עדכונים',
  audit: 'כניסות טכנאי',
  auditNone: 'אין רישומים',
  auditGranted: 'נכנס',
  auditWrong: 'קוד שגוי',
  auditLockedOut: 'ננעל ל-5 דקות',
  auditRefused: 'נדחה — נעול',
  computer: 'המחשב',
  computerSerial: 'מספר סידורי',
  computerModel: 'דגם',
  computerOs: 'מערכת הפעלה',
  computerBattery: 'סוללה',
  computerClock: 'שעון מול השרת',
  autostart: 'הפעלה אוטומטית',
  autostartOn: 'פעילה — האפליקציה עולה עם Windows',
  autostartOff: 'לא פעילה',
  autostartFix: 'הפעל',
  tax: 'מיסוי',
  taxDealer: 'סוג עוסק',
  taxVat: 'שיעור מע"מ',
  taxNote: 'קובץ מבנה אחיד מופק בלוח הבקרה בענן, לא במכשיר.',
  kitchen: 'מדפסות בונים',
  kitchenTest: 'הדפסת ניסיון',
  kitchenSync: 'רענן מהענן',
  kitchenEmpty: 'לא הוגדרו מדפסות בונים לסניף',
  cash: 'מכשיר מזומן',
  appLog: 'יומן אפליקציה',
  danger: 'פעולות מסוכנות',
  dangerNote: 'פעולה זו אינה ניתנת לביטול.',
  unpair: 'בטל שיוך מכשיר',
  unpairConfirm: 'המכשיר ינותק מהענן ותידרש התאמה מחדש. לאשר?',
} as const;

/* ------------------------------------------------------------ "כתובת שרת" */

/**
 * [input] as the app keeps a server (no trailing slash, no /api/v1), or null when it is not an http(s) URL with a host —
 * Android's KioskServerAddress.normalize.
 */
export function normalizeServerUrl(input: string): string | null {
  const typed = input.trim();
  if (!/^https?:\/\//i.test(typed)) return null;
  let u: URL;
  try {
    u = new URL(typed);
  } catch {
    return null;
  }
  if (!u.hostname || u.username || u.password || u.search || u.hash) return null;
  const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v\d+$/i, '');
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}`;
}

/** The connection test at one normalized URL. */
export interface ServerProbe {
  url: string;
  /** `/health` answered (2xx). */
  reachable: boolean;
  /** The same cloud answers for this device with its own token. */
  sameCloud: boolean;
}

export type ServerDecision = 'invalid' | 'unchanged' | 'not_tested' | 'unreachable' | 'refused_unsynced' | 'confirm_new_cloud' | 'switch_keep_pairing' | 'switch_and_unpair';

/**
 * What "שמירה" does with the address typed (Android KioskServerAddress.decide, without Android's cleartext policy and its
 * offline-Z and transmission guards — Windows sends its Zs and documents through the one outbox, counted in `unsynced`).
 */
export function decideServerSwitch(current: string | null, typed: string, probe: ServerProbe | null, unsynced: number, newCloudConfirmed: boolean): ServerDecision {
  const target = normalizeServerUrl(typed);
  if (!target) return 'invalid';
  const here = current ? normalizeServerUrl(current) : null;
  if (here && here.toLowerCase() === target.toLowerCase()) return 'unchanged';
  if (!probe || probe.url.toLowerCase() !== target.toLowerCase()) return 'not_tested';
  if (!probe.reachable) return 'unreachable';
  if (!probe.sameCloud && unsynced > 0) return 'refused_unsynced';
  if (probe.sameCloud) return 'switch_keep_pairing';
  return newCloudConfirmed ? 'switch_and_unpair' : 'confirm_new_cloud';
}

/* ------------------------------------------------------------ "מגירת כסף" */

/** The drawer's kick through the receipt printer: `ESC p m t1 t2` — pin 2 (m = 0) or pin 5 (m = 1), on / off in ms. */
export interface DrawerKick {
  pin: 2 | 5;
  onMs: number;
  offMs: number;
}

/** `ESC p 0 25 250` — what the app always sent (core/escpos.ts DRAWER_KICK). */
export const DEFAULT_DRAWER_KICK: DrawerKick = { pin: 2, onMs: 50, offMs: 500 };
/** The pulses offered ("אורך הפולס"): the printers count in 2 ms steps, 1–255. */
export const DRAWER_PULSES = [50, 100, 150, 200] as const;

const units = (ms: number) => Math.min(255, Math.max(1, Math.round(ms / 2)));

export function drawerKickBytes(k: DrawerKick = DEFAULT_DRAWER_KICK): Uint8Array {
  return Uint8Array.of(ESC, 0x70, k.pin === 5 ? 0x01 : 0x00, units(k.onMs), units(k.offMs));
}

/** A saved setting read back (a malformed value is the default's). */
export function parseDrawerKick(raw: unknown): DrawerKick {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const pin = o.pin === 5 || o.pin === '5' ? 5 : 2;
  const on = Number(o.onMs);
  const off = Number(o.offMs);
  return {
    pin,
    onMs: Number.isFinite(on) && on >= 2 && on <= 510 ? Math.round(on) : DEFAULT_DRAWER_KICK.onMs,
    offMs: Number.isFinite(off) && off >= 2 && off <= 510 ? Math.round(off) : DEFAULT_DRAWER_KICK.offMs,
  };
}

/* ------------------------------------------------------------ "בדיקת רוחב" */

export const WIDTH_TEST_DOTS = [384, 432, 512, 576] as const;

/** 3×5 digits (rows top→bottom, bit 2 = left). */
const DIGITS: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7],
  '1': [2, 6, 2, 2, 7],
  '2': [7, 1, 7, 4, 7],
  '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7],
  '6': [7, 4, 7, 5, 7],
  '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7],
  '9': [7, 5, 7, 1, 7],
};

/**
 * One page of frames, the widest first: each a box [w] dots wide with ticks every 8 mm (64 dots) and its width written
 * in it — centred on the 80 mm raster, as every page of the app. A frame the head cannot reach prints cut on both sides.
 */
export function widthTestBitmap(raster = 576, widths: readonly number[] = [...WIDTH_TEST_DOTS].reverse()): MonoBitmap {
  const frameH = 72;
  const gap = 24;
  const height = widths.length * (frameH + gap);
  const rowBytes = Math.ceil(raster / 8);
  const data = new Uint8Array(rowBytes * height);
  const dot = (x: number, y: number) => {
    if (x < 0 || x >= raster || y < 0 || y >= height) return;
    data[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  };
  widths.forEach((w, i) => {
    const top = i * (frameH + gap);
    const left = Math.floor((raster - w) / 2);
    for (let t = 0; t < 3; t++) {
      for (let x = left; x < left + w; x++) {
        dot(x, top + t);
        dot(x, top + frameH - 1 - t);
      }
      for (let y = top; y < top + frameH; y++) {
        dot(left + t, y);
        dot(left + w - 1 - t, y);
      }
    }
    for (let x = left; x < left + w; x += 64) for (let y = top; y < top + 14; y++) dot(x, y);
    // The width in digits, ×6, in the middle.
    const text = String(w);
    const scale = 6;
    const textW = text.length * 4 * scale;
    let x0 = left + Math.floor((w - textW) / 2);
    const y0 = top + Math.floor((frameH - 5 * scale) / 2);
    for (const ch of text) {
      const rows = DIGITS[ch] ?? [0, 0, 0, 0, 0];
      rows.forEach((bits, r) => {
        for (let c = 0; c < 3; c++) {
          if (bits & (4 >> c)) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) dot(x0 + c * scale + dx, y0 + r * scale + dy);
        }
      });
      x0 += 4 * scale;
    }
  });
  return { width: raster, height, rowBytes, data };
}

/* ------------------------------------------------------------ "סורק ברקוד" */

function ean13Ok(d: string): boolean {
  const n = d.split('').map(Number);
  const sum = n.slice(0, 12).reduce((s, v, i) => s + v * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10 === n[12];
}

function ean8Ok(d: string): boolean {
  const n = d.split('').map(Number);
  const sum = n.slice(0, 7).reduce((s, v, i) => s + v * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === n[7];
}

/**
 * The symbology of a scan as a keyboard-wedge scanner hands it over (no AIM prefix): EAN-13 / UPC-A / EAN-8 by their
 * length and check digit, the app's own prefixes ("CC:" a cash credit, "KO:" a kiosk order), else by its characters.
 */
export function symbologyOf(code: string): string {
  const s = code.trim();
  if (!s) return '—';
  if (/^CC:/i.test(s)) return 'QR — זיכוי מזומן (CC)';
  if (/^KO:/i.test(s)) return 'QR — הזמנת קיוסק (KO)';
  if (/^\d{13}$/.test(s)) return ean13Ok(s) ? 'EAN-13' : 'מספרים (13) — ספרת ביקורת לא תקינה';
  if (/^\d{12}$/.test(s)) return ean13Ok(`0${s}`) ? 'UPC-A' : 'מספרים (12)';
  if (/^\d{8}$/.test(s)) return ean8Ok(s) ? 'EAN-8' : 'מספרים (8)';
  if (/^\d+$/.test(s)) return `מספרים (${s.length})`;
  if (/^[0-9A-Z \-.$/+%]+$/.test(s)) return 'Code 39 / Code 128';
  if (s.length > 20 || /[^\x20-\x7e]/.test(s)) return 'QR / Data Matrix';
  return 'Code 128';
}

/* ------------------------------------------------------------ "מידע רשת" */

/** `netsh wlan show interfaces`: the SSID and the signal of the connected Wi-Fi (labels are localised — the values are not). */
export function parseNetshWlan(text: string): { ssid: string | null; signal: number | null } | null {
  let ssid: string | null = null;
  let signal: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    if (key === 'SSID' && ssid === null) ssid = m[2].trim() || null;
    const pct = /^(\d{1,3})\s*%$/.exec(m[2].trim());
    if (pct && signal === null) signal = Number(pct[1]);
  }
  return ssid === null && signal === null ? null : { ssid, signal };
}

/** Android's words for the signal (ktech_signal_*): 75+ מצוינת, 50+ טובה, 25+ בינונית, else חלשה. */
export function signalLabel(pct: number): string {
  return pct >= 75 ? 'מצוינת' : pct >= 50 ? 'טובה' : pct >= 25 ? 'בינונית' : 'חלשה';
}

export interface AdapterFacts {
  name: string;
  addresses: string[];
  gateways: string[];
  dns: string[];
  wifi: boolean;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []).filter((s) => s && s !== 'null');

/** PowerShell's `Win32_NetworkAdapterConfiguration` (IPEnabled) as JSON — one object or an array. */
export function parseAdapterJson(text: string): AdapterFacts[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return rows
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => {
      const name = String(r.Description ?? r.description ?? '');
      return {
        name,
        addresses: list(r.IPAddress).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
        gateways: list(r.DefaultIPGateway).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)),
        dns: list(r.DNSServerSearchOrder),
        wifi: /wi-?fi|wireless|wlan|802\.11/i.test(name),
      };
    })
    .filter((a) => a.addresses.length > 0);
}

/** The connection's kind from the adapters with an address (a gateway: the one in use). */
export function connectionKind(adapters: readonly AdapterFacts[]): 'wifi' | 'ethernet' | 'other' | 'none' {
  const live = adapters.filter((a) => a.gateways.length > 0);
  const pick = live[0] ?? adapters[0];
  if (!pick) return 'none';
  if (pick.wifi) return 'wifi';
  return /ethernet|gbe|gigabit|realtek|intel\(r\) .*connection|lan/i.test(pick.name) ? 'ethernet' : 'other';
}

/* ------------------------------------------------------------ lights and logs */

export type TechLight = 'ok' | 'warn' | 'bad' | 'unknown';

/** "ענן": the cloud answered → ok; the internet but not the cloud → warn; neither → bad (Android KioskTechnicianLights.cloud). */
export function cloudLight(cloudOk: boolean | null, internetOk: boolean | null): TechLight {
  if (cloudOk === null) return 'unknown';
  if (cloudOk) return 'ok';
  return internetOk ? 'warn' : 'bad';
}

/** "מדיה": nothing missing → ok, else warn. */
export function mediaLight(missing: number): TechLight {
  return missing > 0 ? 'warn' : 'ok';
}

/** "שליחת לוגים" (Android SendLogsUi): the ranges, in minutes back from now ("היום": since midnight). */
export const LOG_RANGES = [
  { id: 'hour', label: 'שעה' },
  { id: 'three', label: '3 שעות' },
  { id: 'today', label: 'היום' },
] as const;
export type LogRange = (typeof LOG_RANGES)[number]['id'];

export function logRangeMinutes(range: LogRange, now: Date): number {
  if (range === 'hour') return 60;
  if (range === 'three') return 180;
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.max(1, Math.ceil((now.getTime() - midnight) / 60_000));
}
