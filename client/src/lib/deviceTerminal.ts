/**
 * "מסופון אשראי" — the card terminal type of one device (a till or a kiosk; Android / Windows / the browser
 * kiosk), chosen in the add-device dialog and on the device page's "תפקיד ודגם", with that type's fields.
 *
 * Not a store of its own: the choice is "סוג אינטגרציית אשראי" (`paymentIntegration`) and its non-secret
 * keys on the device's own settings layer — the till parameters the device already reads. The add dialog
 * sends it with the pairing code (`terminal`, written as the device pairs: server
 * app/services/device_terminal.py); the device page writes it with `PATCH /machines/{id}/settings`. Secrets
 * (Z-Credit's password, Tap to Pay's merchant code, SynqPay's key) are never asked or shown here: the
 * payment settings page takes them.
 *
 * Only relative imports, so `npm test` compiles it with them.
 */

import {
  INTEGRATION_LABELS,
  cleanIntegration,
  cleanNayaxUsbDevice,
  cleanSynqpayConnection,
  cleanSynqpayModel,
  cleanSynqpayProtocol,
  cleanSynqpayUsbDevice,
  cleanTapToPayEnvironment,
  cleanPinpadId,
  isValidPinpadHost,
  isValidPort,
  isValidTapToPayTpn,
  type PaymentIntegration,
  type SynqpayConnection,
  type SynqpayModel,
  type SynqpayProtocol,
  type TapToPayEnvironment,
  type ZcreditMode,
} from './paymentIntegration';

export type TerminalPlatform = 'android' | 'windows' | 'web';
export type TerminalRole = 'till' | 'kiosk';

/** The Windows app (kiosk and till alike, kiosk-desktop src/main/payment/registry.ts) and the browser kiosk's bridge. */
export const WINDOWS_TERMINAL_TYPES: readonly PaymentIntegration[] = ['auto', 'nayax_lan', 'nayax_usb', 'synqpay', 'none'];
/** An Android kiosk: external terminals only (never the built-in one, never Tap to Pay). */
export const ANDROID_KIOSK_TERMINAL_TYPES: readonly PaymentIntegration[] = ['auto', 'nayax_lan', 'nayax_usb', 'zcredit', 'synqpay', 'none'];
/** An Android till: the built-in terminal only on a model that has one; Tap to Pay unless it has no NFC. */
export const ANDROID_TILL_TERMINAL_TYPES: readonly PaymentIntegration[] = [
  'auto',
  'agamento',
  'nayax_lan',
  'nayax_usb',
  'zcredit',
  'synqpay',
  'tap_to_pay',
  'none',
];

/** Whether a device of [role] gets a terminal at all: the two that sell. */
export function takesTerminal(role: unknown): role is TerminalRole {
  return role === 'till' || role === 'kiosk';
}

/**
 * The types offered to a device, as the server checks them (device_terminal.types_for). [builtinTerminal]:
 * the Android model has a terminal of its own (false / unknown model chosen → no "מובנה"); [hasNfc] false
 * drops Tap to Pay.
 */
export function terminalTypesFor(d: {
  role: unknown;
  platform?: TerminalPlatform | null;
  builtinTerminal?: boolean | null;
  hasNfc?: boolean | null;
}): PaymentIntegration[] {
  if (!takesTerminal(d.role)) return [];
  const platform = d.platform ?? 'android';
  if (platform === 'windows' || platform === 'web') return [...WINDOWS_TERMINAL_TYPES];
  if (d.role === 'kiosk') return [...ANDROID_KIOSK_TERMINAL_TYPES];
  return ANDROID_TILL_TERMINAL_TYPES.filter(
    (t) => !(t === 'agamento' && d.builtinTerminal === false) && !(t === 'tap_to_pay' && d.hasNfc === false),
  );
}

/** Today's behaviour, so nothing changes for a new device left as it is: a kiosk on a Nayax pinpad, a till by the shop. */
export function defaultTerminalType(role: unknown): PaymentIntegration {
  return role === 'kiosk' ? 'nayax_lan' : 'auto';
}

/** The select's words for a type (a kiosk without a terminal is "ללא מסופון"). */
export function terminalTypeLabel(type: PaymentIntegration, role: unknown): string {
  if (type === 'auto') return 'לפי הגדרות הסניף (אוטומטי)';
  if (type === 'agamento') return 'מובנה במכשיר';
  if (type === 'none') return role === 'kiosk' ? 'ללא מסופון — תשלום בקופה' : 'ללא מסופון (מזומן ואמצעים אחרים)';
  return INTEGRATION_LABELS[type];
}

