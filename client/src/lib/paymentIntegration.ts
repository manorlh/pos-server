/**
 * "סוג אינטגרציית אשראי": which card integration a settings layer (tenant → company → shop
 * → area → till) chooses, which fields each one needs, and the checks the dashboard runs
 * before a save. The server's rules are in server/app/services/payment_integration.py and
 * payment_terminal.py; the ones here mirror them so a save is not refused.
 *
 * No imports, so `npm test` compiles it alone. The Hebrew of this feature lives here too
 * (one place for the form, the shop dialog and the machines list).
 */

// ── Values ───────────────────────────────────────────────────────────────────

export type PaymentIntegration = 'auto' | 'agamento' | 'nayax_lan' | 'zcredit' | 'tap_to_pay';
/** What a till actually charges on (never `auto`). */
export type ResolvedIntegration = 'agamento' | 'nayax_lan' | 'zcredit';
export type ZcreditMode = 'test' | 'production';
export type SettingsLevelName = 'tenant' | 'company' | 'shop' | 'area' | 'machine';

export const PAYMENT_INTEGRATIONS: readonly PaymentIntegration[] = [
  'auto',
  'agamento',
  'nayax_lan',
  'zcredit',
  'tap_to_pay',
];

/** Charged on a terminal outside the till: all a till without one of its own can use. */
export const EXTERNAL_INTEGRATIONS: readonly PaymentIntegration[] = ['nayax_lan', 'zcredit', 'tap_to_pay'];
/** Shown as "בקרוב" and refused by the server on write. */
export const RESERVED_INTEGRATIONS: readonly PaymentIntegration[] = ['tap_to_pay'];

export const INTEGRATION_LABELS: Record<PaymentIntegration, string> = {
  auto: 'אוטומטי',
  agamento: 'מובנה — Agamento במכשיר',
  nayax_lan: 'Nayax — מסופון ברשת',
  zcredit: 'Z-Credit — מסופון חיצוני',
  tap_to_pay: 'Tap to Pay במכשיר (iPOSpays)',
};

/** Short names for the machines list. */
export const INTEGRATION_SHORT_LABELS: Record<PaymentIntegration, string> = {
  auto: 'אוטומטי',
  agamento: 'מובנה',
  nayax_lan: 'Nayax',
  zcredit: 'Z-Credit',
  tap_to_pay: 'Tap to Pay',
};

export const ZCREDIT_MODES: readonly ZcreditMode[] = ['test', 'production'];
export const ZCREDIT_MODE_LABELS: Record<ZcreditMode, string> = { test: 'בדיקה', production: 'ייצור' };

/** "בירושה מהחנות", "שמורה ברמת החנות". */
export const LEVEL_LABELS: Record<SettingsLevelName, string> = {
  tenant: 'הארגון',
  company: 'החברה',
  shop: 'החנות',
  area: 'נקודת המכירה',
  machine: 'הקופה',
};

/** Defaults of the till's SPICy client when no layer sets them. */
export const NAYAX_DEFAULT_PORT = '8080';
export const NAYAX_DEFAULT_PATH = '/SPICy';

// ── Fields ───────────────────────────────────────────────────────────────────

export type PaymentSecretKey = 'zcreditPassword' | 'zcreditKey';
export const PAYMENT_SECRET_KEYS: readonly PaymentSecretKey[] = ['zcreditPassword', 'zcreditKey'];

export type PaymentFieldKey =
  | 'paymentIntegration'
  | 'nayaxDeviceHost'
  | 'nayaxDevicePort'
  | 'nayaxSpicyPath'
  | 'zcreditTerminalNumber'
  | 'zcreditPassword'
  | 'zcreditPinpadId'
  | 'zcreditMode'
  | 'zcreditKey';

export const FIELD_LABELS: Record<PaymentFieldKey, string> = {
  paymentIntegration: 'סוג אינטגרציית אשראי',
  nayaxDeviceHost: 'כתובת IP של המסופון',
  nayaxDevicePort: 'פורט',
  nayaxSpicyPath: 'נתיב SPICy',
  zcreditTerminalNumber: 'מספר מסוף',
  zcreditPassword: 'סיסמת מסוף',
  zcreditPinpadId: 'מזהה PinPad',
  zcreditMode: 'מצב בדיקה / ייצור',
  zcreditKey: 'מפתח (Key)',
};

