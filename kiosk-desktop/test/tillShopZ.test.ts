/**
 * "סגירת Z סניפי" on the Windows till as the shop's master (core/till/shopZRun.ts, main/till/tillShopZ.ts,
 * screens/ShopZScreen.tsx): pos-android ShopZLogicTest's cases word for word, the menu row's rule (MainTill /
 * IndependentTill.showsShopZ), the cloud's refusals, "Z לנקודת מכירה" feature-detected; then the engine — the start, this
 * till's own shift closed from the run's answer, the polls, the typed "סגור", the Z printed (summary, then each till), the
 * held sales, offline, local mode — and the screen's markup. A fake cloud only.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SHOP_Z_TEXT,
  cloudPrintDocumentOf,
  cloudZOps,
  confirmTyped,
  describeRefusal,
  emptyShopZState,
  isoMillis,
  localMasterOf,
  ownPendingItem,
  printInSequence,
  printSequenceMessage,
  runOf,
  runStartOnTillClock,
  shopZFailedCount,
  shopZMenuShown,
  shopZOffersScopeChoice,
  shopZShopOffered,
  shopZStartScope,
  shopZStatusPath,
  shopZTitle,
  shopZView,
  shopZWaitingCount,
  startRefusal,
  statusOf,
  tillLabel,
  tillLiveStatus,
  tillsInOrder,
  withoutFailedPaymentSections,
  type ShopZRun,
  type ShopZRunItem,
  type ShopZState,
  type ShopZTill,
} from '../src/core/till/shopZRun';
import { TillShopZ, type TillShopZOptions } from '../src/main/till/tillShopZ';
import { HeldStore } from '../src/main/till/heldStore';
import { ShopZScreen, type ShopZActions } from '../src/renderer/roles/till/screens/ShopZScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { MACHINE, harness, readyTill, type Harness, type HarnessOptions } from './tillEngineHarness';

/* ------------------------------------------------------------------ the pure rules (ShopZLogicTest) */

const till: ShopZTill = { id: 't2', posNumber: '2', name: 'בר', self: false, online: true, lastSeenAt: null, openShift: null, closedWaiting: 0 };

function item(status: string, extra: Partial<ShopZRunItem> = {}): ShopZRunItem {
  return {
    id: 'item-t2',
    machineId: 't2',
    machineName: null,
    posNumber: null,
    status,
    errorCode: null,
    errorMessage: null,
    closeShiftId: null,
    online: null,
    readyAt: null,
    cloudVerified: null,
    tillDocuments: null,
    cloudDocuments: null,
    deferredBy: null,
    ...extra,
  };
}

const run: ShopZRun = {
  id: 'r',
  status: 'waiting',
  zReportId: null,
  zNumber: null,
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-10-04T00:18:42.413468Z',
  serverTime: null,
  strictCloudCheck: true,
  items: [],
};

