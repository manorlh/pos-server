/**
 * "תמיכה מרחוק" (pos-server app/services/remote_support.py, P:/specs/quicksupport-autoinstall.md §2, §2א):
 * TeamViewer QuickSupport as the device reports it on its heartbeat (`deviceInfo.remoteSupport`), the
 * allowed signer fingerprint ("pin", the till parameter `remoteSupportSignerSha256`) and the Hebrew the
 * device page and the parameters page show. Pure — the components are
 * components/dashboard/remote-support/*.
 */

export const SIGNER_KEY = 'remoteSupportSignerSha256';
export const OFFICIAL_HOST = 'download.teamviewer.com';

export type PinStatus = 'match' | 'mismatch' | 'no_pin' | 'pinned_first';
export type PinSource = 'auto' | 'confirmed' | 'manual';

/** `deviceInfo.remoteSupport`, as the cloud keeps it (each key checked on the way in). */
export interface RemoteSupportReport {
  installed?: boolean;
  package?: string;
  signerSha256?: string[];
  installedFrom?: string;
  reportedAt?: string;
  checkedAt?: string;
  pinStatus?: PinStatus;
}

/** Where an automatic pin came from: the till of the first install, and when. */
export interface PinOrigin {
  machineId?: string | null;
  machineName?: string | null;
  posNumber?: string | null;
  tillLabel?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  at?: string | null;
  package?: string | null;
  installedFrom?: string | null;
}

/** `GET /remote-support/signer-pin[?machineId=]` (super admin). */
export interface SignerPin {
  key: string;
  parameterId: string | null;
  active: boolean;
  /** The global value (the parameter's default): canonical fingerprints. */
  value: string[];
  source: PinSource | null;
  auto: PinOrigin | null;
  confirmedAt?: string | null;
  confirmedBy?: string | null;
  setAt?: string | null;
  setBy?: string | null;
  officialHost: string;
  machine?: {
    id: string;
    /** The pin as this till gets it (a company / shop / till may set its own). */
    effective: string[];
    reported: string[];
    status: Exclude<PinStatus, 'pinned_first'> | null;
    differsFromGlobal: boolean;
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const PIN_STATUSES: readonly PinStatus[] = ['match', 'mismatch', 'no_pin', 'pinned_first'];

function canonical(item: string): string {
  return item.replace(/[\s:]/g, '').toLowerCase();
}

/** The valid fingerprints in a list, canonical (lower-case hex, no colons), without repeats. */
export function fingerprintsOf(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,;\r\n]/) : [];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const fp = canonical(item);
    if (HEX64.test(fp) && !out.includes(fp)) out.push(fp);
  }
  return out;
}

/** The device's report out of `deviceInfo`, or null when it never said (an older build). */
export function reportOf(deviceInfo: Record<string, unknown> | null | undefined): RemoteSupportReport | null {
  const raw = deviceInfo?.remoteSupport;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: RemoteSupportReport = {};
  if (typeof r.installed === 'boolean') out.installed = r.installed;
  if (typeof r.package === 'string' && r.package) out.package = r.package;
  if (Array.isArray(r.signerSha256)) out.signerSha256 = fingerprintsOf(r.signerSha256);
  if (typeof r.installedFrom === 'string' && r.installedFrom) out.installedFrom = r.installedFrom;
  if (typeof r.reportedAt === 'string') out.reportedAt = r.reportedAt;
  if (typeof r.checkedAt === 'string') out.checkedAt = r.checkedAt;
  if (typeof r.pinStatus === 'string' && (PIN_STATUSES as readonly string[]).includes(r.pinStatus)) {
    out.pinStatus = r.pinStatus as PinStatus;
  }
  return out;
}

/** "מותקן" / "לא מותקן" / "לא דווח". */
export function installedLabel(report: RemoteSupportReport | null): string {
  if (!report || report.installed === undefined) return 'לא דווח';
  return report.installed ? 'מותקן' : 'לא מותקן';
}

/** A fingerprint as keytool prints it — upper case in colon-separated pairs — for reading. */
export function formatFingerprint(fp: string): string {
  const hex = canonical(fp).toUpperCase();
  return hex.match(/.{1,2}/g)?.join(':') ?? hex;
}

export type Tone = 'ok' | 'bad' | 'muted' | 'info';

