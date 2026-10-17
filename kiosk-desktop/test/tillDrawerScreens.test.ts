/**
 * The screens of the drawer, the signed-in employees, the change owed and the cash credit, rendered to markup
 * (react-dom/server): what the engine's state says is what they show — the rows the role and the drawer allow, the reasons,
 * a blind count's hidden expected, the countdown of "לפתוח מגירה?", "שולם ללקוח", "הסרת הזיכוי".
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DrawerState, TillState } from '../src/shared/till/protocol';
import { browserFacts, displayProfile } from '../src/renderer/roles/till/layout/displayProfileAdapter';
import { tillLayout } from '../src/renderer/roles/till/layout/tillLayout';
import { DrawerScreen } from '../src/renderer/roles/till/screens/DrawerScreen';
import { UsersScreen } from '../src/renderer/roles/till/screens/UsersScreen';
import { OwedScreen } from '../src/renderer/roles/till/screens/OwedScreen';
import { CheckoutScreen } from '../src/renderer/roles/till/screens/CheckoutScreen';
import { EngineDialog } from '../src/renderer/roles/till/parts/EngineDialog';
import { TillMenuDrawer } from '../src/renderer/roles/till/parts/TillMenuDrawer';
import { menuFactsOf } from '../src/renderer/roles/till/TillApp';
import { buildTillMenu } from '../src/core/till/tillMenu';
import { initialState } from '../src/shared/till/mockEngine';

const noop = () => undefined;
const anoop = async () => undefined;
const drawer = (o: Partial<DrawerState> = {}): DrawerState => ({
  offered: { open: true, cashIn: true, cashOut: true, deposit: true, count: true, walletDeposit: true, log: false, remote: false },
  hosts: [],
  requireReason: true,
  requireNoteForOther: true,
  movementsEnabled: true,
  blindCount: false,
  reasons: [
    { code: 'CHANGE', label: 'פריטת כסף' },
    { code: 'OTHER', label: 'אחר' },
  ],
  count: null,
  ...o,
});
const actions = { open: anoop, openRemote: anoop, movement: anoop, count: anoop, countSave: anoop, countDone: anoop, wallets: async () => undefined, deposit: anoop, log: async () => undefined, back: noop };

describe('the drawer screens', () => {
  it('"מזומן במגירה": the rows the drawer and the role allow, in Android\'s words', () => {
    const html = renderToStaticMarkup(createElement(DrawerScreen, { drawer: drawer(), actions }));
    for (const w of ['פתיחת מגירה', 'הכנסת מזומן', 'הוצאת מזומן', 'הפקדה / ריקון חלקי', 'ספירת מגירה', 'הפקדת מזומן מעובד']) expect(html).toContain(w);
    expect(html).not.toContain('לוג פתיחות מגירה');
    const remote = renderToStaticMarkup(createElement(DrawerScreen, { drawer: drawer({ offered: { ...drawer().offered, open: false, remote: true }, hosts: [{ id: 'm-2', label: 'בר' }] }), actions }));
    expect(remote).toContain('פתיחת מגירה בבר');
  });

  it('the reasons, and a blind count says the expected comes after the amount', () => {
    expect(renderToStaticMarkup(createElement(DrawerScreen, { drawer: drawer(), initial: 'reason', actions }))).toContain('פריטת כסף');
    const blind = renderToStaticMarkup(createElement(DrawerScreen, { drawer: drawer({ count: { blind: true, expectedAgorot: null, result: null } }), initial: 'count', actions }));
    expect(blind).toContain('ספירה עיוורת');
    const result = renderToStaticMarkup(createElement(DrawerScreen, { drawer: drawer({ count: { blind: true, expectedAgorot: 20_000, result: { countedAgorot: 19_900, expectedAgorot: 20_000, varianceAgorot: -100 } } }), initial: 'count', actions }));
    expect(result).toContain('צפוי');
    expect(result).toContain('נספר');
  });

  it('"לפתוח מגירה?" shows its seconds left', () => {
    const html = renderToStaticMarkup(
      createElement(EngineDialog, {
        dialog: { id: 'd1', kind: 'confirm', title: 'לפתוח מגירה?', body: 'נפתחת בעוד 8 שניות', fields: [], actions: [{ id: 'open', label: 'פתח', primary: true }, { id: 'skip', label: 'לא' }], expiresAt: Date.now() + 8_000 },
        answer: noop,
      }),
    );
    expect(html).toContain('t-countdown');
    expect(html).toContain('פתח');
    expect(html).toContain('לא');
  });
});

describe('the employees, the change owed, the credit', () => {
  it('"עובדים מחוברים": who, where, since; release on the others', () => {
    const html = renderToStaticMarkup(
      createElement(UsersScreen, {
        users: {
          notice: null,
          offered: true,
          busy: false,
          error: null,
          list: {
            at: 0,
            sessions: [
              { id: 's1', posUserId: 'u1', posUserName: 'דנה', machineName: 'בר', posNumber: '3', startedAt: '2026-10-16T10:00:00Z', lastSeenAt: null, silentSince: null, openTables: 2, here: false },
              { id: 's2', posUserId: 'u2', posUserName: 'אבי', machineName: null, posNumber: '1', startedAt: '2026-10-16T10:00:00Z', lastSeenAt: null, silentSince: null, openTables: 0, here: true },
            ],
          },
        },
        actions: { open: noop, refresh: noop, release: noop, close: noop },
      }),
    );
    expect(html).toContain('דנה');
    expect(html).toContain('שולחנות פתוחים: 2');
    expect(html).toContain('המכשיר הזה');
    expect(html.match(/שחרור/g)?.length).toBe(1);
  });

  it('"עודף חייב ללקוח" with "שולם ללקוח" on each', () => {
    const html = renderToStaticMarkup(createElement(OwedScreen, { owed: { items: [{ id: 'o-1', line: 'עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪', amountAgorot: 1300 }] }, actions: { refresh: noop, pay: noop, back: noop } }));
    expect(html).toContain('עמדת מזומן 2 · עודף חייב ללקוח — הזמנה 57: 13 ₪');
    expect(html).toContain('שולם ללקוח');
  });

  it('the payment: the credit field, the credit leg and "הסרת הזיכוי"', () => {
    const layout = tillLayout(displayProfile(browserFacts(1280, 800, 1)));
    const html = renderToStaticMarkup(
      createElement(CheckoutScreen, {
        checkout: { phase: 'tender', totalAgorot: 4_200, paidAgorot: 1_000, dueAgorot: 3_200, changeAgorot: 0, legs: [{ method: 'cash_credit', amountAgorot: 1_000, status: 'approved', credit: { code: 'C-K7Q3MX', redemptionId: 'r1' } }], documentRef: null },
        layout,
        cardTile: { id: 'card', label: 'אשראי', available: true, reason: '' },
        demo: false,
        actions: { cash: noop, card: noop, cancel: noop, finish: noop, print: noop, copy: noop, recheck: noop, markNotApproved: noop, credit: noop, removeCredit: noop },
      }),
    );
    expect(html).toContain('זיכוי C-K7Q3MX');
    expect(html).toContain('הסרת הזיכוי');
    expect(html).toContain('זיכוי מזומן');
  });

  it('the menu: the drawer rows by the engine\'s word, "עובדים מחוברים" where the rule is on', () => {
    const base: TillState = initialState({ role: 'till', rolesAllowed: [], terminal: false, printer: false, catalogVersion: 1, nowIso: '2026-10-09T12:00:00.000Z' });
    const open = { ...base.shift, open: true };
    const s: TillState = { ...base, shift: open, drawer: drawer(), users: { notice: null, offered: true, list: null, busy: false, error: null }, owed: { items: [{ id: 'o', line: 'x', amountAgorot: 1 }] } };
    const draw = (st: TillState, demo: boolean) =>
      renderToStaticMarkup(
        createElement(TillMenuDrawer, {
          groups: buildTillMenu(menuFactsOf(st, { demo, settings: false, current: null })),
          folderOpen: false,
          user: { name: 'דנה כהן', roleName: 'קופאי/ת', shopName: 'מרכז', posNumber: '3', identity: [] },
          onTarget: noop,
          onClose: noop,
        }),
      );
    const html = draw(s, false);
    expect(html).toContain('עובדים מחוברים');
    expect(html).toContain('עודף חייב ללקוח');
    expect(html).toContain('פתיחת מגירה');
    expect(html).toContain('מזומן במגירה');
    expect(html).not.toContain('פתיחת מגירה בקופה אחרת');
    // The profile card: initials, the name, "role · shop · till".
    expect(html).toContain('דכ');
    expect(html).toContain('קופאי/ת · מרכז · קופה 3');
    // The demo's engine says nothing of the drawer: no drawer rows at all — never a "soon" button that does nothing.
    const demo = draw({ ...base, shift: open }, true);
    expect(demo).not.toContain('פתיחת מגירה');
    expect(demo).not.toContain('בקרוב');
    expect(demo).not.toContain('עודף חייב ללקוח');
    expect(demo).toContain('יציאה מהמשתמש');
  });
});