/**
 * The fields each integration needs before its first card, in the order the form shows
 * them (the server's REQUIRED_FIELDS). `auto` resolves to one of the others first.
 */
export const REQUIRED_FIELDS: Record<Exclude<PaymentIntegration, 'auto'>, readonly PaymentFieldKey[]> = {
  agamento: [],
  nayax_lan: ['nayaxDeviceHost'],
  zcredit: ['zcreditTerminalNumber', 'zcreditPassword', 'zcreditPinpadId', 'zcreditMode'],
  tap_to_pay: [],
};

/** The fields the form shows for each integration (required and optional). */
export const FORM_FIELDS: Record<PaymentIntegration, readonly PaymentFieldKey[]> = {
  auto: [],
  agamento: [],
  nayax_lan: ['nayaxDeviceHost', 'nayaxDevicePort', 'nayaxSpicyPath'],
  zcredit: ['zcreditTerminalNumber', 'zcreditPassword', 'zcreditPinpadId', 'zcreditMode', 'zcreditKey'],
  tap_to_pay: [],
};

// ── Hebrew ───────────────────────────────────────────────────────────────────

export const PI_TEXT = {
  sectionTitle: 'סוג אינטגרציית אשראי',
  sectionDesc:
    'באיזה מסוף הקופה מחייבת כרטיסי אשראי. נבחר ברמה אחת (למשל החנות) וחל על כל הקופות שמתחתיה; קופה יכולה לקבל בחירה משלה.',
  required: 'שדה חובה',
  digitsOnly: 'ספרות בלבד',
  terminalTooLong: 'עד 20 ספרות',
  hostInvalid: 'כתובת IP או שם מארח לא תקינים',
  portInvalid: 'פורט 1–65535',
  pathNoSlash: 'נתיב חייב להתחיל ב-/',
  pathInvalid: 'נתיב לא תקין: אותיות באנגלית, ספרות ו- / . _ ~ - בלבד, עד 100 תווים',
  pinpadInvalid: 'אותיות באנגלית וספרות בלבד, עם או בלי הקידומת PINPAD',
  modeRequired: 'יש לבחור מצב: בדיקה או ייצור',
  secretInvalid: 'עד 200 תווים, ללא תווי בקרה',
  agamentoNeedsBuiltin: 'לקופה זו אין מסוף מובנה (טאבלט) — ניתן לבחור רק אינטגרציה חיצונית',
  tapToPayReserved: 'Tap to Pay עדיין לא זמין',
  soon: 'בקרוב',
  autoHint: 'קופה עם מסוף מובנה — Agamento; Nayax אם הוגדר; טאבלט — מסופון חיצוני',
  autoNayaxLegacy: 'מוגדר כאן Nayax מהגדרה קודמת (nayaxEnabled), ולכן "אוטומטי" מחייב ב-Nayax.',
  autoNayaxLegacyClear: 'בטל את ההגדרה הקודמת',
  agamentoHint: 'הקופה מחייבת במסוף האשראי המובנה שלה (Agamento). אין שדות להגדרה.',
  nayaxHint: 'מסופון Nayax (Nova C4) ברשת המקומית של העסק.',
  nayaxHttpHint: 'חיבור HTTP ללא הצפנה מוגדר בפרמטרים לקופות (pinpadAllowHttp)',
  hostPlaceholder: '192.168.1.50',
  hostHint: 'כתובת IPv4 או שם מארח, בלי http:// ובלי פורט',
  portHint: 'ברירת מחדל 8080',
  pathHint: 'ברירת מחדל /SPICy',
  zcreditHint: 'מסופון Z-Credit חיצוני. מספר המסוף והסיסמה מתקבלים מ-Z-Credit.',
  terminalHint: 'ספרות בלבד; אפסים מובילים נשמרים',
  pinpadHint: 'כפי שמופיע במסופון — למשל PINPAD100000 או 100000',
  modePlaceholder: 'בחרו מצב',
  advanced: 'מתקדם',
  keyHint: 'לא נדרש לסליקה במסופון — משמש ל-WebCheckout בלבד; לא נשלח לקופה',
  tapToPayHint: 'Tap to Pay במכשיר (iPOSpays) יהיה זמין בקרוב. אין עדיין שדות להגדרה.',
  tapToPayMerchant: 'מזהה סוחר (בקרוב)',
  tapToPayTerminal: 'מזהה מסוף (בקרוב)',
  needsNfc: 'למכשיר אין NFC',
  replace: 'החלף',
  cancelReplace: 'ביטול',
  typeNewSecret: 'הקלידו ערך חדש',
  resolvedPrefix: 'לפי ההגדרות השמורות, הקופה מחייבת ב:',
  hiddenInvalid: 'ערך לא תקין בשדה שאינו מוצג לסוג שנבחר',
  clear: 'נקה',
  resetToInherited: 'חזרה לערך בירושה',
  override: 'דריסה',
  inheritedSuffix: '(בירושה)',
  automaticSuffix: '(אוטומטי)',
  chosenAt: 'נבחר ברמת',
  missingPrefix: 'חסר:',
  missingUpperLevelHint: 'אפשר להשלים כאן (לכל הקופות) או בהגדרות כל קופה.',
  contextError: 'לא ניתן לטעון את פרטי האינטגרציה מהשרת; השדות מוצגים ללא בדיקת סיסמאות שמורות.',
  formInvalid: 'יש לתקן את שדות סוג אינטגרציית האשראי לפני השמירה.',
  shopCreateHint:
    'חל על כל הקופות בחנות; פרטי החיבור (כתובת/מספר מסוף) מוגדרים בהגדרות החנות או הקופה. אפשר לשנות לכל קופה בנפרד',
} as const;

