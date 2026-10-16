/**
 * "עיצוב בון" for a kitchen printer (P:/specs/kitchen-ticket-designs.md §3, §6ג, §10): the look a ticket prints in on
 * a printer — the port of pos-android hardware/kitchen/KitchenTicketStyle.kt `KitchenTicketStyles.forPrinter` /
 * `fromWire`, over the design engine this app already shares with the dashboard (core/kitchenTicketStyle.ts — byte for
 * byte client/src/lib/kitchenTicketStyle.ts, pinned by server/tests/fixtures/kitchen_ticket_designs_golden.json):
 *
 *  - a test print's own style ("הדפסת ניסיון בעיצוב הזה") wins;
 *  - else the printer's style as the cloud resolved it (`ticketStyle`) — drawn by it alone;
 *  - else the printer's own design and choices over this device's till parameters (`kitchenTicketDesign`…), for a
 *    cloud that sends no resolved style.
 *
 * Lenient, as the Android till's: an element the wire lacks, or a value this build does not know, keeps its
 * template's own — a style never stops a ticket from printing. Pure.
 */

import {
  ALLERGY_STYLES,
  applyInkSaver,
  BAND_STYLES,
  DEFAULT_TEMPLATE,
  FITS,
  FONT_SCALE,
  GROUP_HEADERS,
  HEADER_FILLS,
  HEADER_SIZES,
  HELD_COURSE_STYLES,
  IMPORTANT_NOTE_STYLES,
  isTemplate,
  ITEM_DIVIDERS,
  LINE_LAYOUTS,
  MAX_TEXT_SIZES,
  MIN_TEXT_SIZES,
  MOD_LAYOUTS,
  MOD_MARKS,
  NO_COURSE,
  ORDER_BYS,
  parseHeader,
  parseOrderList,
  QTY_STYLES,
  resolveStyle,
  SEPARATORS,
  SPACINGS,
  WEIGHTS,
  GROUPINGS,
  type TemplateKey,
  type TicketOptions,
  type TicketStyle,
} from '../kitchenTicketStyle';
import type { KitchenPrinter } from './config';

/** The till parameters' defaults: a value equal to one is not taken as set (this device gets resolved values). */
const PARAM_DEFAULTS: Record<string, unknown> = {
  kitchenTicketFontScale: 100,
  kitchenTicketHeader: 'table,guests,waiter,time,till,order,customer',
  kitchenTicketCheckboxes: false,
  kitchenTicketElapsed: false,
  kitchenTicketFit: 'fit',
  kitchenTicketMinTextSize: 's',
  kitchenTicketMaxTextSize: 'm',
  kitchenTicketHeaderSize: 'm',
  kitchenTicketInlineMods: true,
  kitchenTicketOrder: 'added',
  kitchenTicketOrderList: '',
  kitchenTicketGroupHeaders: 'auto',
  kitchenTicketNoCourse: 'last',
};

/** The till parameters that were SET (differ from their defaults), and the ink saver as it resolves (on unless off). */
export function setParams(params: Record<string, unknown>): Record<string, unknown> {
  const set: Record<string, unknown> = { kitchenTicketInkSaver: params.kitchenTicketInkSaver !== false && params.kitchenTicketInkSaver !== 'false' };
  for (const [key, def] of Object.entries(PARAM_DEFAULTS)) {
    const v = params[key];
    if (v !== undefined && v !== null && v !== def) set[key] = v;
  }
  return set;
}

/** Values a wire element may take; anything else keeps the template's own. */
const ENUMS: Record<string, readonly string[]> = {
  fit: FITS,
  'header.size': HEADER_SIZES,
  'header.fill': HEADER_FILLS,
  'header.layout': LINE_LAYOUTS,
  'itemName.maxSize': MAX_TEXT_SIZES,
  'itemName.minSize': MIN_TEXT_SIZES,
  qty: QTY_STYLES,
  'mods.layout': MOD_LAYOUTS,
  'mods.marks': MOD_MARKS,
  'note.important': IMPORTANT_NOTE_STYLES,
  allergy: ALLERGY_STYLES,
  separators: SEPARATORS,
  separatorWeight: WEIGHTS,
  itemDivider: ITEM_DIVIDERS,
  spacing: SPACINGS,
  'order.by': ORDER_BYS,
  'order.noCourse': NO_COURSE,
  grouping: GROUPINGS,
  heldCourse: HELD_COURSE_STYLES,
  'footer.layout': LINE_LAYOUTS,
};

