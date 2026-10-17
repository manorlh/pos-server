/**
 * "תפריט" on the Windows till as the Android till's ☰ drawer (core/till/tillMenu.ts, P:/specs/windows-till-menu-parity.md):
 * the groups and rows in the Android order and words, the visibility rules (`hiddenMenuItems` by the Android keys of the
 * shared golden till_menu_items_golden.json, "כשאין הרשאה" = להסתיר, a closed till, a Z-only till, a refund under way), the
 * local reports of the "דוחות" folder (core/till/localReports.ts), and the engine's side (main/till/tillMenuService.ts).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MENU_ITEM_KEYS } from '../src/core/till/menuHide';
import { MENU_TEXT, buildTillMenu, folderOpenAtStart, initialsOf, profileLine, type MenuGroup, type TillMenuFacts } from '../src/core/till/tillMenu';
import { docsIn, productSalesReport, reportWindow, tipsReport, workerReport, type ReportDoc } from '../src/core/till/localReports';
import { MANAGER_PIN, readyTill } from './tillEngineHarness';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Everything on: an open till that makes its own Z, the drawer, a release, the reports, the device's rows. */
const FULL: TillMenuFacts = {
  shiftOpen: true,
  zOnly: false,
  tillZMode: true,
  hidden: [],
  denied: [],
  refundMode: false,
  drawer: { open: true, remote: false, cashIn: true, cashOut: true, deposit: true, count: true, walletDeposit: true, log: true },
  drawerHosts: [],
  owedCount: 0,
  sync: { running: false, lastAt: '2026-10-17 21:04', error: null, waiting: 0 },
  update: { version: '0.5.12', phase: 'ready', message: null },
  showTillZHistory: true,
  localReports: true,
  shopX: true,
  settings: true,
  printQueueCount: 2,
  printQueue: true,
  blocks: true,
  signedInUsers: true,
  workMode: { label: MENU_TEXT.toKiosk },
  support: true,
};

const labels = (g: MenuGroup[]) => g.map((x) => ({ id: x.id, title: x.title, rows: x.rows.map((r) => r.label), folder: (x.folder ?? []).map((r) => r.label) }));
const keys = (g: MenuGroup[]) => g.flatMap((x) => [...x.rows, ...(x.folder ?? [])].map((r) => r.key)).filter((k): k is NonNullable<typeof k> => k !== null);

