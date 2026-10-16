/**
 * "פעולות אשראי" and the §13 warning (P:/specs/nayax-deferred-all.md §10–§13): pos-android TerminalOfflineTest,
 * OfflineModeTest, DeferredControlTest (§13), TransmissionRulesTest, TransmissionHistoryTest and TransmissionIndicatorTest's
 * pure cases, then the Windows engine — the deferred mode read and kept, its switch under TRANSMIT with the confirmation, the
 * amber warning on the payment screen, a debit card refused while deferred named, "שדר עסקאות עכשיו", the history.
 * Tests only: a fake terminal, a fake cloud.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { authorizePendingFrame, deviceConfigFrame, setOfflineModeFrame } from '../src/core/nayax';
import {
  DEFERRED_CARD_NOTICE_DEFAULT,
  DEFERRED_CUSTOMER_NOTICE,
  REFUSED_OFFLINE_TEXT,
  TX_TEXT,
  ageText,
  authorizationOf,
  authorizationText,
  batchReportOf,
  deferredCardNotices,
  deferredPendingOnTerminal,
  indicatorTone,
  mergeHistory,
  offlineBanner,
  offlineModeOf,
  offlineRefusedCard,
  pendingLine,
  rowOf,
  rowWords,
  transmitResultMessage,
  type OfflineModeStatus,
} from '../src/core/till/transmission';
import type { TransmitResult } from '../src/main/payment/provider';
import { MANAGER_PIN, PIN, harness, type Harness } from './tillEngineHarness';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('the terminal\'s deferred mode (OfflineModeTest)', () => {
  it('the frames as the till sends them', () => {
    expect(deviceConfigFrame()).toBe('{"jsonrpc":"2.0","method":"getConfig","params":["device",{}],"id":"1"}');
    expect(setOfflineModeFrame(true)).toBe('{"jsonrpc":"2.0","method":"setConfig","params":["device",{"offlineModeWorking":true}],"id":"1"}');
    expect(authorizePendingFrame()).toBe('{"jsonrpc":"2.0","method":"authorizePendingTransactions","params":["ashrait",{}],"id":"1"}');
  });

  it('getConfig: every limit -1 is none; numbers or strings kept; a reply without the mode is null', () => {
    const none = offlineModeOf(JSON.stringify({ result: { allowedOfflineMode: true, offlineModeWorking: false, deferredAmountLimit: '-1', deferredAmountLimitLeft: '-1', deferredTransactionsLimit: -1, deferredTransactionsLimitLeft: -1 } }));
    expect(none).toEqual({ allowed: true, working: false, amountLimit: null, amountLeft: null, txLimit: null, txLeft: null });
    expect(offlineModeOf(JSON.stringify({ result: { allowedOfflineMode: true, offlineModeWorking: true, deferredAmountLimit: '50000', deferredAmountLimitLeft: '12000' } }))).toMatchObject({ working: true, amountLimit: 50000, amountLeft: 12000 });
    expect(offlineModeOf('{"result":{"statusCode":-1}}')).toBeNull();
    expect(offlineModeOf('not json')).toBeNull();
  });

  it('authorizePendingTransactions: approved / declined / the total', () => {
    const a = authorizationOf(JSON.stringify({ result: { statusCode: 0, approvedTransactions: ['u1', 'u2'], declinedTransactions: [{ uid: 'u3' }], totalAmount: 4200, totalCount: 3 } }))!;
    expect(a).toEqual({ ok: true, statusCode: 0, approved: ['u1', 'u2'], declined: ['u3'], totalAmountAgorot: 4200, totalCount: 3 });
    expect(authorizationOf('{"result":{"statusCode":5}}')!.ok).toBe(false);
  });

  it('the terminal\'s own count by its limits (deferredPendingOnTerminal)', () => {
    expect(deferredPendingOnTerminal({ txLimit: 10, txLeft: 7 })).toBe(3);
    expect(deferredPendingOnTerminal({ txLimit: 10, txLeft: 10 })).toBe(0);
    expect(deferredPendingOnTerminal({ txLimit: null, txLeft: 4 })).toBeNull();
    expect(deferredPendingOnTerminal({ txLimit: 10, txLeft: null })).toBeNull();
    expect(deferredPendingOnTerminal({ txLimit: 10, txLeft: 12 })).toBeNull();
    expect(deferredPendingOnTerminal(null)).toBeNull();
  });

  it('getReport x: the batch\'s count and amount wherever the terminal puts them', () => {
    expect(batchReportOf('{"result":{"statusCode":0,"transactionCount":4,"totalAmount":12345}}')).toEqual({ count: 4, amountAgorot: 12345 });
    expect(batchReportOf('{"result":{"report":{"numOfTransactions":"2","sum":500}}}')).toEqual({ count: 2, amountAgorot: 500 });
    expect(batchReportOf('{"result":{"transactions":[1,2,3]}}')).toEqual({ count: 3, amountAgorot: null });
    expect(batchReportOf('{"result":{"statusCode":5}}')).toBeNull();
  });
});

describe('§13 (DeferredControlTest)', () => {
  it('the notices: none online; the default, the customer\'s; a custom one, the customer\'s off', () => {
    expect(deferredCardNotices(false, {})).toEqual({ cashier: null, customer: null });
    expect(deferredCardNotices(true, {})).toEqual({ cashier: DEFERRED_CARD_NOTICE_DEFAULT, customer: DEFERRED_CUSTOMER_NOTICE });
    expect(deferredCardNotices(true, { deferredCardNotice: '  ' }).cashier).toBe(DEFERRED_CARD_NOTICE_DEFAULT);
    expect(deferredCardNotices(true, { deferredCardNotice: 'טקסט', deferredCustomerNotice: 'false' })).toEqual({ cashier: 'טקסט', customer: null });
    expect(DEFERRED_CARD_NOTICE_DEFAULT).toContain('חו\u05f4ל');
  });

  it('a card refused while deferred, by its words', () => {
    expect(offlineRefusedCard('כרטיס דביט לא נתמך', true, true)).toBe('debit');
    expect(offlineRefusedCard('Direct card not allowed offline', true, true)).toBe('direct');
    expect(offlineRefusedCard('כרטיס תייר', true, true)).toBe('foreign');
    expect(offlineRefusedCard('Foreign card', true, true)).toBe('foreign');
    expect(offlineRefusedCard('כרטיס דביט', false, true)).toBeNull();
    expect(offlineRefusedCard('סירוב', true, true)).toBeNull();
    expect(offlineRefusedCard('עסקה חוזרת', true, true)).toBeNull();
    expect(REFUSED_OFFLINE_TEXT.debit).toBe('כרטיס דביט — לא נתמך במצב לא מקוון. בחרו אמצעי תשלום אחר.');
  });

  it('the sell screen\'s banner: deferred (with what waits), or sales waiting online', () => {
    expect(offlineBanner({ on: true, pending: 0, online: true })?.text).toBe('מסופון במצב לא מקוון\nתייר / דיירקט / דביט לא עוברים');
    expect(offlineBanner({ on: true, pending: 3, online: false })?.text).toBe('מסופון במצב לא מקוון · 3 ממתינות לאישור\nתייר / דיירקט / דביט לא עוברים');
    expect(offlineBanner({ on: false, pending: 2, online: true })?.text).toBe('2 עסקאות אשראי אושרו במסופון במצב לא מקוון וממתינות לאישור חברת האשראי.');
    expect(offlineBanner({ on: false, pending: 2, online: false })).toBeNull();
    expect(offlineBanner({ on: false, pending: 0, online: true })).toBeNull();
  });
});

describe('the transmission (TransmissionRulesTest, TransmissionIndicatorTest, TransmissionHistoryTest)', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  it('the tone: a day orange, four days red; nothing pending hidden for a day after a success', () => {
    expect(indicatorTone(1, now - 23 * HOUR, null, now)).toBe('green');
    expect(indicatorTone(1, now - 25 * HOUR, null, now)).toBe('orange');
    expect(indicatorTone(1, now - 4 * DAY, null, now)).toBe('orange');
    expect(indicatorTone(1, now - 4 * DAY - 60_000, null, now)).toBe('red');
    expect(indicatorTone(1, now - 3 * DAY, now - HOUR, now)).toBe('orange');
    expect(indicatorTone(1, null, now - 5 * DAY, now)).toBe('red');
    expect(indicatorTone(1, null, null, now)).toBe('green');
    expect(indicatorTone(0, null, now - HOUR, now)).toBe('hidden');
    expect(indicatorTone(0, null, null, now)).toBe('hidden');
    expect(indicatorTone(0, null, now - 2 * DAY, now)).toBe('green');
  });

  it('the pending line and the ages', () => {
    expect(ageText(45 * 60_000)).toBe('45 דק׳');
    expect(ageText(5 * HOUR)).toBe('5 שע׳');
    expect(ageText(3 * DAY)).toBe('3 ימים');
    expect(pendingLine({ running: true, pending: 3, amountText: '₪10.00', lastSuccessAtMs: null, now, full: true })).toBe('משדר עסקאות לשב״א…');
    expect(pendingLine({ running: false, pending: 3, amountText: '₪10.00', lastSuccessAtMs: now - 5 * HOUR, now, full: true })).toBe('ממתינות לשידור: 3 עסקאות · ₪10.00 · שידור אחרון לפני 5 שע׳');
    expect(pendingLine({ running: false, pending: 3, amountText: '₪10.00', lastSuccessAtMs: null, now, full: true })).toBe('ממתינות לשידור: 3 עסקאות · ₪10.00 · טרם שודר');
    expect(pendingLine({ running: false, pending: 0, amountText: '₪0.00', lastSuccessAtMs: now - 2 * DAY, now, full: true })).toBe('אין עסקאות ממתינות לשידור · שידור אחרון לפני 2 ימים');
    expect(pendingLine({ running: false, pending: 0, amountText: '₪0.00', lastSuccessAtMs: now - HOUR, now, full: true })).toBe('שודר לאחרונה לפני 1 שע׳');
    expect(pendingLine({ running: false, pending: 0, amountText: '₪0.00', lastSuccessAtMs: now - HOUR, now, full: false })).toBeNull();
  });

  it('"שדר עכשיו"\'s answer in words', () => {
    const r = (o: Partial<Parameters<typeof transmitResultMessage>[0] & object>) => ({ outcome: 'success' as const, batchNumber: null, statusCode: null, statusMessage: null, error: null, ...o });
    expect(transmitResultMessage(r({ batchNumber: '512' }))).toBe('השידור הצליח · אצווה 512');
    expect(transmitResultMessage(r({ batchNumber: 'assumed:512' }))).toBe('השידור הצליח');
    expect(transmitResultMessage(r({ outcome: 'busy' }))).toBe(TX_TEXT.busy);
    expect(transmitResultMessage(r({ outcome: 'unknown' }))).toBe('לא התקבלה תשובה מהמסוף. התוצאה תיבדק לפני ניסיון נוסף.');
    expect(transmitResultMessage(r({ outcome: 'failed', statusMessage: 'אין קו' }))).toBe('השידור נכשל: אין קו. ינוסה שוב אוטומטית.');
    expect(transmitResultMessage(r({ outcome: 'failed', statusCode: 7 }))).toBe('השידור נכשל: 7. ינוסה שוב אוטומטית.');
    expect(transmitResultMessage(r({ outcome: 'failed' }))).toBe('השידור נכשל: —. ינוסה שוב אוטומטית.');
    expect(transmitResultMessage(null, true)).toBe('אין שידור עסקאות במצב הדרכה');
  });

  it('the authorisation in words', () => {
    const shek = (a: number) => `₪${(a / 100).toFixed(2)}`;
    expect(authorizationText(null, shek)).toBe('המסוף לא ענה. נסו שוב.');
    expect(authorizationText({ ok: false, statusCode: 5, approved: [], declined: [], totalAmountAgorot: null, totalCount: null }, shek)).toBe('אישור העסקאות הממתינות נכשל (קוד 5). ינסה שוב בכיבוי הבא או בלחיצה על "אשר עסקאות ממתינות".');
    expect(authorizationText({ ok: true, statusCode: 0, approved: ['a'], declined: ['b', 'c'], totalAmountAgorot: 100, totalCount: 3 }, shek)).toBe('⚠ 2 עסקאות נדחו על ידי חברת האשראי (אושרו 1). הסכום לא ייגבה — יש לטפל מול הלקוח.');
    expect(authorizationText({ ok: true, statusCode: 0, approved: [], declined: [], totalAmountAgorot: 0, totalCount: 0 }, shek)).toBe('אין עסקאות ממתינות לאישור.');
    expect(authorizationText({ ok: true, statusCode: 0, approved: ['a', 'b'], declined: [], totalAmountAgorot: 4200, totalCount: 2 }, shek)).toBe('אושרו 2 עסקאות ממתינות, ₪42.00.');
  });

  it('the history: this till\'s unsynced rows, the cloud\'s copy wins, newest first; a row in words', () => {
    const l1 = { ...rowOf({ id: 'l1', status: 'success', startedAt: '2026-10-16T11:00:00Z', amount: 12.5, trigger: 'manual' })!, unsynced: true };
    const c1 = rowOf({ id: 'c1', status: 'failed', startedAt: '2026-10-15T11:00:00Z', error: 'אין קו', trigger: 'shift_close' })!;
    const c2 = rowOf({ id: 'c2', status: 'success', startedAt: '2026-10-16T09:00:00Z', batchNumber: 'assumed:5', transactionCount: 4, amount: '40.00', trigger: 'daily' })!;
    const dupLocal = { ...rowOf({ id: 'c2', status: 'unknown', startedAt: '2026-10-16T09:00:00Z' })!, unsynced: true };
    const merged = mergeHistory([l1, dupLocal], [c2, c1]);
    expect(merged.map((r) => r.id)).toEqual(['l1', 'c2', 'c1']);
    expect(merged[1].status).toBe('success');
    expect(l1.amount).toBe('12.50');
    expect(rowWords(merged[1])).toEqual({ status: 'שודר בהצלחה', tone: 'ok', trigger: 'שידור יומי אוטומטי', facts: ['4 עסקאות', '₪40.00'], detail: null });
    expect(rowWords(c1)).toMatchObject({ status: 'השידור נכשל', tone: 'error', trigger: 'בסגירת משמרת', detail: 'אין קו' });
  });
});

/* ------------------------------------------------------------------ on the Windows till */

