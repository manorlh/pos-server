/**
 * The kitchen ticket as it travels (pos-android data/remote/KitchenPrinterDtos.kt `KitchenTicketDto`, the cloud's
 * `TicketIn`): to a kitchen printer here, to the shop's print server over the LAN, to the cloud relay — the same JSON
 * every way, drawn by whichever device prints it. And how a Windows sale becomes one (the Android till's
 * domain/KitchenMenu.kt `expand`: a meal goes as its components, each routed by its own product).
 *
 * Pure.
 */

import { kitchenOptionText, type SaleLine, type SaleOption } from '../sale';
import type { KitchenTicket, TicketLine } from '../kitchenTicketStyle';

/** A line as the routing sees it: the wire line, plus the routing's own facts (never sent). */
export interface KitchenLine extends TicketLine {
  productId: string;
  categoryId: string | null;
  /** The sale line it comes from (a meal's components share it); never sent. */
  lineId?: string | null;
  /** A held course's line ("ממתין ל-FIRE"): rides apart, never cooked. Windows sells none today. */
  waiting?: boolean;
}

/** The ticket on the wire: the Android DTO (`waiting`: held lines, `style`: a test print's own design). */
export interface WireTicket extends KitchenTicket {
  waiting?: TicketLine[] | null;
  style?: Record<string, unknown> | null;
}

/** The words the queue writes on a ticket (KitchenTicketLabels, Hebrew — the kitchen's language). */
export const LABELS = {
  /** A moved ticket's band: "הופנה מ: בר". */
  redirectedFrom: 'הופנה מ:',
  /** A ticket sent again after its print host moved or its answer was lost. */
  resent: 'הדפסה חוזרת — ייתכן שכבר הודפס',
  /** A person's reprint of a printed ticket. */
  reprint: 'הדפסה חוזרת',
  /** The till copy ("גם בקופה", `kitchenTicketsOnTill`) — read by the design's notice bands as a copy. */
  tillCopy: 'עותק קופה',
  /** The till's own printer, as a ticket names it. */
  till: 'קופה',
  /** A KDS-only shop's ticket printed because the KDS did not have the order. */
  kdsFallback: 'גיבוי KDS',
} as const;

const NOTICE_SEPARATOR = ' · ';

/** [part] after whatever band the ticket had, once however often it is added (KitchenFailover.resendNotice). */
export function withNotice(previous: string | null | undefined, part: string): string {
  const before = (previous ?? '').trim();
  if (!before) return part;
  return before.split(NOTICE_SEPARATOR).some((p) => p.trim() === part) || before.includes(part) ? before : `${before}${NOTICE_SEPARATOR}${part}`;
}

/** "הופנה מ: בר" after the band it had (KitchenFailover.notice). */
export function redirectNotice(fromName: string, previous: string | null | undefined): string {
  return withNotice(previous, `${LABELS.redirectedFrom} ${fromName}`);
}

const nonBlank = (s: string | null | undefined): string | null => (s && s.trim() ? s.trim() : null);

/** A choice as the kitchen reads it: "+ גבינה", "בלי בצל" (the Windows bon's own form, printDocs.bonTicket). */
function modsOf(options: readonly SaleOption[]): { mods: string[]; removals: string[] } {
  const mods: string[] = [];
  const removals: string[] = [];
  for (const o of options) {
    const text = kitchenOptionText(o);
    if (o.kind === 'removal' || text.startsWith('בלי ')) removals.push(text);
    else mods.push(`+ ${text}`);
  }
  return { mods, removals };
}

/**
 * A sale's lines as the kitchen gets them (KitchenMenu.expand): a plain line as one item, its choices as `mods` /
 * `removals`; a meal as one item per component — each routed by its own product and category — with the meal's
 * name and notes on each. A credit line, a line of nothing and a voucher's own mark never reach the kitchen.
 * [categoryOf]: the product's category NOW (printers hang on categories; a product moved since prints where it is).
 */
