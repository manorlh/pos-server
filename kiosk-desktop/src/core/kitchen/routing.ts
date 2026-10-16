/**
 * Where each line of a kitchen ticket prints, and how a printer's job leaves this device — the port of pos-android
 * hardware/kitchen/KitchenRouting.kt (pos-server docs/SPEC_PROMOTIONS_TABLES_SHOPZ.md §4.4, SPEC_KIOSK.md §16.9).
 * Pure, over the last synced config: it runs offline.
 *
 * - Printers hang on whole categories. A line goes where its product's own list says (an empty own list is "no
 *   ticket"); otherwise where its category's does — the category it is in NOW — already inherited by the cloud.
 * - A line prints on every printer it routes to; each printer gets one ticket with only its lines. Printers out of
 *   this device's scope (`inScope` false) are ignored.
 * - [unroutedToTill] (a counter sale, tables off): a line routed nowhere prints on this device's own printer.
 * - `kitchenTicketsOnTill`: this device's ticket also carries every line that went to a kitchen printer.
 *
 * Windows (this app): this device's "own printer" is its receipt printer (the Windows spooler queue or a printer on
 * TCP 9100 it was set to) — the `till` and `usb` connections. Bluetooth printers are never reached from here: their
 * jobs go to the shop's print server (over the LAN, or the cloud).
 */

import type { KitchenConfig, KitchenPrinter, PrintHost } from './config';
import { DEFAULT_LAN_PORT } from './config';
import type { KitchenLine } from './tickets';

/** The pseudo-printer "this device's own printer": lines routed nowhere, the till copy. */
export const TILL_PRINTER_ID = 'till';

/** A printer of type `till` — this device's own (its receipt printer). */
export function tillPrinter(name: string): KitchenPrinter {
  return {
    id: TILL_PRINTER_ID,
    name,
    type: 'till',
    host: null,
    port: null,
    btAddress: null,
    btName: null,
    hostMachineId: null,
    hostConnection: null,
    hostMachineName: null,
    hostLanAddress: null,
    hostLanPort: null,
    isHost: false,
    inScope: true,
    paperWidth: 80,
    printWidthDots: null,
    copies: 1,
    cutPaper: true,
    beep: false,
    purpose: 'kitchen',
    cashDrawer: false,
    scope: 'machine',
    ticketDesign: null,
    ticketDesignId: null,
    ticketFontScale: null,
    ticketHeader: null,
    ticketCheckboxes: null,
    ticketElapsed: null,
    ticketFit: null,
    ticketMinTextSize: null,
    ticketMaxTextSize: null,
    ticketHeaderSize: null,
    ticketInlineMods: null,
    ticketOrder: null,
    ticketOrderList: null,
    ticketGroupHeaders: null,
    ticketNoCourse: null,
    ticketStyle: null,
  };
}

/** One printer's share of a ticket: the lines routed to it, in the ticket's order. */
export interface RoutedTicket {
  printer: KitchenPrinter;
  lines: KitchenLine[];
  /** A copy on this device of lines that also went elsewhere (`kitchenTicketsOnTill`). */
  isTillCopy: boolean;
}

/** How a printer's job leaves this device. */
export type JobRoute = 'DIRECT' | 'RELAY' | 'LAN';

/** Where on the shop's LAN a printer's jobs are handed over. */
export interface LanTarget {
  address: string;
  port: number;
}

/** One way a hand-over tries. */
export type HandOverStep = 'LAN' | 'DIRECT' | 'CLOUD';

const HOSTED = new Set(['cloud']);
/** The printers a shop's print server prints for the others. */
const SERVED = new Set(['network', 'bluetooth']);

/** The line's printers: its product's own list (an empty one is "no ticket"), else its category's. */
export function printerIdsFor(line: Pick<KitchenLine, 'productId' | 'categoryId'>, config: KitchenConfig): string[] {
  const own = config.productRoutes[line.productId];
  if (own !== undefined) return own;
  if (!line.categoryId) return [];
  return config.categoryRoutes[line.categoryId] ?? [];
}

/** The product was explicitly set to "no ticket" ("ללא בון"). */
export function isExplicitNone(line: Pick<KitchenLine, 'productId'>, config: KitchenConfig): boolean {
  const own = config.productRoutes[line.productId];
  return own !== undefined && own.length === 0;
}

