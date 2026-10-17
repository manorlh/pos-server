/**
 * "בירור יתרת שובר" (core/till/voucherBalance.ts, main/till/tillVoucherBalance.ts, screens/VoucherBalanceScreen.tsx) — the
 * Android till's VoucherBalance.kt / VoucherBalanceScreen.kt / VoucherBalanceTest.kt: the menu's switch, the status in its
 * colour and words, what is left, the history read defensively; the service over the real engine with a fake cloud — read
 * only (a lookup, never a hold or a redemption), offline said, a wrong code said; and the screen's markup.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VOUCHER_BALANCE_STATUS,
  balanceCodeOf,
  parseVoucherHistory,
  prepaidVoucherCodeOf,
  typedByHand,
  voucherBalanceCard,
  voucherBalanceCheckEnabled,
  voucherBalanceQuotaText,
  voucherBalanceRefusalText,
  voucherBalanceStatus,
  voucherHistoryText,
  voucherLastRedeemedText,
  type VoucherBalanceState,
} from '../src/core/till/voucherBalance';
import { TillVoucherBalance } from '../src/main/till/tillVoucherBalance';
import { VoucherBalanceScreen } from '../src/renderer/roles/till/screens/VoucherBalanceScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const fmt = (s: string | null | undefined) => (s ? s.slice(0, 16).replace('T', ' ') : null);
const op = (name: string) => name as TillOp;
const CODE = 'ABCD-EFGH-2345-6789';

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

describe('the pure rules (VoucherBalanceTest)', () => {
  it('the menu entry shows only when the cloud switches it on', () => {
    expect(voucherBalanceCheckEnabled({})).toBe(false);
    expect(voucherBalanceCheckEnabled({ voucherBalanceCheckEnabled: 'false' })).toBe(false);
    expect(voucherBalanceCheckEnabled({ voucherBalanceCheckEnabled: 'auto' })).toBe(false);
    expect(voucherBalanceCheckEnabled({ voucherBalanceCheckEnabled: 'true' })).toBe(true);
    expect(voucherBalanceCheckEnabled({ voucherBalanceCheckEnabled: ' TRUE ' })).toBe(true);
    expect(voucherBalanceCheckEnabled({ voucherBalanceCheckEnabled: true })).toBe(true);
  });

  it('each status in its colour and words', () => {
    expect(voucherBalanceStatus(true, null, 'active')).toBe('active');
    expect(VOUCHER_BALANCE_STATUS.active.tone).toBe('green');
    expect(voucherBalanceStatus(true, null, 'partially_used')).toBe('partial');
    expect(voucherBalanceStatus(true, null, 'active', false, true)).toBe('partial');
    expect(VOUCHER_BALANCE_STATUS.partial.tone).toBe('orange');
    const used = voucherBalanceStatus(false, 'prepaid_voucher_used', 'used');
    expect(used).toBe('used');
    expect(VOUCHER_BALANCE_STATUS[used].text).toBe('השובר כבר מומש במלואו — אין יתרה');
    expect(VOUCHER_BALANCE_STATUS[used].tone).toBe('red');
    // Nothing left on any item, whatever the code: used.
    expect(voucherBalanceStatus(false, null, 'active', true)).toBe('used');
    expect(VOUCHER_BALANCE_STATUS[voucherBalanceStatus(false, 'prepaid_voucher_cancelled', null)].text).toBe('השובר בוטל — לא ניתן לממש אותו');
    expect(VOUCHER_BALANCE_STATUS[voucherBalanceStatus(false, 'prepaid_voucher_expired', null)].text).toBe('פג תוקף השובר — לא ניתן לממש אותו');
    expect(voucherBalanceStatus(false, 'prepaid_voucher_not_yet_valid', 'active')).toBe('not_yet_valid');
    // Valid, just not here (another point of sale, in use): orange, the cloud's words beside it.
    const elsewhere = voucherBalanceStatus(false, 'prepaid_voucher_wrong_shop', 'active');
    expect(elsewhere).toBe('not_here');
    expect(VOUCHER_BALANCE_STATUS[elsewhere].tone).toBe('orange');
    expect(voucherBalanceQuotaText({ quota: 5, used: 2, remaining: 3 })).toBe('מכסה 5 | מומשו 2 | נותרו 3');
  });

  it('the history is read defensively, newest first, and said in one line each', () => {
    const raw = [
      {
        id: 'r2',
        at: '2026-10-11T19:14:00Z',
        machineName: 'קופה 3',
        shopName: 'סניף מרכז',
        posUserName: 'דנה',
        quantity: 2,
        items: [
          { productId: 'p1', name: 'המבורגר', quantity: 1 },
          { productId: 'p2', name: 'קולה', quantity: 1 },
        ],
        amountAgorot: 4500,
        status: 'redeemed',
        reversedAt: null,
        documentNumber: '1234',
      },
      { at: '2026-10-10T08:00:00Z', machineName: 'קופה 1', shopName: 'סניף מרכז', quantity: 1, items: [{ name: 'קולה', quantity: 1 }], status: 'reversed' },
      'junk',
      { nothing: true },
    ];
    const hist = parseVoucherHistory(raw);
    expect(hist).toHaveLength(2);
    expect(hist[0].machineName).toBe('קופה 3');
    expect(hist[0].items).toEqual([
      ['המבורגר', 1],
      ['קולה', 1],
    ]);
    expect(hist[0].amountAgorot).toBe(4500);
    expect(hist[1].status).toBe('reversed');
    expect(voucherLastRedeemedText(hist, '2026-10-11T19:14:00Z', fmt)).toBe('מומש לאחרונה: 2026-10-11 19:14 · קופה 3 · סניף מרכז');
    expect(voucherHistoryText(hist[0], fmt)).toBe('2026-10-11 19:14 · קופה 3 · סניף מרכז · דנה — 1× המבורגר, 1× קולה · ₪45 · מסמך 1234');
    // A discount voucher's uses (no goods).
    const uses = parseVoucherHistory([{ at: '2026-10-09T10:00:00Z', machineName: 'קופה 2', uses: 2.0, status: 'redeemed' }]);
    expect(voucherHistoryText(uses[0], fmt)).toBe('2026-10-09 10:00 · קופה 2 — 2 שימושים');
    expect(voucherHistoryText(hist[1], fmt).endsWith('(בוטל)')).toBe(true);
    // Absent, or not a list: no history, the section hidden.
    expect(parseVoucherHistory(null)).toEqual([]);
    expect(parseVoucherHistory({ at: 'x' })).toEqual([]);
    expect(voucherLastRedeemedText([], null, fmt)).toBeNull();
  });

  it('a code: "PV:" is a voucher; typed — 16 characters of the alphabet; a product barcode is not one', () => {
    expect(prepaidVoucherCodeOf('PV:ABCD-EFGH-2345-6789')).toBe('ABCDEFGH23456789');
    expect(prepaidVoucherCodeOf('pv:abcdefgh23456789')).toBe('ABCDEFGH23456789');
    // A "PV:" scan that is not a valid code still goes to the cloud ("לא נמצא").
    expect(prepaidVoucherCodeOf('PV:XYZ')).toBe('XYZ');
    expect(prepaidVoucherCodeOf('ABCD-EFGH-2345-6789')).toBeNull();
    expect(prepaidVoucherCodeOf('ABCD-EFGH-2345-6789', true)).toBe('ABCDEFGH23456789');
    // Digits only, a 0/O or 1/I, the wrong length: not a code.
    expect(prepaidVoucherCodeOf('2345678923456789', true)).toBeNull();
    expect(prepaidVoucherCodeOf('ABCD-EFGH-2345-678O', true)).toBeNull();
    expect(prepaidVoucherCodeOf('ABCDEFGH', true)).toBeNull();
    expect(balanceCodeOf('7290000000011', false)).toEqual({ error: 'זה ברקוד של מוצר, לא של שובר. סרקו את הברקוד שעל השובר.' });
    expect(balanceCodeOf('ABCD', true)).toEqual({ error: 'הקוד אינו תקין — 16 תווים, כפי שמודפס על השובר.' });
    expect(balanceCodeOf(']Q1PV:ABCDEFGH23456789\r', false)).toEqual({ code: 'ABCDEFGH23456789' });
    expect(typedByHand('PV:ABC')).toBe(false);
    expect(typedByHand('7290000000011')).toBe(false);
    expect(typedByHand(CODE)).toBe(true);
  });

  it('the card: number, names, the dead red banner, what is left — by quota, per item, a discount voucher\'s uses', () => {
    const groups = voucherBalanceCard(
      { id: 'v', serial: 8, typeName: 'שובר ארוחה', eventName: 'פסטיבל', productionName: 'קייטרינג אלון', validUntil: '2026-12-31T21:59:00Z', redeemable: true, status: 'active', selection: 'groups', totalMax: 5, totalRemaining: 3, groups: [{ key: 'g', name: 'מנה', maxQty: 5, remaining: 3 }] },
      fmt,
    );
    expect(groups.serial).toBe('שובר מס׳ 8');
    expect(groups.production).toBe('הפקה: קייטרינג אלון');
    expect(groups.validUntil).toBe('בתוקף עד 2026-12-31 21:59');
    expect(groups.status).toEqual({ text: 'מומש חלקית', tone: 'orange', dead: false, detail: null });
    expect(groups.left).toEqual(['מכסה 5 | מומשו 2 | נותרו 3']);
    expect(groups.redeemable).toBe(true);
    const items = voucherBalanceCard({ id: 'v', serial: 3, redeemable: false, reason: 'prepaid_voucher_used', message: 'מומש בקופה 2 ב־11.10', items: [{ productId: 'p', name: 'נקניקייה', quantity: 2, remaining: 0 }, { productId: 'z', name: 'זיתים', quantity: 0.5, remaining: 0, weighed: true }] }, fmt);
    expect(items.status).toEqual({ text: '✕  השובר כבר מומש במלואו — אין יתרה', tone: 'red', dead: true, detail: 'מומש בקופה 2 ב־11.10' });
    expect(items.left).toEqual(['נקניקייה: נותרו 0 מתוך 2', 'זיתים: נותרו 0 ק"ג מתוך 0.5 ק"ג']);
    expect(items.redeemable).toBe(false);
    const discount = voucherBalanceCard({ id: 'd', serial: 7, kind: 'item_discount', redeemable: true, usesAvailable: 2, benefit: { text: '100% הנחה על פיצה' } }, fmt);
    expect(discount.left).toEqual(['100% הנחה על פיצה', 'נותרו 2 שימושים']);
    expect(discount.redeemable).toBe(false);
    const elsewhere = voucherBalanceCard({ id: 'w', serial: 1, redeemable: false, reason: 'prepaid_voucher_wrong_shop', message: 'תקף בסניף מרכז בלבד', status: 'active' }, fmt);
    expect(elsewhere.status.text).toBe('לא ניתן לממש בקופה זו כעת — תקף בסניף מרכז בלבד');
    const test = voucherBalanceCard({ id: 't', serial: 2, redeemable: true, testMode: true, redemptions: [{ at: '2026-10-11T10:00:00Z', machineName: 'קופה 1' }, { at: '2026-10-10T10:00:00Z', machineName: 'קופה 1' }], redemptionsTotal: 2, firstRedeemedAt: '2026-10-10T10:00:00Z' }, fmt);
    expect(test.testBar).toBe('מצב בדיקה — השובר לא ימומש ושום דבר לא יירשם');
    expect(test.historyTitle).toBe('היסטוריית מימושים (2)');
    expect(test.first).toBe('מומש לראשונה: 2026-10-10 10:00');
    expect(test.lastRedeemed).toBe('מומש לאחרונה: 2026-10-11 10:00 · קופה 1');
  });

  it('a refusal in words: not found, the cloud\'s own sentence, an HTTP error, anything else', () => {
    expect(voucherBalanceRefusalText('prepaid_voucher_not_found')).toBe('השובר לא נמצא — ייתכן שהקוד נסרק או הוקלד לא נכון. בדקו את הקוד ונסו שוב.');
    expect(voucherBalanceRefusalText('x', 'המילים של הענן')).toBe('המילים של הענן');
    expect(voucherBalanceRefusalText('http_500')).toBe('הענן לא השיב כמצופה (שגיאה 500) — השובר לא מומש. נסו שוב בעוד רגע.');
    expect(voucherBalanceRefusalText('something_else')).toBe('לא ניתן לממש את השובר כעת — נסו שוב, ואם זה חוזר פנו למנהל.');
  });
});

describe('the service over the engine (read only)', () => {
  const dto = { id: 'v-g', voucherId: 'v-g', serial: 8, typeName: 'שובר ארוחה', redeemable: true, status: 'active', selection: 'groups', totalMax: 2, totalRemaining: 2, groups: [{ key: 'food', name: 'מזון', maxQty: 1 }] };

  async function till(answers: HarnessOptions['answers'], parameters: Record<string, unknown> = { voucherBalanceCheckEnabled: 'true' }) {
    h = harness({ answers, parameters });
    const f = h.engine.register(new TillVoucherBalance(h.engine.ctx, { format: fmt }));
    return { hh: h, f, view: () => (h!.state() as unknown as { voucherBalance?: VoucherBalanceState }).voucherBalance };
  }

  it('nothing while nobody is signed in or the cloud did not switch it on; any cashier may check, no shift needed', async () => {
    const off = await till({}, {});
    await off.hh.ok('session.login', { pin: PIN });
    expect(off.view()).toBeUndefined();
    expect((await off.hh.fail(op('voucherBalance.open'))).code).toBe('invalid_args');
    off.hh.stop();
    const { hh, view } = await till({});
    expect(view()).toBeUndefined();
    await hh.ok('session.login', { pin: PIN });
    expect(view()).toEqual({ enabled: true, open: false, busy: false, error: null, answer: null });
    await hh.ok(op('voucherBalance.open'));
    expect(view()!.open).toBe(true);
  });

  it('a voucher looked up with what this till can do: its card; never a hold, a redemption or a sale', async () => {
    const { hh, f, view } = await till({ 'POST sync/m/prepaid-vouchers/lookup': () => dto });
    await hh.ok('session.login', { pin: PIN });
    await hh.ok(op('voucherBalance.open'));
    expect(await hh.ok(op('voucherBalance.lookup'), { code: CODE, typed: true })).toEqual({ started: true });
    expect(view()!.busy).toBe(true);
    await f.last;
    const a = view()!.answer!;
    expect(a.kind).toBe('found');
    if (a.kind !== 'found') return;
    expect(a.code).toBe('ABCDEFGH23456789');
    expect(a.card.serial).toBe('שובר מס׳ 8');
    expect(a.card.left).toEqual(['מכסה 2 | מומשו 0 | נותרו 2']);
    expect(view()!.busy).toBe(false);
    const sent = hh.sent.filter((c) => c.path.includes('prepaid-vouchers'));
    expect(sent.map((c) => c.path)).toEqual(['sync/m/prepaid-vouchers/lookup']);
    expect(sent[0].body).toMatchObject({ code: 'ABCDEFGH23456789', features: ['accounting', 'override', 'groups', 'production_voucher', 'reserve_goods'] });
    expect(hh.state().sell.lines).toEqual([]);
    // "בדיקת שובר נוסף": the field again.
    await hh.ok(op('voucherBalance.again'));
    expect(view()!.answer).toBeNull();
    await hh.ok(op('voucherBalance.close'));
    expect(view()!.open).toBe(false);
  });

  it('a wrong code is said under the field (nothing sent); not found and offline are said in Android\'s words', async () => {
    let up = true;
    const { hh, f, view } = await till({
      'POST sync/m/prepaid-vouchers/lookup': () => {
        if (!up) throw new Error('network down');
        return { __status: 404, detail: 'prepaid_voucher_not_found' };
      },
    });
    await hh.ok('session.login', { pin: PIN });
    await hh.ok(op('voucherBalance.open'));
    await hh.ok(op('voucherBalance.lookup'), { code: 'ABC', typed: true });
    expect(view()!.error).toBe('הקוד אינו תקין — 16 תווים, כפי שמודפס על השובר.');
    await hh.ok(op('voucherBalance.lookup'), { code: '7290000000011', typed: false });
    expect(view()!.error).toBe('זה ברקוד של מוצר, לא של שובר. סרקו את הברקוד שעל השובר.');
    expect(hh.sent.filter((c) => c.path.includes('prepaid-vouchers'))).toEqual([]);
    await hh.ok(op('voucherBalance.lookup'), { code: `PV:${CODE}`, typed: false });
    await f.last;
    expect(view()!.answer).toEqual({ kind: 'refused', text: 'השובר לא נמצא — ייתכן שהקוד נסרק או הוקלד לא נכון. בדקו את הקוד ונסו שוב.' });
    up = false;
    await hh.ok(op('voucherBalance.again'));
    await hh.ok(op('voucherBalance.lookup'), { code: CODE, typed: true });
    await f.last;
    expect(view()!.answer).toEqual({ kind: 'offline', text: 'אין חיבור לענן — לא ניתן לבדוק את היתרה המעודכנת. נסו שוב כשיש חיבור.' });
    expect((await hh.fail(op('voucherBalance.lookup'), { code: 5 })).code).toBe('invalid_args');
  });
});

describe('the screen', () => {
  const actions = { lookup: () => undefined, again: () => undefined };
  const back = () => undefined;
  it('the field and its hint; the answer card with its status, what is left and the history', () => {
    const empty = renderToStaticMarkup(createElement(VoucherBalanceScreen, { view: { enabled: true, open: true, busy: false, error: 'הקוד אינו תקין — 16 תווים, כפי שמודפס על השובר.', answer: null }, actions, back }));
    for (const w of ['בירור יתרת שובר', 'קוד השובר', 'בדוק שובר', 'סגור', 'הקוד אינו תקין', 'vbal-red']) expect(empty).toContain(w);
    const card = voucherBalanceCard(
      { id: 'v', serial: 8, typeName: 'שובר ארוחה', redeemable: true, selection: 'groups', totalMax: 3, totalRemaining: 1, groups: [{ key: 'g', name: 'מנה', maxQty: 3 }], redemptions: [{ at: '2026-10-11T19:14:00Z', machineName: 'קופה 3', items: [{ name: 'המבורגר', quantity: 1 }], status: 'reversed' }] },
      fmt,
    );
    const html = renderToStaticMarkup(
      createElement(VoucherBalanceScreen, { view: { enabled: true, open: true, busy: false, error: null, answer: { kind: 'found', code: 'X', card } }, actions: { ...actions, redeem: () => undefined }, back }),
    );
    for (const w of ['שובר מס׳ 8', 'שובר ארוחה', 'מומש חלקית', 'vbal-orange', 'מכסה 3 | מומשו 2 | נותרו 1', 'היסטוריית מימושים', '(בוטל)', 'בדיקת שובר נוסף', 'מימוש השובר']) expect(html).toContain(w);
    const off = renderToStaticMarkup(createElement(VoucherBalanceScreen, { view: { enabled: true, open: true, busy: false, error: null, answer: { kind: 'offline', text: 'אין חיבור לענן — לא ניתן לבדוק את היתרה המעודכנת. נסו שוב כשיש חיבור.' } }, actions, back }));
    expect(off).toContain('vbal-orange');
    expect(off).not.toContain('מימוש השובר');
  });
});
