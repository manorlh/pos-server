/**
 * "בניית חברת הדגמה" (P:/specs/demo-company.md; pos-server app/routers/demo_company.py) — the shapes
 * the server answers and the rules the dashboard applies to them. No imports: run by `npm test`.
 *
 * The super admin's one click builds a whole LIVE company ("R2M הדגמה": a snack bar and a restaurant
 * with points of sale), and a second click completes only what is missing. The page then shows what
 * was built, a pairing code for every device still to pair, and what to try in each shop.
 */

export type DealerType = 'company' | 'licensed' | 'exempt';

/** The confirmation's form: every field optional (the owner fills or edits them later). */
export interface DemoCompanyForm {
  vatNumber: string;
  dealerType: DealerType | '';
  address: string;
  city: string;
  phone: string;
}

export const EMPTY_DEMO_FORM: DemoCompanyForm = { vatNumber: '', dealerType: '', address: '', city: '', phone: '' };

export type DemoCompanyBuildBody = Partial<{
  vatNumber: string;
  dealerType: DealerType;
  address: string;
  city: string;
  phone: string;
}>;

export type DemoDeviceStatus = 'waiting' | 'paired' | 'expired' | 'none';

export interface DemoDevice {
  key: string;
  label: string;
  role: string;
  roleLabel: string;
  /** Only a live code; null once used or expired. */
  code: string | null;
  expiresAt: string | null;
  status: DemoDeviceStatus;
  machineId: string | null;
  machineName: string | null;
}

export interface DemoShop {
  key: 'snack' | 'restaurant' | string;
  id: string | null;
  name: string;
  present: boolean;
  trainingMode: boolean;
  devices: DemoDevice[];
  checklist: string[];
}

export interface DemoItemRef {
  key: string;
  label: string;
}

export interface DemoFailure extends DemoItemRef {
  message: string;
}

export interface DemoCompanySummary {
  exists: boolean;
  companyName?: string;
  company?: {
    id: string;
    name: string;
    vatNumber: string | null;
    dealerType: DealerType | null;
    address: string | null;
    city: string | null;
    phone: string | null;
  };
  /** "vatNumber" | "address" | "phone" — what an invoice still needs. */
  missingDetails?: string[];
  shops?: DemoShop[];
  itemCount?: number;
  removedByOwner?: DemoItemRef[];
  /** Employees whose code is random (the server has none configured): set theirs on "משתמשי קופה". */
  employeesToSetCode?: string[];
  digitalMenuSlug?: string | null;
  builtAt?: string | null;
  /** Only in the answer of a build. */
  created?: DemoItemRef[];
  failed?: DemoFailure[];
  notes?: string[];
}

/** The body of a build: the fields typed, trimmed — an empty one is not sent (nothing to fill). */
export function buildBody(form: DemoCompanyForm): DemoCompanyBuildBody {
  const out: DemoCompanyBuildBody = {};
  const vat = form.vatNumber.replace(/\s+/g, '');
  if (vat) out.vatNumber = vat;
  if (form.dealerType) out.dealerType = form.dealerType;
  const address = form.address.trim();
  if (address) out.address = address;
  const city = form.city.trim();
  if (city) out.city = city;
  const phone = form.phone.trim();
  if (phone) out.phone = phone;
  return out;
}

/** A ח.פ / עוסק number as typed: digits only, up to 9 (empty is fine — filled later). */
export function vatNumberProblem(value: string): 'digits' | 'length' | null {
  const v = value.replace(/\s+/g, '');
  if (!v) return null;
  if (!/^\d+$/.test(v)) return 'digits';
  if (v.length > 9) return 'length';
  return null;
}

/** A phone as typed: digits, spaces, dashes and a leading "+" (empty is fine). */
export function phoneProblem(value: string): 'invalid' | null {
  const v = value.trim();
  if (!v) return null;
  return /^\+?[\d\s-]{7,20}$/.test(v) && (v.match(/\d/g) ?? []).length >= 7 ? null : 'invalid';
}

/** Whole minutes left on a code (0 once it expired); null without an expiry. */
export function minutesLeft(expiresAt: string | null | undefined, now: Date = new Date()): number | null {
  if (!expiresAt) return null;
  const end = Date.parse(expiresAt);
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - now.getTime()) / 60000));
}

/** The device's state as of `now`: a "waiting" code whose time ran out reads as expired. */
export function deviceState(device: DemoDevice, now: Date = new Date()): DemoDeviceStatus {
  if (device.status === 'waiting' && minutesLeft(device.expiresAt, now) === 0) return 'expired';
  return device.status;
}

/** Devices still to pair (their code to show or to renew), and how many are paired. */
export function pairingProgress(shops: DemoShop[] | undefined, now: Date = new Date()) {
  const devices = (shops ?? []).flatMap((s) => s.devices);
  const paired = devices.filter((d) => d.status === 'paired').length;
  const expired = devices.filter((d) => deviceState(d, now) === 'expired' || d.status === 'none').length;
  return { total: devices.length, paired, toPair: devices.length - paired, expired };
}

/** The code in two halves for reading aloud / typing ("AB12 CD34"). */
export function formatCode(code: string | null | undefined): string {
  if (!code) return '';
  const c = code.trim();
  if (c.length <= 4) return c;
  const half = Math.ceil(c.length / 2);
  return `${c.slice(0, half)} ${c.slice(half)}`;
}