describe('the menu: the Android drawer\'s groups, order and words', () => {
  it('an open till with everything on', () => {
    expect(labels(buildTillMenu(FULL))).toEqual([
      {
        id: 'shift',
        title: 'משמרת',
        rows: ['משמרת (דו״ח X)', 'סגירת משמרת', 'הפק Z', 'פתיחת מגירה', 'מזומן במגירה', 'זיכוי', 'פעולות אשראי', 'סנכרון מול הענן', 'עדכון גרסה 0.5.12'],
        folder: [],
      },
      { id: 'reports', title: 'דוחות', rows: ['היסטוריה'], folder: ['24 השעות האחרונות', 'היסטוריית משמרות', 'דוחות Z', 'מכירות לפי מוצר', 'דוח לפי עובד', 'דוח תשר', 'דוח X סניפי'] },
      { id: 'manage', title: 'ניהול', rows: ['הגדרות', 'תור הדפסה', 'אבחון'], folder: [] },
      { id: 'device', title: null, rows: ['מעבר לקיוסק', 'חסומים כעת', 'עובדים מחוברים', 'תמיכה מרחוק', 'יציאה מהמשתמש'], folder: [] },
    ]);
  });

  it('the tiles and glyphs are the Android ones (tileOf / DrawerIcon)', () => {
    const rows = buildTillMenu(FULL).flatMap((g) => [...g.rows, ...(g.folder ?? [])]);
    const tile = (label: string) => rows.find((r) => r.label === label)!;
    expect([tile('משמרת (דו״ח X)').tile, tile('סגירת משמרת').tile, tile('הפק Z').tile, tile('פעולות אשראי').tile]).toEqual(['blue', 'graphite', 'green', 'orange']);
    expect([tile('24 השעות האחרונות').tile, tile('היסטוריית משמרות').tile, tile('מכירות לפי מוצר').tile, tile('דוח תשר').tile, tile('דוח X סניפי').tile]).toEqual(['teal', 'indigo', 'orange', 'yellow', 'cyan']);
    expect([tile('זיכוי').glyph, tile('סנכרון מול הענן').glyph, tile('תור הדפסה').badge, tile('יציאה מהמשתמש').danger]).toEqual(['return', 'refresh', 2, true]);
  });

  it('every row is a key of the shared golden (till_menu_items_golden.json), and the golden\'s own words where it names the row', () => {
    const golden = JSON.parse(readFileSync(path.join(here, 'fixtures', 'till_menu_items_golden.json'), 'utf8')) as Array<{ key: string; label: string }>;
    const goldenKeys = golden.map((g) => g.key);
    const ks = keys(buildTillMenu({ ...FULL, owedCount: 1 }));
    for (const k of ks) expect(goldenKeys).toContain(k);
    expect([...MENU_ITEM_KEYS]).toEqual(goldenKeys);
    const label = (k: string) => golden.find((g) => g.key === k)!.label;
    for (const k of ['shift', 'shift_close', 'till_z', 'open_cash_drawer', 'refund', 'sync_now', 'history', 'recent', 'shift_history', 'product_sales', 'workers', 'tips', 'settings', 'print_queue', 'blocks_now', 'signed_in_users', 'support', 'shop_x']) {
      const row = buildTillMenu(FULL)
        .flatMap((g) => [...g.rows, ...(g.folder ?? [])])
        .find((r) => r.key === k)!;
      expect(row.label, k).toBe(label(k));
    }
  });
});