describe('a till\'s live line (ShopZLogicTest)', () => {
  it('a till on its way to closing says so, with its seconds', () => {
    const live = tillLiveStatus(till, item('waiting_close', { online: true }), run, 4);
    expect(live).toEqual({ text: 'נסגרת… · 4 ש׳', tone: 'working' });
    expect(tillLiveStatus(till, item('closing', { online: true }), run, 9).text).toBe('נסגרת… · 9 ש׳');
    expect(tillLiveStatus(till, item('closing', { online: true, errorCode: 'card_in_flight' }), run, 2).text).toBe('נסגרת… (תשלום באשראי בתהליך) · 2 ש׳');
  });

  it('a till the cloud has not heard from is waited for, and said to be off', () => {
    expect(tillLiveStatus(till, item('waiting_close', { online: false }), run, 12)).toEqual({ text: 'לא מחוברת — ממתינה · 12 ש׳', tone: 'off' });
  });

  it('a till the cloud verified is closed and confirmed, with the seconds it took', () => {
    expect(tillLiveStatus(till, item('ready', { cloudVerified: true, readyAt: '2026-10-04T00:18:45.913Z' }), run, null)).toEqual({ text: 'נסגרה ✓ (אושר בענן) · 3 ש׳', tone: 'done' });
  });

  it('a till whose transactions the cloud does not hold yet is waited for', () => {
    expect(tillLiveStatus(till, item('ready', { cloudVerified: false, tillDocuments: 2, cloudDocuments: 1 }), run, 20)).toEqual({ text: 'ממתינה לעסקאות (בענן 1 מתוך 2) · 20 ש׳', tone: 'waiting' });
  });

  it('a till deferred with the typed word moves to the next Z, naming who decided', () => {
    expect(tillLiveStatus(till, item('excluded', { deferredBy: 'דנה (קופה 1)' }), run, null).text).toBe('עוברת ל-Z הבא (אישר/ה: דנה (קופה 1))');
    expect(tillLiveStatus(till, item('excluded', { errorCode: 'excluded_by_operator' }), run, null).text).toBe('עוברת ל-Z הבא');
    expect(tillLiveStatus(till, item('excluded'), run, null).text).toBe('אין מה לדווח');
  });

  it('a refusal says why; a till out of time; with no item, its shift', () => {
    expect(tillLiveStatus(till, item('failed', { errorCode: 'open_tables' }), run, null)).toEqual({ text: 'שולחנות פתוחים בקופה', tone: 'failed' });
    expect(tillLiveStatus(till, item('failed', { errorCode: 'unknown_shift' }), run, null).text).toBe('המשמרת בקופה השתנתה');
    expect(tillLiveStatus(till, item('failed'), run, null).text).toBe('הסגירה נכשלה');
    expect(tillLiveStatus(till, item('expired'), run, null).text).toBe('לא נסגרה בזמן');
    const open = { ...till, openShift: { id: 's', openedAt: null, openedByName: 'דנה' } };
    expect(tillLiveStatus(open, null, null, null)).toEqual({ text: 'משמרת פתוחה', tone: 'waiting' });
    expect(tillLiveStatus({ ...open, online: false }, null, null, null)).toEqual({ text: 'משמרת פתוחה · לא מחוברת', tone: 'off' });
    expect(tillLiveStatus({ ...till, closedWaiting: 2 }, null, null, null)).toEqual({ text: 'סגורה — ממתינה ל-Z', tone: 'done' });
    expect(tillLiveStatus(till, null, null, null)).toEqual({ text: 'אין מה לדווח', tone: 'muted' });
  });

  it('the run waits for closes and for transactions alike; the failed counted apart', () => {
    const r = { ...run, items: [item('waiting_close', { machineId: 'a' }), item('ready', { machineId: 'b', cloudVerified: false }), item('ready', { machineId: 'c', cloudVerified: true }), item('excluded', { machineId: 'd' }), item('expired', { machineId: 'e' })] };
    expect(shopZWaitingCount(r)).toBe(2);
    expect(shopZFailedCount(r)).toBe(1);
  });

  it("the seconds count from the run's start on the cloud's clock, whatever the till's", () => {
    const r = { ...run, serverTime: '2026-10-04T00:18:47.413468Z' };
    expect(runStartOnTillClock(r, 1_000_000_000_000)).toBe(1_000_000_000_000 - 5_000);
    // A time with no offset is the cloud's UTC, as the Android till reads it.
    expect(isoMillis('2026-10-04T00:18:42.413468')).toBe(Date.parse('2026-10-04T00:18:42.413Z'));
    expect(isoMillis('nonsense')).toBeNull();
  });

  it('the master finds its own item to close, and only while it is pending', () => {
    const r = { ...run, items: [item('waiting_close', { machineId: 'master', id: 'req-1' }), item('waiting_close')] };
    expect(ownPendingItem(r, 'master')?.id).toBe('req-1');
    expect(ownPendingItem({ ...r, items: [item('ready', { machineId: 'master' })] }, 'master')).toBeNull();
  });

  it("the tills' details print in till-number order", () => {
    const ordered = tillsInOrder([
      { machineId: 'x', posNumber: '10', name: 'עשר' },
      { machineId: 'y', posNumber: null, name: 'בלי מספר' },
      { machineId: 'z', posNumber: '2', name: 'שתיים' },
      { machineId: 'w', posNumber: '1', name: 'אחת' },
    ]);
    expect(ordered.map((t) => t.machineId)).toEqual(['w', 'z', 'x', 'y']);
    expect(SHOP_Z_TEXT.detailProgress(2, 5)).toBe('מדפיס קופה 3 מתוך 5…');
    expect(tillLabel({ posNumber: '4', name: 'קופה 1' })).toBe('#4 קופה 1');
    expect(tillLabel({ posNumber: null, name: null })).toBe('קופה');
  });

  it('a cancel stops between documents, never in the middle of one; a failure stops the rest', async () => {
    const printed: number[] = [];
    let cancelled = false;
    const o = await printInSequence(
      [1, 2, 3, 4],
      () => cancelled,
      () => undefined,
      async (n) => {
        printed.push(n);
        if (n === 2) cancelled = true;
        return null;
      },
    );
    expect(printed).toEqual([1, 2]);
    expect(o).toEqual({ printed: 2, total: 4, cancelled: true, error: null });
    expect(printSequenceMessage(o)).toBe('ההדפסה הופסקה — הודפסו 2 מתוך 4');
    const f = await printInSequence(['a', 'b', 'c'], () => false, () => undefined, async (s) => (s === 'b' ? 'ההדפסה נכשלה: אין נייר' : null));
    expect(f.printed).toBe(1);
    expect(printSequenceMessage(f)).toBe('ההדפסה נכשלה: אין נייר (הודפסו 1 מתוך 3)');
  });
});