/** "בירושה מהחנות: Z-Credit — מסופון חיצוני". */
export function inheritedLabel(integration: PaymentIntegration, source: SettingsLevelName | null | undefined): string {
  const from = source ? `מ${LEVEL_LABELS[source]}` : 'מהרמה שמעל';
  return `בירושה ${from}: ${INTEGRATION_LABELS[integration]}`;
}

/** A field's value from the layers above: "בירושה מהרמה שמעל: 10.0.0.7". */
export function inheritedValueLabel(value: string): string {
  return `בירושה מהרמה שמעל: ${value}`;
}

/** "סיסמה שמורה", "סיסמה שמורה ברמת החנות", "מפתח שמור ברמת הארגון". */
export function secretSavedLabel(key: PaymentSecretKey, source: SettingsLevelName | null | undefined, own: boolean): string {
  const noun = key === 'zcreditPassword' ? 'סיסמה שמורה' : 'מפתח שמור';
  return own || !source ? noun : `${noun} ברמת ${LEVEL_LABELS[source]}`;
}

// ── Cleaning ─────────────────────────────────────────────────────────────────

/** A stored or sent value as one of PAYMENT_INTEGRATIONS, or null for nothing / unknown. */
export function cleanIntegration(value: unknown): PaymentIntegration | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase().replace(/-/g, '_');
  return (PAYMENT_INTEGRATIONS as readonly string[]).includes(text) ? (text as PaymentIntegration) : null;
}

export function isExternal(value: unknown): boolean {
  const v = cleanIntegration(value);
  return v !== null && EXTERNAL_INTEGRATIONS.includes(v);
}

export function isReserved(value: unknown): boolean {
  const v = cleanIntegration(value);
  return v !== null && RESERVED_INTEGRATIONS.includes(v);
}

function cleanLevel(value: unknown): SettingsLevelName | null {
  return typeof value === 'string' && value in LEVEL_LABELS ? (value as SettingsLevelName) : null;
}

/** A non-blank string (trimmed), else null. Numbers (an old port) read as their text. */
function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t === '' ? null : t;
}

/** What the dashboard shows instead of a stored secret ("••••"); the server ignores it. */
export const SECRET_MASK = '••••';
const MASK_CHARS = new Set(['•', '*', '●', '·']);

/** The mask echoed back (only "•"/"*" characters): means "unchanged", never a value. */
export function isSecretMask(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const t = value.trim();
  return t !== '' && [...t].every((c) => MASK_CHARS.has(c));
}

/** A newly typed secret worth sending: a non-blank string that is not the mask. */
export function isTypedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && !isSecretMask(value);
}

/**
 * The PATCH body without secrets that must not be sent: nothing typed (`undefined`), a
 * blank field (which the server would read as "remove") or the mask. A typed secret, or an
 * explicit `null` (remove this layer's), is kept.
 */
export function withSendableSecrets<T extends Partial<Record<PaymentSecretKey, string | null | undefined>>>(patch: T): T {
  const out = { ...patch };
  for (const key of PAYMENT_SECRET_KEYS) {
    const v = out[key];
    if (v === null) continue;
    if (!isTypedSecret(v)) delete out[key];
  }
  return out;
}