describe('the menu: what is shown (MenuHideNav.kt, DeniedMenu.kt, ShiftMenu.kt)', () => {
  it('`hiddenMenuItems`: each hidden key\'s row is gone, for everyone; "אבחון" stays while "הגדרות" is hidden', () => {
    for (const k of MENU_ITEM_KEYS) {
      const ks = keys(buildTillMenu({ ...FULL, hidden: [k] }));
      expect(ks, k).not.toContain(k);
    }
    expect(keys(buildTillMenu({ ...FULL, hidden: ['settings', 'diagnostics'] }))).toContain('diagnostics');
    // The whole folder hidden: no "דוחות" folder row either.
    const all = buildTillMenu({ ...FULL, hidden: ['recent', 'shift_history', 'till_z_history', 'product_sales', 'workers', 'tips', 'shop_x'] });
    expect(all.find((g) => g.id === 'reports')!.folder).toEqual([]);
  });

  it('"כשאין הרשאה" = להסתיר: the close, the Z, the refund, the reports, the shop X leave; "סיום זיכוי" never', () => {
    const g = buildTillMenu({ ...FULL, denied: ['SHIFT_CLOSE', 'Z', 'REFUND', 'VIEW_REPORTS', 'SHOP_X_REPORT'] });
    const ks = keys(g);
    for (const k of ['shift_close', 'till_z', 'refund', 'recent', 'product_sales', 'shop_x']) expect(ks, k).not.toContain(k);
    expect(ks).toContain('shift');
    expect(ks).toContain('history');
    const ending = buildTillMenu({ ...FULL, denied: ['REFUND'], refundMode: true }).flatMap((x) => x.rows);
    expect(ending.find((r) => r.key === 'refund')).toMatchObject({ label: 'סיום זיכוי', target: 'refundEnd', selected: true });
  });

  it('a closed till: reports, "פעולות אשראי", the sync and the device\'s rows — no shift, drawer, refund or "ניהול"; the folder opens', () => {
    const g = buildTillMenu({ ...FULL, shiftOpen: false });
    expect(labels(g).map((x) => x.id)).toEqual(['shift', 'reports', 'device']);
    expect(g[0].rows.map((r) => r.label)).toEqual(['פעולות אשראי', 'סנכרון מול הענן']);
    expect(folderOpenAtStart(g, null, false, false)).toBe(true);
    expect(folderOpenAtStart(buildTillMenu(FULL), null, true, false)).toBe(false);
    expect(folderOpenAtStart(buildTillMenu(FULL), 'productSales', true, false)).toBe(true);
  });

  it('a Z-only till: "הקופה", "דו״ח X" and "הפק Z" (whatever the Z mode), no "סגירת משמרת"; "היסטוריית דו״חות X"', () => {
    const g = buildTillMenu({ ...FULL, zOnly: true, shiftOpen: false, tillZMode: false });
    expect(g[0].title).toBe('הקופה');
    expect(g[0].rows.slice(0, 2).map((r) => r.label)).toEqual(['דו״ח X', 'הפק Z']);
    expect(g.find((x) => x.id === 'reports')!.folder!.map((r) => r.label)).toContain('היסטוריית דו״חות X');
    // The shop's Z mode on an ordinary till: no "הפק Z".
    expect(keys(buildTillMenu({ ...FULL, tillZMode: false }))).not.toContain('till_z');
  });

  it('the drawer rows by the engine\'s word; another till\'s drawer named when it is the one', () => {
    const none = buildTillMenu({ ...FULL, drawer: null });
    expect(keys(none)).not.toContain('open_cash_drawer');
    expect(keys(none)).not.toContain('cash_menu');
    const remote = buildTillMenu({ ...FULL, drawer: { ...FULL.drawer!, open: false, remote: true }, drawerHosts: [{ id: 'm2', label: 'קופה 2' }] });
    expect(remote[0].rows.map((r) => r.label)).toContain('פתיחת מגירה בקופה 2');
    const many = buildTillMenu({ ...FULL, drawer: { ...FULL.drawer!, open: false, remote: true }, drawerHosts: [{ id: 'm2', label: 'קופה 2' }, { id: 'm3', label: 'קופה 3' }] });
    expect(many[0].rows.map((r) => r.label)).toContain('פתיחת מגירה בקופה אחרת');
  });

  it('no row the till cannot carry out: the demo has no drawer, queue, blocks, reports or update — and never a "בקרוב"', () => {
    const demo = buildTillMenu({ ...FULL, drawer: null, sync: null, update: null, localReports: false, shopX: false, settings: false, printQueue: false, blocks: false, signedInUsers: false, workMode: null, support: false });
    expect(keys(demo)).toEqual(['shift', 'shift_close', 'till_z', 'refund', 'transmission', 'history', 'diagnostics', 'switch_user']);
  });

  it('the sync row says how it went; the update row what it waits for', () => {
    const row = (f: Partial<TillMenuFacts>, key: string) => buildTillMenu({ ...FULL, ...f }).flatMap((g) => g.rows).find((r) => r.key === key)!;
    expect(row({}, 'sync_now').sub).toBe('סנכרון אחרון: 2026-10-17 21:04');
    expect(row({ sync: { running: true, lastAt: null, error: null, waiting: 0 } }, 'sync_now')).toMatchObject({ label: 'מסנכרן…', busy: true, sub: null });
    expect(row({ sync: { running: false, lastAt: null, error: 'אין חיבור לענן', waiting: 0 } }, 'sync_now')).toMatchObject({ sub: 'הסנכרון נכשל: אין חיבור לענן', subError: true });
    expect(row({ update: { version: '0.5.12', phase: 'downloading', message: null } }, 'app_update').sub).toBe('מוריד את העדכון…');
  });

  it('the profile card: two initials, "role · shop · till"', () => {
    expect(initialsOf('דנה כהן')).toBe('דכ');
    expect(initialsOf('Jonathan')).toBe('JO');
    expect(initialsOf(' ')).toBe('?');
    expect(profileLine('קופאי/ת', 'הרצליה', '2')).toBe('קופאי/ת · הרצליה · קופה 2');
    expect(profileLine(null, null, null)).toBe('');
  });
});

