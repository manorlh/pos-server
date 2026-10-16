/**
 * "מדפסות בונים" — the kitchen printers' settings as the cloud gives them to this device
 * (`GET /sync/{m}/printers`, pos-server app/routers/printers.py `sync_payload`; the Android till's
 * data/remote/KitchenPrinterDtos.kt `KitchenPrintersResponse`, field for field).
 *
 * Read leniently: a field this build does not know is ignored, a missing one takes the Android DTO's
 * default — a printers' answer never stops the tickets. The shop's print secret (`printSecret`) is
 * kept apart from the rest (sealed on disk, main/kitchen/kitchenService.ts): `withoutSecret` drops it.
 * Pure.
 */

/** One printer this device uses, or prints for the others. */
export interface KitchenPrinter {
  id: string;
  name: string;
  /** network | bluetooth | cloud | till | usb */
  type: string;
  host: string | null;
  port: number | null;
  btAddress: string | null;
  btName: string | null;
  hostMachineId: string | null;
  /** cloud: how the host device reaches the printer — till | network | bluetooth | usb. */
  hostConnection: string | null;
  hostMachineName: string | null;
  /** cloud, hosted by another device: where that device takes jobs on the shop's LAN. */
  hostLanAddress: string | null;
  hostLanPort: number | null;
  /** This device prints the printer's jobs itself (it hosts it, or it is the shop's print server). */
  isHost: boolean;
  /** Lines of this device's tickets may route here; false — listed only to host it, a kiosk's bon printer, a redirect target. */
  inScope: boolean;
  paperWidth: number;
  /** "רוחב הדפסה" (576 / 512 / 432 / 384); null — by the paper. */
  printWidthDots: number | null;
  copies: number;
  cutPaper: boolean;
  beep: boolean;
  /** kitchen ("מדפסת בונים") | receipt ("מדפסת חשבוניות"): a receipt printer never prints a ticket. */
  purpose: string;
  cashDrawer: boolean;
  /** machine | area | shop; null from an older cloud. */
  scope: string | null;
  /** The printer's own design choices (null: by the till parameters), for a cloud that sends no resolved style. */
  ticketDesign: string | null;
  ticketDesignId: string | null;
  ticketFontScale: number | null;
  ticketHeader: unknown;
  ticketCheckboxes: boolean | null;
  ticketElapsed: boolean | null;
  ticketFit: string | null;
  ticketMinTextSize: string | null;
  ticketMaxTextSize: string | null;
  ticketHeaderSize: string | null;
  ticketInlineMods: boolean | null;
  ticketOrder: string | null;
  ticketOrderList: unknown;
  ticketGroupHeaders: string | null;
  ticketNoCourse: string | null;
  /** The whole style the cloud resolved for this printer ("עיצוב בון"): the ticket is drawn by it alone. */
  ticketStyle: Record<string, unknown> | null;
}

/** The shop's print server ("שרת הדפסות"): which device, whether it is this one, where it listens on the LAN. */
export interface PrintHost {
  machineId: string;
  name: string | null;
  isSelf: boolean;
  lanAddress: string | null;
  port: number;
  deviceRole: string | null;
  keyId: string | null;
  /** This device stands off the shop's LAN ("מרוחקת"): never the print server over the LAN, never a shop printer at its address. */
  offLan: boolean;
}

export interface KitchenConfig {
  syncType: string | null;
  etag: string | null;
  machineId: string | null;
  printers: KitchenPrinter[];
  /** Category id → printer ids, already inherited down the tree. */
  categoryRoutes: Record<string, string[]>;
  /** Product id → printer ids; an empty list is "no ticket" ("ללא בון"). */
  productRoutes: Record<string, string[]>;
  options: { kitchenTicketsOnSale: boolean; kitchenTicketsOnTill: boolean };
  hostsRelay: boolean;
  hostsLan: boolean;
  /** The shop's print secret — the bearer on the shop's LAN. */
  printSecret: string | null;
  printHost: PrintHost | null;
  /** Table zone id → {from printer id: to printer id}. */
  zoneRedirects: Record<string, Record<string, string>>;
  acceptsDocuments: boolean;
}

/** The Android LAN server's port when the cloud names none (KitchenLan.kt DEFAULT_LAN_PORT). */
export const DEFAULT_LAN_PORT = 8399;
/** A raw network printer's port (9100). */
export const DEFAULT_PRINTER_PORT = 9100;

export const EMPTY_KITCHEN_CONFIG: KitchenConfig = {
  syncType: null,
  etag: null,
  machineId: null,
  printers: [],
  categoryRoutes: {},
  productRoutes: {},
  options: { kitchenTicketsOnSale: false, kitchenTicketsOnTill: false },
  hostsRelay: false,
  hostsLan: false,
  printSecret: null,
  printHost: null,
  zoneRedirects: {},
  acceptsDocuments: false,
};

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const port = (v: unknown): number | null => {
  const n = int(v);
  return n !== null && n > 0 && n < 65536 ? n : null;
};