// ── Host, port, path, ids ─────────────────────────────────────────────────────

const HOST_MAX = 253;
const PATH_MAX = 100;
const DNS_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const PATH_RE = /^\/[A-Za-z0-9._~/-]*$/;
const TERMINAL_RE = /^[0-9]+$/;
const PINPAD_RE = /^[A-Za-z0-9]{1,32}$/;

function isIPv4(textValue: string): boolean {
  const parts = textValue.split('.');
  if (parts.length !== 4) return false;
  // As Python's ipaddress: 0–255, no leading zeros ("01" is refused).
  return parts.every((p) => /^\d{1,3}$/.test(p) && (p === '0' || !p.startsWith('0')) && Number(p) <= 255);
}

/**
 * An IPv4 address or a host name, as the server's `clean_pinpad_host`: labels made only
 * of digits must be a valid IPv4 ("192.168.1.300" is not a name), anything else must be
 * RFC 1123 labels. No scheme, port or path.
 */
export function isValidPinpadHost(value: string): boolean {
  const t = value.trim();
  if (t === '' || t.length > HOST_MAX) return false;
  const labels = t.split('.');
  if (labels.every((l) => /^\d+$/.test(l))) return isIPv4(t);
  return labels.every((l) => DNS_LABEL.test(l));
}

export function isValidPort(value: string): boolean {
  const t = value.trim();
  if (!/^\d{1,5}$/.test(t)) return false;
  const n = Number(t);
  return n >= 1 && n <= 65535;
}

/** Null when fine, else the Hebrew error. */
export function spicyPathError(value: string): string | null {
  const t = value.trim();
  if (!t.startsWith('/')) return PI_TEXT.pathNoSlash;
  if (t.length > PATH_MAX || !PATH_RE.test(t)) return PI_TEXT.pathInvalid;
  return null;
}

/** The PinPad id without its "PINPAD" prefix, or null when it is not a valid one. */
export function cleanPinpadId(value: string): string | null {
  let t = value.trim();
  if (t.toUpperCase().startsWith('PINPAD')) t = t.slice('PINPAD'.length);
  return PINPAD_RE.test(t) ? t : null;
}

function secretError(value: string): string | null {
  return value.length > 200 || /[\u0000-\u001f\u007f]/.test(value) ? PI_TEXT.secretInvalid : null;
}

// ── Options ──────────────────────────────────────────────────────────────────

export interface DeviceCapabilities {
  /** null = not a till (an upper layer), or unknown. */
  hasBuiltinTerminal?: boolean | null;
  /** null = unknown. */
  hasNfc?: boolean | null;
}

export type OptionReason = 'needs_builtin_terminal' | 'soon' | 'needs_nfc';

export interface IntegrationOption {
  value: PaymentIntegration;
  /** What the select shows ("… — בקרוב" for a reserved one). */
  label: string;
  selectable: boolean;
  /** Not offered at all (Tap to Pay on a device known to have no NFC). */
  hidden: boolean;
  reason: OptionReason | null;
  /** Why it cannot be picked, in Hebrew; null when it can. */
  explanation: string | null;
}

/** The server's per-option verdict (GET /payment-integration/context `options`). */
export interface ServerIntegrationOption {
  value: string;
  selectable: boolean;
  reason?: string | null;
}

/**
 * The select's choices for a layer. A till without a terminal of its own may not pick
 * the built-in one (shown disabled, with why); Tap to Pay is never selectable yet, and
 * hidden on a device known to have no NFC. A server verdict, when given, can only take a
 * choice away.
 */
export function integrationOptions(
  device: DeviceCapabilities | null | undefined,
  serverOptions?: readonly ServerIntegrationOption[] | null,
): IntegrationOption[] {
  const builtin = device?.hasBuiltinTerminal;
  const nfc = device?.hasNfc;
  return PAYMENT_INTEGRATIONS.map((value) => {
    let reason: OptionReason | null = null;
    if (value === 'tap_to_pay') reason = nfc === false ? 'needs_nfc' : 'soon';
    else if (value === 'agamento' && builtin === false) reason = 'needs_builtin_terminal';
    const server = serverOptions?.find((o) => o.value === value);
    if (reason === null && server && !server.selectable) {
      const r = server.reason;
      reason = r === 'needs_builtin_terminal' || r === 'needs_nfc' ? r : 'soon';
    }
    const explanation =
      reason === 'needs_builtin_terminal'
        ? PI_TEXT.agamentoNeedsBuiltin
        : reason === 'needs_nfc'
          ? PI_TEXT.needsNfc
          : reason === 'soon'
            ? PI_TEXT.soon
            : null;
    return {
      value,
      label: reason === 'soon' ? `${INTEGRATION_LABELS[value]} — ${PI_TEXT.soon}` : INTEGRATION_LABELS[value],
      selectable: reason === null,
      hidden: reason === 'needs_nfc',
      reason,
      explanation,
    };
  });
}

