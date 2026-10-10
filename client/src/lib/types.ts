import type { CardBrandBreakdownRow } from './cardBrands';
import type { DealerType, DealerTypeChange } from './dealerType';
import type { TillDataState } from './zDataState';
import type { AutoReopenMode } from './availabilityReopen';
import { DEVICE_MODEL_IDS } from './deviceProfile';

/**
 * Listed most senior first, matching the server's `ROLE_LEVEL`, so a reader does
 * not have to guess where a role sits relative to its neighbours.
 *
 * `shift_supervisor` (אחמ"ש) is the odd one: it outranks a cashier only at a
 * till, where it may authorise a refund, a discount or the close of the day. It
 * administers nothing from the dashboard, which is why none of the dashboard's
 * role gates grew to include it.
 */
export type UserRole =
  | 'super_admin'
  | 'distributor'
  | 'merchant_admin'
  | 'company_manager'
  | 'shop_manager'
  | 'shift_supervisor'
  | 'cashier'
  // "עמדת מפיק" (feat/event-live): an event's producer — the producer portal only.
  | 'producer_view';

export interface User {
  id: string;
  email: string;
  username: string;
  role: UserRole;
  companyId?: string;
  shopId?: string;
  isActive: boolean;
  /**
   * Whether this person holds a till PIN — the credential that lets them authorise
   * an action at a terminal without signing into the dashboard. Never the PIN or
   * its hash, only whether one exists.
   */
  hasTillPin?: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * What the server will actually let the caller do, as reported by `GET /users/me`.
 *
 * These are not re-derived in the dashboard on purpose: the role→permission rules
 * live in the users router, and a UI that guesses them offers authority the caller
 * does not have and then blames them for the 403.
 */
export interface UserCapabilities {
  /** Exactly the roles this caller may assign, highest first. Empty = none. */
  creatableRoles: UserRole[];
  /** May read the staff list at all. False for a dashboard cashier. */
  canReadUsers: boolean;
  /** May create / edit / deactivate staff. */
  canManageUsers: boolean;
  /** May manage till operators (קופאים). */
  canManagePosUsers: boolean;
  /**
   * What this caller could authorise at a till once they set a PIN. Empty means a
   * PIN would buy them nothing, so the profile page says so instead of offering it.
   */
  tillScopes?: string[];
  /**
   * "הרשאות דשבורד": the sections this user may open (lib/dashboardAccess.ts). The server
   * enforces the same grant on every route; this only decides the menu and the pages.
   */
  dashboardAccess?: import('./dashboardAccess').DashboardAccess;
}

/** `GET /users/me` — the caller's own record plus its capabilities. */
export interface CurrentUser extends User, UserCapabilities {}

/**
 * A permanent customer, or a temporary one (an event, a season) whose tills stop selling
 * after the last day. Set by a super admin only.
 */
export type LicenseType = 'permanent' | 'temporary';

export interface Company {
  id: string;
  name: string;
  /** Company #1, #2 … in its tenant; never reused. Null for a tenantless company. */
  companyNumber?: number | null;
  vatNumber?: string;
  address?: string;
  city?: string;
  /**
   * Parent company, for tenants that nest their legal entities. Nullable on the
   * wire and `undefined` on a server that predates the column, so treat both as
   * "this company is a root" — see `buildCompanyTree`, which never drops a row
   * whose parent it cannot resolve.
   */
  parentCompanyId?: string | null;
  /** "לקוח זמני": the tills stop selling after `licenseExpiresOn`. */
  licenseType?: LicenseType;
  licenseExpiresOn?: string | null;
  /**
   * "סוג עוסק" (docs/SPEC_BUSINESS_TYPE.md). Absent on a server that predates it, which
   * means "company" — see `dealerTypeOf` in lib/dealerType.ts.
   */
  dealerType?: DealerType;
  dealerTypeChangedAt?: string | null;
  dealerTypeChangedBy?: string | null;
  dealerTypeHistory?: DealerTypeChange[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

/** חברה בע״מ (ח.פ.) / עוסק מורשה / עוסק פטור — defined in lib/dealerType.ts. */
export type { DealerType, DealerTypeChange };

// ── Dashboard scope (organization ▸ company ▸ shop ▸ device) ───────────────────

/**
 * How deep the dashboard's shared scope currently points.
 *
 * The tenant is always in scope (it is the `X-Tenant-Id` header); the three
 * deeper levels are the shared selection every page reads instead of carrying its
 * own pickers. Ordered shallow → deep; compare with `SCOPE_LEVEL_ORDER`.
 */
export type ScopeLevel = 'tenant' | 'company' | 'shop' | 'machine';

/** The scope as it lives in the URL query and in localStorage. */
export interface ScopeSelection {
  companyId: string | null;
  shopId: string | null;
  machineId: string | null;
}

/**
 * One company plus its position in the tenant's company tree.
 *
 * `depth` is how far to indent. `parentMissing` marks a company whose
 * `parentCompanyId` points at something the caller cannot see (a parent in
 * another tenant, or one filtered out by role scoping): the row is still shown,
 * as a root, flagged — dropping it would hide a real company.
 */
export interface CompanyTreeNode {
  company: Company;
  depth: number;
  children: CompanyTreeNode[];
  parentMissing: boolean;
}

/** Flat, depth-first render list plus the lookups the UI needs. */
export interface CompanyTree {
  roots: CompanyTreeNode[];
  /** Depth-first order — render this directly for an indented list. */
  flat: CompanyTreeNode[];
  byId: Map<string, CompanyTreeNode>;
  /** False when no company has a parent — the common case; render it flat. */
  nested: boolean;
}

// ── Category ordering ─────────────────────────────────────────────────────────

/** One row of `PUT /categories/reorder`. */
export interface CategoryReorderEntry {
  id: string;
  sortOrder: number;
}

/** `PUT /categories/reorder` → how many rows the server actually moved. */
export interface CategoryReorderResponse {
  updated: number;
}

export interface PairingSessionCreateResponse {
  sessionId: string;
  sessionToken: string;
  expiresAt: string;
  mobileUrl: string;
  sessionExpireHours: number;
}

export interface PairingSessionSummary {
  id: string;
  expiresAt: string;
  machinesPairedCount: number;
  createdAt: string;
}

export interface MobileContextResponse {
  sessionExpiresAt: string;
  sessionExpireHours: number;
  machinesPairedCount: number;
  defaultCompanyId?: string | null;
  defaultShopId?: string | null;
  companies: Array<{ id: string; name: string }>;
  shops: Array<{ id: string; name: string; companyId: string }>;
}

export interface MobileClaimResponse {
  ok: boolean;
  machineId: string;
  machineCode: string;
  companyName: string;
  shopName: string;
  /** The register number the claimed till was given in that shop. */
  posNumber?: string | null;
}

export interface Shop {
  id: string;
  companyId: string;
  name: string;
  /** Shop #1, #2 … in its company; never reused. */
  shopNumber?: number | null;
  /** "קוד סניף": internal, mandatory, digits 1–7, unique in the company (lib/branchCode.ts). */
  branchId?: string;
  address?: string;
  city?: string;
  licenseType?: LicenseType;
  licenseExpiresOn?: string | null;
  /** "מצב הדרכה": the shop's tills sell for practice (docs/SPEC_TRAINING_MODE.md). */
  trainingMode?: boolean;
  trainingStartedAt?: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type OutOfStockPolicy = 'block' | 'warn' | 'allow';
export type TipDistribution = 'direct' | 'equal_pool' | 'by_sales';

/** POS till settings v1 (camelCase keys match server JSONB). */
export interface PosSettingsV1 {
  globalTaxRate?: number;
  hideOutOfStockProducts?: boolean;
  language?: 'he' | 'en';
  nayaxEnabled?: boolean;
  nayaxDeviceHost?: string;
  nayaxDevicePort?: string;
  nayaxSpicyPath?: string;
  /**
   * "סוג אינטגרציית אשראי" (lib/paymentIntegration.ts). Unset = automatic: a till with a
   * terminal of its own charges on Agamento (or Nayax when `nayaxEnabled`), a tablet on
   * an external one. `auto` is never stored.
   */
  paymentIntegration?: 'auto' | 'agamento' | 'nayax_lan' | 'nayax_usb' | 'zcredit' | 'synqpay' | 'tap_to_pay';
  /** `nayax_usb`: the C4's USB ids "VVVV:PPPP" (hex); unset = the first CDC-ACM device on the till. */
  nayaxUsbDevice?: string;
  /** Z-Credit: the terminal number, digits with leading zeros kept. */
  zcreditTerminalNumber?: string;
  /** Z-Credit: the PinPad id, stored without the "PINPAD" prefix. */
  zcreditPinpadId?: string;
  zcreditMode?: 'test' | 'production';
  /** SynqPay (docs/SPEC_SYNQPAY.md): the terminal's model (lib/paymentIntegration.ts SYNQPAY_MODELS). */
  synqpayDeviceModel?: string;
  /** SynqPay (an external terminal): `lan` | `usb`. */
  synqpayConnection?: string;
  synqpayHost?: string;
  /** SynqPay over the network: `tcp` (default) | `http`. */
  synqpayProtocol?: string;
  /** Text, like `nayaxDevicePort`; unset = the protocol's documented port. */
  synqpayPort?: string;
  synqpayTls?: boolean;
  /** USB serial: "" = detect, "VVVV:PPPP" (hex) or "COMn" (Windows). */
  synqpayUsbDevice?: string;
  synqpaySerialNumber?: string;
  /**
   * "מכשירי תשלום" (lib/paymentDevices.ts): a till without built-in clearing works with several
   * payment devices of its shop. Unset = inherit (off when no level sets it).
   */
  multiPaymentDevices?: boolean;
  /**
   * How a till picks its device (shop = the default for its tills, area, till): "fixed" — always
   * `fixedPaymentDeviceId`; "group" — the cashier picks from `paymentDeviceGroup` (empty = every
   * device of the shop). Unset everywhere = a group of every device.
   */
  paymentDeviceMode?: 'fixed' | 'group';
  fixedPaymentDeviceId?: string;
  paymentDeviceGroup?: string[];
  outOfStockPolicy?: OutOfStockPolicy;
  /**
   * "פתיחת פריטים אוטומטית אחרי Z" (lib/availabilityReopen.ts, pos-server
   * docs/SPEC_AVAILABILITY.md): unset = off. And whether it reopens an item that tracks
   * stock and has none (unset = no).
   */
  autoReopenAfterZ?: AutoReopenMode;
  autoReopenIgnoreStock?: boolean;
  /**
   * Legacy tip switches. The server still reads them as the fallback for the
   * per-option `pay*Tips` keys below, so they stay in the type, but the
   * dashboard no longer writes them.
   */
  tipsEnabled?: boolean;
  cashTipsEnabled?: boolean;
  // Which payment buttons the till shows, and whether each asks for a tip.
  // What each option is lives in lib/paymentOptions.ts.
  payFastCashEnabled?: boolean;
  payFastCashTips?: boolean;
  payCashEnabled?: boolean;
  payCashTips?: boolean;
  payFastCardEnabled?: boolean;
  payFastCardTips?: boolean;
  payCardEnabled?: boolean;
  payCardTips?: boolean;
  payManualCardEnabled?: boolean;
  payManualCardTips?: boolean;
  /**
   * The most instalments the `card` option's picker offers, 2–36. Unset = the card
   * terminal decides.
   */
  payInstallmentsMax?: number;
  /**
   * "סדר אמצעי התשלום": the payment methods' ids in the order the till lists them (see
   * lib/payOrder.ts). Unset = the default order. In `effective` the server sends it
   * completed (every method); a layer's own list is as it was saved.
   */
  payOrder?: string[];
  // Optional tools on the till's sell screen. Unset = shown; see lib/sellScreen.ts.
  sellSearchEnabled?: boolean;
  sellScanEnabled?: boolean;
  sellCalculatorEnabled?: boolean;
  // The till's return flow. Unset = on; see lib/refundSettings.ts.
  unlinkedCardCreditEnabled?: boolean;
  refundCustomerDetailsRequired?: boolean;
  tipPresets?: number[];
  tipDistribution?: TipDistribution;
  /** The question on the customer's tip screen; '' / unset = the till's default wording. */
  tipPromptText?: string;
  receiptPrinterName?: string;
  drawerPrinterName?: string;
  businessInfo?: Record<string, unknown>;
  /** White label: logo the till shows in its own UI. '' = deliberately no logo. */
  brandLogoUrl?: string;
  /** White label: full-screen image the till shows for ~2s while it starts up. */
  brandHeroUrl?: string;
  /** White label: the till's main colour, "#RRGGBB"; its whole palette derives from it. '' = the till's default. */
  brandPrimaryColor?: string;
  /** White label: printed at the head of the till's receipts. '' = deliberately none. */
  brandReceiptLogoUrl?: string;
  /**
   * The card terminal number (מספר מסוף) a till must be connected to: on a shop, one
   * number for all its tills; on a till, its own. The till refuses to work on a mismatch.
   */
  expectedTerminalNumber?: string;
  /**
   * Which clearing server the till's Agamento uses. The till switches it on sync.
   * '' = leave the terminal as it is.
   */
  clearingServer?: '' | 'SHVA' | 'PELECARD';
  /**
   * While true, a till whose Agamento reports another number writes the expected one
   * into Agamento on its next sync (only while idle, with nothing waiting to transmit).
   */
  forceTerminalNumber?: boolean;
  /**
   * "חזרה אוטומטית לקיוסק" (R2M POS for Windows, lib/desktopIdleReturn.ts): back in full screen
   * after this many idle minutes on the desktop; 0 = never; unset = 10.
   */
  desktopIdleReturnMinutes?: number;
  /**
   * Tenant level only: how Z reports are produced. `shop` (default) = one Z per shop
   * over all its tills; `machine` = one till per Z. Not sent to tills.
   */
  zScope?: 'shop' | 'machine';
}

export type PaymentOptionSettingKey =
  | 'payFastCashEnabled'
  | 'payFastCashTips'
  | 'payCashEnabled'
  | 'payCashTips'
  | 'payFastCardEnabled'
  | 'payFastCardTips'
  | 'payCardEnabled'
  | 'payCardTips'
  | 'payManualCardEnabled'
  | 'payManualCardTips';

export type SellScreenSettingKey =
  | 'sellSearchEnabled'
  | 'sellScanEnabled'
  | 'sellCalculatorEnabled';

export type RefundSettingKey = 'unlinkedCardCreditEnabled' | 'refundCustomerDetailsRequired';

/** Switch keys whose PATCH accepts `null` (= unset this layer, inherit again). */
export type ResettableSwitchKey = PaymentOptionSettingKey | SellScreenSettingKey | RefundSettingKey;

/**
 * PATCH body for POS settings. Branding keys accept an explicit `null`, which
 * unsets them at that level so the level above is inherited again — distinct
 * from `''`, which is stored and means "deliberately no image here".
 *
 * The payment-option and sell-screen keys take `null` for the same reason: a
 * switch has no empty state, so without it a layer that once overrode a key could
 * never go back to inheriting it.
 */
export type PosSettingsPatch = Partial<
  Omit<
    PosSettingsV1,
    | 'brandLogoUrl'
    | 'brandHeroUrl'
    | 'brandPrimaryColor'
    | 'brandReceiptLogoUrl'
    | 'expectedTerminalNumber'
    | 'clearingServer'
    | 'forceTerminalNumber'
    | 'tipPresets'
    | 'tipDistribution'
    | 'tipPromptText'
    | 'payInstallmentsMax'
    | 'payOrder'
    | 'desktopIdleReturnMinutes'
    | 'autoReopenAfterZ'
    | 'autoReopenIgnoreStock'
    | 'multiPaymentDevices'
    | 'paymentDeviceMode'
    | 'fixedPaymentDeviceId'
    | 'paymentDeviceGroup'
    | ResettableSwitchKey
    | PaymentIntegrationSettingKey
  >
> & {
  /** "מכשירי תשלום": `null` = inherit the switch / the device choice from the level above again. */
  multiPaymentDevices?: boolean | null;
  paymentDeviceMode?: 'fixed' | 'group' | null;
  fixedPaymentDeviceId?: string | null;
  paymentDeviceGroup?: string[] | null;
  /** `null` = inherit "פתיחת פריטים אוטומטית אחרי Z" from the level above again. */
  autoReopenAfterZ?: AutoReopenMode | null;
  autoReopenIgnoreStock?: boolean | null;
  /** `null` = unset this layer's payment order and inherit the level above's again. */
  payOrder?: string[] | null;
  brandLogoUrl?: string | null;
  brandHeroUrl?: string | null;
  brandPrimaryColor?: string | null;
  brandReceiptLogoUrl?: string | null;
  /** `null` = this layer sets none and inherits again (a till rejoins its shop's number). */
  expectedTerminalNumber?: string | null;
  /** `null` = inherit the level above's server again. */
  clearingServer?: '' | 'SHVA' | 'PELECARD' | null;
  /** `null` = inherit whether to force the number from the level above again. */
  forceTerminalNumber?: boolean | null;
  /** `null` = unset this layer's percentages and inherit the level above's again. */
  tipPresets?: number[] | null;
  tipDistribution?: TipDistribution | null;
  /** `null` = inherit the level above's tip question again. */
  tipPromptText?: string | null;
  /** `null` = unset this layer's most instalments and inherit the level above's again. */
  payInstallmentsMax?: number | null;
  /** `null` = inherit "חזרה אוטומטית לקיוסק" (Windows) from the level above again. */
  desktopIdleReturnMinutes?: number | null;
  // "סוג אינטגרציית אשראי": `null` = inherit the level above's again (`auto` too, for the type).
  paymentIntegration?: PosSettingsV1['paymentIntegration'] | null;
  nayaxUsbDevice?: string | null;
  zcreditTerminalNumber?: string | null;
  zcreditPinpadId?: string | null;
  zcreditMode?: 'test' | 'production' | null;
  synqpayDeviceModel?: string | null;
  synqpayConnection?: string | null;
  synqpayHost?: string | null;
  synqpayProtocol?: string | null;
  synqpayPort?: string | null;
  synqpayTls?: boolean | null;
  synqpayUsbDevice?: string | null;
  synqpaySerialNumber?: string | null;
  nayaxEnabled?: boolean | null;
  nayaxDeviceHost?: string | null;
  nayaxDevicePort?: string | null;
  nayaxSpicyPath?: string | null;
  /**
   * Write-only Z-Credit secrets: never returned by a GET. A string sets this layer's,
   * `null` removes it, absent leaves it as it is. Never send the "••••" mask or ''.
   */
  zcreditPassword?: string | null;
  zcreditKey?: string | null;
  /** The SynqPay API key: write-only, as the Z-Credit password. */
  synqpayApiKey?: string | null;
} & {
  [K in ResettableSwitchKey]?: boolean | null;
};

/** Settings keys of the payment integration whose PATCH takes `null` (= inherit again). */
export type PaymentIntegrationSettingKey =
  | 'paymentIntegration'
  | 'nayaxUsbDevice'
  | 'zcreditTerminalNumber'
  | 'zcreditPinpadId'
  | 'zcreditMode'
  | 'synqpayDeviceModel'
  | 'synqpayConnection'
  | 'synqpayHost'
  | 'synqpayProtocol'
  | 'synqpayPort'
  | 'synqpayTls'
  | 'synqpayUsbDevice'
  | 'synqpaySerialNumber'
  | 'nayaxEnabled'
  | 'nayaxDeviceHost'
  | 'nayaxDevicePort'
  | 'nayaxSpicyPath';

/** The most tip percentages a layer may offer: the till lays them out as square buttons. */
export const TIP_PRESETS_MAX = 6;
/** `receipt` is printed at the head of the till's receipts. */
export type BrandingImageKind = 'logo' | 'hero' | 'receipt';

export interface BrandingUploadResult {
  url: string;
  publicId: string;
  width: number;
  height: number;
  bytes: number;
}

export interface EntitySettingsResponse {
  settings: PosSettingsV1;
  settingsUpdatedAt: string;
}

/** A level of the settings hierarchy, least specific first. */
export type SettingsLevel = 'tenant' | 'company' | 'shop' | 'area' | 'machine';

/**
 * With `effective`: per key, the level above that set the inherited value. A key no
 * level above sets is absent — its value is the option's default.
 */
export type EffectiveSources = Partial<Record<string, SettingsLevel>>;

export interface ShopSettingsResponse extends EntitySettingsResponse {
  effective?: PosSettingsV1;
  effectiveSources?: EffectiveSources | null;
}

/** A till's own layer: never written yet means no `settingsUpdatedAt`. */
export interface MachineSettingsResponse {
  settings: PosSettingsV1;
  settingsUpdatedAt: string | null;
  effective?: PosSettingsV1;
  effectiveSources?: EffectiveSources | null;
}

/** A point of sale's (shop area's) own layer, between its shop and its tills. */
export type AreaSettingsResponse = MachineSettingsResponse;

/** Global product row with optional shop override (GET /shops/{id}/product-overrides). */
export interface ShopProductCatalogRow {
  globalProductId: string;
  name: string;
  sku: string;
  categoryId: string;
  globalPrice: number;
  overridePrice?: number | null;
  isListed: boolean;
  /** This shop's own availability level: null = not set (inherits the company, then the product). */
  isAvailable: boolean | null;
  /** What the shop would get if it set nothing — resolved on the server. */
  inheritedAvailable: boolean;
  /** What this shop's tills get when the till itself sets nothing — resolved on the server. */
  effectiveAvailable: boolean;
  /** Its place on the shop's tills ("סידור פריטים", 1 = first); null — not placed, by name. */
  tillPosition?: number | null;
  /** The company's built-in general item: it cannot be hidden in or removed from a shop. */
  isGeneral?: boolean;
}

/** Global product not yet in shop assortment (GET .../product-catalog-candidates). */
export interface ShopProductCatalogCandidate {
  globalProductId: string;
  name: string;
  sku: string;
  categoryId: string;
  globalPrice: number;
}

/**
 * "דגם מכשיר" — the hardware a till is (pos-server docs/SPEC_DEVICE_ROLE_MODEL.md): a Feitian
 * F20 / Nova 55F (built-in printer and terminal), a Modo (terminal, no printer), a Kozen
 * Nebullar P18 tablet, a LANDI and a Feitian tablet (no printer / drawer driver yet), or a
 * plain Android tablet — and every SUNMI (docs/SPEC_SUNMI.md). Capabilities:
 * lib/deviceProfile.ts. A P18, a LANDI and a SUNMI are recognised by themselves when they pair.
 */
export const DEVICE_MODELS = DEVICE_MODEL_IDS;
export type DeviceModel = (typeof DEVICE_MODELS)[number];

/** Who set "עקיפת בדיקת מספר מסוף" for the level a till takes it from, and when (lib/terminalCheckBypass.ts). */
export interface TerminalCheckBypassChange {
  userEmail: string | null;
  userRole: string | null;
  scopeType: string | null;
  at: string | null;
}

export interface PosMachine {
  id: string;
  name: string;
  machineCode: string;
  tenantId?: string;
  shopId?: string;
  /**
   * Register number in its shop ("קופה 2"), allocated by the server from the shop's own
   * run and never reused. Text on the wire because documents copy it verbatim; always a
   * plain integer when set. Null when the machine has no shop. Read it through
   * `registerNumberOf`, which never yields 0.
   */
  posNumber?: string | null;
  /**
   * "קידומת מסמכים" (docs/SPEC_DOCUMENT_PREFIX.md): the till's own prefix (null = the
   * default, its register number), and the one its documents are issued under now.
   */
  documentPrefix?: string | null;
  effectiveDocumentPrefix?: string | null;
  /**
   * The area of its shop the till is in now (bar, terrace …), or null when unassigned.
   * Current membership only — history (shifts, Zs, reports) carries its own stamp.
   */
  areaId?: string | null;
  areaName?: string | null;
  pairingStatus: 'unpaired' | 'paired' | 'assigned';
  /** Its shop's number in its company, and that company's in the tenant; null without a shop. */
  shopNumber?: number | null;
  companyNumber?: number | null;
  /** "N55F" | "MODO" | "P18"; null when never recorded, which reads as a 55F. */
  deviceModel?: DeviceModel | null;
  /** False for a Modo only. Absent on a server that predates it. */
  hasPrinter?: boolean;
  /**
   * False for a till with no card terminal of its own (a P18): it charges on a Nayax
   * pinpad on the network. Absent on a server that predates it.
   */
  hasBuiltinTerminal?: boolean;
  /**
   * "סוג מכשיר (תפקיד)": `till`, `kiosk` (a self-order kiosk), `kds` (a kitchen screen) or
   * `order_status_board` (the "מוכן / לא מוכן" board). Null where the server did not compute
   * it. `kioskEnabled` false: a kiosk switched off, working as a till.
   */
  deviceRole?: 'till' | 'kiosk' | 'kds' | 'order_status_board' | null;
  kioskEnabled?: boolean | null;
  /**
   * False for a display device (a KDS / the board): not a till, not an accounting system —
   * no sales, shifts, Z, payments or register number. Absent on an older server: a till.
   */
  fiscal?: boolean;
  /** "android" | "windows" | "web" (the browser kiosk, docs/SPEC_KIOSK.md §27) — what the device runs. */
  platform?: 'android' | 'windows' | 'web' | null;
  /**
   * Its KDS screen, or null. On a fiscal till: a screen paired on the KDS page before
   * display devices existed (flagged "מסך מטבח על קופה").
   */
  kdsScreen?: { role: 'station' | 'expo' | 'pickup' | 'manager'; name: string; isActive: boolean; shopId: string | null } | null;
  /** The model chosen on the dashboard, and the one the device named itself at pairing. */
  deviceModelChosen?: DeviceModel | null;
  deviceModelReported?: DeviceModel | null;
  /** A drawer port the till drives itself (no model today). */
  hasCashDrawerPort?: boolean;
  /** LANDI / Feitian tablet: built-in printer / drawer support "בקרוב". */
  deviceDriverPending?: boolean;
  /** "לקוח זמני" on this till alone; the till keeps the earliest end above it too. */
  licenseType?: LicenseType;
  licenseExpiresOn?: string | null;
  mqttClientId?: string;
  deviceInfo?: Record<string, unknown>;
  isActive: boolean;
  lastHeartbeatAt?: string;
  mqttConnected?: boolean | null;
  lastSyncAt?: string;
  lastCatalogChangeAt?: string;
  catalogPullStale?: boolean;
  /** `open` when the cloud holds an open shift for this till, else `none`. */
  shiftStatus?: 'open' | 'none';
  openShiftId?: string;
  /** The open shift's per-till number ("משמרת #N"); null if none open or unnumbered. */
  openShiftSequence?: number | null;
  /** The open shift's business date (the till's local date it opened). */
  businessDate?: string;
  openedAt?: string;
  /** Display name of whoever opened the shift. */
  openedBy?: string;
  /** A Z run or a remote close has asked this till to close its shift and waits for it. */
  closeShiftPending?: boolean;
  /**
   * Which of the two is waiting: `z_run` (close it through that run, not a second
   * request) or `request` (a standalone remote close). Null when none is, or from a
   * server that does not say.
   */
  pendingCloseSource?: 'z_run' | 'request' | null;
  /** The Z run waiting for this till's close, when `pendingCloseSource` is `z_run`. */
  pendingZRunId?: string | null;
  /** Closed shifts of this till that no Z has taken yet. */
  closedShiftsAwaitingZ?: number | null;
  /** Documents of this till that named no shift. No Z takes them. */
  orphanDocuments?: number | null;
  /** The shift the till says it has open (heartbeat); the cloud may not have seen it yet. */
  reportedOpenShiftId?: string | null;
  /**
   * The terminal's resolved status, decided server-side.
   *
   * A single value with strict precedence, not a set of independent lights — see
   * `app/services/machine_status.py`. The dashboard renders it; it must not re-derive
   * it, because the Z wizard reads the same definition and the two drifting apart is
   * how a manager is told a till is reachable when it is not.
   */
  status?:
    | 'not_paired'
    | 'retired'
    | 'offline_with_unsynced'
    | 'no_open_shift'
    | 'offline'
    | 'pending_sync'
    | 'shift_close_pending'
    | 'online';
  online?: boolean;
  /** Secondary conditions. Shown beside the status, never instead of it. */
  statusFlags?: Array<
    | 'shift_open_past_its_date'
    | 'closed_shifts_awaiting_z'
    | 'catalog_behind'
    | 'clock_skewed'
    | 'low_battery'
    | 'realtime_down'
    | 'transmission_overdue'
    | 'transmission_critical'
    | 'printer_problem'
  >;
  /** Undelivered sales as last reported. Null means never reported, which is not zero. */
  pendingDocuments?: number | null;
  /** When that reading was taken — the UI must say "as of", not present it as live. */
  pendingAsOf?: string | null;
  /** Hardware serial the till reports on its heartbeat (or at pairing). */
  serialNumber?: string | null;
  /**
   * 0..100, or `null` when the device could not read the battery at all.
   * `null` is NOT zero — render it as unknown, never as a flat battery.
   */
  batteryPercent?: number | null;
  batteryStatus?: 'charging' | 'discharging' | 'full' | 'not_charging' | 'unknown' | null;
  /** Signed. Negative = the device clock is BEHIND the server. Can be huge. */
  clockSkewMs?: number | null;
  /** Null on a till that has never sent a health report. */
  lastHealthReportAt?: string | null;
  // ── Card transmission to Shva (docs/SHIFTS_API.md §4.6) ────────────────────
  /** The till's reading if it sent one, else our records. Null = never reported. */
  pendingTransmissionCount?: number | null;
  /** Decimal string, same source as the count. */
  pendingTransmissionAmount?: string | null;
  /** The oldest card sale waiting to be transmitted. */
  oldestPendingTransmissionAt?: string | null;
  lastTransmissionAt?: string | null;
  /** The latest attempt's error, if it failed; null otherwise. */
  lastTransmissionError?: string | null;
  /** When the till last reported its transmission state — "as of", never live. */
  transmissionReportedAt?: string | null;
  transmissionSource?: string | null;
  /** Card sales the till assumes a successful batch carried (not named by uid). Not verified, not a flag. */
  assumedTransmissionCount?: number | null;
  /** Our records: card sales after the tracking start in no successful batch. */
  untransmittedCardLegs?: number | null;
  untransmittedCardAmount?: string | null;
  /** Null = this till never reported transmissions (older build). */
  transmissionTrackingStartedAt?: string | null;
  transmitPending?: boolean;
  pendingTransmitRequestId?: string | null;
  // ── The built-in printer, from the heartbeat (docs/SHIFTS_API.md §1.6a) ────
  /** Null = the till never reported its printer (older build) — not "fine". */
  printerStatus?: PrinterStatus | null;
  /** The vendor's code: 115 no paper, 116 overheated, 120 error, 132/133 black mark. */
  printerErrorCode?: number | null;
  printerMessage?: string | null;
  /** When the till observed it (the till's clock) — "as of", never live. */
  printerStatusAt?: string | null;
  printerLastOkAt?: string | null;
  /** When the cloud received it. */
  printerReportedAt?: string | null;
  // ── The card terminal (Agamento), from the heartbeat ───────────────────────
  /** What Agamento reports. Null with a null `terminalReportedAt` = never reported. */
  terminalNumber?: string | null;
  terminalClearingServer?: 'SHVA' | 'PELECARD' | string | null;
  terminalOfflineMode?: boolean | null;
  /** When the cloud received the reading — "as of", never live. */
  terminalReportedAt?: string | null;
  /** The till's last write into Agamento (a forced number, or the clearing server). */
  terminalLastWrite?: TerminalLastWrite | null;
  /** The business name and supplier number (מספר ספק) the terminal is set up under. */
  terminalMerchantName?: string | null;
  terminalSupplierNumber?: string | null;
  /** The till's effective `expectedTerminalNumber`; null = no level requires one. */
  expectedTerminalNumber?: string | null;
  forceTerminalNumber?: boolean;
  /** The level `forceTerminalNumber` comes from; null = no level sets it (off). */
  forceTerminalNumberSource?: SettingsLevel | null;
  /** Server-resolved, ignoring leading zeros as the till does. */
  terminalStatus?: TerminalStatus;
  /** The level `expectedTerminalNumber` comes from; null = none sets it. */
  expectedTerminalNumberSource?: string | null;
  /**
   * The till's card lock on its last report (docs/SPEC_KIOSK.md §20): a network pinpad needs
   * the expected number on the till itself and a matching report; null = not locked.
   */
  cardLock?: 'mismatch' | 'not_configured' | 'unknown' | null;
  /**
   * "עקיפת בדיקת מספר מסוף" (docs/SPEC_KIOSK.md §20.1): the till parameter is on for this till
   * (then `cardLock` is null), the level it comes from, who set that level and when, what the
   * till itself last reported it applies (null: never said), and the lock it lifts now.
   */
  terminalNumberCheckBypass?: boolean;
  terminalNumberCheckBypassSource?: string | null;
  terminalNumberCheckBypassChange?: TerminalCheckBypassChange | null;
  terminalNumberCheckBypassReported?: boolean | null;
  cardLockBypassed?: 'mismatch' | 'not_configured' | 'unknown' | null;
  /** The merged `nayaxEnabled`: the till charges on a Nayax pinpad on the network. */
  pinpadEnabled?: boolean;
  /** The merged pinpad address (`nayaxDeviceHost`, `nayaxDevicePort`); null = not set. */
  pinpadHost?: string | null;
  pinpadPort?: string | null;
  /** The till charges on a network pinpad: no terminal of its own, or `pinpadEnabled`. */
  pinpadRequired?: boolean;
  /** It does, and no level gives it an address: "נדרשת כתובת IP למסופון". */
  pinpadAddressMissing?: boolean;
  /** "סוג אינטגרציית אשראי" the till charges on; null on an older server. */
  paymentIntegration?: 'agamento' | 'nayax_lan' | 'nayax_usb' | 'zcredit' | 'synqpay' | null;
  /** The level that chose it; null = automatic (hardware / `nayaxEnabled`). */
  paymentIntegrationSource?: SettingsLevel | null;
  paymentIntegrationAutomatic?: boolean | null;
  /** Fields it still needs ("zcreditTerminalNumber", "nayaxDeviceHost", …); [] = none. */
  paymentIntegrationMissing?: string[];
  /**
   * Who produces this till's Z (docs/SHIFTS_API.md §5.1): the cloud, as part of the
   * shop's Z (`cloud`, the default), or the till itself, numbered per till (`till`).
   */
  zMode?: ZMode;
  /**
   * Zs the till closed with no connection and has not uploaded, as it last said (null:
   * never said), and whether one is held in a conflict for support
   * (docs/SPEC_OFFLINE_TILL_Z.md §4.4–4.5).
   */
  offlineTillZPending?: number | null;
  offlineTillZConflict?: boolean;
  /** Support produced this till's Z from the cloud (§4.6): who, when, why, the Z; null otherwise. */
  supportZ?: Record<string, unknown> | null;
  /** The last reset of the till's data support ordered from the cloud (§4.7); null otherwise. */
  tillReset?: Record<string, unknown> | null;
  /** "הוחלפה קופה": every replacement of the till's device, oldest first (§4.6.2). */
  replacements?: TillReplacement[] | null;
  /**
   * "קופה עצמאית" (always zMode `till`): its own Z, never part of the shop Z, and never
   * leaning on the shop's main till. Absent on a server that predates it.
   */
  independentTill?: boolean;
  createdAt: string;
  updatedAt: string;
}

export type TerminalStatus = 'match' | 'mismatch' | 'unknown' | 'not_required';

export interface TerminalLastWrite {
  field: 'terminalNumber' | 'clearingServer' | string | null;
  value: string | null;
  ok: boolean | null;
  error: string | null;
  at: string | null;
}

/** `POST /machines/terminal-number/force`. */
export interface TerminalNumberForceRequest {
  level: Exclude<SettingsLevel, 'tenant'>;
  targetId: string;
  /** Also set `expectedTerminalNumber` at that level. */
  terminalNumber?: string;
  force: boolean;
}

/** One till the force reached, with its status as of the answer. */
export type TerminalForceMachine = Pick<
  PosMachine,
  | 'id'
  | 'name'
  | 'shopId'
  | 'areaName'
  | 'posNumber'
  | 'terminalNumber'
  | 'terminalClearingServer'
  | 'terminalOfflineMode'
  | 'terminalReportedAt'
  | 'terminalLastWrite'
  | 'terminalMerchantName'
  | 'terminalSupplierNumber'
  | 'expectedTerminalNumber'
  | 'forceTerminalNumber'
  | 'forceTerminalNumberSource'
  | 'terminalStatus'
>;

export interface TerminalNumberForceResponse {
  level: TerminalNumberForceRequest['level'];
  targetId: string;
  forceTerminalNumber: boolean;
  expectedTerminalNumber: string | null;
  machines: TerminalForceMachine[];
}
/** `cloud` = the shop's Z, built in the cloud; `till` = the till produces its own Z. */
export type ZMode = 'cloud' | 'till';

export type PrinterStatus = 'ok' | 'no_paper' | 'overheated' | 'error' | 'unavailable' | 'unknown';

export type TransmissionTrigger = 'shift_close' | 'daily' | 'manual' | 'remote';
export type TransmissionStatus = 'success' | 'failed' | 'unknown';

/** One `doPeriodic` attempt of a till (docs/SHIFTS_API.md §4.7). */
export interface CardTransmission {
  id: string;
  machineId: string;
  trigger: TransmissionTrigger;
  requestId?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  receivedAt?: string | null;
  status: TransmissionStatus;
  statusCode?: number | null;
  statusMessage?: string | null;
  batchNumber?: string | null;
  transactionCount?: number | null;
  amount?: string | null;
  error?: string | null;
  terminalTransactionCount: number;
  legsMatched: number;
  /** Detail only. */
  terminalTransactionIds?: string[];
  reportText?: string | null;
}

export interface CardTransmissionList {
  total: number;
  items: CardTransmission[];
}

/** A card sale in no successful batch, from our records (§4.8). */
export interface UntransmittedCardSale {
  transactionId: string;
  transactionNumber: string;
  /**
   * The number as its till printed it: `<prefix>-<number>` ("קידומת מסמכים",
   * docs/SPEC_DOCUMENT_PREFIX.md). Show this; `transactionNumber` is the bare counter.
   */
  documentNumber?: string | null;
  documentType?: number | null;
  createdAt: string;
  shiftId?: string | null;
  legId: string;
  amount: string;
  approvalNumber?: string | null;
  terminalTransactionId?: string | null;
  cardLast4?: string | null;
  creditPayments?: number | null;
}

export interface UntransmittedCardSales {
  machineId: string;
  trackingStartedAt?: string | null;
  count: number;
  amount: string;
  tillPendingCount?: number | null;
  tillReportedAt?: string | null;
  items: UntransmittedCardSale[];
}

export type TransmitRequestStatus =
  | 'waiting'
  | 'transmitting'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** "Transmit now" (`POST /machines/{id}/transmit`, §4.10). */
export interface TransmitRequest {
  id: string;
  machineId: string;
  machineName?: string | null;
  shopId?: string | null;
  status: TransmitRequestStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  online?: boolean | null;
  transmissionId?: string | null;
  transmission?: CardTransmission | null;
}

export type CatalogLevel = 'global' | 'local';

/** Item-ticket ("שובר פריט") print mode — see server app/services/item_ticket.py. */
export type TicketMode = 'off' | 'per_unit' | 'per_line' | 'per_sale';

export interface Category {
  id: string;
  companyId?: string;
  shopId?: string;
  catalogLevel: CatalogLevel;
  name: string;
  description?: string;
  color?: string;
  imageUrl?: string;
  parentId?: string;
  voucherId?: string;
  /** Null/absent is "off". */
  ticketMode?: TicketMode | null;
  /**
   * "מחייב אישור מנהל במכירה" (lib/restrictedItems.ts): every product here and beneath it needs a
   * manager's code at the till and is not shown at a kiosk. The category's own flag.
   */
  requiresManagerApproval?: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  /** Shops, areas and tills that switched it off (set from the till). List only. */
  inactiveAt?: CategoryInactiveAt[];
}

export interface CategoryInactiveAt {
  level: 'shop' | 'area' | 'machine';
  targetId: string;
  name?: string | null;
}

export interface Product {
  id: string;
  companyId?: string;
  shopId?: string;
  categoryId: string;
  catalogLevel: CatalogLevel;
  isLocalOverride: boolean;
  name: string;
  description?: string;
  price: number;
  sku: string;
  globalSku?: string;
  skuAutoAssigned?: boolean;
  imageUrl?: string;
  inStock: boolean;
  /** Global row: informational only; shop POS uses assortment `isAvailable` on overrides. */
  isAvailable?: boolean;
  stockQuantity: number;
  barcode?: string;
  taxRate?: number;
  voucherId?: string;
  /** The product's own mode; null/absent inherits its category's. */
  ticketMode?: TicketMode | null;
  /** An entry ticket: entries per unit (> 1 prints that many tickets per unit). Null/1 = ordinary. */
  ticketEntries?: number | null;
  trackStock?: boolean;
  /** "לא מקבל הנחות": no line, basket or promotion discount at the till. */
  noDiscount?: boolean;
  /**
   * "מחייב אישור מנהל במכירה" (lib/restrictedItems.ts): the product's own flag — its category
   * (or one above it) may restrict it too.
   */
  requiresManagerApproval?: boolean;
  /**
   * "היכן הפריט נמכר" (lib/productChannel.ts): all (קופות וקיוסק, the default) /
   * kiosk_only (the tills hide it) / pos_only (the kiosk hides it).
   */
  salesChannel?: import('./productChannel').SalesChannel;
  /**
   * "סימוני תזונה" (lib/productDietary.ts): vegan / vegetarian / dairy / meat / gluten_free /
   * spicy, in that order; [] when none. Shown in the kiosk and, by a till parameter, on the till.
   */
  dietaryTags?: string[];
  /**
   * The company's built-in general item ("פריט כללי"), which the till's calculator
   * sells through. Every company has exactly one; it cannot be deleted, and whether it
   * is open price, its VAT and where it is sold are fixed by the server.
   */
  isGeneral?: boolean;
  /**
   * Where a global product is sold. `null` for a product managed by hand from the
   * assortment page (every product created before this existed). For `shops` mode the
   * list itself comes from `GET /products/{id}/shops`.
   */
  shopScope?: ShopScope | null;
  /** "הודעות לעובד": shown on the till when the product is added (lib/productExtras.ts). */
  alerts?: import('./productExtras').ProductAlert[];
  /** "הצג אזהרת אלרגנים": one more alert, from the product's allergens. */
  allergenAlert?: boolean;
  allergenAlertRequireAck?: boolean;
  /** "פריטים נלווים": added by the till with the product, as lines of their own. */
  companions?: import('./productExtras').ProductCompanion[];
  createdAt: string;
  updatedAt: string;
}

export type ShopScopeMode = 'company' | 'shops';

export interface ShopScope {
  mode: ShopScopeMode;
  companyId?: string | null;
  includeSubcompanies?: boolean;
}

/** Body of `shopScope` on product create/update. */
export type ShopScopeInput =
  | { mode: 'company'; companyId: string; includeSubcompanies: boolean }
  | { mode: 'shops'; shopIds: string[] };

/** Body of `shopPrices` on product create/update. `price: null` = the base price. */
export interface ShopPriceInput {
  shopId: string;
  price: number | null;
}

/** One row of `GET /products/{id}/shops`. */
export interface ProductShopRow {
  shopId: string;
  shopName: string;
  companyId: string;
  companyName?: string | null;
  /** The shop's own price, or null when it sells at the base price. */
  price: number | null;
  effectivePrice: number;
  isListed: boolean;
  assignedByRule: boolean;
}

/**
 * Where a product may be sold — `GET /products/{id}/availability`.
 *
 * Every value here is resolved on the server (app/services/product_availability.py):
 * `value` is the level's own setting (null = not set), `inherited` what it would get
 * without one, `effective` what it gets, and `source` the level that decided it.
 */
export type AvailabilityLevel = 'product' | 'company' | 'shop' | 'area' | 'machine';

export interface AvailabilityNode {
  value: boolean | null;
  inherited: boolean;
  effective: boolean;
  source: AvailabilityLevel;
  canEdit: boolean;
  /**
   * "חסימה קבועה" on this level's own lock (only while `value` is false, never on the
   * company level): "פתיחת פריטים אוטומטית אחרי Z" never opens it. And when the lock began.
   */
  permanent?: boolean;
  blockedAt?: string | null;
}

export interface MachineAvailability extends AvailabilityNode {
  machineId: string;
  name: string;
  posNumber?: string | null;
  /** The till's own catalog: its whole shop's, or a whitelist. */
  catalogMode?: MachineCatalogMode;
  /** False when the till's own list leaves this product out: not shown there at all. */
  inCatalog?: boolean;
  /** The area (point of sale) the till stands in, which it inherits from; null = none. */
  areaId?: string | null;
}

/** An area of the shop: a level between the shop and its tills. */
export interface AreaAvailability extends AvailabilityNode {
  areaId: string;
  name: string;
}

// ── A till's own catalog (server: app/services/machine_catalog.py) ─────────────

export type MachineCatalogMode = 'all' | 'selected';

export interface MachineCatalogProduct {
  productId: string;
  name: string;
  sku?: string | null;
  barcode?: string | null;
  price: number;
  categoryId?: string | null;
  categoryName?: string | null;
  imageUrl?: string | null;
  /** On this till's list. Kept in "all" mode too, so switching back restores it. */
  included: boolean;
  /** Delisted from the shop: on none of its tills, whatever the list says. */
  shopListed: boolean;
  /** Availability at this till; false shows locked. */
  available: boolean;
  /** Shown on the till right now, with the mode and the listing applied. */
  onTill: boolean;
}

export interface MachineCatalogCategory {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MachineCatalog {
  machineId: string;
  machineName: string;
  posNumber?: string | null;
  shopId: string;
  shopName: string;
  mode: MachineCatalogMode;
  modeUpdatedAt?: string | null;
  canEdit: boolean;
  selectedCount: number;
  totalCount: number;
  products: MachineCatalogProduct[];
  categories: MachineCatalogCategory[];
}

export interface ShopAvailability extends AvailabilityNode {
  shopId: string;
  shopName: string;
  isListed: boolean;
  /** The shop's live areas; each till in `machines` names its own. */
  areas?: AreaAvailability[];
  machines: MachineAvailability[];
}

export interface CompanyAvailability extends AvailabilityNode {
  companyId: string;
  companyName?: string | null;
  shops: ShopAvailability[];
}

export interface ProductAvailability {
  productId: string;
  productAvailable: boolean;
  companies: CompanyAvailability[];
}

/** A level that sets its own value against what it would inherit. */
export interface AvailabilityException {
  level: Exclude<AvailabilityLevel, 'product'>;
  id: string;
  name?: string | null;
  /** The shop an area or till belongs to. */
  shopName?: string | null;
  posNumber?: string | null;
  /** true unlocks, false locks. */
  value: boolean;
}

/**
 * One line of `POST /products/availability-summary`: counts over the tree
 * `GET /products/{id}/availability` shows, for the shops the caller can reach.
 * "Active" = listed in the shop and effectively available (a till: also on its catalog).
 */
export interface ProductAvailabilitySummary {
  productId: string;
  productAvailable: boolean;
  companyCount: number;
  shopCount: number;
  activeShopCount: number;
  areaCount: number;
  activeAreaCount: number;
  machineCount: number;
  activeMachineCount: number;
  /** The first few overriding levels, locks first. */
  exceptions: AvailabilityException[];
  exceptionCount: number;
}

/** `POST /products/shop-scope/preview`. */
export interface ShopScopePreview {
  shopCount: number;
  machineCount: number;
  shops: { id: string; name: string; companyId: string }[];
}

export interface StockLevel {
  productId: string;
  productName?: string;
  sku?: string;
  quantity: number;
  reorderMin?: number | null;
  reorderMax?: number | null;
  reorderOpt?: number | null;
  updatedAt: string;
}

export interface TipCashierRow {
  cashierId?: string | null;
  cashierName?: string | null;
  workerNumber?: string | null;
  tipsCollected: number;
  cashTips: number;
  cardTips: number;
  salesTotal: number;
  transactionCount: number;
  amountOwed: number;
}

export interface TipsReport {
  shopId: string;
  distribution: TipDistribution;
  fromDate?: string | null;
  toDate?: string | null;
  totalTips: number;
  totalCashTips: number;
  totalCardTips: number;
  totalSales: number;
  cashiers: TipCashierRow[];
}

export interface TaxOpenFormatPreview {
  transactionCount: number;
  recordCounts: Record<string, number>;
  businessInfo: {
    vatNumber?: string;
    companyName?: string;
    companyCity?: string;
    branchId?: string;
    /** "סוג עוסק" (docs/SPEC_BUSINESS_TYPE.md); absent on an older server. */
    dealerType?: DealerType;
  };
  globalTaxRate: number;
  dateRange: { year?: number; from?: string; to?: string };
  /** Documents whose payment records were apportioned (their tenders did not add up). */
  flaggedDocuments?: { transactionId: string; documentNumber: string | null; code: string; text: string }[];
  /** Duplicate copies left out of the file (each document once). */
  excludedDuplicateCopies?: number;
}

export type ValueDisplayMode = 'product_price' | 'fixed' | 'none';

export interface Voucher {
  id: string;
  tenantId: string;
  name: string;
  isActive: boolean;
  title?: string;
  subtitle?: string;
  bodyText?: string;
  footerText?: string;
  validityDays?: number;
  validFrom?: string;
  validUntil?: string;
  valueDisplayMode: ValueDisplayMode;
  displayValue?: number;
  printBarcode: boolean;
  printQr: boolean;
  language?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IssuedVoucher {
  id: string;
  tenantId?: string;
  shopId?: string;
  machineId?: string;
  transactionId: string;
  transactionItemId?: string;
  voucherId?: string;
  productId?: string;
  productName?: string;
  quantity: number;
  unitValue?: number;
  faceValue?: number;
  issuedAt: string;
  expiresAt?: string;
  status: 'issued' | 'voided' | 'redeemed';
  reprintCount: number;
  lastPrintedAt?: string;
}

export interface PaginatedResponse<T> {
  page: number;
  pageSize: number;
  total: number;
  items: T[];
}

export type ProductListResponse = PaginatedResponse<Product>;
export type ShopProductCatalogRowListResponse = PaginatedResponse<ShopProductCatalogRow>;
export type ShopProductCatalogCandidateListResponse = PaginatedResponse<ShopProductCatalogCandidate>;

export interface PairingCode {
  id: string;
  code: string;
  expiresAt: string;
  isUsed: boolean;
  usedAt?: string;
  createdAt: string;
  /** "till" | "kiosk" | "kds" | "order_status_board"; null = till (an older code). */
  deviceRole?: string | null;
  /** "android" | "windows" | "web"; null = no check (an older code, a replacement code). */
  platform?: 'android' | 'windows' | 'web' | null;
}

export interface SyncLog {
  id: string;
  machineId: string;
  direction: 'server_to_pos' | 'pos_to_server';
  entityType: 'products' | 'categories' | 'transactions' | 'z_report';
  action: 'create' | 'update' | 'delete' | 'full_sync';
  status: 'success' | 'failed' | 'conflict_resolved';
  conflictNote?: string;
  createdAt: string;
}

export interface AuthResponse {
  accessToken: string;
  tokenType: string;
  user: User;
}

// ── Transactions / Z-reports ───────────────────────────────────────────────────

export type TransactionStatus =
  | 'pending'
  | 'completed'
  | 'cancelled'
  | 'refunded'
  | 'partial_refund';

export interface TransactionItem {
  id: string;
  productId?: string;
  productName?: string;
  sku?: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  discount?: number;
  discountType?: string;
  transactionType?: number;
  lineDiscount?: number;
  notes?: string;
  /** On a credit-note line returned from a receipt: the original sale line. */
  refundOfItemId?: string | null;
}

/** One tender leg. `exchange` settles a mixed basket's sale against its returns. */
export interface TransactionPayment {
  id: string;
  sequence: number;
  method: string;
  amount: number;
  /** Card legs: מותג / חברת סליקה / מנפיק (codes of `lib/cardBrands`). */
  cardBrand?: string | null;
  cardAcquirer?: string | null;
  cardIssuer?: string | null;
  /** "ללא החזר כספי" (docs/SPEC_REMOTE_CREDIT.md): no money moved on this leg. */
  noMoneyMovement?: boolean;
  /**
   * The acquirer's reply as the till stored it: `result.provider` says Z-Credit (a cloud card
   * refund may be offered, SPEC_REMOTE_CREDIT.md §11); `cloudCardRefundId` marks a credit
   * note's leg that records one.
   */
  nayaxMeta?: Record<string, unknown> | null;
}

/** Another document of the same mixed basket (same `basketId`). */
export interface BasketDocument {
  id: string;
  transactionNumber: string;
  /**
   * The number as its till printed it: `<prefix>-<number>` ("קידומת מסמכים",
   * docs/SPEC_DOCUMENT_PREFIX.md). Show this; `transactionNumber` is the bare counter.
   */
  documentNumber?: string | null;
  documentType?: number | null;
  status: TransactionStatus;
  totalAmount: number;
  paymentMethod?: string | null;
  refundOfTransactionId?: string | null;
  createdAt: string;
}

export interface Transaction {
  id: string;
  machineId: string;
  shopId?: string;
  shiftId?: string;
  transactionNumber: string;
  /**
   * The number as its till printed it: `<prefix>-<number>` ("קידומת מסמכים",
   * docs/SPEC_DOCUMENT_PREFIX.md). Show this; `transactionNumber` is the bare counter.
   */
  documentNumber?: string | null;
  /** The prefix frozen on the document at issue; null on one from before the prefix. */
  documentPrefix?: string | null;
  status: TransactionStatus;
  documentType?: number;
  documentProductionDate?: string;
  paymentMethod?: string;
  amountTendered?: number;
  changeAmount?: number;
  totalAmount: number;
  totalDiscount?: number;
  documentDiscount?: number;
  whtDeduction?: number;
  customerId?: string;
  cashierId?: string;
  branchId?: string;
  notes?: string;
  refundOfTransactionId?: string;
  /** The original's document number as printed, `2-57` (detail read only). */
  refundOfTransactionNumber?: string | null;
  nayaxMeta?: Record<string, unknown> | null;
  /** The till basket this document was committed in; shared by its sibling documents. */
  basketId?: string | null;
  customerName?: string | null;
  customerPhone?: string | null;
  customerAddress?: string | null;
  createdAt: string;
  updatedAt: string;
  serverReceivedAt: string;
  items?: TransactionItem[];
  payments?: TransactionPayment[];
  /** The other documents of its basket (detail read only). */
  basketDocuments?: BasketDocument[];
  /**
   * An offline authorization run of its till answered one of its card legs: `declined`
   * (the acquirer refused a sale the terminal had approved offline — declined wins) or
   * `approved`. Null when no run answered any.
   */
  offlineOutcome?: OfflineOutcome | null;
  /** List rows: the brands (מותג) of its card legs. */
  cardBrands?: string[];
  /**
   * "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): the dashboard request this credit answered,
   * and whether it moved no money ("ללא החזר כספי — עסקה שלא בוצעה").
   */
  remoteCreditRequestId?: string | null;
  noMoneyMovement?: boolean;
  /** The approver linked when they are of this business (informational, never a refusal). */
  approvedByUserId?: string | null;
  approvedByPosUserId?: string | null;
  /** The approver exactly as the till sent it (docs/SHIFTS_API.md §1.2b). */
  claimedApproverUserId?: string | null;
  claimedApproverPosUserId?: string | null;
  /** Quiet notes written at ingest — shown in the detail, never an alarm. */
  ingestNotes?: IngestNote[] | null;
}

export interface IngestNote {
  code: string;
  text: string;
  detail?: string;
}

export type OfflineOutcome = 'approved' | 'declined';

export interface TransactionListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: Transaction[];
}

// ── Shifts (משמרות), X and Z ─────────────────────────────────────────────────
//
// The wire contract is pos-server `docs/SHIFTS_API.md`. Two rules run through
// every type below:
//
// * **Money arrives as a decimal string** ("123.40") — that is how the server's
//   Decimal serialises. It is displayed, never added up in the browser.
// * **`null` means unknown / not counted / not applicable, never zero.** An
//   uncounted drawer has `countedCash: null`, and must read "לא נספר", not ₪0.

/** A money amount as the shift and Z endpoints send it. */
export type Money = string | number;

/** The X figures of a shift, recomputed by the server from its documents (§3.2). */
export interface ShiftTotals {
  /** Net of document discounts — the money collected. Tips excluded. */
  totalSales?: Money | null;
  /** Σ totalAmount of the sales, before document discounts (the till's `totalSales`). */
  grossSales?: Money | null;
  /** Σ documentDiscount of the sales (the till's `totalDiscounts`). */
  discountsTotal?: Money | null;
  totalRefunds?: Money | null;
  totalCash?: Money | null;
  totalCard?: Money | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  /** Null when any document of the shift carries no VAT figure. */
  vatTotal?: Money | null;
  transactionsCount?: number | null;
  firstTransactionNumber?: string | null;
  lastTransactionNumber?: string | null;
}

export type ShiftStatus = 'open' | 'closed';

export interface Shift {
  id: string;
  tenantId?: string | null;
  machineId: string;
  shopId?: string | null;
  businessDate: string;
  /** Per-till counter. Null only on shifts from tills that predate it. */
  sequenceNumber?: number | null;
  status: ShiftStatus;
  openedAt: string;
  openingCash?: Money | null;
  openedByUserId?: string | null;
  openedByName?: string | null;
  closedAt?: string | null;
  /** When the cloud accepted the close with every document present. */
  closeAcceptedAt?: string | null;
  closedByUserId?: string | null;
  closedByName?: string | null;
  /** Closed remotely with nobody at the drawer (always uncounted). */
  unattended: boolean;
  /** Null = not counted. Never read as zero. */
  countedCash?: Money | null;
  expectedCash?: Money | null;
  /** counted − expected; null when uncounted. */
  discrepancy?: Money | null;
  /** Null while the shift is open. */
  serverTotals?: ShiftTotals | null;
  /** The till's own X, as it sent it (audit only). Absent on summaries. */
  tillTotals?: Record<string, unknown> | null;
  /** The till's X disagreed with the server's by more than a cent. */
  totalsMismatch: boolean;
  /** Documents that reached the cloud after the shift was closed. */
  lateDocuments?: number;
  /** Closed from the cloud for a dead till, from the documents the cloud held. */
  reconstructed: boolean;
  reconstructionBasis?: Record<string, unknown> | null;
  zReportId?: string | null;
  zNumber?: number | null;
  machineName?: string | null;
  shopName?: string | null;
  /**
   * The till's register number in the shift's shop ("קופה 2"); null once the till moved to
   * another shop. Absent from a server that predates it (lib/shiftsPage shiftRegisterNumber).
   */
  posNumber?: string | null;
  /**
   * The area the till was in when the cloud created this shift. Stamped, never
   * updated: moving the till later does not move its past shifts.
   */
  areaId?: string | null;
  areaName?: string | null;
  /** Detail read only: tender → amount, from the documents. */
  paymentBreakdown?: Record<string, Money> | null;
  /** Card transmission of the shift's sales (X detail only), informational. */
  transmission?: PeriodTransmission | null;
  /** Offline-approved card sales of the shift and their authorization (X detail only). */
  offline?: PeriodOffline | null;
  /** Its card legs an offline authorization run declined (list and detail reads). */
  offlineDeclinedCount?: number | null;
  offlineDeclinedAmount?: Money | null;
}

export interface ShiftListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: Shift[];
}

export type ZRunStatus = 'waiting' | 'building' | 'completed' | 'failed' | 'cancelled' | 'expired';

export type ZRunItemStatus =
  | 'waiting_close'
  | 'closing'
  | 'ready'
  | 'excluded'
  | 'failed'
  | 'expired';

/** One till of a shop, as the Z wizard sees it (`GET /shops/{id}/z-candidates`). */
export interface ZCandidateMachine {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  online: boolean;
  status?: PosMachine['status'] | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  openShift?: Shift | null;
  /** From the heartbeat — the till may have opened a shift the cloud has not heard of. */
  tillReportedOpenShiftId?: string | null;
  /** Closed and not in a Z, oldest first. A Z always takes a prefix of these. */
  closedShifts: Shift[];
  activeRun?: { runId: string; itemStatus: ZRunItemStatus } | null;
  /** Documents of this till stored with no shift. No Z takes them. */
  orphanDocuments?: number;
  /** False for a till listed only for its closed shifts of this shop (retired, moved). */
  inShop?: boolean;
  isActive?: boolean;
  /** `till`: the cloud never builds this till's Z; it is asked for its own (§5.4). */
  zMode?: ZMode;
  /** The till as the cloud knows it before the Z, with its warnings (offline till Z §4.6.1). */
  dataState?: TillDataState | null;
}

export interface ZCandidates {
  shopId: string;
  shopName?: string | null;
  /** `machine` = "Z לכל קופה" for the shop (or the point of sale asked for): one till per Z. */
  zScope: 'shop' | 'machine';
  /**
   * The shop's `shopZOpenTills` till parameter, for a shop Z that leaves tills with open
   * (or un-Z'd) shifts behind: refused (`block`), or only on the operator's confirmation
   * (`confirm`). Null when it does not apply. The server enforces it on `POST /z-runs`.
   */
  openTillsRule?: 'block' | 'confirm' | null;
  machines: ZCandidateMachine[];
  /** The shop's main till ("קופה ראשית"), or null. */
  mainTill?: TillRef | null;
  /**
   * The shop Z is the main till's alone (`shopZFrom` «הקופה הראשית בלבד»): the wizard starts
   * only tills' own Zs here. The server refuses the rest (409 `z_only_from_main_till`).
   */
  dashboardZBlocked?: boolean;
}

/** "הוחלפה קופה" — one replacement of a till's device (offline till Z §4.6.2). */
export interface TillReplacement {
  id: string;
  at: string;
  by?: string | null;
  reason?: string | null;
  oldDevice?: Record<string, unknown> | null;
  newDevice?: Record<string, unknown> | null;
  oldLastHeartbeatAt?: string | null;
  supportZFirst?: boolean;
  supportZ?: { at?: string; by?: string; zNumber?: number | null } | null;
}

/** A till as a small reference. */
export interface TillRef {
  machineId: string;
  posNumber?: string | null;
  name?: string | null;
}

/** A till a shop Z leaves behind (409 `open_tills_*`, and the record on the Z). */
export interface ZOpenTill {
  id: string;
  posNumber?: string | null;
  name?: string | null;
  /** The open shift left open; null when only closed shifts are left behind. */
  openShiftId?: string | null;
}

/** The operator's confirmation that a shop Z was produced without some tills. */
export interface ZOpenTillsLeftOut {
  tills: ZOpenTill[];
  confirmedByUserId?: string | null;
  confirmedByName?: string | null;
  confirmedAt?: string | null;
}

export interface ZRunMachineSelection {
  machineId: string;
  /** Omitted = every closed un-Z'd shift of this till. */
  throughShiftId?: string | null;
  includeOpenShift?: boolean;
}

export interface ZRunItem {
  id: string;
  machineId: string;
  machineName?: string | null;
  throughShiftId?: string | null;
  closeShiftId?: string | null;
  status: ZRunItemStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  readyAt?: string | null;
  updatedAt?: string | null;
  /** The till's last reported reading — not a live count. */
  online?: boolean | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  /** While waiting for the till's close: documents of that shift the cloud holds. */
  documentsOnCloud?: number | null;
}

export interface ZRun {
  id: string;
  shopId: string;
  status: ZRunStatus;
  businessDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  createdByUserId?: string | null;
  zReportId?: string | null;
  zNumber?: number | null;
  /** Set when the run was started for one area of the shop. */
  areaId?: string | null;
  areaName?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  /** Set when the operator confirmed producing this shop Z without some tills. */
  openTillsLeftOut?: ZOpenTillsLeftOut | null;
  /** "כפה סגירה (גם באמצע מכירה)" (docs/SPEC_OFFLINE_TILL_Z.md §9). */
  force?: boolean;
  items: ZRunItem[];
}

export type ShiftCloseRequestStatus =
  | 'waiting_close'
  | 'closing'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** A remote shift close without a Z (`POST /machines/{id}/close-shift`). */
export interface ShiftCloseRequest {
  id: string;
  machineId: string;
  machineName?: string | null;
  shopId?: string | null;
  shiftId?: string | null;
  status: ShiftCloseRequestStatus;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  completedAt?: string | null;
  /** The till's last reported reading — not a live count. */
  online?: boolean | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  /** While pending: documents of the shift the cloud holds. */
  documentsOnCloud?: number | null;
  /** The shift being closed (its X once completed); null if the cloud has not seen it. */
  shift?: Shift | null;
}

export type TillZRequestStatus =
  | 'waiting'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'expired'
  | 'cancelled';

/**
 * The dashboard asking a `till`-mode till to produce its own Z (docs/SHIFTS_API.md §5.4).
 * `completed` with no `zReportId` means the till had nothing to report.
 */
export interface TillZRequest {
  id: string;
  machineId: string;
  machineName?: string | null;
  shopId?: string | null;
  status: TillZRequestStatus;
  /** `deferred` keeps its code while in progress (`card_in_flight`, `printing`). */
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  expiresAt?: string | null;
  createdByUserId?: string | null;
  /** Who asked, by name. */
  initiatedBy?: string | null;
  sentAt?: string | null;
  receivedAt?: string | null;
  completedAt?: string | null;
  /** Set when it completed with a Z. */
  zReportId?: string | null;
  machineSequenceNumber?: number | null;
  /** The till's last reported reading — not a live count. */
  online?: boolean | null;
  pendingDocuments?: number | null;
  pendingAsOf?: string | null;
  /** "כפה סגירה (גם באמצע מכירה)" (docs/SPEC_OFFLINE_TILL_Z.md §9). */
  force?: boolean;
}

/** One figure where a Z closed offline differs from the cloud's own (docs/SPEC_OFFLINE_TILL_Z.md §6.1). */
export interface ZOfflineDiscrepancy {
  key: string;
  till: unknown;
  cloud: unknown;
}

/** The card batch transmitted before a till Z, as the terminal answered (§7.3). */
export interface ZCardTransmission {
  outcome: 'success' | 'failed' | 'busy' | 'unknown' | 'skipped';
  batchNumber?: string | null;
  statusCode?: number | null;
  statusMessage?: string | null;
  error?: string | null;
  transactionCount?: number | null;
  amount?: string | null;
  byBrand?: { brand: string; count: number; amount: string }[];
  at?: string | null;
  confirmedFailure?: boolean;
  confirmedByName?: string | null;
}

export interface ZReport {
  id: string;
  tenantId?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  /** The shop's number in its company ("#3"), as it is today. */
  shopNumber?: number | null;
  /**
   * The shop's Z number — 1, 2, 3 … per shop, gapless.
   *
   * What a bookkeeper quotes. Null only on a legacy Z from a terminal with no shop.
   */
  shopSequenceNumber?: number | null;
  /** The number it is known by: the till's own under "Z לכל קופה" (`perTill`), else the shop's. */
  zNumber?: number | null;
  perTill?: boolean;
  /**
   * The area this Z was run for, or null for a whole-shop / hand-picked Z. The number
   * above is still the shop's — an area has no sequence of its own.
   */
  areaId?: string | null;
  areaName?: string | null;
  businessDate: string;
  /**
   * The local date the Z was produced (`closedAt` in the tenant's timezone). From the
   * list only; absent on a server that predates it.
   */
  productionDate?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  shiftCount?: number | null;
  machineCount?: number | null;
  zRunId?: string | null;
  createdByUserId?: string | null;
  closedAt: string;
  createdAt: string;
  /** After document discounts, before refunds. */
  totalSales?: Money | null;
  /** Before document discounts (= totalSales + discountsTotal). Absent on older servers. */
  grossSales?: Money | null;
  /** totalSales − totalRefunds. Absent on older servers. */
  netSales?: Money | null;
  totalRefunds?: Money | null;
  discountsTotal?: Money | null;
  totalCashSales?: Money | null;
  totalCardSales?: Money | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  vatTotal?: Money | null;
  transactionsCount?: number | null;
  paymentBreakdown?: Record<string, Money> | null;
  openingCash?: Money | null;
  expectedCash?: Money | null;
  /** Null when any included shift was not counted. */
  actualCash?: Money | null;
  discrepancy?: Money | null;
  /**
   * Σ of the tills' cash put into / taken out of the drawer between shifts (part of
   * expectedCash). Null on a Z built before it existed.
   */
  betweenShiftAdjustments?: Money | null;
  /**
   * "טיפ באשראי משולם מהמזומן" (till parameter `cashDrawer.cardTipsFromDrawer`): the card
   * tips the tills paid staff in cash out of their drawers, as frozen at each close —
   * already out of expectedCash. Null/absent when no included close carried the figure.
   */
  cardTipsFromDrawer?: Money | null;
  /** "מזומן במגירה": cash sales net + cash tips − cardTipsFromDrawer. Null/absent with it. */
  drawerCash?: Money | null;
  /**
   * Σ of the tills' `offline` blocks. Null on a Z built before the block was stored (and
   * on a legacy Z): shown as nothing, never as zero.
   */
  offlineAuthorizationCount?: number | null;
  offlineApprovedCount?: number | null;
  offlineDeclinedCount?: number | null;
  offlineDeclinedAmount?: Money | null;
  /** Any included shift was closed unattended. */
  unattended?: boolean;
  /** Any included shift was reconstructed for a dead till. */
  reconstructed?: boolean;
  /** Documents of its shifts that reached the cloud after it was built (not in its figures). */
  lateDocuments?: number;
  /** A pre-shift Z issued by one till: `machineId` set, no per-till sections. */
  legacy?: boolean;
  /**
   * `till`: produced by the till itself (zMode = till), over that till alone. It has no
   * shop number (`shopSequenceNumber` null) — its number is `machineSequenceNumber`.
   */
  origin?: 'cloud' | 'till' | null;
  /** The till's own Z number, 1, 2, 3 … per till, gapless. Till Zs only. */
  machineSequenceNumber?: number | null;
  /** Set on till Zs (and on legacy rows). */
  machineId?: string | null;
  machineName?: string | null;
  /**
   * The till's register number, if the list sends it; the detail has it on its one
   * `perMachine` section.
   */
  posNumber?: string | null;
  /** Who produced it; null on a till Z produced for a dashboard request with nobody there. */
  createdByName?: string | null;
  /** Till Zs: the till's own figures differed from the ones the cloud built. */
  totalsMismatch?: boolean;
  /** Closed at the till with no connection to the cloud, uploaded at `uploadedAt`. */
  builtOffline?: boolean;
  uploadedAt?: string | null;
  /** Where the cloud's figures differ from the offline Z's paper; null/empty = none. */
  offlineDiscrepancies?: ZOfflineDiscrepancy[] | null;
  /** What this Z includes ("קופה עצמאית בתוך סניף"); null on older Zs. */
  scope?: ZReportScope | null;
  /** "סוג Z": shop | independent | till | kiosk | legacy (docs/SPEC_REPORTS.md §4). */
  zType?: 'shop' | 'independent' | 'till' | 'kiosk' | 'legacy' | null;
  /**
   * The shop's branch code ("קוד סניף") — on every Z, so two Z sequences of one branch
   * (the shop Z and an independent till's) are told apart with the till number.
   */
  branchCode?: string | null;
  /**
   * A till Z's run ("רצף"): a till made independent starts again at Z 1, and switching it
   * back and making it independent again starts another run — so one till can have two
   * "Z 1", told apart by the run's start. 0 = the till's first run.
   */
  machineSequenceEpoch?: number | null;
  /** When the run started; set on runs > 0 and on every independent till Z, else null. */
  sequenceStartedAt?: string | null;
  /**
   * A local shop Z's check against the cloud's documents (null on any other Z): stored as
   * printed, compared only once every document it names has arrived.
   */
  verification?: ZVerification | null;
  /** The card transmission the till ran before the Z. */
  cardTransmission?: ZCardTransmission | null;
  /** Produced by support from the cloud for a dead till (offline till Z §4.6). */
  producedBySupport?: {
    by?: string;
    at?: string;
    reasonText?: string;
    note?: string | null;
    reportedByTill?: { lastNumber?: number | null; pendingZs?: number; numbers?: number[] } | null;
  } | null;
  /** Late documents of a period support closed, carried into this Z — own section (§4.6.3). */
  lateFromEarlier?: {
    shiftId: string;
    posNumber?: string | null;
    label?: string;
    sourceZNumber?: number | null;
    documents: number;
    firstDocumentNumber?: string | null;
    lastDocumentNumber?: string | null;
    totalSales?: string | null;
  }[] | null;
  /** "המכשיר הוחלף בתאריך …": the till(s) whose device was replaced before this Z (§4.6.2). */
  devicesReplaced?: { machineId: string; posNumber?: string | null; name?: string | null; at?: string | null }[] | null;
  /** Legacy rows only: the till's own Z blob. */
  payload?: Record<string, unknown> | null;
  /** Legacy rows only. */
  reconstructionBasis?: Record<string, unknown> | null;
}

/**
 * What a Z includes: the shop, an area, one till, or an independent till of the shop.
 * `label` is the server's Hebrew sentence; `independentOutside` are the shop's independent
 * tills a shop Z leaves out.
 */
/**
 * A local shop Z's verification. Every till part carries a manifest (document ids, per-type
 * count/first/last, totals, digest) computed the same on the till and in the cloud. The
 * cloud compares only once every named document arrived — until then it waits; a dead,
 * removed or 24 h-late till is "incomplete", for support to close. `mismatch` means every
 * document arrived and the same computation still disagrees: a bug.
 */
export type ZVerificationState =
  | 'waiting'
  | 'incomplete'
  | 'verified'
  | 'mismatch'
  | 'closed_by_support'
  | 'unverified';

export interface ZVerificationSupportClose {
  by?: string | null;
  at?: string | null;
  note?: string | null;
  /** Ids on the detail; a count (or absent) on the list. */
  missingDocuments?: string[] | number | null;
  missingShiftIds?: string[] | number | null;
  printedTotals?: Record<string, unknown> | null;
  printedTypes?: Record<string, unknown> | null;
}

export interface ZVerificationTill {
  /**
   * "<machineId>" for a till's regular part, "<machineId>:late" for its "late documents"
   * part — one till can have both in one local shop Z.
   */
  key?: string | null;
  /** The late part: documents from an earlier period; `label` names it. */
  late?: boolean;
  label?: string | null;
  machineId: string;
  posNumber?: string | null;
  state: ZVerificationState | string;
  /** Hebrew, ready to show. */
  message?: string | null;
  named?: number | null;
  arrived?: number | null;
  missing?: number | null;
  shiftsAwaited?: number | null;
  reason?: 'removed' | 'support_closed' | 'stale' | string | null;
  closedBySupport?: ZVerificationSupportClose | null;
  /** Detail only: the till's manifest as printed, and the cloud's from the documents. */
  printed?: { totals?: Record<string, unknown>; types?: Record<string, unknown>; digest?: string } | null;
  cloud?: { totals?: Record<string, unknown>; types?: Record<string, unknown>; digest?: string } | null;
}

export interface ZVerification {
  state: ZVerificationState | string;
  /** Hebrew, ready to show. */
  message?: string | null;
  checkedAt?: string | null;
  tills?: ZVerificationTill[];
  /** Detail only, on `mismatch`: [{key, printed, cloud}]. */
  discrepancies?: { key: string; printed?: unknown; cloud?: unknown }[];
}

export interface ZReportScope {
  kind: 'shop' | 'area' | 'till' | 'independent_till';
  label?: string | null;
  tills?: TillRef[];
  independentOutside?: TillRef[];
}

/** One register's section of a Z (§3.6) — what the regulation ties a Z to. */
export interface ZReportMachineSection {
  machineId: string;
  /**
   * A local shop Z's "late documents" part of a till (it may also have its regular part):
   * shown under `label`, never as a second "קופה N".
   */
  late?: boolean;
  label?: string | null;
  machineName?: string | null;
  posNumber?: string | null;
  shiftIds?: string[];
  shiftCount?: number | null;
  firstShiftSequence?: number | null;
  lastShiftSequence?: number | null;
  firstDocumentNumber?: string | null;
  lastDocumentNumber?: string | null;
  transactionsCount?: number | null;
  salesCount?: number | null;
  creditNotesCount?: number | null;
  nonSaleDocumentsCount?: number | null;
  totalSales?: Money | null;
  grossSales?: Money | null;
  netSales?: Money | null;
  totalRefunds?: Money | null;
  discountsTotal?: Money | null;
  vatTotal?: Money | null;
  vatMissingCount?: number | null;
  totalCash?: Money | null;
  totalCard?: Money | null;
  paymentBreakdown?: Record<string, Money> | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  openingCash?: Money | null;
  expectedCash?: Money | null;
  /** Null when any of this till's shifts is uncounted. */
  countedCash?: Money | null;
  overShort?: Money | null;
  /** Cash put into (+) / taken out of (−) the drawer between its shifts; part of expectedCash. */
  betweenShiftAdjustments?: Money | null;
  /** Card tips this till paid out of the drawer (Σ of its closes'); absent without the parameter. */
  cardTipsFromDrawer?: Money | null;
  /** "מזומן במגירה" = cashSalesNet + cash tips − cardTipsFromDrawer; absent with it. */
  drawerCash?: Money | null;
  uncountedShiftCount?: number | null;
  reconstructedShiftCount?: number | null;
  unattendedShiftCount?: number | null;
  /** Offline-approved card sales and their authorization. Absent on a Z built before it. */
  offline?: PeriodOffline | null;
}

/**
 * The `offline` block of an X or a Z section: card legs the terminal approved offline
 * that an authorization run then approved or declined, matched by the terminal's uid.
 */
export interface PeriodOffline {
  /** Authorization runs of the till that answered any leg of the period. */
  authorizationCount: number;
  approvedCount: number;
  approvedAmount: Money;
  declinedCount: number;
  declinedAmount: Money;
  declined: Array<{
    transactionId: string;
    documentNumber?: string | null;
    amount: Money;
    terminalUid: string;
    at?: string | null;
  }>;
}

/** Who issued the Z, frozen when it was built — never live settings. */
export interface ZReportBusiness {
  businessName?: string | null;
  vatNumber?: string | null;
  companyRegNumber?: string | null;
  companyId?: string | null;
  address?: string | null;
  addressNumber?: string | null;
  city?: string | null;
  zip?: string | null;
  branchId?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  /** Frozen with the header: the area's name as it was when the Z was built. */
  areaId?: string | null;
  areaName?: string | null;
  capturedAt?: string | null;
  /** Frozen too: the tills the operator confirmed producing this shop Z without. */
  openTillsLeftOut?: ZOpenTillsLeftOut | null;
  /** "סוג עוסק" as the Z was built (docs/SPEC_BUSINESS_TYPE.md); absent on older Zs. */
  dealerType?: DealerType | null;
  /**
   * A local shop Z: the main till's printed Z IS the Z — stored exactly as printed (figures,
   * ranges, number), never corrected by the cloud.
   */
  asPrinted?: { producedBy?: TillRef | null; note?: string | null } | null;
}

export interface ZReportDetail extends ZReport {
  /** A Z closed offline: what the till printed (number, shifts, range, section). */
  offlineReport?: Record<string, unknown> | null;
  perMachine: ZReportMachineSection[];
  shifts: Shift[];
  business?: ZReportBusiness | null;
  /**
   * "מתוך ה-Z": its documents per calendar month of their document date (lib/businessDay.ts
   * `crossMonthLine`) — two or more = the Z spans months and says so. stored / documents as below.
   */
  documentMonths?: import('./businessDay').DocumentMonth[];
  documentMonthsSource?: 'stored' | 'documents' | null;
  /** Card legs per brand (מותג) × acquirer (חברת סליקה), summed over the tills. */
  cardBrands?: CardBrandBreakdownRow[];
  /** stored — frozen at build time; documents — read now (a Z built before the split). */
  cardBrandsSource?: 'stored' | 'documents' | null;
  /** Per waiter ("פירוט לפי מלצר"): a table's sales by its waiter, any other by its cashier. */
  byWaiter?: ZWaiterRow[];
  byWaiterSource?: 'stored' | 'documents' | null;
}

/** One waiter's row of a Z (money as decimal strings). `waiter` null: no one on the documents. */
export interface ZWaiterRow {
  waiterId?: string | null;
  waiter?: string | null;
  salesCount: number;
  sales: string;
  refundsCount: number;
  refunds: string;
  net: string;
  cash: string;
  card: string;
  /** "שוברי הפקה" — the production voucher tender (a Z frozen before it: absent, read as 0). */
  productionVoucher?: string;
  other: string;
  tips: string;
  tables: number;
  guests: number;
}

export interface ZReportListResponse {
  page: number;
  pageSize: number;
  total: number;
  items: ZReport[];
  /** The date window the server filtered on, with its basis and timezone. */
  window?: {
    from?: string | null;
    to?: string | null;
    defaulted: boolean;
    dateBasis?: 'business' | 'production';
    timezone?: string | null;
  } | null;
}

/**
 * A Z as the till prints it (80 mm) — built by the server (`app/services/z_print.py`),
 * the same document the Android till prints. Every value is a finished string.
 */
export interface ZPrintRow {
  label: string;
  value: string;
  emphasis: boolean;
}

export interface ZPrintSection {
  title: string;
  rows: ZPrintRow[];
}

export interface ZPrintDoc {
  title: string;
  number: number | null;
  businessName: string;
  subtitle: string[];
  sections: ZPrintSection[];
  footer: string[];
}

/** `GET /z-reports/print-documents`: several Zs, in Z-number order. */
export interface ZPrintDocList {
  items: {
    id: string;
    number: number | null;
    shopId: string | null;
    document: ZPrintDoc;
    /** A till Z's run ("רצף") and its start — one till can have two "Z 1". */
    sequenceEpoch?: number | null;
    sequenceStartedAt?: string | null;
  }[];
  total: number;
}

export interface DashboardStats {
  grossRevenue: number;
  netRevenue: number;
  transactionsCount: number;
  averageBasket: number;
  itemsSold: number;
  refundsCount: number;
  refundsAmount: number;
  tipsCash: number;
  tipsCard: number;
  paymentCash: number;
  paymentCard: number;
  from: string;
  to: string;
  generatedAt: string;
}

export interface DashboardBreakdownRow {
  id: string;
  name: string;
  grossRevenue: number;
  netRevenue: number;
  transactionsCount: number;
}

export interface DashboardBreakdown {
  groupBy: 'company' | 'shop';
  rows: DashboardBreakdownRow[];
  from: string;
  to: string;
}

// ── Manager overview (לוח מנהל, `GET /reports/overview`) ─────────────────────

/** One node's takings for the day — the per-cashier report's money. */
export interface OverviewSales {
  /** gross − discounts − refunds. */
  salesToday: number;
  gross: number;
  discounts: number;
  refunds: number;
  /** Sales + credit notes. */
  documentsToday: number;
  salesCount: number;
  refundsCount: number;
  cash: number;
  card: number;
  other: number;
  tips: number;
}

export interface OverviewKpis extends OverviewSales {
  /** (gross − discounts) / salesCount; 0 when nothing was sold. */
  averageTicket: number;
}

export interface OverviewMachine extends OverviewSales {
  id: string;
  posNumber?: string | null;
  name: string;
  /** The open shift and what it took since it opened (not since midnight). Null when none. */
  openShiftId?: string | null;
  openShiftSales?: number | null;
  openShiftDocuments?: number | null;
  /** The area (point of sale) it stands in now; null when none. */
  areaId?: string | null;
}

/**
 * A point of sale (area) of a shop. Its money is the day's documents whose shift was
 * stamped with it (the area report's rule); its tills are those standing in it now.
 */
export interface OverviewArea extends OverviewSales {
  id: string;
  name: string;
  sortOrder: number;
  machineIds: string[];
}

export interface OverviewShop extends OverviewSales {
  id: string;
  number?: number | null;
  name: string;
  /** Every till of the shop, whatever its area (each carries `areaId`). */
  machines: OverviewMachine[];
  /** Live areas in order; absent from an older server. */
  areas?: OverviewArea[];
}

export interface OverviewCompany extends OverviewSales {
  id: string;
  number?: number | null;
  name: string;
  parentCompanyId?: string | null;
  shops: OverviewShop[];
}

/** Sales only: a till's live state is the machines list's, joined on `id`. */
export interface OverviewReport {
  window: ReportWindowOut;
  generatedAt: string;
  kpis: OverviewKpis;
  companies: OverviewCompany[];
}

// ── POS users (per-shop till operators) ────────────────────────────────────────

export type PosUserRole = 'cashier' | 'shop_manager';

export interface PosUser {
  id: string;
  shopId: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
  workerNumber?: string | null;
  role: PosUserRole;
  isActive: boolean;
  /** "תפקידים והרשאות": the till role (null = not assigned yet: the legacy role of `role`). */
  tillRoleId?: string | null;
  tillRoleName?: string | null;
  permissionOverrides?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface PosUserCreate {
  username: string;
  firstName?: string;
  lastName?: string;
  workerNumber?: string;
  role: PosUserRole;
  tillRoleId?: string;
  pin: string;
}

export interface PosUserUpdate {
  firstName?: string;
  lastName?: string;
  workerNumber?: string | null;
  role?: PosUserRole;
  tillRoleId?: string;
  isActive?: boolean;
  pin?: string;
}

// ── Operational reports (GET /reports/products, /reports/cashiers, /reports/tips) ──

/**
 * The window the server actually used, echoed on every report response.
 *
 * `from`/`to` are calendar days in `timezone`; `fromHour`/`toHour` (when present)
 * narrow every one of those days to the same hour band — `fromHour` inclusive,
 * `toHour` exclusive, `fromHour > toHour` wrapping past midnight. Both are null
 * when no hour filter applied. `windowStart`/`windowEnd` are the absolute UTC
 * bounds of the outer day range (end exclusive); with an hour filter the covered
 * set is a subset of that span, not the whole of it.
 *
 * The timezone is resolved server-side (tz param → tenant → Asia/Jerusalem), so
 * the UI must display it rather than assume the reader's own zone.
 */
export interface ReportWindowOut {
  from: string;
  to: string;
  fromHour?: number | null;
  toHour?: number | null;
  timezone: string;
  windowStart: string;
  windowEnd: string;
  /** "business" — each sale on its till's business day ("שעת סיום יום עסקי"); "document" — its date. */
  dayBasis?: import('./businessDay').DayBasis;
  /** The scope's business day end hour (0–12) on the business basis; null otherwise. */
  businessDayEndHour?: number | null;
}

export interface ProductSalesRow {
  productId?: string | null;
  productName?: string | null;
  sku?: string | null;
  unitsSold: number;
  unitsRefunded: number;
  /** unitsSold - unitsRefunded. What actually left the shop. */
  unitsNet: number;
  gross: number;
  discounts: number;
  /** Always >= 0 and SUBTRACTS from net; a credit note never adds to takings. */
  refunds: number;
  /** gross - discounts - refunds */
  net: number;
  linesSold: number;
  linesRefunded: number;
  /** Of `unitsSold`, how many were sold inside meals (their money is the meals', allocated). */
  unitsInMeals?: number;
}

export interface ProductSalesTotals {
  unitsSold: number;
  unitsRefunded: number;
  unitsNet: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  productCount: number;
}

export interface ProductSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  /** True when the row cap trimmed the tail. `totals` still cover every row. */
  truncated: boolean;
  rowLimit: number;
  totals: ProductSalesTotals;
  rows: ProductSalesRow[];
}

export interface CashierSalesRow {
  /** Null for documents with no cashier, or a cashier that is not a pos_user. */
  cashierId?: string | null;
  cashierName?: string | null;
  workerNumber?: string | null;
  documentCount: number;
  salesCount: number;
  refundsCount: number;
  gross: number;
  /** Without production vouchers' deductions (`productionVoucherDeductions`). */
  discounts: number;
  /** "שוברי הפקה": what production vouchers booked as a document deduction took off — not a discount. */
  productionVoucherDeductions?: number;
  refunds: number;
  /** gross - discounts - productionVoucherDeductions - refunds */
  net: number;
  averageBasket: number;
  /** cashNet + cardNet + productionVoucherNet + otherNet === net. */
  cashNet: number;
  cardNet: number;
  otherNet: number;
  /** "שוברי הפקה": what production vouchers paid (absent from an older server: 0). */
  productionVoucherNet?: number;
  tips: number;
}

export interface CashierSalesReport {
  window: ReportWindowOut;
  generatedAt: string;
  /** Same shape as a row; the per-cashier identity fields are null on it. */
  totals: CashierSalesRow;
  rows: CashierSalesRow[];
}

export type TipMethod = 'cash' | 'card' | 'other';

export interface TipMethodRow {
  method: TipMethod;
  amount: number;
  documentCount: number;
}

export interface TipsByCashierRow {
  cashierId?: string | null;
  cashierName?: string | null;
  workerNumber?: string | null;
  tipsTotal: number;
  tipsCash: number;
  tipsCard: number;
  tipsOther: number;
  /** Documents that carried a non-zero tip. */
  tippedDocumentCount: number;
  /** Net takings by this cashier over the window, for a tips-to-sales ratio. */
  salesNet: number;
}

/**
 * GET /reports/tips — "how much tip money came in, on what tender, when".
 * Distinct from the per-shop `TipsReport`, which answers "who is owed what"
 * under the shop's tip-distribution policy.
 */
export interface TipsRangeReport {
  window: ReportWindowOut;
  generatedAt: string;
  tipsTotal: number;
  tipsCash: number;
  tipsCard: number;
  tipsOther: number;
  byMethod: TipMethodRow[];
  byCashier: TipsByCashierRow[];
}

// ── Day summary (סיכום יומי) ────────────────────────────────────────────────
//
// Z reports rolled into one figure per business date (the Z's). Not a Z: it
// closes nothing, it is not a fiscal document, and it is deliberately not
// printable.

/**
 * One day's takings across every contributing terminal.
 *
 * `vat` and `variance` are `null` when they could not be computed for *every*
 * contributing Z — see the count beside each. The UI must render those as "not
 * available" rather than falling back to 0, because both nulls are load-bearing: a
 * day containing an unattended close has no counted cash, and showing it as balanced
 * is the exact claim the server refuses to make.
 */
export interface DaySummaryTotals {
  sales: number;
  refunds: number;
  /** `sales - refunds`, precomputed server-side so nobody subtracts differently. */
  net: number;
  cashSales: number;
  cardSales: number;
  transactionsCount: number;
  tips: number;
  cashTips: number;
  cardTips: number;
  openingCash: number;
  expectedCash: number;
  /** Null unless every contributing Z declared its VAT. */
  vat: number | null;
  vatMissingCount: number;
  /** Null unless every contributing Z was actually counted. */
  actualCash: number | null;
  variance: number | null;
  uncountedCount: number;
  /** Offline-approved card sales later declined, as the Zs froze them. */
  offlineDeclinedCount?: number;
  offlineDeclinedAmount?: number;
}

/** One Z report behind a day's figures. `zReportId` is the drill-down target. */
export interface DaySummaryContributor {
  zReportId: string;
  /** This till's section of the Z includes a shift closed from the cloud (dead till). */
  reconstructed?: boolean;
  /** The shop's Z number. Null on a Z from a terminal with no shop, and on a till Z. */
  shopSequenceNumber?: number | null;
  /** `till` = the till produced this Z itself; its number is `machineSequenceNumber`. */
  origin?: 'cloud' | 'till' | null;
  machineSequenceNumber?: number | null;
  posNumber?: string | null;
  machineId: string;
  machineName?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  closedAt?: string | null;
  unattended: boolean;
  /** True when this Z has no counted cash, i.e. it is why `variance` is null. */
  uncounted: boolean;
  sales: number;
  refunds: number;
  net: number;
  cashSales: number;
  cardSales: number;
  tips: number;
  transactionsCount: number;
  expectedCash: number;
  actualCash: number | null;
  discrepancy: number | null;
  offlineDeclinedCount?: number;
  offlineDeclinedAmount?: number;
  /** An independent till of its shop ("קופה עצמאית"): its Z is apart from the shop Z. */
  independent?: boolean;
  /** Its shop's branch code ("קוד סניף"). */
  branchCode?: string | null;
  /** A till Z's run ("רצף") and when it started (see `ZReport.sequenceStartedAt`). */
  machineSequenceEpoch?: number | null;
  sequenceStartedAt?: string | null;
}

export interface DaySummaryRow {
  /** The Zs' business date (the field keeps its old name on the wire). */
  dayDate: string;
  /** What the day's Zs include, in Hebrew ("Z סניפי מס׳ 12 (קופות 1–5) · Z עצמאי: …"); null = nothing to add. */
  includesNote?: string | null;
  /** Distinct tills across the day's Zs' per-till sections, not Z reports. */
  machineCount: number;
  zReportCount: number;
  totals: DaySummaryTotals;
  contributors: DaySummaryContributor[];
}

export interface DaySummaryReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: DaySummaryTotals;
  /** Newest first. A day nobody closed is absent, not a zero row. */
  days: DaySummaryRow[];
}

// ── Offline card authorization (GET /reports/offline-authorizations) ────────

/** One uid a run declined, and the till's card leg it matched — if any did. */
export interface OfflineDeclinedLeg {
  terminalUid: string;
  /** False: no document of the till carries the uid (yet). */
  matched: boolean;
  transactionId?: string | null;
  documentNumber?: string | null;
  amount?: Money | null;
  /** The original sale's time. */
  soldAt?: string | null;
}

/** One `authorizePendingTransactions` run of one till. */
export interface OfflineAuthorizationRun {
  id: string;
  authorizedAt: string;
  receivedAt?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  statusCode?: number | null;
  approvedCount: number;
  /** The terminal's own approved total when it sent one, else the matched legs' sum. */
  approvedAmount: Money;
  declinedCount: number;
  /** Σ of the matched declined legs; an unmatched uid has no amount. */
  declinedAmount: Money;
  declinedUnmatchedCount: number;
  declined: OfflineDeclinedLeg[];
}

export interface OfflineAuthorizationTotals {
  authorizationCount: number;
  approvedCount: number;
  approvedAmount: Money;
  declinedCount: number;
  declinedAmount: Money;
  declinedUnmatchedCount: number;
}

export interface OfflineAuthorizationReport {
  window: ReportWindowOut;
  generatedAt: string;
  totals: OfflineAuthorizationTotals;
  /** Newest first. */
  items: OfflineAuthorizationRun[];
  /** More runs than the server returns in one report; the totals are of these. */
  truncated: boolean;
}


/** One candidate parent for a company, with the reason it cannot be chosen. */
export interface ParentOption {
  id: string;
  name: string;
  /** Edges above it, so the picker can indent rather than show a flat list. */
  depth: number;
  allowed: boolean;
  /** Present only when `allowed` is false. */
  reason?: string | null;
}

export interface ParentOptions {
  options: ParentOption[];
  /** What a move would carry. All zero for a company being created. */
  movesShops: number;
  movesMachines: number;
  movesCompanies: number;
  mayDetach: boolean;
}

/**
 * The status values an area's roll-up counts: the machine status light's own values
 * (`app/services/machine_status.py`), minus `retired` and `not_paired`.
 */
export type AreaStatusValue = Exclude<
  NonNullable<PosMachine['status']>,
  'retired' | 'not_paired'
>;

/**
 * An area's status roll-up, resolved server-side (`ROLLUP_SEVERITY`). Rendered as is —
 * the dashboard never re-derives `worst` from `counts`.
 */
export interface AreaStatusRollup {
  /** The most severe status among the area's active tills; null for an empty area. */
  worst: string | null;
  /** Status value → how many of the area's active tills have it. */
  counts: Record<string, number>;
}

/** A till as listed on an area after its membership was set. */
export interface ShopAreaMachine {
  id: string;
  name?: string | null;
  posNumber?: string | null;
}

/** An area of one shop: a group of its tills (docs/AREAS_API.md). */
export interface ShopArea {
  id: string;
  shopId: string;
  name: string;
  sortOrder: number;
  /** Archived, never deleted: old shifts, Zs and reports keep pointing at it. */
  archivedAt?: string | null;
  /** Active tills currently in the area. */
  machineCount: number;
  status?: AreaStatusRollup | null;
  /** Present on the answer to `PUT /areas/{id}/machines`. */
  machines?: ShopAreaMachine[];
}

/** One row of `GET /reports/sales-by-area`. `areaId` null = the unassigned row. */
export interface SalesByAreaRow {
  areaId: string | null;
  areaName?: string | null;
  archived?: boolean;
  transactionsCount: number;
  gross: Money;
  discounts: Money;
  /** "שוברי הפקה": production vouchers' deductions (not in `discounts`). */
  productionVoucherDeductions?: Money;
  net: Money;
  refunds: Money;
  cash: Money;
  card: Money;
  other: Money;
  /** "שוברי הפקה". */
  productionVoucher?: Money;
  tips: Money;
}

export type SalesByAreaTotals = Omit<SalesByAreaRow, 'areaId' | 'areaName' | 'archived'> &
  Partial<Pick<SalesByAreaRow, 'areaId' | 'areaName' | 'archived'>>;

export interface SalesByAreaReport {
  shopId?: string;
  dateFrom?: string;
  dateTo?: string;
  rows: SalesByAreaRow[];
  totals: SalesByAreaTotals;
  generatedAt?: string | null;
}

/** The `transmission` block of an X or a Z section (docs/SHIFTS_API.md §4.11). */
export interface PeriodTransmission {
  batches: Array<{
    id: string;
    batchNumber?: string | null;
    status: TransmissionStatus;
    trigger: TransmissionTrigger;
    startedAt?: string | null;
    finishedAt?: string | null;
    transactionCount?: number | null;
    amount?: string | null;
    legsInPeriod: number;
  }>;
  cardLegs: number;
  transmittedLegs: number;
  untransmittedLegs: number;
  untransmittedAmount?: string | null;
  untrackedLegs: number;
  tillPendingCount?: number | null;
  tillPendingAmount?: string | null;
  tillReportedAt?: string | null;
  asOf?: string | null;
}

// ── Till parameters ("פרמטרים לקופות", super admin) ─────────────────────────

export type TillParameterValueType = 'string' | 'integer' | 'decimal' | 'boolean' | 'enum';

/** A value as the till receives it: text, a number or a boolean, per the type. */
export type TillParameterScalar = string | number | boolean;

/** Where a value is set, least specific first. The till takes the most specific. */
export type TillParameterScope = 'company' | 'shop' | 'area' | 'machine';

/** A definition. Global — not per tenant. */
export interface TillParameter {
  id: string;
  /** The name the till reads it by: a letter, then letters, digits, `_` or `.`. */
  key: string;
  label: string;
  description?: string | null;
  valueType: TillParameterValueType;
  /** Only for `enum`; null otherwise. */
  enumOptions?: string[] | null;
  /** null = no default: a till with no value at any level does not get the key. */
  defaultValue?: TillParameterScalar | null;
  isActive: boolean;
  /** How many levels set a value for it. */
  valueCount: number;
  /**
   * How it is edited beyond its type: `'image'` = a string holding an image URL, picked
   * by upload (the server's `IMAGE_PARAMETER_KEYS`, e.g. `receiptLogoUrl`); null = by type.
   */
  widget?: 'image' | null;
  /** For `widget: 'image'`: the branding upload kind its images go through. */
  imageKind?: BrandingImageKind | 'media' | null;
  /** The dashboard tab that edits it instead of this page (`'printers'`), or null. */
  managedOn?: 'printers' | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** Body of `POST /till-parameters` and `PUT /till-parameters/{id}` (partial there). */
export interface TillParameterInput {
  key: string;
  label: string;
  description?: string | null;
  valueType: TillParameterValueType;
  enumOptions?: string[] | null;
  defaultValue?: TillParameterScalar | null;
  isActive: boolean;
}

export interface TillParameterValue {
  id: string;
  parameterId: string;
  scopeType: TillParameterScope;
  scopeId: string;
  /** The entity's name; null when it no longer exists. */
  scopeName?: string | null;
  /** The shop of an area or till, the company of a shop. */
  scopeContext?: string | null;
  value: TillParameterScalar;
  updatedAt?: string | null;
}

// ── Till app releases ("עדכון קופות", super admin) ──────────────────────────

/** Where a release is sent. A till takes the most specific: till, area, shop, company, tenant. */
export type AppReleaseLevel = 'tenant' | 'company' | 'shop' | 'area' | 'machine';

/** What a till reports while it takes a release. */
export type AppUpdateStatus =
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'installed'
  | 'failed'
  | 'declined';

/**
 * Which app a release is: the Android till APK, the Windows app's installer, or a kiosk web
 * bundle (`kiosk_web`: a zip of the kiosk's screens the Android kiosk shows in a WebView).
 */
export type AppPlatform = 'android' | 'windows' | 'kiosk_web';

/** Auto-install only between these device-local times ("HH:MM"; may cross midnight). */
export interface AppInstallWindow {
  start: string;
  end: string;
}

/** One uploaded APK or Windows installer. Global — every tenant's devices run the same app. */
export interface AppRelease {
  id: string;
  /** Absent on an older server: Android. */
  platform?: AppPlatform;
  versionCode: number;
  versionName: string;
  sha256: string;
  sizeBytes: number;
  notes?: string | null;
  /** Retired releases are offered to no till. */
  isActive: boolean;
  createdAt?: string | null;
  /** Live (not cancelled) assignments. */
  assignmentCount: number;
  /** Kiosk web bundles: the bridge API the bundle needs from the kiosk's APK; null otherwise. */
  bridgeApi?: number | null;
}

export interface AppReleaseAssignment {
  id: string;
  releaseId: string;
  versionName?: string | null;
  /** The release's platform: the assignment reaches only devices of that platform. */
  platform?: AppPlatform;
  level: AppReleaseLevel;
  targetId: string;
  /** The target's name; null when it no longer exists. */
  targetName?: string | null;
  /** The shop of an area or till, the company of a shop. */
  targetContext?: string | null;
  tenantId: string;
  autoInstall: boolean;
  /** Staged rollout: the share (1..100) of the target's devices it covers. */
  rolloutPercent?: number;
  /** Rollback allowed (Windows and kiosk web bundles only). */
  allowDowngrade?: boolean;
  installWindow?: AppInstallWindow | null;
  createdAt?: string | null;
  cancelledAt?: string | null;
  /** Active devices of its platform it reaches (whether or not something more specific wins there). */
  machineCount: number;
}

/** One till of `GET /app-releases/rollout`. */
export interface AppReleaseRolloutRow {
  machineId: string;
  machineName: string;
  posNumber?: string | null;
  platform?: AppPlatform;
  /** "till" | "kiosk". */
  deviceRole?: string | null;
  companyId?: string | null;
  companyName?: string | null;
  shopId?: string | null;
  shopName?: string | null;
  areaId?: string | null;
  areaName?: string | null;
  /** What the till last said it runs (its heartbeat's app version). */
  currentVersion?: string | null;
  lastHeartbeatAt?: string | null;
  releaseId?: string | null;
  targetVersion?: string | null;
  targetVersionCode?: number | null;
  assignmentId?: string | null;
  assignmentLevel?: AppReleaseLevel | null;
  autoInstall?: boolean | null;
  /** The till already runs the target. */
  upToDate: boolean;
  /** A target is assigned and the device does not run it. */
  behind?: boolean;
  /** The newest active release of the device's platform. */
  newestVersion?: string | null;
  newestVersionCode?: number | null;
  behindNewest?: boolean;
  /** The till's last report about the target; null = it has said nothing yet. */
  status?: AppUpdateStatus | null;
  statusMessage?: string | null;
  statusAt?: string | null;
  // Kiosk web rows only (`platform` "kiosk_web"; null on the others) — the kiosk's last
  // kiosk-web status. On these rows `currentVersion` is its active bundle (not the APK).
  /** What the kiosk shows now. */
  renderer?: 'native' | 'web' | null;
  /** What its config asks (`general.renderer`). */
  rendererConfigured?: 'native' | 'web' | null;
  /** Why it shows the built-in screens: ready_timeout | render_gone | js_errors | no_bundle | bridge_api | load_error … */
  fallbackReason?: string | null;
  /** Downloaded, waiting for the kiosk to be idle. */
  pendingVersion?: string | null;
  /** "bundled" (inside the APK) | "downloaded". */
  bundleSource?: string | null;
  webStatusAt?: string | null;
  webStatusMessage?: string | null;
  // "עדכון שקט" (lib/deviceManagement.ts), from the device's heartbeat; null: not said yet.
  deviceOwner?: boolean | null;
  silentUpdate?: boolean | null;
  /** device_owner | self_update | urovo | pax — silent; tap — someone confirms on screen. */
  updatePath?: string | null;
  kioskLock?: string | null;
  deviceManagementReportedAt?: string | null;
}

// ── Live sales by item (`GET /reports/live-items`) ────────────────────────────

export interface LiveItemRow {
  productId?: string | null;
  sku?: string | null;
  name?: string | null;
  /** Units sold minus units credited back. */
  qty: number;
  unitsSold: number;
  unitsRefunded: number;
  gross: number;
  discounts: number;
  refunds: number;
  /** gross − discounts − refunds. */
  net: number;
  /** % of the scope's net (0 when that is not positive). */
  share: number;
}

export interface LiveItemsReport {
  window: ReportWindowOut;
  generatedAt: string;
  period: 'day' | 'range' | 'shift';
  openShiftCount?: number | null;
  truncated: boolean;
  rowLimit: number;
  totals: {
    qty: number;
    gross: number;
    discounts: number;
    refunds: number;
    net: number;
    productCount: number;
  };
  rows: LiveItemRow[];
}

// ── Messages to tills (הודעות לקופות, `/till-messages`) ──────────────────────

export type TillMessageLevel = 'company' | 'shop' | 'area' | 'machine';
/** scheduled = not gone out yet; paused / ended = a recurring message's schedule. */
export type TillMessageStatus = 'active' | 'expired' | 'cancelled' | 'scheduled' | 'paused' | 'ended';
export type TillMessageScheduleKind = 'now' | 'scheduled' | 'recurring';
/** fullscreen = until "קראתי" (the default); banner = the specials strip on the sell screen and the floor. */
export type TillMessageDisplay = 'fullscreen' | 'banner';
/** A banner's colour preset; none = amber. */
export type TillMessageColor = 'amber' | 'blue' | 'green' | 'red' | 'purple' | 'dark';

/** Days are 0 = Sunday (א׳) … 6 = Saturday (ש׳); `time` is "HH:MM" in the tenant's zone. */
export interface TillMessageRecurrence {
  days: number[];
  time: string;
  startDate?: string | null;
  endDate?: string | null;
  occurrenceTtlMinutes?: number | null;
}
/** sent = not fetched yet; delivered = the till has it; acknowledged = "קראתי". */
export type TillMessageReceiptStatus = 'sent' | 'delivered' | 'acknowledged';

export interface TillMessageReceipt {
  machineId: string;
  machineName: string;
  posNumber?: string | null;
  shopName?: string | null;
  areaName?: string | null;
  status: TillMessageReceiptStatus;
  deliveredAt?: string | null;
  acknowledgedAt?: string | null;
  acknowledgedByPosUserId?: string | null;
  acknowledgedByName?: string | null;
}

export interface TillMessage {
  id: string;
  title?: string | null;
  body: string;
  targetLevel: TillMessageLevel;
  targetId: string;
  targetName?: string | null;
  createdAt: string;
  senderName?: string | null;
  expiresAt?: string | null;
  cancelledAt?: string | null;
  status: TillMessageStatus;
  counts: { total: number; delivered: number; acknowledged: number };
  /** Whether this user may cancel or resend it (an active message in their scope). */
  canManage: boolean;
  /** A scheduled message not yet sent, or a recurring one, in this user's scope. */
  canEdit?: boolean;
  /** For a recurring message: the latest occurrence's tills. */
  tills: TillMessageReceipt[];
  scheduleKind?: TillMessageScheduleKind;
  sendAt?: string | null;
  sentAt?: string | null;
  timezone?: string | null;
  pausedAt?: string | null;
  recurrence?: TillMessageRecurrence | null;
  nextOccurrenceAt?: string | null;
  occurrence?: { date: string; startsAt: string; expiresAt: string; live: boolean } | null;
  /** Absent from an older server: full-screen. */
  display?: TillMessageDisplay;
  /** A banner's product (its chip adds it to the order on the till). */
  productId?: string | null;
  productName?: string | null;
  color?: TillMessageColor | null;
}

export interface TillMessageList {
  items: TillMessage[];
  total: number;
}

export interface TillMessageCreate {
  title?: string | null;
  body: string;
  targetLevel: TillMessageLevel;
  targetId: string;
  expiresAt?: string | null;
  scheduleKind?: TillMessageScheduleKind;
  /** "YYYY-MM-DDTHH:mm" without an offset = the tenant's local time. */
  sendAt?: string | null;
  recurDays?: number[];
  recurTime?: string;
  recurStartDate?: string | null;
  recurEndDate?: string | null;
  occurrenceTtlMinutes?: number | null;
  display?: TillMessageDisplay;
  productId?: string | null;
  color?: TillMessageColor | null;
}

/** Only the fields sent change; null clears an optional one. */
export type TillMessageUpdate = Partial<
  Pick<
    TillMessageCreate,
    | 'title'
    | 'body'
    | 'expiresAt'
    | 'sendAt'
    | 'recurDays'
    | 'recurTime'
    | 'recurStartDate'
    | 'recurEndDate'
    | 'occurrenceTtlMinutes'
    | 'display'
    | 'productId'
    | 'color'
  >
>;