export interface TerminalDraft {
  type: PaymentIntegration;
  nayaxDeviceHost: string;
  nayaxDevicePort: string;
  nayaxUsbDevice: string;
  zcreditTerminalNumber: string;
  zcreditPinpadId: string;
  zcreditMode: ZcreditMode | '';
  synqpayDeviceModel: SynqpayModel | '';
  synqpayConnection: SynqpayConnection | '';
  synqpayHost: string;
  synqpayProtocol: SynqpayProtocol | '';
  synqpayPort: string;
  synqpayTls: boolean;
  synqpayUsbDevice: string;
  tapToPayTpn: string;
  tapToPayEnvironment: TapToPayEnvironment | '';
}

export type TerminalField = Exclude<keyof TerminalDraft, 'type'>;

export function emptyTerminalDraft(type: PaymentIntegration = 'auto'): TerminalDraft {
  return {
    type,
    nayaxDeviceHost: '',
    nayaxDevicePort: '',
    nayaxUsbDevice: '',
    zcreditTerminalNumber: '',
    zcreditPinpadId: '',
    zcreditMode: '',
    synqpayDeviceModel: '',
    synqpayConnection: '',
    synqpayHost: '',
    synqpayProtocol: '',
    synqpayPort: '',
    synqpayTls: false,
    synqpayUsbDevice: '',
    tapToPayTpn: '',
    tapToPayEnvironment: '',
  };
}

/** The fields the block shows for the draft's type (SynqPay: by its connection). Nothing for auto / built-in / none. */
export function terminalFieldsOf(d: Pick<TerminalDraft, 'type' | 'synqpayConnection'>): TerminalField[] {
  switch (d.type) {
    case 'nayax_lan':
      return ['nayaxDeviceHost', 'nayaxDevicePort'];
    case 'nayax_usb':
      return ['nayaxUsbDevice'];
    case 'zcredit':
      return ['zcreditTerminalNumber', 'zcreditPinpadId', 'zcreditMode'];
    case 'synqpay':
      return [
        'synqpayDeviceModel',
        'synqpayConnection',
        ...(d.synqpayConnection === 'lan'
          ? (['synqpayHost', 'synqpayProtocol', 'synqpayPort', 'synqpayTls'] as TerminalField[])
          : d.synqpayConnection === 'usb'
            ? (['synqpayUsbDevice'] as TerminalField[])
            : []),
      ];
    case 'tap_to_pay':
      return ['tapToPayTpn', 'tapToPayEnvironment'];
    default:
      return [];
  }
}

/** The secret a type also needs, set on the payment settings page (never here). */
export function terminalSecretElsewhere(type: PaymentIntegration): 'zcreditPassword' | 'tapToPayMerchantCode' | 'synqpayPairing' | null {
  if (type === 'zcredit') return 'zcreditPassword';
  if (type === 'tap_to_pay') return 'tapToPayMerchantCode';
  if (type === 'synqpay') return 'synqpayPairing';
  return null;
}

const ZCREDIT_TERMINAL_RE = /^[0-9]{1,20}$/;

/** The fields of the shown ones the server would refuse ('' everywhere is fine: set later). */
export function terminalDraftErrors(d: TerminalDraft): Partial<Record<TerminalField, 'invalid'>> {
  const out: Partial<Record<TerminalField, 'invalid'>> = {};
  const shown = terminalFieldsOf(d);
  const text = (f: TerminalField) => String(d[f] ?? '').trim();
  for (const f of shown) {
    const v = text(f);
    if (!v) continue;
    const ok =
      f === 'nayaxDeviceHost' || f === 'synqpayHost'
        ? isValidPinpadHost(v)
        : f === 'nayaxDevicePort' || f === 'synqpayPort'
          ? isValidPort(v)
          : f === 'nayaxUsbDevice'
            ? cleanNayaxUsbDevice(v) !== null
            : f === 'synqpayUsbDevice'
              ? cleanSynqpayUsbDevice(v) !== null
              : f === 'zcreditTerminalNumber'
                ? ZCREDIT_TERMINAL_RE.test(v)
                : f === 'zcreditPinpadId'
                  ? cleanPinpadId(v) !== null
                  : f === 'tapToPayTpn'
                    ? isValidTapToPayTpn(v)
                    : true;
    if (!ok) out[f] = 'invalid';
  }
  return out;
}

