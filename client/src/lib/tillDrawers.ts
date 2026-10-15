/**
 * "מגירות לפי קופה" — the printers page's card (the owner, 15.10.2026: a cash drawer is on a
 * network / Bluetooth / USB receipt printer, or on a till's own drawer port; with two tills it must
 * be easy to see and mark which has a drawer). Pure: one row per till of the shop, from the page's
 * printing settings and receipt printers, the way the till itself picks its drawers (pos-android
 * AppContainer.receiptDestinations / drawersOf):
 *
 *  - the till's own drawer follows "פתיחת מגירה" (`cashDrawer`), resolved till → point of sale →
 *    shop → company → the device's own default (SUNMI / iMin desktops with a drawer port:
 *    «בתשלום מזומן + כפתור פתיחה») → the parameter's default («כבוי»). It opens only where there
 *    is one: the till's drawer port, or the external printer its "מדפסת חשבוניות" parameter names;
 *  - every active receipt printer of type network / Bluetooth / USB with "מגירת כסף מחוברת" that
 *    applies to the till (set to it, to its point of sale, or to the whole shop) adds its drawer.
 *    A printer of type "ענן" (another till's printer) never opens a drawer here;
 *  - more than one drawer: the till asks "איזו מגירה לפתוח?".
 *
 * Types are structural (the page's `KitchenPrintersPage` fits), so the tests run without the API.
 */

export const CASH_DRAWER_KEY = 'cashDrawer';
/** pos-server app/services/till_parameters.py `CASH_DRAWER_*`. */
export const DRAWER_OFF = 'כבוי';
export const DRAWER_ON_CASH = 'בתשלום מזומן';
export const DRAWER_WITH_BUTTON = 'בתשלום מזומן + כפתור פתיחה';
export const DRAWER_ASK = 'בתשלום מזומן — לשאול';
/** The options in the order the card offers them. */
export const DRAWER_MODES = [DRAWER_OFF, DRAWER_ON_CASH, DRAWER_WITH_BUTTON, DRAWER_ASK] as const;

/** "מדפסת חשבוניות" of the till itself; an external one carries the till's own drawer. */
export const RECEIPT_PRINTER_KEY = 'receiptPrinter';
const EXTERNAL_RECEIPT_PRINTERS = new Set(['רשת (ip)', 'רשת', 'bluetooth', 'usb']);
/** The receipt printers a till opens a drawer on (the till maps "ענן" / "till" to nothing). */
const DRAWER_PRINTER_TYPES = new Set(['network', 'bluetooth', 'usb']);

export type DrawerModeKey = 'off' | 'onCash' | 'button' | 'ask';
export type DrawerSource = 'machine' | 'area' | 'shop' | 'company' | 'device_default' | 'default';
export type PrinterScope = 'machine' | 'area' | 'shop';

type Value = string | number | boolean;

export interface DrawerSettingsInput {
  shop: Record<string, Value>;
  areas: Record<string, Record<string, Value>>;
  machines: Record<string, Record<string, Value>>;
  fromCompany: string[];
  inherited: Record<string, Value | null>;
  deviceDefaults?: Record<string, Record<string, Value>>;
}

export interface DrawerMachineInput {
  id: string;
  name: string;
  areaId: string | null;
  /** The model drives a drawer port of its own (the server's `has_cash_drawer_port`); absent on an older server. */
  cashDrawerPort?: boolean;
}

export interface DrawerPrinterInput {
  id: string;
  name: string;
  purpose: string;
  cashDrawer: boolean;
  connectionType: string;
  isActive: boolean;
  areaId: string | null;
  machineId: string | null;
}

export interface DrawerPageInput {
  machines: DrawerMachineInput[];
  printers: DrawerPrinterInput[];
  options: DrawerSettingsInput;
}

export interface Resolved {
  value: Value | null;
  source: DrawerSource;
  /** The point of sale it comes from (`source` "area"). */
  areaId?: string;
}

export type DrawerSummary =
  | { kind: 'none' }
  | { kind: 'builtIn' }
  | { kind: 'ownPrinter' }
  | { kind: 'printer'; printerName: string }
  | { kind: 'several'; count: number };

export interface TillDrawerRow {
  machineId: string;
  name: string;
  areaId: string | null;
  /** "פתיחת מגירה" set on this very till; null — it inherits. */
  own: string | null;
  /** What the till takes when it sets nothing itself, and from where. */
  inherited: Resolved;
  /** What it takes now. */
  effective: Resolved;
  /** The effective mode opens a drawer at all (anything but «כבוי»). */
  modeOn: boolean;
  /**
   * Where the till's own drawer is: its drawer port, or the external printer its parameter names;
   * null — nowhere, so "פתיחת מגירה" opens nothing of its own.
   */
  ownDrawer: 'port' | 'ownPrinter' | null;
  /** The till's own drawer opens (mode on and a place for it). */
  builtInActive: boolean;
  /** Mode on but no drawer port and no external printer of its own: the setting opens nothing. */
  builtInUnreachable: boolean;
  /** The shop's receipt printers with a drawer this till uses, its own first. */
  printers: Array<{ id: string; name: string; scope: PrinterScope }>;
  summary: DrawerSummary;
}

/** `cashDrawer`'s value as the card's word for it; null for a value it does not know. */
export function drawerModeKey(value: unknown): DrawerModeKey | null {
  switch (typeof value === 'string' ? value.trim() : value) {
    case DRAWER_OFF:
      return 'off';
    case DRAWER_ON_CASH:
      return 'onCash';
    case DRAWER_WITH_BUTTON:
      return 'button';
    case DRAWER_ASK:
      return 'ask';
    default:
      return null;
  }
}