describe('the menu row (PosNavigation.kt, MainTill / IndependentTill.showsShopZ)', () => {
  const base = { zMode: 'cloud', independent: false, params: { mainTill: true }, hidden: [] as string[] };
  it('the main till, a master the old way, or any till when the shop opened it to all', () => {
    expect(shopZMenuShown(base)).toBe(true);
    expect(shopZMenuShown({ ...base, params: { mainTill: 'true' } })).toBe(true);
    expect(shopZMenuShown({ ...base, params: { shopZMasterTill: 'כן' } })).toBe(true);
    expect(shopZMenuShown({ ...base, params: { shopZFrom: 'כל קופה בסניף והדשבורד' } })).toBe(true);
    expect(shopZMenuShown({ ...base, params: { shopZFrom: 'הקופה הראשית בלבד' } })).toBe(false);
    expect(shopZMenuShown({ ...base, params: { mainTill: false } })).toBe(false);
    expect(shopZMenuShown({ ...base, params: {} })).toBe(false);
  });
  it('never in zMode = till, on an independent till, in training, or hidden', () => {
    expect(shopZMenuShown({ ...base, zMode: 'till' })).toBe(false);
    expect(shopZMenuShown({ ...base, zMode: null })).toBe(true);
    expect(shopZMenuShown({ ...base, independent: true })).toBe(false);
    expect(shopZMenuShown({ ...base, training: true })).toBe(false);
    expect(shopZMenuShown({ ...base, hidden: ['shop_z'] })).toBe(false);
  });
});

describe("the cloud's refusals (ShopZViewModel.start / describe)", () => {
  it('the open tills: confirm by typing, or the shop\'s rule blocks', () => {
    const tills = [{ id: 'a', posNumber: '3', name: 'בר' }, { id: 'b', posNumber: null, name: 'מטבח' }];
    expect(startRefusal({ detail: { code: 'open_tills_need_confirmation', tills } }, 409)).toEqual({ kind: 'needs_confirm', tills: ['#3 בר', 'מטבח'] });
    expect(startRefusal({ detail: { code: 'open_tills_block_z', tills } }, 409)).toEqual({ kind: 'blocked', tills: ['#3 בר', 'מטבח'] });
  });
  it('open tables, a Z on nothing, the producer elsewhere, the plain details', () => {
    expect(startRefusal({ detail: { code: 'open_tables_block_z', tables: [{ number: 12 }, { number: 3, name: 'מרפסת' }] } }, 409)).toEqual({ kind: 'error', text: 'לא ניתן להפיק Z — שולחנות פתוחים: מרפסת, 12. יש לשלם או לבטל אותם קודם.' });
    expect(startRefusal({ detail: { code: 'empty_z' } }, 409)).toEqual({ kind: 'error', text: 'אין תנועות — לא ניתן לסגור Z על 0' });
    expect(startRefusal({ detail: { code: 'empty_z', message: 'אין מה לסגור' } }, 409)).toEqual({ kind: 'error', text: 'אין מה לסגור' });
    expect(startRefusal({ detail: { code: 'shop_z_producer_local', message: 'ה-Z הסניפי של הסניף מופק בקופה הראשית ברשת המקומית — לא בענן.' } }, 409).kind).toBe('error');
    expect(describeRefusal({ detail: 'z_run_in_progress:abc' }, 409)).toBe('כבר מתבצעת סגירת Z בסניף — רעננו.');
    expect(describeRefusal({ detail: 'nothing_to_report' }, 409)).toBe('אין משמרות לדווח ב-Z.');
    expect(describeRefusal({ detail: 'not_master_till' }, 403)).toBe('הקופה הזו אינה מוגדרת כקופה ראשית ל-Z סניפי.');
    expect(describeRefusal({ detail: 'z_only_from_main_till' }, 403)).toContain('ה-Z הסניפי מופק בקופה הראשית בלבד');
    expect(describeRefusal({ detail: 'run_not_waiting' }, 409)).toBe('סגירת ה-Z כבר הסתיימה — רעננו.');
    expect(describeRefusal({ detail: 'items_not_ready: 2' }, 409)).toBe('יש קופות שהענן עדיין לא אישר.');
    expect(describeRefusal({ detail: 'what' }, 500)).toBe('שגיאה מהענן (500)');
  });
});

describe('"Z לנקודת מכירה" — feature-detected (§11.2a)', () => {
  const areaZ = { available: true, areaId: 'a1', areaName: 'בר', reason: null, message: null };
  it('an older cloud: the shop\'s only — no choice, no scope sent', () => {
    const old = statusOf({ shopName: 'הרצליה', tills: [] })!;
    expect(old.scope).toBeNull();
    expect(old.areaZ).toBeNull();
    expect(shopZShopOffered(old)).toBe(true);
    expect(shopZOffersScopeChoice(old, true)).toBe(false);
    expect(shopZStartScope(old)).toBeNull();
    expect(shopZTitle(old)).toBe('סגירת Z סניפי');
  });
  it('a till that may run both: the choice; the point of sale\'s screen names it and starts its Z', () => {
    const shop = statusOf({ scope: 'shop', areaZ, tills: [] })!;
    expect(shopZShopOffered(shop)).toBe(true);
    expect(shopZOffersScopeChoice(shop, true)).toBe(true);
    const area = statusOf({ scope: 'area', areaZ, tills: [] })!;
    expect(shopZTitle(area)).toBe('Z לנקודת המכירה: בר');
    expect(shopZStartScope(area)).toBe('area');
    expect(shopZTitle(statusOf({ scope: 'area', tills: [] }))).toBe('Z לנקודת המכירה');
    // An area's master only: the cloud answers "area" unasked — no shop's Z offered, no choice.
    expect(shopZShopOffered(area)).toBe(false);
    expect(shopZOffersScopeChoice(statusOf({ scope: 'shop', areaZ: { ...areaZ, available: false }, tills: [] }), true)).toBe(false);
    expect(shopZStatusPath('m', true)).toBe('sync/m/shop-z?scope=area');
    expect(shopZStatusPath('m', false)).toBe('sync/m/shop-z');
  });
});

