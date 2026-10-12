/**
 * Run with `npm test`. "סיכום השובר": the same plain sentences wherever a voucher is set up or shown —
 * a punch card (the owner's 6 of 50), a list, a package, one of several, a discount; the till's pricing,
 * the stacking, the validity and the shops.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { namesText, summaryIsPerGroup, summaryIsPunchCard, validityText, voucherSummary, voucherSummaryText, type SummaryInput } from './voucherSummary';

const punch: SummaryInput = {
  kind: 'items', selection: 'groups', totalQty: 50, splitAllowed: true,
  groups: [{ name: 'פריטים', minQty: 1, maxQty: 50, allowRepeat: true, names: ['מזון'] }],
};

describe('voucherSummary', () => {
  it('a punch card: up to 50 from the approved items, 6 approved in a sale use 6 in one scan', () => {
    assert.ok(summaryIsPunchCard(punch));
    const [what] = voucherSummary(punch);
    assert.equal(what, "כרטיסייה: עד 50 פריטים מתוך 'מזון', לאורך כל חיי השובר. כל פריט שנמסר הוא שימוש אחד: "
      + 'בעסקה עם 6 פריטים מאושרים ינוצלו 6 שימושים בסריקה אחת (עד היתרה), והיתרה נשמרת לפעמים הבאות.');
  });

  it('the owner\'s example in full: stacking, validity and the shops', () => {
    const text = voucherSummaryText({
      ...punch, stacking: 'unlimited', maxVouchersPerSale: 10, validFrom: '2026-11-01', validUntil: '2026-12-31', shopNames: null,
    });
    assert.match(text, /ניתן לשלב עד 10 שוברים בעסקה, גם מאותה סדרה\./);
    assert.match(text, /תקף 01\/11–31\/12\/2026 בכל הסניפים\./);
  });

  it('a small punch card says its own quota in the example; a whole menu with an exclusion', () => {
    const [what] = voucherSummary({ ...punch, totalQty: 4, groups: [{ name: 'פריטים', minQty: 1, maxQty: 4, allItems: true, names: [], excluded: ['אלכוהול'] }] });
    assert.match(what, /^כרטיסייה: עד 4 פריטים מתוך כל התפריט חוץ מ-'אלכוהול'/);
    assert.match(what, /בעסקה עם 4 פריטים מאושרים ינוצלו 4 שימושים/);
  });

  it('a punch card in one sale: at least one item each time, the rest stays (the cloud\'s rule)', () => {
    const [what] = voucherSummary({ ...punch, splitAllowed: false });
    assert.match(what, /מימוש בעסקה אחת: בכל עסקה לפחות פריט אחד, והיתרה נשמרת\./);
  });

  it('not a punch card: the same item once, or a minimum of all of it', () => {
    assert.equal(summaryIsPunchCard({ ...punch, groups: [{ ...punch.groups![0], allowRepeat: false }] }), false);
    assert.equal(summaryIsPunchCard({ ...punch, groups: [{ ...punch.groups![0], minQty: 50 }] }), false);
    assert.equal(summaryIsPunchCard({ ...punch, totalQty: 10 }), false);
  });

  it('a package of three, whole in one sale', () => {
    const [what] = voucherSummary({
      kind: 'items', selection: 'groups', splitAllowed: false, groups: [
        { name: 'מנה', minQty: 1, maxQty: 1, names: ['מנות עיקריות'] },
        { name: 'תוספת', minQty: 1, maxQty: 1, names: ['צ׳יפס', 'סלט'] },
        { name: 'משקה', minQty: 1, maxQty: 1, names: ['שתייה קלה'] },
      ],
    });
    assert.equal(what, "חבילה: 1 מנה (מתוך 'מנות עיקריות') + 1 תוספת (מתוך 'צ׳יפס' ו-'סלט') + 1 משקה (מתוך 'שתייה קלה'). "
      + 'מימוש בעסקה אחת: בכל עסקה צריך להשלים את המינימום של כל קבוצה.');
  });

  it('one item of several', () => {
    const [what] = voucherSummary({ kind: 'items', selection: 'groups', totalQty: 1, groups: [{ name: 'פריט לבחירה', minQty: 1, maxQty: 1, names: ['קפה', 'מאפה'] }] });
    assert.equal(what, "פריט אחד לבחירה מתוך 'קפה' ו-'מאפה'.");
  });

  it('a fixed list, in one sale or in parts', () => {
    const items = [{ name: 'נקניקייה', quantity: 1 }, { name: 'שתייה', quantity: 2 }];
    assert.equal(voucherSummary({ kind: 'items', items })[0], 'שובר פריטים: נקניקייה + 2× שתייה. מימוש בעסקה אחת: מה שלא נלקח בעסקה אובד (באישור הקופאי).');
    assert.match(voucherSummary({ kind: 'items', items, splitAllowed: true })[0], /מימוש בחלקים: מה שלא נלקח בעסקה נשמר לפעם הבאה\.$/);
    assert.equal(voucherSummary({ kind: 'items', items: [] })[0], 'שובר פריטים: עוד לא נבחרו פריטים.');
  });

  it('the till: a fixed value, a cover with or without a cap, the accounting', () => {
    assert.equal(voucherSummary({ kind: 'items', items: [{ name: 'x', quantity: 1 }], pricing: 'fixed', tillValue: 60, accounting: 'discount' })[1],
      'בקופה: שווי קבוע ₪60 — הפריטים שמומשו מסתכמים בשווי השובר; נרשם כקיזוז מהחשבונית.');
    assert.equal(voucherSummary({ ...punch, pricing: 'cover', tillValue: null, accounting: 'payment' })[1],
      'בקופה: כל פריט מכוסה במחיר התפריט, בלי תקרה; נרשם כאמצעי התשלום "שובר הפקה".');
    assert.equal(voucherSummary({ kind: 'items', items: [{ name: 'x', quantity: 1 }], pricing: 'cover', tillValue: 30, allowTopUp: false, includeExtras: true })[1],
      'בקופה: השובר מכסה עד ₪30 לפי מחירי התפריט; בחירה יקרה יותר חסומה, כולל תוספות בתשלום.');
  });

  it('a discount voucher: its benefit and its uses, no till pricing sentence', () => {
    const s = voucherSummary({ kind: 'order_discount', benefit: '₪30 הנחה על כל ההזמנה', usesPerVoucher: 5, maxUsesPerSale: 2, maxUsesPerDay: 3, stacking: 'single' });
    assert.deepEqual(s, ['שובר הנחה: ₪30 הנחה על כל ההזמנה. 5 שימושים בשובר (עד 2 בעסקה, עד 3 ביום).', 'שובר אחד בעסקה.']);
    assert.equal(voucherSummary({ kind: 'order_discount', benefit: '10% הנחה על כל ההזמנה' })[0], 'שובר הנחה: 10% הנחה על כל ההזמנה. שימוש אחד בשובר.');
  });

  it('a batch: its count first; shops by name; offline', () => {
    const s = voucherSummary({ ...punch, count: 200, shopNames: ['תל אביב', 'חיפה'], validUntil: '2026-12-31', offlineAllowed: true });
    assert.equal(s[0], 'סדרה של 200 שוברים.');
    assert.equal(s[s.length - 1], "תקף עד 31/12/2026 בסניפים 'תל אביב' ו-'חיפה'. ניתן לממש גם בלי אינטרנט, בקופה שהסדרה משויכת אליה.");
  });

  it('a type (no validity or shops): no where-sentence', () => {
    const s = voucherSummary({ ...punch, stacking: 'unlimited' });
    assert.equal(s.length, 3);
    assert.ok(s.every((x) => !/תקף|סניפים/.test(x)));
  });
});

describe('helpers', () => {
  it('validityText: same year short, other years full, one end, none', () => {
    assert.equal(validityText('2026-11-01', '2026-12-31'), '01/11–31/12/2026');
    assert.equal(validityText('2026-12-01', '2027-01-31'), '01/12/2026–31/01/2027');
    assert.equal(validityText('01/11/2026', null), 'מ-01/11/2026');
    assert.equal(validityText(null, '2026-12-31'), 'עד 31/12/2026');
    assert.equal(validityText(null, undefined), null);
  });

  it('namesText: quoted, "ו-" before the last, "ועוד" past three', () => {
    assert.equal(namesText(['מזון']), "'מזון'");
    assert.equal(namesText(['א', 'ב', 'ג', 'ד', 'ה']), "'א', 'ב', 'ג' ועוד 2");
    assert.equal(namesText([]), '');
  });
});

describe('"פריט אחד מכל קבוצה" (P:/specs/voucher-one-per-group.md §4.5)', () => {
  const perGroup: SummaryInput = {
    kind: 'items', selection: 'groups', totalQty: 2, splitAllowed: false, groups: [
      { name: 'מזון', minQty: 0, maxQty: 1, names: ['נקניקייה', 'המבורגר'], categories: [], products: ['נקניקייה', 'המבורגר'] },
      { name: 'שתייה', minQty: 0, maxQty: 1, names: ['משקאות'], categories: ['משקאות'], products: [] },
    ],
  };

  it('the spec\'s line: the groups, departments as "מחלקת …", one from each, in one sale', () => {
    assert.ok(summaryIsPerGroup(perGroup));
    assert.equal(voucherSummary(perGroup)[0],
      'עד 2 פריטים · פריט אחד מכל קבוצה: מזון (נקניקייה, המבורגר), שתייה (מחלקת משקאות) · לא ניתן לממש שני פריטים מאותה קבוצה · מימוש בעסקה אחת.');
  });

  it('in parts; more than three names "+N"; an exclusion; the whole menu', () => {
    const [what] = voucherSummary({
      ...perGroup, splitAllowed: true, groups: [
        { name: 'שתייה', minQty: 0, maxQty: 1, names: [], products: ['קולה', 'ספרייט', 'מים', 'סודה', 'תה', 'קפה', 'מיץ'] },
        { name: 'מזון', minQty: 0, maxQty: 1, names: [], categories: ['משקאות'], products: [], excluded: ['בירה'] },
        { name: 'קינוח', minQty: 0, maxQty: 1, names: [], allItems: true },
      ], totalQty: 3,
    });
    assert.equal(what, 'עד 3 פריטים · פריט אחד מכל קבוצה: שתייה (קולה, ספרייט, מים +4), מזון (מחלקת משקאות, בלי בירה), קינוח (כל התפריט) '
      + '· לא ניתן לממש שני פריטים מאותה קבוצה · מימוש בחלקים.');
  });

  it('the meal (every group a must), one of several and free numbers keep their own words', () => {
    const meal = { ...perGroup, totalQty: null, groups: perGroup.groups!.map((g) => ({ ...g, minQty: 1 })) };
    assert.equal(summaryIsPerGroup(meal), false);
    assert.match(voucherSummary(meal)[0], /^חבילה: /);
    assert.equal(summaryIsPerGroup({ ...perGroup, totalQty: 1 }), false);
    assert.equal(summaryIsPerGroup({ ...perGroup, totalQty: 3, groups: [{ ...perGroup.groups![0], maxQty: 2 }, perGroup.groups![1]] }), false);
    assert.equal(summaryIsPerGroup({ ...perGroup, kind: 'order_discount' }), false);
  });

  it('names without the split say them as products', () => {
    const [what] = voucherSummary({ ...perGroup, groups: perGroup.groups!.map((g) => ({ name: g.name, minQty: 0, maxQty: 1, names: g.names })) });
    assert.match(what, /מזון \(נקניקייה, המבורגר\), שתייה \(משקאות\)/);
  });
});