/** Each printer to its zone redirect (when this device knows the target), deduplicated, in order. */
export function redirected(printerIds: readonly string[], redirect: Record<string, string>, known: (id: string) => boolean = () => true): string[] {
  const out: string[] = [];
  for (const p of printerIds) {
    const to = redirect[p];
    const id = to && known(to) ? to : p;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The printer is this device's own (its receipt printer, or a cloud printer it hosts on itself). */
export function printsOnThisTill(printer: KitchenPrinter): boolean {
  return printer.type === 'till' || (HOSTED.has(printer.type) && printer.isHost && (printer.hostConnection ?? 'till') === 'till');
}

/** KitchenRouting.split: the ticket's lines by printer. */
export function split(lines: readonly KitchenLine[], config: KitchenConfig, tillName = 'קופה', unroutedToTill = false, zoneId: string | null = null): RoutedTicket[] {
  const inScope = new Map(config.printers.filter((p) => p.inScope).map((p) => [p.id, p]));
  const known = new Map(config.printers.map((p) => [p.id, p]));
  const redirect = (zoneId && config.zoneRedirects[zoneId]) || {};
  const byPrinter = new Map<string, KitchenLine[]>();
  const routed: KitchenLine[] = [];
  const local: KitchenLine[] = [];
  for (const line of lines) {
    if (!(line.quantity > 0)) continue;
    const targets = redirected(
      printerIdsFor(line, config).filter((id) => inScope.has(id)),
      redirect,
      (id) => known.has(id),
    );
    if (targets.length === 0) {
      if (unroutedToTill && !isExplicitNone(line, config)) local.push(line);
      continue;
    }
    routed.push(line);
    for (const id of targets) {
      const list = byPrinter.get(id) ?? [];
      list.push(line);
      byPrinter.set(id, list);
    }
  }
  const tickets: RoutedTicket[] = [...byPrinter.entries()].map(([id, its]) => ({ printer: known.get(id)!, lines: its, isTillCopy: false }));
  const onThisTill = tickets.findIndex((t) => printsOnThisTill(t.printer));
  const copy = config.options.kitchenTicketsOnTill && routed.length > 0 && onThisTill < 0;
  if (local.length > 0 && onThisTill >= 0) {
    // A routed printer is this device's own: the unrouted lines join that ticket.
    const own = tickets[onThisTill];
    tickets[onThisTill] = { ...own, lines: lines.filter((l) => own.lines.includes(l) || local.includes(l)) };
  } else if (local.length > 0 || copy) {
    const its = copy ? lines.filter((l) => routed.includes(l) || local.includes(l)) : local;
    tickets.push({ printer: tillPrinter(tillName), lines: [...its], isTillCopy: copy && local.length === 0 });
  }
  // A printer with nothing to cook — only a held course's lines — gets no ticket.
  return tickets.filter((t) => t.lines.some((l) => !l.waiting));
}

/** The lines no kitchen printer takes on this device ("פריטים שלא נותבו למדפסת"), not "ללא בון" on purpose. */
export function unrouted(lines: readonly KitchenLine[], config: KitchenConfig, zoneId: string | null = null): KitchenLine[] {
  const inScope = new Set(config.printers.filter((p) => p.inScope).map((p) => p.id));
  const known = new Set(config.printers.map((p) => p.id));
  const redirect = (zoneId && config.zoneRedirects[zoneId]) || {};
  return lines.filter(
    (line) =>
      line.quantity > 0 &&
      !isExplicitNone(line, config) &&
      redirected(
        printerIdsFor(line, config).filter((id) => inScope.has(id)),
        redirect,
        (id) => known.has(id),
      ).length === 0,
  );
}

/** The tickets without this device's own share (lines routed nowhere, the till copy): a kiosk whose printer may not take its bon. */
export function withoutOwnShare(tickets: readonly RoutedTicket[]): RoutedTicket[] {
  return tickets.filter((t) => t.printer.id !== TILL_PRINTER_ID);
}

/** A printer that is this device's own wherever it stands: set for it alone, or a Bluetooth one. */
export function ownedHere(printer: KitchenPrinter): boolean {
  return printer.scope === 'machine' || printer.type === 'bluetooth';
}

/**
 * Printed here, relayed through the cloud (a cloud printer this device does not host), or — when the shop has a
 * print server and it is another device — sent to it over the LAN.
 */
export function routeOf(printer: KitchenPrinter, printHost: PrintHost | null = null): JobRoute {
  if (HOSTED.has(printer.type) && !printer.isHost) return lanTargetOf(printer, printHost) !== null ? 'LAN' : 'RELAY';
  if (printHost && printHost.offLan && SERVED.has(printer.type) && ownedHere(printer)) return 'DIRECT';
  if (printHost && !printHost.isSelf && SERVED.has(printer.type)) return 'LAN';
  return 'DIRECT';
}

/** Where on the LAN [printer]'s jobs go from this device, or null (no LAN way). */
export function lanTargetOf(printer: KitchenPrinter, printHost: PrintHost | null): LanTarget | null {
  if (printHost?.offLan) return null;
  if (HOSTED.has(printer.type) && !printer.isHost) {
    const server = printHost && !printHost.isSelf && printer.hostMachineId !== null && printHost.machineId === printer.hostMachineId ? printHost : null;
    const serverAddress = server?.lanAddress?.trim() || null;
    const reported = printer.hostLanAddress?.trim() || null;
    if (server && serverAddress) return { address: serverAddress, port: server.port };
    if (reported) return { address: reported, port: printer.hostLanPort ?? DEFAULT_LAN_PORT };
    return null;
  }
  if (printHost && !printHost.isSelf && SERVED.has(printer.type)) {
    const a = printHost.lanAddress?.trim();
    return a ? { address: a, port: printHost.port } : null;
  }
  return null;
}

/**
 * A LAN job's ways, in order, until one takes it — never two: the host on the LAN (when this device is on one and
 * knows where), the printer itself when this device reaches it, else the cloud relay. The job keeps its id on every
 * way, so a host that gets it twice (a LAN answer lost, then the cloud) prints it once.
 */
export function handOverSteps(printer: KitchenPrinter, printHost: PrintHost | null, onLan: boolean, reachableHere: boolean): HandOverStep[] {
  const steps: HandOverStep[] = [];
  if (onLan && lanTargetOf(printer, printHost) !== null) steps.push('LAN');
  const away = printHost?.offLan === true && !ownedHere(printer);
  if (reachableHere && SERVED.has(printer.type) && !away) steps.push('DIRECT');
  steps.push('CLOUD');
  return steps;
}

/** How this device physically reaches [printer]: network | bluetooth | till | usb; null for a cloud printer it does not host. */
export function connectionOf(printer: KitchenPrinter): string | null {
  if (HOSTED.has(printer.type)) return printer.isHost ? (printer.hostConnection ?? 'till') : null;
  return printer.type;
}

/** This device hosts a kitchen printer of its own: it takes the others' jobs for it (LAN and relay). */
export function hostsOwnPrinter(config: KitchenConfig): boolean {
  return config.printers.some((p) => HOSTED.has(p.type) && p.isHost && p.purpose !== 'receipt');
}

/** The cloud relays jobs to this device: it hosts a cloud kitchen printer, or it is the shop's print server. */
export function takesRelayedJobs(config: KitchenConfig): boolean {
  return config.printers.some((p) => HOSTED.has(p.type) && p.isHost && p.purpose !== 'receipt') || config.printHost?.isSelf === true;
}

/** The refusal's code on the wire (`{"detail": "not_the_print_server"}`, HTTP 409). */
export const NOT_PRINT_SERVER = 'not_the_print_server';

/** What a job that came over the LAN finds on this device. */
export type LanIntake = { kind: 'accepted'; printer: KitchenPrinter } | { kind: 'not_print_server' } | { kind: 'not_here' };

/**
 * The printer a job that came over the LAN prints on here, or a refusal: one this device's config has it print
 * (`isHost`); one it hosts that the config lacks, as the sender has it; and — only while this device is the shop's
 * print server — a network / Bluetooth printer the config lacks.
 */
export function lanIntake(printerId: string, sent: KitchenPrinter | null, config: KitchenConfig, myMachineId: string | null): LanIntake {
  const mine = config.printers.find((p) => p.id === printerId);
  if (mine?.isHost) return { kind: 'accepted', printer: mine };
  if (sent) {
    if (HOSTED.has(sent.type) && myMachineId !== null && sent.hostMachineId === myMachineId) {
      return { kind: 'accepted', printer: { ...sent, isHost: true, inScope: false, hostLanAddress: null, hostLanPort: null } };
    }
    if (SERVED.has(sent.type) && config.printHost?.isSelf === true) return { kind: 'accepted', printer: { ...sent, isHost: true, inScope: false } };
  }
  const type = mine?.type ?? sent?.type ?? null;
  return type !== null && SERVED.has(type) ? { kind: 'not_print_server' } : { kind: 'not_here' };
}