let current: Harness | null = null;
afterEach(() => {
  current?.stop();
  current = null;
});

function deferredTerminal(h: Harness, status: OfflineModeStatus) {
  const t = h.terminal as unknown as Record<string, unknown>;
  const calls: string[] = [];
  let s = { ...status };
  t.offlineMode = async () => {
    calls.push('getConfig');
    return { status: s, error: null };
  };
  t.setOfflineMode = async (on: boolean) => {
    calls.push(`setConfig:${on}`);
    s = { ...s, working: on };
    return { status: s, error: null, authorization: on ? null : { ok: true, statusCode: 0, approved: ['u1'], declined: [], totalAmountAgorot: 1250, totalCount: 1 } };
  };
  t.authorizePending = async () => {
    calls.push('authorize');
    return { ok: true, statusCode: 0, approved: [], declined: [], totalAmountAgorot: 0, totalCount: 0 };
  };
  t.batchReport = async () => ({ count: 2, amountAgorot: 3_000 });
  t.transmit = async (): Promise<TransmitResult> => {
    calls.push('doPeriodic');
    return { outcome: 'success', batchNumber: '77', statusCode: 0, statusMessage: null, error: null, transactionCount: 2, amountAgorot: 3_000, raw: null };
  };
  return calls;
}

const settle = async (h: Harness, n = 30) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  await h.call('session.activity', {});
};

