/**
 * Item tickets ("שוברים") — operational slips printed after a sale and exchanged over the counter
 * for the goods: "5 נקניקיות". The port of pos-android domain/ItemTicket.kt (`ItemTickets.split`,
 * `TicketMode.resolve`, `ItemTicketSetting`, `ItemTicketPrinting`), pinned by the shared cases
 * test/fixtures/item_ticket_cases.json (the same bytes as pos-android's). Not value vouchers: no
 * serial, no value, nothing recorded.
 *
 * - The mode is set per category in the cloud and can be overridden per product; the catalog sync
 *   sends each product's resolved `ticketMode` (and `ticketEntries` for an entry ticket).
 * - "שוברי פריט" — the till parameter `itemTicketMode` (company → shop → point of sale → till): by
 *   the product (default), off on this device, or one mode for every product whose tickets are on.
 * - Not for a credit note; nothing on a device with no printer.
 */

export type TicketMode = 'off' | 'per_unit' | 'per_line' | 'per_sale';
export type ItemTicketSetting = 'by_product' | TicketMode;

export const ITEM_TICKET_PARAM = 'itemTicketMode';

/** A known mode, or null (inherit / anything else). */
export function parseTicketMode(value: unknown): TicketMode | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'off' || v === 'per_unit' || v === 'per_line' || v === 'per_sale' ? v : null;
}

/** The product's own mode wins; otherwise its category's; otherwise off. */
export function resolveTicketMode(productMode: unknown, categoryMode: unknown): TicketMode {
  return parseTicketMode(productMode) ?? parseTicketMode(categoryMode) ?? 'off';
}

/** The cloud's words for "שוברי פריט" (or the wire names); anything else is "by the product". */
export function itemTicketSetting(value: unknown): ItemTicketSetting {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (v) {
    case 'כבוי':
    case 'off':
      return 'off';
    case 'שובר לכל יחידה':
    case 'per_unit':
      return 'per_unit';
    case 'שובר לכל פריט':
    case 'per_line':
      return 'per_line';
    case 'שובר אחד לעסקה':
    case 'per_sale':
      return 'per_sale';
    default:
      return 'by_product';
  }
}

/** A product's mode on this device: its own by default; "כבוי" none; an override only for a product whose tickets are on. */
export function ticketModeFor(productMode: TicketMode, setting: ItemTicketSetting): TicketMode {
  if (setting === 'by_product') return productMode;
  if (setting === 'off' || productMode === 'off') return 'off';
  return setting;
}

/** A sale's tickets print: not for a credit note (330 / -400), not without a printer, not where the setting is off. */
export function itemTicketsPrint(documentType: number, hasPrinter: boolean, setting: ItemTicketSetting = 'by_product'): boolean {
  return hasPrinter && documentType !== 330 && documentType !== -400 && setting !== 'off';
}

export interface TicketLineInput {
  productId: string;
  name: string;
  quantity: number;
  unitLabel?: string | null;
  mode: TicketMode;
  /** A line that credits an earlier one: never gets a ticket. */
  refund?: boolean;
  /** An entry ticket: more than 1 prints that many tickets for every unit, whatever the mode. */
  entries?: number;
}

export interface TicketItem {
  name: string;
  quantity: number;
  unitLabel?: string | null;
  entry?: number | null;
  entries?: number | null;
}

const isWhole = (q: number) => Math.abs(q - Math.round(q)) < 1e-9;

/**
 * The tickets a sale prints, each a list of its items, in the order of the sale's lines: entry
 * tickets first; lines of one product combined; per unit a ticket per whole unit (a weighed
 * quantity one for all of it); per line one per product; every per-sale line on one ticket, last.
 */
export function splitItemTickets(lines: TicketLineInput[]): TicketItem[][] {
  const entryTickets: TicketItem[][] = [];
  for (const line of lines) {
    const entries = line.entries ?? 1;
    if (line.refund || line.quantity <= 0 || entries <= 1) continue;
    const units = isWhole(line.quantity) ? Math.round(line.quantity) : 1;
    for (let u = 0; u < units; u++) {
      for (let k = 1; k <= entries; k++) {
        entryTickets.push([{ name: line.name, quantity: 1, unitLabel: line.unitLabel ?? null, entry: k, entries }]);
      }
    }
  }
  const sold = lines.filter((l) => !l.refund && l.quantity > 0 && l.mode !== 'off' && (l.entries ?? 1) <= 1);
  if (sold.length === 0) return entryTickets;
  const combined = new Map<string, TicketLineInput>();
  for (const line of sold) {
    const key = `${line.productId}\u0000${line.mode}`;
    const prev = combined.get(key);
    combined.set(key, prev ? { ...prev, quantity: prev.quantity + line.quantity } : line);
  }
  const tickets: TicketItem[][] = [];
  const perSale: TicketItem[] = [];
  for (const line of combined.values()) {
    const item: TicketItem = { name: line.name, quantity: line.quantity, unitLabel: line.unitLabel ?? null };
    if (line.mode === 'per_unit') {
      if (isWhole(line.quantity)) {
        for (let u = 0; u < Math.round(line.quantity); u++) tickets.push([{ ...item, quantity: 1 }]);
      } else tickets.push([item]);
    } else if (line.mode === 'per_line') tickets.push([item]);
    else if (line.mode === 'per_sale') perSale.push(item);
  }
  if (perSale.length > 0) tickets.push(perSale);
  return [...entryTickets, ...tickets];
}
