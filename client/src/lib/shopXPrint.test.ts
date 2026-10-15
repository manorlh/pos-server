/**
 * Run with `npm test`. "דוח X סניפי" on the dashboard (lib/shopXPrint.ts; P:/specs/shop-x-report.md §4):
 * the warnings apart, the summary, each till folded, and the strip printed as the till prints it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isTillSection, printableHtml, splitSections, type ShopXPrintDocument } from './shopXPrint';

const doc: ShopXPrintDocument = {
  title: 'דוח X סניפי',
  number: null,
  businessName: 'מסעדה <טובה>',
  subtitle: ['דוח X סניפי — דוח ביניים, אינו סוגר יום'],
  sections: [
    { title: 'אזהרות — קופות שלא עודכנו', rows: [{ label: 'קופה 2', value: 'לא עודכנה מאז 20:10', emphasis: true }] },
    { title: 'מכירות', rows: [{ label: 'סה״כ נטו', value: '₪263.00', emphasis: true }] },
    { title: 'קופה', rows: [{ label: 'מזומן צפוי', value: '₪353.00', emphasis: true }] },
    { title: 'קופה 1 · Till 1', rows: [] },
    { title: 'קיוסק לובי', rows: [] },
  ],
  footer: ['הופק ע״י רותי בקופה 2, 14/10/2026 20:15', 'סוף דוח X סניפי'],
};

describe('the shop X on the dashboard', () => {
  it('folds the tills apart from the summary, the drawer block ("קופה") stays in the summary', () => {
    assert.equal(isTillSection('קופה'), false);
    assert.equal(isTillSection('קופה 3'), true);
    assert.equal(isTillSection('קיוסק לובי'), true);
    const parts = splitSections(doc);
    assert.deepEqual(parts.summary.map((s) => s.title), ['מכירות', 'קופה']);
    assert.deepEqual(parts.tills.map((s) => s.title), ['קופה 1 · Till 1', 'קיוסק לובי']);
  });

  it('prints the strip RTL, escaped, with its footer', () => {
    const html = printableHtml(doc);
    assert.match(html, /dir="rtl"/);
    assert.match(html, /מסעדה &lt;טובה&gt;/);
    assert.match(html, /סוף דוח X סניפי/);
    assert.match(html, /<tr class="b"><td>סה״כ נטו<\/td><td>₪263.00<\/td><\/tr>/);
  });
});