describe('the local reports (RangeReports.kt)', () => {
  const doc = (o: Partial<ReportDoc>): ReportDoc => ({
    status: 'completed',
    documentType: 320,
    createdAt: '2026-10-17T09:00:00.000Z',
    cashierId: 'u1',
    cashierName: 'דנה',
    lines: [],
    payments: [],
    tipAgorot: 0,
    tipMethod: null,
    ...o,
  });
  const docs = [
    doc({ lines: [{ productId: 'p1', name: 'המבורגר', qty: 2, agorot: 8_400 }], payments: [{ method: 'cash', amountAgorot: 8_400 }], tipAgorot: 500, tipMethod: 'cash' }),
    doc({ cashierId: 'u2', cashierName: 'אבי', lines: [{ productId: 'p2', name: 'קולה', qty: 1, agorot: 1_250 }, { productId: 'p1', name: 'המבורגר', qty: 1, agorot: 4_200 }], payments: [{ method: 'card', amountAgorot: 5_450 }] }),
    // A credit note: positive figures, a refund by its type — never added to the sales.
    doc({ documentType: 330, lines: [{ productId: 'p1', name: 'המבורגר', qty: 1, agorot: 4_200 }], payments: [{ method: 'cash', amountAgorot: 4_200 }] }),
    // Cancelled: in no report.
    doc({ status: 'cancelled', lines: [{ productId: 'p2', name: 'קולה', qty: 9, agorot: 99_999 }] }),
  ];

  it('products: sales, refunds, net and units; the best seller first', () => {
    const r = productSalesReport(docs, 'today', 'היום');
    expect(r.sections[0].rows.map((x) => [x.label, x.value])).toEqual([
      ['מכירות', '₪138.50'],
      ['זיכויים', '−₪42.00'],
      ['נטו', '₪96.50'],
      ['יחידות (נטו)', '3'],
    ]);
    expect(r.sections[1].rows.map((x) => x.label)).toEqual(['המבורגר', 'קולה']);
    expect(r.sections[1].rows[0]).toMatchObject({ value: '₪84.00', sub: '2 יחידות · זיכויים −₪42.00' });
  });

  it('workers: each cashier\'s documents, net, cash less cash given back, card', () => {
    const r = workerReport(docs, 'today', 'היום');
    const dana = r.sections.find((s) => s.title === 'דנה')!;
    expect(dana.rows.map((x) => [x.label, x.value])).toEqual([
      ['נטו', '₪42.00'],
      ['מסמכים', '2'],
      ['מכירות', '₪84.00'],
      ['זיכויים (1)', '−₪42.00'],
      ['מזומן', '₪42.00'],
      ['אשראי', '₪0.00'],
    ]);
  });

  it('tips: by tender and by cashier; none — its sentence', () => {
    const r = tipsReport(docs, 'today', 'היום');
    expect(r.sections[0].rows[0]).toMatchObject({ label: 'סה״כ', value: '₪5.00' });
    expect(r.sections[1].rows[0]).toMatchObject({ label: 'מזומן', value: '₪5.00' });
    expect(tipsReport([], 'today', 'היום').empty).toBe('לא נרשם תשר בטווח הזה.');
  });

  it('the windows: today, yesterday, the week from Sunday, the morning and evening shifts', () => {
    const now = new Date(2026, 9, 17, 15, 30); // Saturday 17.10.2026
    const w = (p: Parameters<typeof reportWindow>[0]) => {
      const x = reportWindow(p, now);
      return [x.from.getDate(), x.from.getHours(), x.to.getDate(), x.to.getHours()];
    };
    expect(w('today')).toEqual([17, 0, 18, 0]);
    expect(w('yesterday')).toEqual([16, 0, 17, 0]);
    expect(w('week')).toEqual([11, 0, 18, 0]);
    expect(w('morning')).toEqual([17, 6, 17, 14]);
    expect(w('evening')).toEqual([17, 14, 17, 22]);
    expect(reportWindow('today', now).label).toBe('היום · 17/10/2026');
    const inside = docsIn([doc({ createdAt: new Date(2026, 9, 17, 9).toISOString() }), doc({ createdAt: new Date(2026, 9, 16, 9).toISOString() })], reportWindow('today', now).from, reportWindow('today', now).to);
    expect(inside).toHaveLength(1);
  });
});