// ── Resolution ───────────────────────────────────────────────────────────────

export interface FormIntegration {
  /** What the select shows: this layer's own choice, or `auto` (= inherit). */
  selected: PaymentIntegration;
  /**
   * The type this layer ends up on, whose fields the form shows: its own choice, else
   * the one inherited, else the automatic one. `auto` only on an upper layer with nothing
   * chosen (each till decides by its hardware).
   */
  effective: PaymentIntegration;
  /** Nothing chosen on this layer or above. */
  automatic: boolean;
  /** The effective type is inherited from a layer above. */
  inherited: boolean;
}

/**
 * own ?? inherited ?? automatic, as the server resolves a till: a till without a terminal
 * of its own skips an inherited `agamento`, and automatic is Nayax when `nayaxEnabled`
 * (the older switch) is on or the till has no terminal, else Agamento on a till, else
 * left `auto` on an upper layer.
 */
export function resolveFormIntegration(input: {
  own: unknown;
  inherited: unknown;
  nayaxEnabled?: boolean | null;
  hasBuiltinTerminal?: boolean | null;
}): FormIntegration {
  const ownRaw = cleanIntegration(input.own);
  const own = ownRaw === 'auto' ? null : ownRaw;
  let inh = cleanIntegration(input.inherited);
  if (inh === 'auto' || (inh !== null && RESERVED_INTEGRATIONS.includes(inh))) inh = null;
  if (inh === 'agamento' && input.hasBuiltinTerminal === false) inh = null;
  const selected = own ?? 'auto';
  if (own) return { selected, effective: own, automatic: false, inherited: false };
  if (inh) return { selected, effective: inh, automatic: false, inherited: true };
  const effective: PaymentIntegration =
    input.nayaxEnabled === true || input.hasBuiltinTerminal === false
      ? 'nayax_lan'
      : input.hasBuiltinTerminal === true
        ? 'agamento'
        : 'auto';
  return { selected, effective, automatic: true, inherited: false };
}

// ── Validation ───────────────────────────────────────────────────────────────

/** The form's keys this feature reads (a slice of PosSettingsPatch). */
export interface PaymentIntegrationForm {
  paymentIntegration?: string | null;
  nayaxEnabled?: boolean | null;
  nayaxDeviceHost?: string | null;
  nayaxDevicePort?: string | number | null;
  nayaxSpicyPath?: string | null;
  zcreditTerminalNumber?: string | null;
  zcreditPinpadId?: string | null;
  zcreditMode?: string | null;
  zcreditPassword?: string | null;
  zcreditKey?: string | null;
}

/** What the layers above give (the settings GET's `effective`). */
export type PaymentIntegrationInherited = Omit<PaymentIntegrationForm, 'zcreditPassword' | 'zcreditKey'>;

export interface SecretStatus {
  set: boolean;
  source?: SettingsLevelName | string | null;
  own?: boolean;
  updatedAt?: string | null;
}
export type SecretsStatus = Partial<Record<PaymentSecretKey, SecretStatus>>;

export type PaymentIntegrationErrors = Partial<Record<PaymentFieldKey, string>>;

export interface ValidateOptions {
  /**
   * Required fields missing are errors (default). A layer above the till passes false:
   * there they are only listed (`missingRequiredFields`), since a till may complete them
   * (a PinPad id is per till).
   */
  requireAll?: boolean;
  /** For a till: whether it has a terminal of its own. */
  hasBuiltinTerminal?: boolean | null;
}

/** The type the form's fields are for, from the form and what it inherits. */
export function formEffectiveIntegration(
  form: PaymentIntegrationForm,
  inherited: PaymentIntegrationInherited | null | undefined,
  hasBuiltinTerminal?: boolean | null,
): FormIntegration {
  const nayaxEnabled =
    typeof form.nayaxEnabled === 'boolean' ? form.nayaxEnabled : inherited?.nayaxEnabled === true;
  return resolveFormIntegration({
    own: form.paymentIntegration,
    inherited: inherited?.paymentIntegration,
    nayaxEnabled,
    hasBuiltinTerminal,
  });
}