/** Does the mode open a drawer (the till: empty / «כבוי» / off / false — no). */
export function drawerModeOn(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  const v = String(value).trim().toLowerCase();
  return v !== '' && v !== DRAWER_OFF && v !== 'off' && v !== 'false';
}

/** What `key` resolves to on `machine` when the till itself sets nothing (area → shop → company → device → default). */
export function inheritedFor(options: DrawerSettingsInput, machine: DrawerMachineInput, key: string): Resolved {
  if (machine.areaId) {
    const fromArea = options.areas[machine.areaId]?.[key];
    if (fromArea !== undefined) return { value: fromArea, source: 'area', areaId: machine.areaId };
  }
  if (options.shop[key] !== undefined) return { value: options.shop[key], source: 'shop' };
  if (options.fromCompany.includes(key)) return { value: options.inherited[key] ?? null, source: 'company' };
  const byDevice = options.deviceDefaults?.[machine.id]?.[key];
  if (byDevice !== undefined) return { value: byDevice, source: 'device_default' };
  return { value: options.inherited[key] ?? null, source: 'default' };
}

/** What `key` is on `machine` now: its own value, else what it inherits. */
export function effectiveFor(options: DrawerSettingsInput, machine: DrawerMachineInput, key: string): Resolved {
  const own = options.machines[machine.id]?.[key];
  return own !== undefined ? { value: own, source: 'machine' } : inheritedFor(options, machine, key);
}

/** Where the shop set a printer: one till, a point of sale, or the whole shop. */
export function printerScope(p: Pick<DrawerPrinterInput, 'machineId' | 'areaId'>): PrinterScope {
  return p.machineId ? 'machine' : p.areaId ? 'area' : 'shop';
}

/** Is the printer one of `machine`'s (pos-server `printer_applies_to`)? */
export function printerAppliesTo(p: DrawerPrinterInput, machine: DrawerMachineInput): boolean {
  if (!p.isActive) return false;
  if (p.machineId) return p.machineId === machine.id;
  if (p.areaId) return !!machine.areaId && p.areaId === machine.areaId;
  return true;
}

/** A receipt printer whose drawer a till opens. */
export function opensDrawer(p: DrawerPrinterInput): boolean {
  return p.purpose === 'receipt' && p.cashDrawer && DRAWER_PRINTER_TYPES.has(p.connectionType);
}

const SCOPE_RANK: Record<PrinterScope, number> = { machine: 0, area: 1, shop: 2 };

/** One row of "מגירות לפי קופה". */
export function tillDrawerRow(page: DrawerPageInput, machine: DrawerMachineInput): TillDrawerRow {
  const { options } = page;
  const ownRaw = options.machines[machine.id]?.[CASH_DRAWER_KEY];
  const inherited = inheritedFor(options, machine, CASH_DRAWER_KEY);
  const effective: Resolved = ownRaw !== undefined ? { value: ownRaw, source: 'machine' } : inherited;
  const modeOn = drawerModeOn(effective.value);

  // The model's port: the server says so; an older one — its device default is the port's.
  const port = machine.cashDrawerPort ?? (options.deviceDefaults?.[machine.id]?.[CASH_DRAWER_KEY] !== undefined);
  const receipt = effectiveFor(options, machine, RECEIPT_PRINTER_KEY).value;
  const externalOwn = typeof receipt === 'string' && EXTERNAL_RECEIPT_PRINTERS.has(receipt.trim().toLowerCase());
  const ownDrawer = externalOwn ? 'ownPrinter' : port ? 'port' : null;
  const builtInActive = modeOn && ownDrawer !== null;

  const printers = page.printers
    .filter((p) => opensDrawer(p) && printerAppliesTo(p, machine))
    .map((p) => ({ id: p.id, name: p.name, scope: printerScope(p) }))
    .sort((a, b) => SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope]);

  const count = (builtInActive ? 1 : 0) + printers.length;
  const summary: DrawerSummary =
    count === 0
      ? { kind: 'none' }
      : count > 1
        ? { kind: 'several', count }
        : builtInActive
          ? { kind: ownDrawer === 'ownPrinter' ? 'ownPrinter' : 'builtIn' }
          : { kind: 'printer', printerName: printers[0].name };

  return {
    machineId: machine.id,
    name: machine.name,
    areaId: machine.areaId,
    own: ownRaw === undefined ? null : String(ownRaw),
    inherited,
    effective,
    modeOn,
    ownDrawer,
    builtInActive,
    builtInUnreachable: modeOn && ownDrawer === null,
    printers,
    summary,
  };
}

/** The card's rows: every till of the shop, in the page's order. */
export function tillDrawerRows(page: DrawerPageInput): TillDrawerRow[] {
  return page.machines.map((m) => tillDrawerRow(page, m));
}

/** The card's "inherit" choice (the select's value for "no value on this till"). */
export const INHERIT = '__inherit__';

/**
 * What to save when the card's choice for a till changes: `{cashDrawer: value}` at the till, `null`
 * to inherit again — or nothing (`undefined`) when it is what the till already has of its own.
 */
export function drawerChange(row: Pick<TillDrawerRow, 'own'>, choice: string): string | null | undefined {
  const next = choice === INHERIT ? null : choice;
  return next === row.own ? undefined : next;
}