/** How the device's QuickSupport stands against the pin it gets. */
export function pinStatusLabel(status: PinStatus | null | undefined): { text: string; tone: Tone } | null {
  switch (status) {
    case 'match':
      return { text: 'תואם לטביעת האצבע המותרת', tone: 'ok' };
    case 'mismatch':
      return { text: 'לא תואם לטביעת האצבע המותרת: התקנה ועדכון נחסמים בקופה', tone: 'bad' };
    case 'no_pin':
      return { text: 'עוד אין טביעת אצבע מותרת', tone: 'muted' };
    case 'pinned_first':
      return { text: 'טביעת האצבע המותרת נקבעה מההתקנה הזו (התקנה ראשונה)', tone: 'info' };
    default:
      return null;
  }
}

/** Both lists hold the same fingerprints (in any order or form). */
export function sameFingerprints(a: unknown, b: unknown): boolean {
  const x = fingerprintsOf(a);
  const y = fingerprintsOf(b);
  return x.length === y.length && x.every((fp) => y.includes(fp));
}

/** "השתמש כטביעת האצבע המותרת" is offered: the device reported a signer and it is not the global pin already. */
export function canUseAsPin(report: RemoteSupportReport | null, pin: Pick<SignerPin, 'value'> | null | undefined): boolean {
  const reported = fingerprintsOf(report?.signerSha256);
  return reported.length > 0 && !sameFingerprints(reported, pin?.value ?? []);
}

/** "קופה 3 · סניף מרכז" — the till of an automatic pin. */
export function originLabel(origin: PinOrigin | null | undefined): string {
  if (!origin) return 'קופה';
  const till = origin.tillLabel || (origin.posNumber ? `קופה ${origin.posNumber}` : origin.machineName || 'קופה');
  return origin.shopName ? `${till} · ${origin.shopName}` : till;
}

/**
 * "נקבע אוטומטית מהתקנה ראשונה (קופה X, תאריך)" — while the pin is the automatic one (and, once a super
 * admin confirmed it, the same line with "אושר"). Null for a pin set by hand or none. `formatDate` is the
 * page's own (lib/format.ts `formatDateTime`).
 */
export function pinNote(pin: SignerPin | null | undefined, formatDate: (iso: string) => string): string | null {
  if (!pin || !pin.value.length || !pin.auto) return null;
  const when = pin.auto.at ? `, ${formatDate(pin.auto.at)}` : '';
  const base = `נקבע אוטומטית מהתקנה ראשונה (${originLabel(pin.auto)}${when})`;
  if (pin.source === 'confirmed') {
    const by = pin.confirmedBy ? ` ע״י ${pin.confirmedBy}` : '';
    return `${base} · אושר${by}${pin.confirmedAt ? ` ${formatDate(pin.confirmedAt)}` : ''}`;
  }
  return base;
}

/** The pin is the automatic one, still waiting for a super admin's "אשר". */
export function awaitsConfirmation(pin: SignerPin | null | undefined): boolean {
  return !!pin && pin.source === 'auto' && pin.value.length > 0;
}

/**
 * The replace dialog's text as the server will take it: one fingerprint or more, comma- or line-separated,
 * with or without colons, any case. The error is the server's own wording, shown before sending.
 */
export function parseFingerprints(text: string): { value: string[]; error: string | null } {
  const items = text.split(/[,;\r\n]/).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return { value: [], error: 'טביעת אצבע: לפחות טביעה אחת' };
  const value: string[] = [];
  for (const item of items) {
    const fp = canonical(item);
    if (!HEX64.test(fp)) {
      return {
        value: [],
        error: `טביעת אצבע לא תקינה: «${item.slice(0, 100)}». נדרשים 64 תווים הקסדצימליים (0-9, A-F), עם נקודתיים או בלי; כמה טביעות מופרדות בפסיק`,
      };
    }
    if (!value.includes(fp)) value.push(fp);
  }
  if (value.length > 10) return { value: [], error: 'טביעת אצבע: עד 10 טביעות' };
  return { value, error: null };
}

/** The server's refusal codes of the pin's actions, in Hebrew; anything else falls through (null). */
export function pinErrorText(detail: unknown): string | null {
  switch (detail) {
    case 'remote_support_pin_not_auto':
      return 'טביעת האצבע כבר לא זו שנקבעה אוטומטית (אושרה או הוחלפה). רעננו את הדף.';
    case 'remote_support_pin_changed':
      return 'טביעת האצבע השתנתה מאז שנטען הדף. רעננו ובדקו שוב.';
    case 'remote_support_no_report':
      return 'המכשיר עוד לא דיווח על טביעת אצבע של QuickSupport.';
    case 'remote_support_pin_source':
      return 'יש לבחור טביעת אצבע אחת או מכשיר אחד.';
    default:
      return null;
  }
}
