/**
 * "סוג רישיון למכשיר" — what a till / kiosk device is licensed as (pos-server app/services/device_license.py,
 * P:/specs/device-license-type.md): "קופה בלבד" (`till`), "קיוסק בלבד" (`kiosk`) or "קיוסק + קופה (משולב)"
 * (`kiosk_till`, the only one with the kiosk ↔ till work mode). The other roles (screens, servers) have none.
 * Set by a super admin or a distributor: in the add-device dialog (by role), then on the machine page.
 * The rules are the shared golden fixture's (server/tests/fixtures/device_license_golden.json).
 */

export type LicenseProduct = 'till' | 'kiosk' | 'kiosk_till';

export const LICENSE_PRODUCTS: readonly LicenseProduct[] = ['till', 'kiosk', 'kiosk_till'];

/** The fiscal roles that carry a license. */
export type LicensedRole = 'till' | 'kiosk';

/** Which products each role fits (the default first). */
export const LICENSE_FITS: Readonly<Record<LicensedRole, readonly LicenseProduct[]>> = {
  till: ['till', 'kiosk_till'],
  kiosk: ['kiosk', 'kiosk_till'],
};

/** The product a new device of the role gets when none is chosen. */
export const LICENSE_DEFAULTS: Readonly<Record<LicensedRole, LicenseProduct>> = { till: 'till', kiosk: 'kiosk' };

/** Who may set it (the server's `ADMIN_ROLES`; a distributor for their own devices). */
export const LICENSE_ADMIN_ROLES: readonly string[] = ['super_admin', 'distributor'];

/** A product from the wire (trimmed, any case); null for anything else. */
export function parseLicenseProduct(raw: unknown): LicenseProduct | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  return (LICENSE_PRODUCTS as readonly string[]).includes(v) ? (v as LicenseProduct) : null;
}

/** "till" / "kiosk" for the roles that carry a license; null for the others (and no role yet). */
export function licensedRoleOf(role: unknown): LicensedRole | null {
  return role === 'till' || role === 'kiosk' ? role : null;
}

/** The products the role may hold (none for a screen / server). */
export function licenseOptionsFor(role: unknown): readonly LicenseProduct[] {
  const r = licensedRoleOf(role);
  return r ? LICENSE_FITS[r] : [];
}

/** Whether a device of `role` may hold `product`; a "קיוסק בלבד" kiosk must be on (a disabled kiosk works as a till). */
export function licenseFits(product: LicenseProduct | null, role: unknown, kioskEnabled: boolean | null = true): boolean {
  if (product == null) return true;
  const r = licensedRoleOf(role);
  if (!r || !LICENSE_FITS[r].includes(product)) return false;
  return !(product === 'kiosk' && r === 'kiosk' && kioskEnabled === false);
}

/** Whether the work mode (kiosk ↔ till) exists for the product — the devices' rule (`workModeAllowed`). */
export function workModeAllowed(product: unknown, gate: boolean): boolean {
  const p = parseLicenseProduct(product);
  if (p === 'kiosk_till') return true;
  if (p === 'till' || p === 'kiosk') return false;
  return gate;
}

/** Whether the reader may set a license (the server checks the distributor's own devices). */
export function mayManageLicense(userRole: string | null | undefined): boolean {
  return !!userRole && LICENSE_ADMIN_ROLES.includes(userRole);
}

/**
 * The add-device dialog's choice for the role: the one picked when it fits the role, else the role's
 * default; null for a role with no license (nothing is sent).
 */
export function pairingLicenseOf(role: unknown, chosen: LicenseProduct | '' | null | undefined): LicenseProduct | null {
  const r = licensedRoleOf(role);
  if (!r) return null;
  return chosen && LICENSE_FITS[r].includes(chosen) ? chosen : LICENSE_DEFAULTS[r];
}

/**
 * The machine page's role change: when the device's stored product does not fit the new role, the
 * products to choose from (the new role's, default first); null — the current one fits (or none is stored).
 */
export function licenseChoiceForRoleChange(
  stored: LicenseProduct | null | undefined,
  newRole: unknown,
): readonly LicenseProduct[] | null {
  if (!stored) return null;
  const r = licensedRoleOf(newRole);
  if (!r) return null;
  return licenseFits(stored, r) ? null : LICENSE_FITS[r];
}

/* ---------------------------------------------------------------- the count */

export interface LicenseCounts {
  till: number;
  kiosk: number;
  kiosk_till: number;
  total: number;
}

export interface LicenseCountsAnswer {
  products: LicenseProduct[];
  labels: Record<LicenseProduct, string>;
  tenants: { id: string | null; name: string | null; counts: LicenseCounts }[];
  companies: { id: string | null; name: string | null; tenantId: string | null; counts: LicenseCounts }[];
  shops: { id: string | null; name: string | null; companyId: string | null; tenantId: string | null; counts: LicenseCounts }[];
  unassigned: { tenantId: string | null; counts: LicenseCounts }[];
}

export type LicenseCountRow = {
  key: string;
  level: 'tenant' | 'company' | 'shop' | 'unassigned';
  name: string | null;
  counts: LicenseCounts;
};

/**
 * The table's rows, a tree in reading order: each organization, then its companies, each followed by its
 * shops, then the organization's devices in no shop.
 */
export function licenseCountRows(answer: LicenseCountsAnswer | null | undefined): LicenseCountRow[] {
  if (!answer) return [];
  const rows: LicenseCountRow[] = [];
  for (const tenant of answer.tenants) {
    rows.push({ key: `t:${tenant.id}`, level: 'tenant', name: tenant.name, counts: tenant.counts });
    for (const company of answer.companies.filter((c) => c.tenantId === tenant.id)) {
      rows.push({ key: `c:${company.id}`, level: 'company', name: company.name, counts: company.counts });
      for (const shop of answer.shops.filter((s) => s.companyId === company.id)) {
        rows.push({ key: `s:${shop.id}`, level: 'shop', name: shop.name, counts: shop.counts });
      }
    }
    for (const loose of answer.unassigned.filter((u) => u.tenantId === tenant.id)) {
      rows.push({ key: `u:${loose.tenantId}`, level: 'unassigned', name: null, counts: loose.counts });
    }
  }
  return rows;
}