export function kitchenLinesOfSale(lines: readonly SaleLine[], categoryOf: (productId: string) => string | null = () => null): KitchenLine[] {
  const out: KitchenLine[] = [];
  for (const l of lines) {
    if (!(l.qty > 0)) continue;
    const notes = nonBlank(l.notes.filter((n) => n && n.trim()).join(NOTICE_SEPARATOR));
    const components = l.meal?.components ?? [];
    if (components.length > 0) {
      for (const c of components) {
        const { mods, removals } = modsOf(c.options);
        out.push({
          lineId: l.key,
          productId: c.productId,
          categoryId: categoryOf(c.productId) ?? c.categoryId ?? null,
          name: c.name,
          quantity: l.qty,
          notes,
          mods: mods.length > 0 ? mods : null,
          removals: removals.length > 0 ? removals : null,
          mealName: nonBlank(l.meal?.name ?? l.name),
        });
      }
      continue;
    }
    const { mods, removals } = modsOf(l.options);
    out.push({
      lineId: l.key,
      productId: l.productId,
      categoryId: categoryOf(l.productId) ?? l.categoryId ?? null,
      name: l.name,
      quantity: l.qty,
      notes,
      mods: mods.length > 0 ? mods : null,
      removals: removals.length > 0 ? removals : null,
    });
  }
  return out;
}

/** The line on the wire (KitchenTicketLine.toDto): only what the DTO has, nothing empty. */
export function wireLine(l: KitchenLine): TicketLine {
  const out: TicketLine = { productId: l.productId, categoryId: l.categoryId ?? null, name: l.name, quantity: l.quantity };
  if (nonBlank(l.notes ?? null)) out.notes = l.notes!.trim();
  if (l.mods && l.mods.length > 0) out.mods = [...l.mods];
  if (l.removals && l.removals.length > 0) out.removals = [...l.removals];
  if (l.important) out.important = true;
  if (l.allergies && l.allergies.length > 0) out.allergies = [...l.allergies];
  if (l.seat) out.seat = l.seat;
  if (l.course) out.course = l.course;
  if (l.courseId) out.courseId = l.courseId;
  if (l.mealName) out.mealName = l.mealName;
  if (l.refill) out.refill = l.refill;
  if (l.held) out.held = true;
  return out;
}

export interface SaleTicketInput {
  lines: KitchenLine[];
  /** The document number as the receipt prints it (`20000057`). */
  orderRef: string | null;
  /** Who sold it (the cashier / the kiosk's name). */
  waiterName: string | null;
  /** "2-047 · דנה" — the headline before the lines (a counter sale's name, a kiosk's pickup number). */
  customerName: string | null;
  dining: 'take_away' | 'eat_in' | null;
  notice?: string | null;
  createdAt: string;
  /** This device as it prints small on the ticket ("2 · בר"); the queue fills it when absent. */
  sourceName?: string | null;
}

/** A counter sale's ticket (KitchenPrintService.printSaleTickets / KioskBonService.queueTickets). */
export function saleTicket(i: SaleTicketInput): { ticket: WireTicket; lines: KitchenLine[] } {
  return {
    lines: i.lines,
    ticket: {
      source: 'sale',
      tableName: null,
      zoneName: null,
      guests: null,
      waiterName: nonBlank(i.waiterName),
      createdAt: i.createdAt,
      isAddition: false,
      lines: [],
      orderRef: nonBlank(i.orderRef),
      sourceName: nonBlank(i.sourceName ?? null),
      customerName: nonBlank(i.customerName),
      dining: i.dining,
      notice: nonBlank(i.notice ?? null),
    },
  };
}

/** "הזמנה A-17 · דנה · שולחן 5" — a kiosk order's headline (KioskBonService / KioskPayAtTillBon.headline). */
export function kioskBonHeadline(label: string | null, name: string | null, table: string | null): string {
  return [`הזמנה ${label ?? '?'}`, nonBlank(name), nonBlank(table) ? `שולחן ${table!.trim()}` : null].filter(Boolean).join(' · ');
}

/** "2 · בר": this device as a ticket names it (KitchenPrintService.tillName). */
export function tillNameOf(posNumber: string | null | undefined, machineName: string | null | undefined): string | null {
  const n = (posNumber ?? '').trim();
  const m = (machineName ?? '').trim();
  if (n && m) return `${n} · ${m}`;
  return m || n || null;
}
