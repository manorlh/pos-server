/**
 * "עיצוב בון" on the Windows kiosk (pos-server P:/specs/kitchen-ticket-designs.md §10): the kiosk prints
 * its own kitchen bon on its own printer ("בון מטבח במדפסת הקיוסק"), so it draws it in the look its
 * till parameters give (`kitchenTicketDesign` and its options) — with the dashboard's preview engine,
 * byte for byte (client/src/lib/kitchenTicketStyle.ts), pinned by the shared golden
 * server/tests/fixtures/kitchen_ticket_designs_golden.json. A cloud that predates the designs: the bon
 * of before, unchanged.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bonDoc, bonTicket, kioskBonStyle, type BonInput } from '../src/core/printDocs';
import { blackParts, layoutText, layoutTicket, resolveStyle, TEMPLATES } from '../src/core/kitchenTicketStyle';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_LIB = path.join(here, '..', '..', 'client', 'src', 'lib', 'kitchenTicketStyle.ts');
const GOLDEN = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'kitchen_ticket_designs_golden.json');
const text = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const input = (over: Partial<BonInput> = {}): BonInput => ({
  pickupLabel: 'A-17',
  customerName: 'דנה',
  tableRef: null,
  documentNumber: '20000057',
  service: 'take_away',
  createdAt: new Date('2026-10-14T17:14:00Z'),
  kioskName: 'קיוסק 1',
  posNumber: '7',
  machineName: 'כניסה',
  lines: [
    { qty: 2, name: 'המבורגר', options: ['גבינה', 'בלי בצל'], notes: 'מדיום' },
    { qty: 1, name: 'צ׳יפס', options: [], notes: null },
  ],
  reprint: true,
  copy: 2,
  printerName: null,
  ...over,
});

describe("the kiosk draws the dashboard's look, byte for byte", () => {
  it('the engine is the client\'s copy', () => {
    if (!existsSync(CLIENT_LIB)) return; // a kiosk-desktop checkout alone
    expect(text(path.join(here, '..', 'src', 'core', 'kitchenTicketStyle.ts'))).toBe(text(CLIENT_LIB));
  });

  it("the templates' looks are the golden's", () => {
    if (!existsSync(GOLDEN)) return;
    const gold = JSON.parse(text(GOLDEN));
    for (const t of TEMPLATES) expect(resolveStyle(t)).toEqual(gold.styles[t]);
  });
});

describe('the kiosk bon in its design', () => {
  it('a cloud that predates the designs: the bon of before', () => {
    expect(kioskBonStyle({})).toBeNull();
    const doc = bonDoc(input(), kioskBonStyle({}));
    expect(doc.ticket).toBeUndefined();
    expect(doc.style).toBeUndefined();
    // The ticket of before with the ink saver off: drawn exactly as before too.
    expect(kioskBonStyle({ kitchenTicketDesign: 'classic_legacy', kitchenTicketInkSaver: false })).toBeNull();
  });

  it('the default: classic, no solid black', () => {
    const style = kioskBonStyle({ kitchenTicketDesign: 'classic', kitchenTicketInkSaver: true })!;
    expect(style).toEqual(resolveStyle('classic'));
    expect(blackParts(style)).toEqual([]);
    // A named design's id — the kiosk has no designs: classic.
    expect(kioskBonStyle({ kitchenTicketDesign: '5b0e4c1a-2f3d-4e5f-8a9b-0c1d2e3f4a5b' })!.template).toBe('classic');
  });

  it('the parameters that differ from their defaults lay over the template', () => {
    const style = kioskBonStyle({
      kitchenTicketDesign: 'courses',
      kitchenTicketCheckboxes: false, // the default: the template's own (on) stays
      kitchenTicketFontScale: 120,
      kitchenTicketInlineMods: false,
    })!;
    expect(style.checkboxes).toBe(true);
    expect(style.fontScale).toBe(120);
    expect(style.mods.layout).toBe('indent');
  });

  it('everything the kitchen must see is on it', () => {
    const style = kioskBonStyle({ kitchenTicketDesign: 'large' })!;
    const doc = bonDoc(input({ sub: 'ממתין לתשלום בקופה' }), style);
    expect(doc.ticket).toEqual(bonTicket(input({ sub: 'ממתין לתשלום בקופה' })));
    const said = layoutText(layoutTicket(doc.ticket!, doc.style!, { paper: 80 }));
    for (const must of ['הזמנה A-17 · דנה', 'לקחת', 'הדפסה חוזרת', 'עותק 2', 'ממתין לתשלום בקופה', 'המבורגר', 'גבינה', 'בצל', 'מדיום', 'קיוסק 1', '7 · כניסה']) {
      expect(said).toContain(must);
    }
    const paid = bonTicket(input({ reprint: false, copy: 1 }));
    expect(paid.orderRef).toBe('20000057');
    expect(paid.notice).toBeNull();
  });
});