describe('the engine\'s side of the menu (main/till/tillMenuService.ts)', () => {
  it('the profile card and the details, the sync row, the reports\' facts — in the state while signed in', async () => {
    const h = await readyTill({ zMode: 'till' });
    try {
      const m = h.state().menu!;
      expect(m.roleName).toBe('קופאי/ת');
      expect(m.shopName).toBe('הרצליה');
      expect(m.posNumber).toBe('2');
      expect(m.identity.map((r) => r.label)).toEqual(['חברה', 'סניף', 'מספר קופה', 'שם קופה', 'גרסה']);
      expect(m.showTillZHistory).toBe(true);
      expect(m.update).toBeNull();
      expect(m.report).toBeNull();
      await h.ok('session.logout');
      expect(h.state().menu).toBeUndefined();
    } finally {
      h.stop();
    }
  });

  it('"מכירות לפי מוצר" after a sale: "דוחות בקופה" for a manager at once; the report in the state', async () => {
    const h = await readyTill({}, MANAGER_PIN);
    try {
      await h.ok('sell.add', { productId: 'p-burger' });
      await h.ok('sell.add', { productId: 'p-burger' });
      await h.ok('checkout.start');
      await h.ok('checkout.cash', { amountAgorot: 10_000 });
      await h.ok('report.local', { kind: 'products', preset: 'today' });
      const r = h.state().menu!.report!;
      expect(r.kind).toBe('products');
      expect(r.sections[1].rows[0]).toMatchObject({ label: 'המבורגר', value: '₪84.00' });
      await h.ok('report.local', { kind: 'shifts' });
      expect(h.state().menu!.report!.sections[0].rows[0].label).toMatch(/^משמרת #\d+ · פתוחה$/);
      // "24 השעות האחרונות": the documents of the last day.
      const recent = await h.ok<Array<{ ref: string }>>('doc.history', { hours: 24 });
      expect(recent).toHaveLength(1);
      // A Z this till does not hold: refused in words.
      expect((await h.fail('report.reprintZ', { id: 'nope' })).message).toBe('הדוח לא נמצא בקופה');
      expect((await h.fail('report.local', { kind: 'nope' })).code).toBe('invalid_args');
    } finally {
      h.stop();
    }
  });

  it('a cashier: "דוחות בקופה" asks a manager\'s code first (the legacy role)', async () => {
    const h = await readyTill();
    try {
      await h.call('report.local', { kind: 'workers' });
      const d = h.state().dialog;
      if (d) {
        expect(d.kind).toBe('manager_approval');
        expect(h.state().menu!.report).toBeNull();
        await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
      }
      expect(h.state().menu!.report!.kind).toBe('workers');
    } finally {
      h.stop();
    }
  });

  it('"סנכרון מול הענן": runs in place and says when; "תמיכה מרחוק": the Android sentence when QuickSupport is missing', async () => {
    const h = await readyTill();
    try {
      await h.ok('menu.sync');
      expect(h.state().menu!.sync.running).toBe(true);
      await new Promise((r) => setTimeout(r, 200));
      expect(h.state().menu!.sync.running).toBe(false);
      await h.ok('menu.support');
      expect(h.events.some((e) => e.ev === 'toast' && (e.data as { text: string }).text === 'TeamViewer QuickSupport אינו מותקן במכשיר')).toBe(true);
    } finally {
      h.stop();
    }
  });
});