describe('local mode and the paper', () => {
  it('local mode only when the history names this till the main till', () => {
    expect(localMasterOf({ localMode: true, mainTill: { machineId: 'm1' } }, 'm1')).toBe(true);
    expect(localMasterOf({ localMode: true, mainTill: { machineId: 'm2' } }, 'm1')).toBe(false);
    expect(localMasterOf({ localMode: false, mainTill: { machineId: 'm1' } }, 'm1')).toBe(false);
    expect(localMasterOf(null, 'm1')).toBe(false);
  });
  it("the cloud's document drawn as the Android renderer does; the failed payments off unless asked", () => {
    const doc = cloudPrintDocumentOf({
      title: 'דו״ח Z',
      number: 12,
      businessName: 'בדיקה',
      subtitle: ['סניף הרצליה'],
      sections: [
        { title: 'סיכום', rows: [{ label: 'מכירות', value: '₪100.00', emphasis: true }] },
        { title: 'עסקאות שלא הושלמו', key: 'failed_payments', rows: [] },
      ],
      footer: ['תודה'],
      tills: [{ machineId: 'a', posNumber: '1', name: 'קופה 1' }],
    })!;
    expect(doc.tills).toHaveLength(1);
    expect(withoutFailedPaymentSections(doc, {}).sections).toHaveLength(1);
    expect(withoutFailedPaymentSections(doc, { printFailedPaymentsWithReports: 'true' }).sections).toHaveLength(2);
    const ops = cloudZOps(withoutFailedPaymentSections(doc, {}));
    expect(ops[0]).toEqual({ t: 'centred', text: 'בדיקה', size: 24, bold: true });
    expect(ops[1]).toEqual({ t: 'centred', text: 'דו״ח Z #12', size: 28, bold: true });
    expect(ops).toContainEqual({ t: 'row', label: 'מכירות', value: '₪100.00', bold: true });
    expect(ops[ops.length - 1]).toEqual({ t: 'centred', text: 'תודה', size: 17, bold: false });
  });
  it('the typed word', () => {
    expect(confirmTyped(' סגור ')).toBe(true);
    expect(confirmTyped('סגו')).toBe(false);
  });
});

/* ------------------------------------------------------------------ the engine */

const NOW = Date.parse('2026-10-17T20:00:00Z');

const tillsJson = [
  { id: MACHINE, posNumber: '2', name: 'קופה 2', self: true, online: true, openShift: { id: 's-me', openedByName: 'דנה כהן' }, closedWaiting: 0 },
  { id: 't-bar', posNumber: '3', name: 'בר', self: false, online: true, openShift: { id: 's-bar', openedByName: 'יוסי' }, closedWaiting: 0 },
];

const runJson = (status: string, items: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
  id: 'run-1',
  status,
  createdAt: '2026-10-17T19:59:58Z',
  serverTime: '2026-10-17T20:00:00Z',
  strictCloudCheck: true,
  items,
  ...extra,
});

const pending = [
  { id: 'req-me', machineId: MACHINE, machineName: 'קופה 2', status: 'waiting_close', online: true },
  { id: 'req-bar', machineId: 't-bar', machineName: 'בר', status: 'waiting_close', online: true },
];

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

async function master(o: HarnessOptions & { opts?: TillShopZOptions; open?: boolean } = {}) {
  h = await readyTill({ parameters: { mainTill: true }, now: () => NOW, ...o });
  const f = h.engine.register(new TillShopZ(h.engine.ctx, { timers: false, ...(o.opts ?? {}) }));
  const op = (name: string, args: Record<string, unknown> = {}) => h!.ok(name as TillOp, args);
  const fail = (name: string, args: Record<string, unknown> = {}) => h!.fail(name as TillOp, args);
  if (o.open !== false) {
    await op('shopZ.open');
    await f.settled();
  }
  const st = () => h!.state() as unknown as { shopZ?: ShopZState };
  return { h, f, op, fail, st };
}