export function terminalDraftHasErrors(d: TerminalDraft): boolean {
  return Object.keys(terminalDraftErrors(d)).length > 0;
}

/** The values the type writes (non-blank only), as the settings keys. */
function typeValues(d: TerminalDraft): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const f of terminalFieldsOf(d)) {
    if (f === 'synqpayTls') {
      out[f] = d.synqpayTls;
      continue;
    }
    const v = String(d[f] ?? '').trim();
    if (!v) continue;
    out[f] = f === 'nayaxUsbDevice' || f === 'synqpayUsbDevice' ? v.toUpperCase() : v;
  }
  return out;
}

/**
 * The pairing request's `terminal` for the draft, or null when there is nothing to write: "לפי הגדרות
 * הסניף", or a kiosk left on its default Nayax pinpad with no address — exactly what the dialog sent before.
 */
export function terminalPairingBody(d: TerminalDraft, role: unknown): Record<string, unknown> | null {
  if (!takesTerminal(role) || d.type === 'auto') return null;
  if (role === 'kiosk' && d.type === 'nayax_lan' && !d.nayaxDeviceHost.trim()) return null;
  return { paymentIntegration: d.type, ...typeValues(d) };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

/**
 * The draft for the device page, from the device's OWN settings layer (`GET /machines/{id}/settings`'s
 * `settings`, never a secret): its own type, else "לפי הגדרות הסניף".
 */
export function terminalDraftFromSettings(own: Record<string, unknown> | null | undefined): TerminalDraft {
  const s = own ?? {};
  const type = cleanIntegration(s.paymentIntegration) ?? 'auto';
  return {
    type,
    nayaxDeviceHost: str(s.nayaxDeviceHost),
    nayaxDevicePort: str(s.nayaxDevicePort),
    nayaxUsbDevice: str(s.nayaxUsbDevice),
    zcreditTerminalNumber: str(s.zcreditTerminalNumber),
    zcreditPinpadId: str(s.zcreditPinpadId),
    zcreditMode: s.zcreditMode === 'test' || s.zcreditMode === 'production' ? s.zcreditMode : '',
    synqpayDeviceModel: cleanSynqpayModel(s.synqpayDeviceModel) ?? '',
    synqpayConnection: cleanSynqpayConnection(s.synqpayConnection) ?? '',
    synqpayHost: str(s.synqpayHost),
    synqpayProtocol: cleanSynqpayProtocol(s.synqpayProtocol) ?? '',
    synqpayPort: str(s.synqpayPort),
    synqpayTls: s.synqpayTls === true,
    synqpayUsbDevice: str(s.synqpayUsbDevice),
    tapToPayTpn: str(s.tapToPayTpn),
    tapToPayEnvironment: cleanTapToPayEnvironment(s.tapToPayEnvironment) ?? '',
  };
}

/**
 * `PATCH /machines/{id}/settings`'s body for the device page: what changed from [initial] (the device's own
 * layer as loaded) — the type ("auto" = back to the shop's), and the shown fields, a cleared one sent as
 * `null` (inherit again). A Nayax pinpad with an address is switched on (`nayaxEnabled`), as the kiosk's
 * pinpad always was. Null when nothing changed.
 */
export function terminalSettingsPatch(initial: TerminalDraft, next: TerminalDraft): Record<string, unknown> | null {
  const patch: Record<string, unknown> = {};
  if (next.type !== initial.type) patch.paymentIntegration = next.type;
  for (const f of terminalFieldsOf(next)) {
    const before = f === 'synqpayTls' ? initial.synqpayTls : String(initial[f] ?? '').trim();
    const after = f === 'synqpayTls' ? next.synqpayTls : String(next[f] ?? '').trim();
    if (before === after) continue;
    patch[f] =
      typeof after === 'boolean'
        ? after
        : after === ''
          ? null
          : f === 'nayaxUsbDevice' || f === 'synqpayUsbDevice'
            ? after.toUpperCase()
            : after;
  }
  if (next.type === 'nayax_lan' && next.nayaxDeviceHost.trim() && ('nayaxDeviceHost' in patch || 'paymentIntegration' in patch)) {
    patch.nayaxEnabled = true;
  }
  return Object.keys(patch).length ? patch : null;
}

// ── Hebrew (one place for the add dialog and the device page) ───────────────

export const TERMINAL_FIELD_LABELS: Record<TerminalField, string> = {
  nayaxDeviceHost: 'כתובת IP של המסופון',
  nayaxDevicePort: 'פורט',
  nayaxUsbDevice: 'מזהה USB של המסופון (לא חובה)',
  zcreditTerminalNumber: 'מספר מסוף',
  zcreditPinpadId: 'מזהה PinPad',
  zcreditMode: 'מצב בדיקה / ייצור',
  synqpayDeviceModel: 'דגם המסוף',
  synqpayConnection: 'סוג החיבור',
  synqpayHost: 'כתובת IP של המסוף',
  synqpayProtocol: 'פרוטוקול',
  synqpayPort: 'פורט',
  synqpayTls: 'חיבור מוצפן (TLS)',
  synqpayUsbDevice: 'יציאת USB / COM (לא חובה)',
  tapToPayTpn: 'TPN',
  tapToPayEnvironment: 'סביבה (בדיקות / ייצור)',
};

export const TERMINAL_FIELD_PLACEHOLDERS: Partial<Record<TerminalField, string>> = {
  nayaxDeviceHost: '192.168.1.20',
  nayaxDevicePort: '8080',
  nayaxUsbDevice: 'VVVV:PPPP',
  synqpayHost: '192.168.1.30',
  synqpayUsbDevice: 'COM3 / VVVV:PPPP',
};

export const TERMINAL_FIELD_ERRORS: Partial<Record<TerminalField, string>> = {
  nayaxDeviceHost: 'כתובת IPv4 (למשל 192.168.1.20) או שם מארח, בלי http:// ובלי פורט.',
  synqpayHost: 'כתובת IPv4 (למשל 192.168.1.30) או שם מארח, בלי http:// ובלי פורט.',
  nayaxDevicePort: 'פורט בין 1 ל-65535 (ריק = 8080).',
  synqpayPort: 'פורט בין 1 ל-65535 (ריק = ברירת המחדל של הפרוטוקול).',
  nayaxUsbDevice: 'מזהה USB בצורה VVVV:PPPP (הקסדצימלי), או ריק — המסופון הראשון שמחובר.',
  synqpayUsbDevice: 'COMn או VVVV:PPPP, או ריק — זיהוי אוטומטי.',
  zcreditTerminalNumber: 'ספרות בלבד (אפסים מובילים נשמרים).',
  zcreditPinpadId: 'אותיות וספרות (עם או בלי הקידומת PINPAD).',
  tapToPayTpn: '4–20 אותיות או ספרות.',
};

export const TERMINAL_TEXT = {
  noneKiosk: 'בלי מסופון: הלקוח משלם בקופה ("מזומן בקופה"), לפי ההגדרה "קיוסק — כשאין מסופון אשראי".',
  noneTill: 'בלי מסופון: המכשיר לא מחייב כרטיסי אשראי — מזומן ואמצעים אחרים בלבד.',
  auto: 'לא נשמרת בחירה למכשיר: הוא מחייב לפי סוג אינטגרציית האשראי של הסניף / החברה (או לפי המכשיר עצמו).',
  builtin: 'המכשיר מחייב במסוף שבתוכו — אין מה להגדיר.',
  nayaxLanKioskBlank: 'בלי כתובת לא נשמר דבר — הכתובת מהסניף, או שתוזן אחר כך בהגדרות הקופה או בקיוסק עצמו.',
  nayaxUsb: 'המסופון מחובר בכבל USB למכשיר. מזהה ריק = המסופון הראשון שמחובר.',
  zcreditPassword:
    'את סיסמת המסוף מזינים בהגדרות הקופה ← "סוג אינטגרציית אשראי" (בתפריט המכשיר: "הגדרות לקופה זו"), אחרי שהמכשיר מחובר. סיסמה לא נשמרת ולא מוצגת כאן.',
  tapToPayMerchantCode:
    'את קוד הסוחר (Merchant Code) מזינים בהגדרות הקופה ← "סוג אינטגרציית אשראי" (בתפריט המכשיר: "הגדרות לקופה זו"), אחרי שהמכשיר מחובר. הקוד לא נשמר ולא מוצג כאן.',
  synqpayPairing: 'מפתח ה-API מתקבל בצימוד המכשיר עם המסוף (במסך הטכנאי) — אין צורך להזין אותו.',
  synqpayConnectionPick: 'בחרו סוג חיבור',
  pick: 'בחרו',
  saveFailed: 'שמירת המסופון נכשלה',
};