/**
 * Whether [key] has a value for the till: set on this layer or inherited; a secret when
 * newly typed or held by some layer (`secrets[key].set`). An unknown secrets status
 * (null — the context did not load) counts as present rather than block a save on a guess.
 */
export function fieldPresent(
  key: PaymentFieldKey,
  form: PaymentIntegrationForm,
  inherited: PaymentIntegrationInherited | null | undefined,
  secrets: SecretsStatus | null | undefined,
): boolean {
  if (key === 'zcreditPassword' || key === 'zcreditKey') {
    if (isTypedSecret(form[key])) return true;
    if (!secrets) return true;
    const status = secrets[key];
    // Removing this layer's own (`null`) leaves only a parent's, which the status cannot tell.
    if (form[key] === null && status?.own) return false;
    return status?.set === true;
  }
  if (key === 'paymentIntegration') return true;
  const own = form[key];
  if (own !== null && text(own) !== null) return true;
  return text(inherited?.[key]) !== null;
}

/** The required fields of [integration] that nothing gives, in form order. */
export function missingRequiredFields(
  integration: PaymentIntegration,
  form: PaymentIntegrationForm,
  inherited: PaymentIntegrationInherited | null | undefined,
  secrets: SecretsStatus | null | undefined,
): PaymentFieldKey[] {
  if (integration === 'auto') return [];
  return REQUIRED_FIELDS[integration].filter((key) => !fieldPresent(key, form, inherited, secrets));
}

/**
 * Field → Hebrew error for the payment-integration part of a layer's form. Formats are
 * checked on this layer's own values (an inherited one was checked where it was set);
 * required fields count as present when inherited too. Empty = valid.
 */
export function validatePaymentIntegration(
  form: PaymentIntegrationForm,
  inherited: PaymentIntegrationInherited | null | undefined,
  secrets: SecretsStatus | null | undefined,
  opts: ValidateOptions = {},
): PaymentIntegrationErrors {
  const errors: PaymentIntegrationErrors = {};
  const requireAll = opts.requireAll !== false;
  const own = cleanIntegration(form.paymentIntegration);
  if (own === 'tap_to_pay') errors.paymentIntegration = PI_TEXT.tapToPayReserved;
  else if (own === 'agamento' && opts.hasBuiltinTerminal === false) {
    errors.paymentIntegration = PI_TEXT.agamentoNeedsBuiltin;
  }

  const { effective } = formEffectiveIntegration(form, inherited, opts.hasBuiltinTerminal);

  if (effective === 'nayax_lan') {
    const host = text(form.nayaxDeviceHost);
    if (host !== null && !isValidPinpadHost(host)) errors.nayaxDeviceHost = PI_TEXT.hostInvalid;
    const port = text(form.nayaxDevicePort);
    if (port !== null && !isValidPort(port)) errors.nayaxDevicePort = PI_TEXT.portInvalid;
    const path = text(form.nayaxSpicyPath);
    if (path !== null) {
      const err = spicyPathError(path);
      if (err) errors.nayaxSpicyPath = err;
    }
  }

  // Z-Credit's values are checked whatever the type: the server validates every one sent
  // (a Nayax address it does not, so a leftover one under another type is left alone).
  const terminal = text(form.zcreditTerminalNumber);
  if (terminal !== null) {
    if (!TERMINAL_RE.test(terminal)) errors.zcreditTerminalNumber = PI_TEXT.digitsOnly;
    else if (terminal.length > 20) errors.zcreditTerminalNumber = PI_TEXT.terminalTooLong;
  }
  const pinpad = text(form.zcreditPinpadId);
  if (pinpad !== null && cleanPinpadId(pinpad) === null) errors.zcreditPinpadId = PI_TEXT.pinpadInvalid;
  const mode = text(form.zcreditMode);
  if (mode !== null && !(ZCREDIT_MODES as readonly string[]).includes(mode)) {
    errors.zcreditMode = PI_TEXT.modeRequired;
  }
  for (const key of PAYMENT_SECRET_KEYS) {
    const v = form[key];
    if (isTypedSecret(v)) {
      const err = secretError(v);
      if (err) errors[key] = err;
    }
  }

  if (requireAll) {
    for (const key of missingRequiredFields(effective, form, inherited, secrets)) {
      if (errors[key]) continue;
      errors[key] = key === 'zcreditMode' ? PI_TEXT.modeRequired : PI_TEXT.required;
    }
  }
  return errors;
}