describe('the engine: the shop Z from this till', () => {
  it('the menu row: the main till in cloud Z mode; not in zMode = till, nor hidden', async () => {
    const { f } = await master({ open: false });
    expect(f.menuShown([])).toBe(true);
    expect(f.menuShown(['shop_z'])).toBe(false);
    h!.svc.cloud.setHeartbeat({ zMode: 'till', lastTillZNumber: null, tillZEpoch: 0, independentTill: false, lastOkAt: Date.now(), serverTime: null });
    expect(f.menuShown([])).toBe(false);
  });

  it('not a master: opening refuses in the cloud\'s words; nobody signed in — no slice', async () => {
    h = harness({ parameters: {} });
    const f = h.engine.register(new TillShopZ(h.engine.ctx, { timers: false }));
    expect((h.state() as unknown as Record<string, unknown>).shopZ).toBeUndefined();
    const e = await h.fail('shopZ.open' as TillOp);
    expect(e.code).toBe('not_logged_in');
    await h.ok('session.login', { pin: '1234' });
    const e2 = await h.fail('shopZ.open' as TillOp);
    expect(e2.message).toBe('הקופה הזו אינה מוגדרת כקופה ראשית ל-Z סניפי.');
    void f;
  });

  it('opened: the tills and their shifts; the start closes this till at once, the run is followed, the Z printed', async () => {
    let runNow: Record<string, unknown> = runJson('waiting', pending);
    const printed: Array<{ refId: string; title: string; ops: number }> = [];
    const { f, op, st } = await master({
      answers: {
        'GET sync/m/shop-z': () => ({ shopId: 's', shopName: 'הרצליה', rule: null, serverTime: '2026-10-17T20:00:00Z', activity: { hasActivity: true, documents: 4 }, tills: tillsJson, run: null }),
        'GET sync/m/shop-z/history': () => ({ localMode: false, mainTill: { machineId: MACHINE } }),
        'POST sync/m/shop-z': () => ({ __status: 201, ...runJson('waiting', pending) }),
        'GET sync/m/shop-z/runs/run-1': () => runNow,
        'GET sync/m/z-reports/z-9/print-document': () => ({ title: 'דו״ח Z', number: 9, sections: [], tills: [{ machineId: 't-bar', posNumber: '3', name: 'בר' }, { machineId: MACHINE, posNumber: '2', name: 'קופה 2' }] }),
      },
      opts: { print: (doc, refId, title) => (printed.push({ refId, title, ops: doc.ops.length }), `job-${printed.length}`) },
    });
    const s0 = st().shopZ!;
    expect(s0.loading).toBe(false);
    expect(s0.status?.shopName).toBe('הרצליה');
    expect(s0.localMode).toBe(false);
    const v0 = shopZView(s0, NOW);
    expect(v0.rows.map((r) => r.live.text)).toEqual(['משמרת פתוחה', 'משמרת פתוחה']);
    expect(v0.phase).toMatchObject({ kind: 'idle', openLine: '2 קופות עם משמרת פתוחה — ייסגרו מרחוק.', startEnabled: true });

    expect(h!.svc.ledger.currentShift()).not.toBeNull();
    await op('shopZ.start', {});
    await f.settled();
    const post = h!.sent.find((r) => r.method === 'POST' && r.path === 'sync/m/shop-z');
    expect(post?.body).toEqual({ confirmOpenTills: false, posUserName: 'דנה כהן' });
    // This till's own shift: closed here, named after its item (the cloud ties it to the run).
    expect(h!.svc.ledger.currentShift()).toBeNull();
    expect(h!.svc.ledger.shiftByCloseRequest('req-me')).not.toBeNull();
    const s1 = st().shopZ!;
    expect(s1.runStartedAtMs).toBe(NOW - 2_000);
    const v1 = shopZView(s1, NOW + 3_000);
    expect(v1.phase).toMatchObject({ kind: 'live', waitingLine: 'ממתין לאישור הענן על 2 קופות…', elapsed: '5 שניות', proceed: 'הפק Z בלי הקופות שלא אושרו' });
    expect(v1.rows[1].live.text).toBe('נסגרת… · 5 ש׳');

    // A poll after the close: asked again, never closed twice.
    runNow = runJson('waiting', [{ ...pending[0], status: 'ready', cloudVerified: true, readyAt: '2026-10-17T20:00:01Z' }, pending[1]]);
    await f.pollOnce('run-1');
    await f.settled();
    expect(shopZView(st().shopZ!, NOW).rows[0].live.text).toBe('נסגרה ✓ (אושר בענן) · 3 ש׳');

    // Built: the Z's number, the summary printed once, then the question about the tills' details.
    runNow = runJson('completed', [{ ...pending[0], status: 'ready', cloudVerified: true }, { ...pending[1], status: 'ready', cloudVerified: true }], { zReportId: 'z-9', zNumber: 9 });
    await f.pollOnce('run-1');
    await f.settled();
    await f.pollOnce('run-1');
    await f.settled();
    const s2 = st().shopZ!;
    expect(shopZView(s2, NOW).phase).toMatchObject({ kind: 'completed', title: 'Z סניפי מס׳ 9 הופק', sub: 'כל הקופות אושרו בענן.' });
    expect(printed).toHaveLength(1);
    expect(printed[0].title).toBe('דו״ח Z #9');
    expect(s2.askDetails).toBe(true);
    expect(s2.zTills.map((t) => t.machineId)).toEqual([MACHINE, 't-bar']);

    await op('shopZ.details', { answer: 'all' });
    await f.settled();
    expect(printed).toHaveLength(3);
    expect(printed.slice(1).map((p) => p.refId.split(':')[3])).toEqual([MACHINE, 't-bar']);
    const s3 = st().shopZ!;
    expect(s3.progress).toBeNull();
    expect(s3.message).toBeNull();

    // "הדפס סיכום שוב".
    await op('shopZ.printSummary');
    await f.settled();
    expect(printed).toHaveLength(4);
  });

  it('the typed "סגור": the cloud lists the tills left out, the start again confirms; "proceed" builds without the rest', async () => {
    const { f, op, st } = await master({
      answers: {
        'GET sync/m/shop-z': () => ({ shopName: 'הרצליה', tills: tillsJson }),
        'POST sync/m/shop-z': (b) =>
          b?.confirmOpenTills ? { ...runJson('waiting', [{ ...pending[1], status: 'failed', errorCode: 'open_tables' }]) } : { __status: 409, detail: { code: 'open_tills_need_confirmation', tills: [{ id: 't-bar', posNumber: '3', name: 'בר' }] } },
        'POST sync/m/shop-z/runs/run-1/proceed': () => runJson('completed', [{ ...pending[1], status: 'excluded', deferredBy: 'דנה כהן (קופה 2)' }], { zReportId: null, zNumber: 10 }),
      },
    });
    await op('shopZ.start', {});
    await f.settled();
    expect(st().shopZ!.needsConfirm).toEqual(['#3 בר']);
    await op('shopZ.start', { confirm: true });
    await f.settled();
    expect(h!.sent.filter((r) => r.path === 'sync/m/shop-z' && r.method === 'POST').map((r) => r.body)).toEqual([
      { confirmOpenTills: false, posUserName: 'דנה כהן' },
      { confirmOpenTills: true, posUserName: 'דנה כהן' },
    ]);
    const live = shopZView(st().shopZ!, NOW);
    expect(live.phase).toMatchObject({ kind: 'live', failedBox: '1 קופות לא נסגרו (הסיבה ליד כל קופה). אפשר להפיק Z בלי הן, או לתקן ולהתחיל שוב.', proceed: 'הפק Z בלי הקופות שלא נסגרו' });
    expect(live.rows[1].live.text).toBe('שולחנות פתוחים בקופה');
    await op('shopZ.proceed');
    await f.settled();
    expect(h!.sent.find((r) => r.path === 'sync/m/shop-z/runs/run-1/proceed')?.body).toEqual({ posUserName: 'דנה כהן' });
    expect(shopZView(st().shopZ!, NOW).phase).toMatchObject({ kind: 'completed', title: 'Z סניפי מס׳ 10 הופק', left: 'עברו ל-Z הבא: בר (אישר/ה: דנה כהן (קופה 2))' });
  });

  it('the shop\'s rule blocks, "Z על 0", open tables: said, and the start stays', async () => {
    let answer: Record<string, unknown> = { __status: 409, detail: { code: 'open_tills_block_z', tills: [{ posNumber: '3', name: 'בר' }] } };
    const { f, op, st } = await master({ answers: { 'GET sync/m/shop-z': () => ({ tills: tillsJson }), 'POST sync/m/shop-z': () => ({ ...answer }) } });
    await op('shopZ.start', {});
    await f.settled();
    expect(st().shopZ!.blockedBy).toEqual(['#3 בר']);
    await op('shopZ.dismiss');
    expect(st().shopZ!.blockedBy).toBeNull();
    answer = { __status: 409, detail: { code: 'empty_z' } };
    await op('shopZ.start', {});
    await f.settled();
    expect(st().shopZ!.error).toBe('אין תנועות — לא ניתן לסגור Z על 0');
    expect(shopZView(st().shopZ!, NOW).phase).toMatchObject({ kind: 'idle', startEnabled: true });
  });

  it('no Z on nothing: the start is not offered', async () => {
    const { st } = await master({ answers: { 'GET sync/m/shop-z': () => ({ tills: tillsJson, activity: { hasActivity: false, message: null } }) } });
    expect(shopZView(st().shopZ!, NOW).phase).toMatchObject({ kind: 'idle', nothing: 'אין תנועות — לא ניתן לסגור Z על 0', startEnabled: false });
  });

  it('the held sales on this till hold the start (kept where the shop allows it)', async () => {
    const { f, op, fail, st } = await master({ parameters: { mainTill: true, allowCloseWithHeldSales: 'true' }, answers: { 'GET sync/m/shop-z': () => ({ tills: tillsJson }), 'POST sync/m/shop-z': () => runJson('waiting', []) } });
    new HeldStore(h!.svc.kv).hold([{ productId: 'p-cola', name: 'קולה', qty: 1, unitAgorot: 1250 } as never], { id: 'u-cashier', name: 'דנה' }, null, 1250);
    const e = await fail('shopZ.start', {});
    expect(e.code).toBe('held_sales');
    expect(e.message).toBe('יש 1 מכירות מושהות');
    expect(e.details).toMatchObject({ keepAllowed: true });
    expect(h!.sent.some((r) => r.method === 'POST' && r.path === 'sync/m/shop-z')).toBe(false);
    await op('shopZ.start', { keepHeld: true });
    await f.settled();
    expect(h!.sent.some((r) => r.method === 'POST' && r.path === 'sync/m/shop-z')).toBe(true);
    void st;
  });

  it('offline: said in the Android words', async () => {
    const { st } = await master({
      answers: {
        'GET sync/m/shop-z': () => {
          throw new Error('down');
        },
      },
    });
    expect(st().shopZ!.error).toBe('אין חיבור לענן — Z סניפי מופק בענן בלבד.');
  });

  it('a refused read: the cloud\'s code', async () => {
    const { st } = await master({ answers: { 'GET sync/m/shop-z': () => ({ __status: 403, detail: 'z_only_from_main_till' }) } });
    expect(st().shopZ!.error).toBe('שגיאה מהענן (403)');
  });

  it('local mode, this till the main till: no start here — said, and nothing sent', async () => {
    const { f, op, st } = await master({
      answers: { 'GET sync/m/shop-z': () => ({ tills: tillsJson }), 'GET sync/m/shop-z/history': () => ({ localMode: true, mainTill: { machineId: MACHINE } }) },
    });
    const v = shopZView(st().shopZ!, NOW);
    expect(v.title).toBe('סגירת Z סניפי — רשת מקומית');
    expect(v.phase).toMatchObject({ kind: 'idle', local: SHOP_Z_TEXT.localBody, startEnabled: false });
    await op('shopZ.start', {});
    await f.settled();
    expect(h!.sent.some((r) => r.method === 'POST' && r.path === 'sync/m/shop-z')).toBe(false);
    expect(h!.svc.ledger.currentShift()).not.toBeNull();
  });

  it('"Z לנקודת מכירה": the choice asked of the cloud, and the area\'s Z started; an older cloud — no scope at all', async () => {
    const areaZ = { available: true, areaId: 'a1', areaName: 'בר', reason: null, message: null };
    let asked = 'shop';
    const { f, op, st } = await master({
      answers: {
        'GET sync/m/shop-z': () => ({ scope: asked, areaZ, tills: tillsJson }),
        'POST sync/m/shop-z': () => runJson('waiting', []),
      },
    });
    const get = vi.spyOn(h!.svc.api, 'get');
    expect(st().shopZ!.shopOffered).toBe(true);
    const v = shopZView(st().shopZ!, NOW);
    expect(v.scope?.options).toEqual([
      { area: false, label: 'כל הסניף', on: true },
      { area: true, label: 'בר', on: false },
    ]);
    asked = 'area';
    await op('shopZ.scope', { area: true });
    await f.settled();
    expect(get.mock.calls.some((c) => c[0] === 'sync/549e903c-4aba-4528-bc4a-c61b4019a64e/shop-z?scope=area')).toBe(true);
    expect(shopZView(st().shopZ!, NOW).title).toBe('Z לנקודת המכירה: בר');
    await op('shopZ.start', {});
    await f.settled();
    expect(h!.sent.find((r) => r.method === 'POST' && r.path === 'sync/m/shop-z')?.body).toMatchObject({ scope: 'area' });
  });

  it('an older cloud (no scope, no areaZ): no choice, no scope in the start', async () => {
    const { f, op, st } = await master({ answers: { 'GET sync/m/shop-z': () => ({ tills: tillsJson }), 'POST sync/m/shop-z': () => runJson('waiting', []) } });
    expect(shopZView(st().shopZ!, NOW).scope).toBeNull();
    await op('shopZ.start', {});
    await f.settled();
    expect(h!.sent.find((r) => r.method === 'POST' && r.path === 'sync/m/shop-z')?.body).not.toHaveProperty('scope');
  });

  it("the engine's own close is used when given; a payment holding it is asked again on the next poll", async () => {
    const calls: string[] = [];
    let next: 'pending' | 'closed' = 'pending';
    const { f, op } = await master({
      answers: { 'GET sync/m/shop-z': () => ({ tills: tillsJson }), 'POST sync/m/shop-z': () => runJson('waiting', pending), 'GET sync/m/shop-z/runs/run-1': () => runJson('waiting', pending) },
      opts: {
        closeOwnShift: ({ requestId, closer }) => {
          calls.push(`${requestId}:${closer.name}`);
          return next;
        },
      },
    });
    await op('shopZ.start', {});
    await f.settled();
    expect(calls).toEqual(['req-me:דנה כהן']);
    next = 'closed';
    await f.pollOnce('run-1');
    await f.settled();
    await f.pollOnce('run-1');
    await f.settled();
    expect(calls).toEqual(['req-me:דנה כהן', 'req-me:דנה כהן']);
  });

  it('a summary that will not come: said, and the tills\' details stay for later', async () => {
    const { f, st } = await master({
      answers: {
        'GET sync/m/shop-z': () => ({ tills: tillsJson, run: runJson('completed', [], { zReportId: 'z-1', zNumber: 1 }) }),
        'GET sync/m/z-reports/z-1/print-document': () => ({ __status: 404, detail: 'Z-report not found' }),
      },
    });
    await f.settled();
    const s = st().shopZ!;
    expect(s.printedZId).toBe('z-1');
    expect(s.message).toBe('ההדפסה נכשלה: HTTP 404');
    expect(s.askDetails).toBe(false);
  });

  it('the bad arguments are refused', async () => {
    const { fail } = await master({ answers: { 'GET sync/m/shop-z': () => ({ tills: [] }) } });
    expect((await fail('shopZ.scope', { area: 'yes' })).code).toBe('invalid_args');
    expect((await fail('shopZ.details', { answer: 'maybe' })).code).toBe('invalid_args');
    expect((await fail('shopZ.printDetails', { machineIds: [] })).code).toBe('invalid_args');
    expect((await fail('shopZ.start', { confirm: 1 })).code).toBe('invalid_args');
  });
});

