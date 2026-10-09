import { describe, expect, it } from 'vitest';
import { bonDoc, documentTitleFor, footerLines, receiptDoc, receiptQty, regLabel, slipDoc, zDoc, type BusinessInfo } from '../src/core/printDocs';

const business: BusinessInfo = {
  companyName: 'רויאל בר',
  vatNumber: '515555555',
  companyRegNumber: null,
  companyAddress: 'הרצל',
  companyAddressNumber: '1',
  companyCity: 'הרצליה',
  companyZip: null,
  phone: null,
  dealerType: 'licensed',
  branchId: '2',
};

describe('the receipt (ReceiptRenderer, 320)', () => {
  const base: Parameters<typeof receiptDoc>[0] = {
    documentType: 320,
    number: '40000057',
    copy: 'original',
    issuedAt: new Date(2026, 9, 6, 9, 14),
    printedAt: new Date(2026, 9, 6, 9, 15),
    cashierName: 'קיוסק Windows',
    business,
    lines: [
      { name: 'המבורגר', qty: 1, unitAgorot: 4200, totalAgorot: 4200, paid: [{ text: 'גבינה', priceAgorot: 400 }] },
      { name: 'צ׳יפס', qty: 2, unitAgorot: 2350, totalAgorot: 4700, paid: [] },
    ],
    totalAgorot: 8900,
    netAgorot: 7542,
    vatAgorot: 1358,
    vatRate: 0.18,
    tipAgorot: 0,
    card: { brand: 'visa', last4: '1234', authNum: '0123456', payments: null, firstPaymentAgorot: null },
    footer: [null, ''],
    logoUrl: null,
  };
  const doc = receiptDoc(base);
  const texts = doc.ops.map((o) => ('text' in o ? o.text : 'label' in o ? `${o.label}|${o.value}` : o.t));

  it('prints the till’s lines in the till’s order', () => {
    expect(texts.indexOf('רויאל בר')).toBeLessThan(texts.indexOf('חשבונית מס/קבלה'));
    expect(texts).toContain('עוסק מורשה 515555555');
    expect(texts).toContain('הרצל 1');
    expect(texts).toContain('מקור');
    expect(texts).toContain('#|40000057');
    expect(texts).toContain('תאריך הנפקה:|2026-10-06 09:14');
    expect(texts).toContain('מלצר/ית|קיוסק Windows');
    expect(texts).toContain('גבינה|(+4.00)');
    expect(texts).toContain('2 × 23.50|47.00');
    expect(texts).toContain('סה"כ פריטים לתשלום|89.00');
    expect(texts).toContain('סה"כ לפני מע"מ|75.42');
    expect(texts).toContain('מע"מ 18%|13.58');
    expect(texts).toContain('סה"כ לתשלום|₪89.00');
    expect(texts).toContain('כרטיס אשראי|89.00');
    expect(texts).toContain('כרטיס|ויזה **** 1234');
    expect(texts).toContain('אישור|0123456');
    expect(texts).toContain('ראנר מערכות קופות ממוחשבות');
    expect(texts).not.toContain('טלפון: 054-2666669'); // "" drops the line
  });

  it('no order number unless given: then "מספר הזמנה" and the number big, before the document title', () => {
    expect(texts).not.toContain('מספר הזמנה');
    const numbered = receiptDoc({ ...base, orderNumber: 'A-12' });
    const t = numbered.ops.map((o) => ('text' in o ? o.text : o.t));
    expect(t.indexOf('מספר הזמנה')).toBeLessThan(t.indexOf('חשבונית מס/קבלה'));
    expect(numbered.ops[t.indexOf('מספר הזמנה') + 1]).toMatchObject({ t: 'text', style: 'number', align: 'center' });
    expect(t).toContain('⁦A-12⁩');
    // Blank is none.
    expect(receiptDoc({ ...base, orderNumber: '  ' }).ops).toEqual(doc.ops);
  });

  it('labels, titles and quantities as the till', () => {
    expect(documentTitleFor(320)).toBe('חשבונית מס/קבלה');
    expect(documentTitleFor(400)).toBe('קבלה');
    expect(regLabel(320, 'company')).toBe('ח.פ.');
    expect(regLabel(400, 'exempt')).toBe('עוסק פטור');
    expect(receiptQty(2)).toBe('2');
    expect(receiptQty(0.75)).toBe('0.75');
    expect(footerLines([null, null])).toHaveLength(2);
  });
});

describe('the kiosk bon and the pickup slip', () => {
  it('"הזמנה A-17 · דנה · שולחן 5", the sale number, the service band, removals apart', () => {
    const b = bonDoc({
      pickupLabel: 'A-17',
      customerName: 'דנה',
      tableRef: '5',
      documentNumber: '40000057',
      service: 'eat_in',
      createdAt: new Date(2026, 9, 6, 9, 15),
      kioskName: 'קיוסק',
      posNumber: '4',
      machineName: 'קיוסק Windows',
      lines: [{ qty: 1, name: 'המבורגר', options: ['גבינה', 'בלי בצל'], notes: 'חתוך לחצי' }],
      reprint: true,
      copy: 2,
      printerName: null,
    });
    expect(b.title).toBe('הזמנה A-17 · דנה · שולחן 5');
    expect(b.sub).toContain('#40000057');
    expect(b.notice).toBe('הדפסה חוזרת · עותק 2');
    expect(b.dining).toBe('eat_in');
    expect(b.lines[0]).toMatchObject({ mods: ['+ גבינה'], removals: ['בלי בצל'], notes: 'חתוך לחצי' });
    expect(b.foot).toContain('קופה: 4 · קיוסק Windows');
  });

  it('the slip: the number big, the service, items and total', () => {
    const s = slipDoc({ businessName: 'רויאל בר', pickupLabel: 'A-17', service: 'take_away', itemCount: 3, totalAgorot: 8900 });
    expect(s.label).toContain('A-17');
    expect(s.service).toBe('טייק אווי');
    expect(s.summary).toContain('3 פריטים');
    expect(s.summary).toContain('₪89.00');
  });

  it('the Z: its number, the document ranges per type, the card transmission', () => {
    const z = zDoc(
      {
        machineSequenceNumber: 8,
        businessDate: '2026-10-06',
        transactionsCount: 3,
        grossSales: '89.00',
        discountsTotal: '0.00',
        totalRefunds: '0.00',
        netSales: '89.00',
        totalCashSales: '0.00',
        totalCardSales: '89.00',
        vatTotal: '13.58',
        openingCash: '0.00',
        expectedCash: '0.00',
        actualCash: '0.00',
        perMachine: [{ documentRanges: [{ documentType: 320, first: '40000055', last: '40000057', count: 3 }] }],
        cardTransmission: { outcome: 'success', batchNumber: '123' },
        createdByName: 'קיוסק · רויאל',
      },
      { business, shopName: 'סניף 2', posNumber: '4', machineName: null, copy: false, logoUrl: null, printedAt: new Date(2026, 9, 6, 23, 31) },
    );
    const t = z.ops.map((o) => (o.t === 'centred' ? o.text : o.t === 'row' ? `${o.label}|${o.value}` : '—'));
    expect(t).toContain('דו״ח Z מס׳ 8');
    expect(t).toContain('חשבוניות מס קבלה|40000055–40000057');
    expect(t).toContain('כרטיס אשראי|₪89.00');
    expect(t).toContain('שידור אשראי|אושר — אצווה 123');
    expect(t).toContain('הופק ע״י קיוסק · רויאל');
  });
});