const ON: OfflineModeStatus = { allowed: true, working: true, amountLimit: 50_000, amountLeft: 40_000, txLimit: 10, txLeft: 7 };

describe('"פעולות אשראי" on the Windows till', () => {
  it('opened: the terminal read and kept, its limits, the batch, the cloud\'s history', async () => {
    const h = harness({ answers: { 'GET sync/m/transmissions': () => ({ total: 1, items: [{ id: 't1', status: 'success', startedAt: '2026-10-16T08:00:00Z', batchNumber: '76', transactionCount: 3, amount: '30.00', trigger: 'shift_close' }] }) } });
    current = h;
    deferredTerminal(h, ON);
    await h.ok('session.login', { pin: PIN });
    await h.ok('transmission.open');
    await settle(h);
    const tx = h.state().transmission!;
    expect(tx.deferredSupported).toBe(true);
    expect(tx.offline.stateLine).toBe(TX_TEXT.stateOn);
    expect(tx.offline.limitsLine).toBe('יתרת סכום: ₪400.00 מתוך ₪500.00 · יתרת עסקאות: 7 מתוך 10');
    expect(tx.pendingLine).toBe('ממתינות לשידור: 2 עסקאות · ₪30.00 · שידור אחרון לפני ' + tx.pendingLine!.split('לפני ')[1]);
    expect(tx.history.rows.map((r) => r.id)).toEqual(['t1']);
    expect(tx.history.total).toBe(1);
    // Deferred: the sell screen's banner, the terminal's three waiting.
    expect(h.state().terminalOffline?.text).toBe('מסופון במצב לא מקוון · 3 ממתינות לאישור\nתייר / דיירקט / דביט לא עוברים');
  });

  it('§13 on the payment screen while deferred; a debit card refused is named', async () => {
    const h = harness();
    current = h;
    deferredTerminal(h, ON);
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.engine.transmission.readOffline(true);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(h.state().checkout.deferredNotice).toBe(DEFERRED_CARD_NOTICE_DEFAULT);
    h.terminal.next = () => ({ answer: 'DECLINED', message: 'כרטיס דביט אינו נתמך', raw: '' }) as never;
    await h.ok('checkout.card', {});
    await settle(h);
    expect(h.state().checkout.cardError).toBe(REFUSED_OFFLINE_TEXT.debit);
  });

  it('online: no warning, no banner', async () => {
    const h = harness();
    current = h;
    deferredTerminal(h, { ...ON, working: false, txLimit: null, txLeft: null });
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.engine.transmission.readOffline(true);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(h.state().checkout.deferredNotice).toBeUndefined();
    expect(h.state().terminalOffline).toBeUndefined();
  });

  it('the switch: on asks "להפעיל מצב לא מקוון?" first, then a cashier needs a manager (TRANSMIT); off approves the waiting sales', async () => {
    const h = harness();
    current = h;
    const calls = deferredTerminal(h, { ...ON, working: false });
    await h.ok('session.login', { pin: PIN });
    const asked = (await h.ok('transmission.offline', { on: true })) as { dialogId: string };
    expect(h.state().dialog?.title).toBe('להפעיל מצב לא מקוון?');
    const approval = (await h.ok('dialog.answer', { dialogId: asked.dialogId, action: 'approve' })) as { dialogId: string };
    expect(h.state().dialog?.kind).toBe('manager_approval');
    await h.ok('dialog.answer', { dialogId: approval.dialogId, action: 'approve', answers: { pin: MANAGER_PIN } });
    await settle(h);
    expect(calls).toContain('setConfig:true');
    expect(h.engine.transmission.offlineOn()).toBe(true);
    await h.call('session.logout', {});
    await h.ok('session.login', { pin: MANAGER_PIN });
    await h.ok('transmission.offline', { on: false });
    await settle(h);
    expect(calls).toContain('setConfig:false');
    expect(h.engine.transmission.offlineOn()).toBe(false);
    const toasts = h.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts).toContain('מצב לא מקוון כובה.\nאושרו 1 עסקאות ממתינות, ₪12.50.');
  });

  it('"שדר עסקאות עכשיו": the batch sent, its row to the cloud, said', async () => {
    const h = harness({ answers: { 'POST sync/m/transmissions': () => ({ id: 'x', status: 'accepted' }), 'GET sync/m/transmissions': () => ({ total: 0, items: [] }) } });
    current = h;
    const calls = deferredTerminal(h, ON);
    await h.ok('session.login', { pin: MANAGER_PIN });
    await h.ok('transmission.open');
    await h.ok('transmission.now');
    await settle(h, 60);
    expect(calls).toContain('doPeriodic');
    const toasts = h.events.filter((e) => e.ev === 'toast').map((e) => (e.data as { text: string }).text);
    expect(toasts).toContain('השידור הצליח · אצווה 77');
    expect(h.svc.localTransmissions()[0]).toMatchObject({ status: 'success', batchNumber: '77', trigger: 'manual' });
  });
});