export function hasPaymentIntegrationErrors(errors: PaymentIntegrationErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** "חסר: מספר מסוף, מזהה PinPad"; '' for nothing missing. Unknown keys read as they are. */
export function missingFieldsLabel(missing: readonly string[] | null | undefined): string {
  if (!missing || missing.length === 0) return '';
  const names = missing.map((key) => (key in FIELD_LABELS ? FIELD_LABELS[key as PaymentFieldKey] : key));
  return `${PI_TEXT.missingPrefix} ${names.join(', ')}`;
}

// ── Server answers ───────────────────────────────────────────────────────────

/**
 * The Hebrew the server sent with a payment-integration refusal (422
 * `{detail: {code, msg}}`: `agamento_needs_builtin_terminal`, `secret_invalid`), or null
 * for any other error.
 */
export function paymentIntegrationErrorMessage(err: unknown): string | null {
  const detail = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response?.data
    ?.detail;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
  const { code, msg } = detail as { code?: unknown; msg?: unknown };
  if (code === 'agamento_needs_builtin_terminal') {
    return typeof msg === 'string' && msg.trim() ? msg : PI_TEXT.agamentoNeedsBuiltin;
  }
  if (code === 'secret_invalid') return typeof msg === 'string' && msg.trim() ? msg : PI_TEXT.secretInvalid;
  return null;
}

// ── The machines list ────────────────────────────────────────────────────────

/** The integration fields of a `GET /machines` row. */
export interface MachineIntegrationFields {
  paymentIntegration?: ResolvedIntegration | null;
  paymentIntegrationSource?: SettingsLevelName | null;
  paymentIntegrationAutomatic?: boolean | null;
  paymentIntegrationMissing?: string[];
}

/** Normalizes the row's integration fields (absent on an older server: null / []). */
export function normalizeMachineIntegration(raw: Record<string, unknown>): Required<MachineIntegrationFields> {
  const v = cleanIntegration(raw.paymentIntegration ?? raw.payment_integration);
  const missingRaw = raw.paymentIntegrationMissing ?? raw.payment_integration_missing;
  const automatic = raw.paymentIntegrationAutomatic ?? raw.payment_integration_automatic;
  return {
    paymentIntegration: v === 'agamento' || v === 'nayax_lan' || v === 'zcredit' ? v : null,
    paymentIntegrationSource: cleanLevel(raw.paymentIntegrationSource ?? raw.payment_integration_source),
    paymentIntegrationAutomatic: typeof automatic === 'boolean' ? automatic : null,
    paymentIntegrationMissing: Array.isArray(missingRaw)
      ? missingRaw.filter((x): x is string => typeof x === 'string' && x !== '')
      : [],
  };
}

export interface IntegrationBadge {
  /** "Z-Credit", "Nayax (אוטומטי)". */
  label: string;
  /** `warn` while the integration is missing fields. */
  tone: 'neutral' | 'warn';
  /** The full name, where it was chosen and what is missing, for the badge's title. */
  title: string;
  /** "חסר: מספר מסוף, מזהה PinPad"; '' for nothing missing. */
  missing: string;
}

/** The machines list's badge for the integration a till charges on; null on an older server. */
export function integrationBadge(row: MachineIntegrationFields): IntegrationBadge | null {
  const v = cleanIntegration(row.paymentIntegration);
  if (!v || v === 'auto') return null;
  const automatic = row.paymentIntegrationAutomatic === true;
  const label = automatic
    ? `${INTEGRATION_SHORT_LABELS[v]} ${PI_TEXT.automaticSuffix}`
    : INTEGRATION_SHORT_LABELS[v];
  const missing = missingFieldsLabel(row.paymentIntegrationMissing);
  const source = cleanLevel(row.paymentIntegrationSource);
  const parts = [INTEGRATION_LABELS[v]];
  if (automatic) parts.push(PI_TEXT.automaticSuffix);
  else if (source) parts.push(`${PI_TEXT.chosenAt} ${LEVEL_LABELS[source]}`);
  if (missing) parts.push(missing);
  return { label, tone: missing ? 'warn' : 'neutral', title: parts.join(' · '), missing };
}
