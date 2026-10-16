/**
 * A kitchen ticket as the hidden print window draws it (renderer/print/draw.ts): the ticket, the look it prints in on
 * its printer and the paper — the design engine's draw operations (core/kitchenTicketStyle.ts `layoutTicket`, the
 * dashboard's preview engine) painted with the canvas's own text widths, then made 1-bit and ESC/POS in the main
 * process (core/kitchen/bytes.ts). One copy per page: "עותק 2 מתוך 3" is the design's own footer.
 */

import type { CategoryRef, CourseRef, KitchenTicket, TicketStyle } from '../kitchenTicketStyle';

export interface KitchenDoc {
  kind: 'kitchen';
  ticket: KitchenTicket;
  style: TicketStyle;
  /** The design engine's paper (58 / 80 mm). */
  paper: 58 | 80;
  printerName: string;
  copy: number;
  copies: number;
  cutPaper: boolean;
  /** §9: this device's courses and categories, to order a ticket by course / category / the manager's list. */
  courses?: CourseRef[];
  categories?: CategoryRef[];
}