/* ------------------------------------------------------------------ the screen */

const noop = () => undefined;
const actions: ShopZActions = { open: noop, leave: noop, refresh: noop, scope: noop, start: noop, proceed: noop, dismiss: noop, printSummary: noop, details: noop, printDetails: noop, cancelDetails: noop };
const draw = (view: ShopZState | undefined) => renderToStaticMarkup(createElement(ShopZScreen, { view, actions, back: noop, nowMs: NOW }));

export const SHOP_Z_FIXTURE: ShopZState = {
  ...emptyShopZState(),
  loading: false,
  status: statusOf({ shopName: 'הרצליה', tills: tillsJson, activity: { hasActivity: true, documents: 12 } }),
  run: runOf(runJson('waiting', [{ ...pending[0], status: 'ready', cloudVerified: true, readyAt: '2026-10-17T20:00:01Z' }, { ...pending[1], status: 'ready', cloudVerified: false, tillDocuments: 14, cloudDocuments: 11 }])),
  runStartedAtMs: NOW - 7_000,
};

describe('the screen', () => {
  it('the tills and the start; the title; nothing yet — the title only', () => {
    const html = draw({ ...emptyShopZState(), loading: false, status: statusOf({ shopName: 'הרצליה', tills: tillsJson }) });
    expect(html).toContain('סגירת Z סניפי');
    expect(html).toContain('הרצליה');
    expect(html).toContain('#3 בר');
    expect(html).toContain('(קופה זו)');
    expect(html).toContain('פתח/ה: יוסי');
    expect(html).toContain('2 קופות עם משמרת פתוחה — ייסגרו מרחוק.');
    expect(html).toContain('סגור את כל הקופות והפק Z סניפי');
    expect(draw(undefined)).toContain('סגירת Z סניפי');
  });

  it('a run waiting: the seconds, the lines, the way on without the rest', () => {
    const html = draw(SHOP_Z_FIXTURE);
    expect(html).toContain('ממתין לאישור הענן על 1 קופות…');
    expect(html).toContain('7 שניות');
    expect(html).toContain('ממתינה לעסקאות (בענן 11 מתוך 14) · 7 ש׳');
    expect(html).toContain('נסגרה ✓ (אושר בענן) · 3 ש׳');
    expect(html).toContain('ה-Z יופק רק כשהענן מאשר שכל קופה נסגרה וכל עסקאותיה עלו.');
    expect(html).toContain('הפק Z בלי הקופות שלא אושרו');
  });

  it('the Z built, a print under way with its cancel, the questions', () => {
    const done: ShopZState = {
      ...SHOP_Z_FIXTURE,
      run: runOf(runJson('completed', [], { zReportId: 'z-9', zNumber: 9 })),
      zTills: [{ machineId: 't-bar', posNumber: '3', name: 'בר' }],
      progress: 'מדפיס קופה 1 מתוך 2…',
      progressDetail: '#3 בר',
    };
    const html = draw(done);
    expect(html).toContain('Z סניפי מס׳ 9 הופק');
    expect(html).toContain('הדפס סיכום שוב');
    expect(html).toContain('פירוט קופות');
    expect(html).toContain('מדפיס קופה 1 מתוך 2…');
    expect(html).toContain('ביטול');
    expect(draw({ ...done, progress: null, progressDetail: null, askDetails: true })).toContain('להדפיס פירוט מלא לכל קופה בנפרד?');
    expect(draw({ ...done, progress: null, progressDetail: null, choosing: true })).toContain('הדפס (1)');
    const confirm = draw({ ...SHOP_Z_FIXTURE, run: null, needsConfirm: ['#3 בר'] });
    expect(confirm).toContain('קופות שיישארו מחוץ ל-Z');
    expect(confirm).toContain('הקלידו &quot;סגור&quot; לאישור');
    expect(draw({ ...SHOP_Z_FIXTURE, run: null, blockedBy: ['#3 בר'] })).toContain('חובה לסגור את כל הקופות');
  });

  it('local mode: the notice, no start', () => {
    const html = draw({ ...SHOP_Z_FIXTURE, run: null, localMode: true });
    expect(html).toContain('סגירת Z סניפי — רשת מקומית');
    expect(html).toContain('קופת Windows אינה מפיקה Z סניפי ברשת מקומית');
    expect(html).toMatch(/disabled=""[^>]*>סגור את כל הקופות והפק Z סניפי/);
  });
});

describe('a Windows till as a participant: the cloud\'s close of its shift (CloseShiftCoordinator.handleCloudRequest)', () => {
  it('closed unattended with the request\'s id, the basket left as it is; again — already closed; no shift — none', async () => {
    const h = await readyTill();
    await h.ok('sell.add', { productId: 'p-burger' });
    expect(await h.engine.remoteClose('req-1')).toBe('closed');
    expect(h.svc.ledger.currentShift()).toBeNull();
    expect(h.svc.ledger.shiftByCloseRequest('req-1')).not.toBeNull();
    // The basket is not a document: it stays.
    expect(h.state().sell.lines).toHaveLength(1);
    expect(await h.engine.remoteClose('req-1')).toBe('closed');
    expect(await h.engine.remoteClose('req-2')).toBe('none');
    h.stop();
  });
});