function idLists(v: unknown): Record<string, string[]> {
  const o = obj(v);
  if (!o) return {};
  const out: Record<string, string[]> = {};
  for (const [k, ids] of Object.entries(o)) {
    if (Array.isArray(ids)) out[k] = ids.filter((x): x is string => typeof x === 'string' && x.length > 0);
  }
  return out;
}

export function parsePrinter(v: unknown): KitchenPrinter | null {
  const p = obj(v);
  const id = p ? str(p.id) : null;
  if (!p || !id) return null;
  const style = obj(p.ticketStyle);
  return {
    id,
    name: str(p.name) ?? id,
    type: (str(p.type) ?? 'network').toLowerCase(),
    host: str(p.host),
    port: port(p.port),
    btAddress: str(p.btAddress),
    btName: str(p.btName),
    hostMachineId: str(p.hostMachineId),
    hostConnection: str(p.hostConnection)?.toLowerCase() ?? null,
    hostMachineName: str(p.hostMachineName),
    hostLanAddress: str(p.hostLanAddress),
    hostLanPort: port(p.hostLanPort),
    isHost: bool(p.isHost, false),
    inScope: bool(p.inScope, true),
    paperWidth: int(p.paperWidth) ?? 80,
    printWidthDots: int(p.printWidthDots),
    copies: Math.max(1, Math.min(5, int(p.copies) ?? 1)),
    cutPaper: bool(p.cutPaper, true),
    beep: bool(p.beep, false),
    purpose: (str(p.purpose) ?? 'kitchen').toLowerCase(),
    cashDrawer: bool(p.cashDrawer, false),
    scope: str(p.scope),
    ticketDesign: str(p.ticketDesign),
    ticketDesignId: str(p.ticketDesignId),
    ticketFontScale: int(p.ticketFontScale),
    ticketHeader: p.ticketHeader ?? null,
    ticketCheckboxes: boolOrNull(p.ticketCheckboxes),
    ticketElapsed: boolOrNull(p.ticketElapsed),
    ticketFit: str(p.ticketFit),
    ticketMinTextSize: str(p.ticketMinTextSize),
    ticketMaxTextSize: str(p.ticketMaxTextSize),
    ticketHeaderSize: str(p.ticketHeaderSize),
    ticketInlineMods: boolOrNull(p.ticketInlineMods),
    ticketOrder: str(p.ticketOrder),
    ticketOrderList: p.ticketOrderList ?? null,
    ticketGroupHeaders: str(p.ticketGroupHeaders),
    ticketNoCourse: str(p.ticketNoCourse),
    ticketStyle: style && Object.keys(style).length > 0 ? style : null,
  };
}

export function parsePrintHost(v: unknown): PrintHost | null {
  const h = obj(v);
  const machineId = h ? str(h.machineId) : null;
  if (!h || !machineId) return null;
  return {
    machineId,
    name: str(h.name),
    isSelf: bool(h.isSelf, false),
    lanAddress: str(h.lanAddress),
    port: port(h.port) ?? DEFAULT_LAN_PORT,
    deviceRole: str(h.deviceRole),
    keyId: str(h.keyId),
    offLan: bool(h.offLan, false),
  };
}

/** The cloud's answer (or what was kept of it), read leniently. */
export function parseKitchenConfig(raw: unknown): KitchenConfig {
  const r = obj(raw);
  if (!r) return { ...EMPTY_KITCHEN_CONFIG };
  const printers = Array.isArray(r.printers) ? r.printers.map(parsePrinter).filter((p): p is KitchenPrinter => p !== null) : [];
  const options = obj(r.options) ?? {};
  const redirects: Record<string, Record<string, string>> = {};
  for (const [zone, map] of Object.entries(obj(r.zoneRedirects) ?? {})) {
    const m = obj(map);
    if (!m) continue;
    const one: Record<string, string> = {};
    for (const [from, to] of Object.entries(m)) if (typeof to === 'string' && to) one[from] = to;
    redirects[zone] = one;
  }
  return {
    syncType: str(r.syncType),
    etag: str(r.etag),
    machineId: str(r.machineId),
    printers,
    categoryRoutes: idLists(r.categoryRoutes),
    productRoutes: idLists(r.productRoutes),
    options: { kitchenTicketsOnSale: bool(options.kitchenTicketsOnSale, false), kitchenTicketsOnTill: bool(options.kitchenTicketsOnTill, false) },
    hostsRelay: bool(r.hostsRelay, false),
    hostsLan: bool(r.hostsLan, false),
    printSecret: str(r.printSecret),
    printHost: parsePrintHost(r.printHost),
    zoneRedirects: redirects,
    acceptsDocuments: bool(r.acceptsDocuments, false),
  };
}

/** The config as kept on disk: everything but the shop's print secret (kept sealed, apart). */
export function withoutSecret(c: KitchenConfig): KitchenConfig {
  return { ...c, printSecret: null };
}

/** Kitchen ("מדפסת בונים") printers that may take this device's lines — what a kiosk's bon route counts. */
export function kitchenPrintersInScope(c: KitchenConfig | null): KitchenPrinter[] {
  return (c?.printers ?? []).filter((p) => p.inScope && p.purpose !== 'receipt');
}
