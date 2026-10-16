/**
 * "סוג רישיון למכשיר" on the device (P:\specs\device-license-type.md §7; pos-server app/services/device_license.py,
 * the Android app's domain/DeviceLicense.kt): what the cloud licensed this till / kiosk as —
 *  - `till` "קופה בלבד": only a till, no kiosk mode;
 *  - `kiosk` "קיוסק בלבד": only a kiosk, no till mode;
 *  - `kiosk_till` "משולב": both, and "מצב עבודה: קיוסק / קופה" between them.
 * A screen / server has none (null), and an older cloud says nothing (null): then the owner's gate
 * `kioskTillModeEnabled` decides, as before. The cloud already sends a licensed device the gate its license
 * gives; this is the device's own second check (parameters kept from before a change say otherwise).
 *
 * Pure, pinned by test/deviceLicense.test.ts against the shared golden fixture (the same bytes as the
 * server's and the Android app's).
 */

export type LicenseProduct = 'till' | 'kiosk' | 'kiosk_till';

export const LICENSE_PRODUCTS: readonly LicenseProduct[] = ['till', 'kiosk', 'kiosk_till'];

export const LICENSE_LABELS: Readonly<Record<LicenseProduct, string>> = {
  till: 'קופה בלבד',
  kiosk: 'קיוסק בלבד',
  kiosk_till: 'משולב',
};

export const LICENSE_SHORT_LABELS: Readonly<Record<LicenseProduct, string>> = {
  till: 'קופה בלבד',
  kiosk: 'קיוסק בלבד',
  kiosk_till: 'משולב',
};

/** The two roles a license speaks of, as the device names them. */
export const LICENSE_ROLE_LABELS: Readonly<Record<'till' | 'kiosk', string>> = { till: 'קופה', kiosk: 'קיוסק' };

/** The fixture's sentences (`{label}` / `{role}` filled by `fillLicenseText`). */
export const LICENSE_TEXT = {
  refusal: 'סוג הרישיון של המכשיר ({label}) אינו כולל מעבר בין קיוסק לקופה',
  refusalWire: 'license',
  blocked: 'רישיון המכשיר אינו כולל מעבר בין קיוסק לקופה',
  paired: 'המכשיר הוגדר: {role} · סוג רישיון: {label}',
  mismatch: 'סוג הרישיון ({label}) לא תואם את תפקיד המכשיר ({role}) — פנו למפיץ',
  info: 'סוג רישיון: {label}',
} as const;

export function fillLicenseText(template: string, values: { label?: string | null; role?: string | null }): string {
  return template.replace('{label}', values.label ?? '—').replace('{role}', values.role ?? '—');
}

/** A product from the wire (trimmed, any case); null for anything else. */
export function parseLicenseProduct(raw: unknown): LicenseProduct | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (LICENSE_PRODUCTS as readonly string[]).includes(v) ? (v as LicenseProduct) : null;
}

/**
 * Whether "מצב עבודה: קיוסק / קופה" exists on the device: `kiosk_till` yes; `till` / `kiosk` no, whatever the
 * gate says; no product (or one not known) — the gate.
 */
export function workModeAllowed(product: unknown, gate: boolean): boolean {
  const p = parseLicenseProduct(product);
  if (p === 'kiosk_till') return true;
  if (p === 'till' || p === 'kiosk') return false;
  return gate;
}

/** A license that leaves out the work mode (`till` / `kiosk`) — the refusal names it. */
export function licenseForbidsWorkMode(product: unknown): product is 'till' | 'kiosk' {
  const p = parseLicenseProduct(product);
  return p === 'till' || p === 'kiosk';
}

/** The license does not fit the role the device opens in: `kiosk` as a till, `till` as a kiosk (a warning only). */
export function licenseMismatch(product: unknown, role: unknown): boolean {
  const p = parseLicenseProduct(product);
  return (p === 'kiosk' && role === 'till') || (p === 'till' && role === 'kiosk');
}

export function licenseLabel(product: unknown): string | null {
  const p = parseLicenseProduct(product);
  return p ? LICENSE_LABELS[p] : null;
}

/** What the device's info screens say of it: the label, the line, and the mismatch warning (null — none). */
export interface LicenseFacts {
  product: LicenseProduct | null;
  label: string | null;
  info: string | null;
  paired: string | null;
  warning: string | null;
}

export function licenseFacts(product: unknown, deviceRole: unknown): LicenseFacts {
  const p = parseLicenseProduct(product);
  if (!p) return { product: null, label: null, info: null, paired: null, warning: null };
  const label = LICENSE_LABELS[p];
  const role = deviceRole === 'kiosk' || deviceRole === 'till' ? LICENSE_ROLE_LABELS[deviceRole] : null;
  return {
    product: p,
    label,
    info: fillLicenseText(LICENSE_TEXT.info, { label }),
    paired: role ? fillLicenseText(LICENSE_TEXT.paired, { role, label }) : null,
    warning: licenseMismatch(p, deviceRole) ? fillLicenseText(LICENSE_TEXT.mismatch, { label, role }) : null,
  };
}

/**
 * The license an answer of the cloud carried (machines/me, a heartbeat, kiosk/sync, the pairing answer):
 * `said` false when the answer has no such field (an older cloud — what is kept stays).
 */
export function saidLicense(body: unknown): { said: boolean; product: LicenseProduct | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { said: false, product: null };
  const o = body as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(o, 'licenseProduct')) return { said: false, product: null };
  return { said: true, product: parseLicenseProduct(o.licenseProduct) };
}