function overlay(base: Record<string, unknown>, wire: Record<string, unknown>, at: string): void {
  for (const [key, current] of Object.entries(base)) {
    if (!(key in wire)) continue;
    const value = wire[key];
    const path = at ? `${at}.${key}` : key;
    if (current && typeof current === 'object' && !Array.isArray(current)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) overlay(current as Record<string, unknown>, value as Record<string, unknown>, path);
      continue;
    }
    if (path.startsWith('bands.')) {
      if (typeof value === 'string' && BAND_STYLES.includes(value as never)) base[key] = value;
      continue;
    }
    const allowed = ENUMS[path];
    if (allowed) {
      if (typeof value === 'string' && allowed.includes(value)) base[key] = value;
      continue;
    }
    if (Array.isArray(current)) {
      if (Array.isArray(value)) base[key] = JSON.parse(JSON.stringify(value));
      continue;
    }
    if (current === null) {
      if (value === null || typeof value === 'string') base[key] = value;
      continue;
    }
    if (typeof value === typeof current) base[key] = value;
  }
}

/** The cloud's `ticketStyle`, over its template's look (lenient). */
export function fromWire(wire: Record<string, unknown>): TicketStyle {
  const template: TemplateKey = isTemplate(wire.template) ? wire.template : DEFAULT_TEMPLATE;
  const ink = typeof wire.inkSaver === 'boolean' ? wire.inkSaver : true;
  const base = resolveStyle(template, { params: { kitchenTicketInkSaver: false } }) as unknown as Record<string, unknown>;
  overlay(base, wire, '');
  const style = base as unknown as TicketStyle;
  style.template = template;
  style.inkSaver = ink;
  style.fontScale = Math.max(FONT_SCALE.min, Math.min(FONT_SCALE.max, Math.round(style.fontScale)));
  style.feedLines = Math.max(0, Math.min(6, Math.trunc(style.feedLines)));
  if (!style.header.fields.includes('table')) style.header.fields.unshift('table');
  if (ink) applyInkSaver(style);
  return style;
}

/** The printer's own choices (null: by the till parameters). */
export function printerOptions(p: KitchenPrinter): TicketOptions {
  const o: TicketOptions = {};
  if (p.ticketFontScale !== null) o.fontScale = Math.max(FONT_SCALE.min, Math.min(FONT_SCALE.max, p.ticketFontScale));
  if (p.ticketHeader !== null && p.ticketHeader !== undefined) o.header = parseHeader(p.ticketHeader);
  if (p.ticketCheckboxes !== null) o.checkboxes = p.ticketCheckboxes;
  if (p.ticketElapsed !== null) o.elapsed = p.ticketElapsed;
  if (p.ticketFit && FITS.includes(p.ticketFit as never)) o.fit = p.ticketFit as TicketOptions['fit'];
  if (p.ticketMinTextSize && MIN_TEXT_SIZES.includes(p.ticketMinTextSize as never)) o.minTextSize = p.ticketMinTextSize as TicketOptions['minTextSize'];
  if (p.ticketMaxTextSize && MAX_TEXT_SIZES.includes(p.ticketMaxTextSize as never)) o.maxTextSize = p.ticketMaxTextSize as TicketOptions['maxTextSize'];
  if (p.ticketHeaderSize && HEADER_SIZES.includes(p.ticketHeaderSize as never)) o.headerSize = p.ticketHeaderSize as TicketOptions['headerSize'];
  if (p.ticketInlineMods !== null) o.inlineMods = p.ticketInlineMods;
  if (p.ticketOrder && ORDER_BYS.includes(p.ticketOrder as never)) o.order = p.ticketOrder as TicketOptions['order'];
  if (p.ticketOrderList !== null && p.ticketOrderList !== undefined) o.orderList = parseOrderList(p.ticketOrderList);
  if (p.ticketGroupHeaders && GROUP_HEADERS.includes(p.ticketGroupHeaders as never)) o.groupHeaders = p.ticketGroupHeaders as TicketOptions['groupHeaders'];
  if (p.ticketNoCourse && NO_COURSE.includes(p.ticketNoCourse as never)) o.noCourse = p.ticketNoCourse as TicketOptions['noCourse'];
  return o;
}

/** The design a ticket prints in on [printer] (KitchenTicketStyles.forPrinter). */
export function styleForPrinter(printer: KitchenPrinter | null, params: Record<string, unknown>, jobStyle: Record<string, unknown> | null = null): TicketStyle {
  try {
    if (jobStyle && Object.keys(jobStyle).length > 0) return fromWire(jobStyle);
    if (printer?.ticketStyle && Object.keys(printer.ticketStyle).length > 0) return fromWire(printer.ticketStyle);
    const design = printer?.ticketDesign;
    const template: TemplateKey = isTemplate(design) ? design : isTemplate(params.kitchenTicketDesign) ? params.kitchenTicketDesign : DEFAULT_TEMPLATE;
    return resolveStyle(template, { params: setParams(params), printer: printer ? printerOptions(printer) : null });
  } catch {
    return resolveStyle(DEFAULT_TEMPLATE);
  }
}
