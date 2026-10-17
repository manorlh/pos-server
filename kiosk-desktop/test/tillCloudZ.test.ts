/**
 * "דוחות Z" from the cloud on the Windows till (core/till/cloudZ.ts, main/till/tillCloudZ.ts, screens/CloudZScreen.tsx) —
 * pos-android ui/reports/CloudZScreen.kt, ShopZLogic.kt, ZPrintJobs.kt, FailedPaymentsUi.kt: the words, the order of the
 * tills, the paper, the gate ("דוחות בקופה"), the list, a Z's parts, a sequence, a cancel between tills, offline, a 404.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import type { ZDoc } from '../src/core/printDocs';
import {
  CLOUD_Z_TEXT,
  cloudPrintDocumentOf,
  cloudZListOf,
  cloudZPaper,
  cloudZView,
  failedPaymentsOnCloudPaper,
  printDocumentPath,
  printSequenceMessage,
  sequenceOrder,
  tillLabel,
  tillsInOrder,
  type CloudZState,
} from '../src/core/till/cloudZ';
import { TillCloudZ, type CloudZPrint } from '../src/main/till/tillCloudZ';
import { CloudZScreen } from '../src/renderer/roles/till/screens/CloudZScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { MANAGER_PIN, PIN, harness, roster, type Harness, type HarnessOptions } from './tillEngineHarness';
import { until } from './support/kitchenFakes';

const op = (s: string) => s as TillOp;

const TILLS = [
  { machineId: 't-3', posNumber: '10', name: 'בר' },
  { machineId: 't-1', posNumber: '2', name: 'קופה ראשית' },
  { machineId: 't-2', posNumber: null, name: 'אחורית' },
];

const LIST = {
  items: [
    { id: 'z-58', number: 58, businessDate: '2026-10-16', totalSales: '₪12,480.00', shiftCount: 3, machineCount: 3, tills: TILLS },
    { id: 'z-57', number: 57, businessDate: '2026-10-15', totalSales: '₪9,310.50' },
    { id: 'z-56', number: 56, businessDate: '2026-10-14', totalSales: '₪8,002.00', tills: [] },
  ],
  total: 3,
};

const DOC = (title: string) => ({
  title,
  number: 58,
  copyMark: 'העתק',
  businessName: 'בדיקה בע״מ',
  subtitle: ['תאריך עסקי 16/10/2026', 'הופק 23:58'],
  sections: [
    { title: 'מכירות', rows: [{ label: 'סה״כ', value: '₪12,480.00', emphasis: true }] },
    { title: 'עסקאות שלא הושלמו', key: 'failed_payments', informational: true, rows: [{ label: 'אשראי', value: '2' }] },
    { title: 'מכירות שבוטלו', key: 'cancelled_sales', rows: [{ label: 'מכירות', value: '1' }] },
  ],
  footer: ['הופק בענן'],
});

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

function users(viewReports: 'allow' | 'approval' | 'deny') {
  return roster().map((u) => (u.id === 'u-cashier' ? { ...u, permissions: { SELL: 'allow', VIEW_REPORTS: viewReports } } : u));
}

async function till(o: HarnessOptions & { viewReports?: 'allow' | 'approval' | 'deny'; pin?: string } = {}, print?: CloudZPrint) {
  h = harness({ users: users(o.viewReports ?? 'allow'), ...o });
  const f = h.engine.register(new TillCloudZ(h.engine.ctx, print ? { print } : {}));
  await h.ok('session.login', { pin: o.pin ?? PIN });
  return { h, f };
}

const cz = (x: Harness) => x.state() as unknown as { cloudZ?: CloudZState };

function capture() {
  const printed: Array<{ doc: ZDoc; refId: string; title: string }> = [];
  const print: CloudZPrint = (doc, refId, title) => {
    printed.push({ doc, refId, title });
    return `job-${printed.length}`;
  };
  return { printed, print };
}

const listed = (x: Harness) => until(() => (cz(x).cloudZ?.rows.length ?? 0) > 0 || !!cz(x).cloudZ?.message || !!cz(x).cloudZ?.empty);

/* ------------------------------------------------------------------ the rules */

describe('the words and the rules (CloudZScreen.kt, ShopZLogic.kt)', () => {
  it('Android\'s words, word for word', () => {
    expect(CLOUD_Z_TEXT.title).toBe('דוחות Z');
    expect(CLOUD_Z_TEXT.loading).toBe('טוען מהענן…');
    expect(CLOUD_Z_TEXT.empty).toBe('עדיין לא הופקו דוחות Z לסניף.');
    expect(CLOUD_Z_TEXT.unavailable).toBe('לא ניתן לטעון את דוחות ה־Z מהענן (בדקו חיבור).');
    expect(CLOUD_Z_TEXT.number(57)).toBe('דו״ח Z ‏#57');
    expect(CLOUD_Z_TEXT.printed(57)).toBe('דו״ח Z ‏#57 נשלח למדפסת.');
    expect(CLOUD_Z_TEXT.printSequence(2)).toBe('הדפס רצף (2)');
    expect(CLOUD_Z_TEXT.sequencePrinting('1/2')).toBe('מדפיס 1/2…');
    expect(CLOUD_Z_TEXT.sequenceDone(2, 2)).toBe('הודפסו 2 מתוך 2 דוחות Z.');
    expect(CLOUD_Z_TEXT.sequenceFailed(0, 2, 'x')).toBe('הודפסו 0 מתוך 2 דוחות Z — x');
    expect(CLOUD_Z_TEXT.printWhat(58)).toBe('מה להדפיס מדו״ח Z ‏#58?');
    expect(CLOUD_Z_TEXT.printSummary).toBe('סיכום (סה״כ הסניף ושורה לכל קופה)');
    expect(CLOUD_Z_TEXT.printTill('#2 קופה')).toBe('פירוט #2 קופה');
    expect(CLOUD_Z_TEXT.printAllTills(3)).toBe('פירוט כל הקופות, כל אחת בנפרד (3)');
    expect(CLOUD_Z_TEXT.printingTill(2, 3)).toBe('מדפיס קופה 2 מתוך 3…');
    expect(CLOUD_Z_TEXT.notPrinted('x')).toBe('הדוח לא הודפס: x');
    expect(CLOUD_Z_TEXT.noPrinter).toBe('אין מדפסת זמינה להדפסת הדוח — הגדירו מדפסת בענן (מדפסות)');
  });

  it('tills in till-number order (numbers as numbers), the unnumbered last by name; "#4 קופה 1"', () => {
    const t = tillsInOrder([...TILLS, { machineId: 't-4', posNumber: null, name: 'א' }]);
    expect(t.map((x) => x.machineId)).toEqual(['t-1', 't-3', 't-4', 't-2']);
    expect(tillLabel({ machineId: 'x', posNumber: '4', name: 'קופה 1' })).toBe('#4 קופה 1');
    expect(tillLabel({ machineId: 'x', posNumber: null, name: null })).toBe('קופה');
    expect(tillLabel({ machineId: 'x', posNumber: ' ', name: 'בר' })).toBe('בר');
  });

  it('the list read leniently; the sequence by Z number', () => {
    const l = cloudZListOf({ items: [...LIST.items, { number: 3 }, null], total: 9 });
    expect(l.items.map((z) => z.id)).toEqual(['z-58', 'z-57', 'z-56']);
    expect(l.total).toBe(9);
    expect(l.items[1].tills).toBeNull();
    expect(cloudZListOf(null)).toEqual({ items: [], total: 0 });
    expect(sequenceOrder(l.items, new Set(['z-58', 'z-56'])).map((z) => z.number)).toEqual([56, 58]);
  });

  it('a run of prints: a failure stops it, a cancel says how far it got, all printed says nothing', () => {
    expect(printSequenceMessage({ printed: 3, total: 3, cancelled: false, error: null })).toBeNull();
    expect(printSequenceMessage({ printed: 1, total: 3, cancelled: true, error: null })).toBe('ההדפסה הופסקה — הודפסו 1 מתוך 3');
    expect(printSequenceMessage({ printed: 1, total: 3, cancelled: false, error: 'אין נייר' })).toBe('הדוח לא הודפס: אין נייר (הודפסו 1 מתוך 3)');
  });

  it('the paper: the failed payments off unless the parameter; drawn as Android\'s renderer', () => {
    const doc = cloudPrintDocumentOf(DOC('דו״ח Z'))!;
    expect(failedPaymentsOnCloudPaper({}, doc).sections.map((s) => s.title)).toEqual(['מכירות']);
    expect(failedPaymentsOnCloudPaper({ printFailedPaymentsWithReports: 'true' }, doc).sections).toHaveLength(3);
    const z = cloudZPaper(failedPaymentsOnCloudPaper({}, doc), null);
    expect(z.ops).toEqual([
      { t: 'centred', text: 'בדיקה בע״מ', size: 24, bold: true },
      { t: 'centred', text: 'דו״ח Z #58', size: 28, bold: true },
      { t: 'centred', text: 'העתק', size: 18, bold: false },
      { t: 'centred', text: 'תאריך עסקי 16/10/2026', size: 18, bold: false },
      { t: 'centred', text: 'הופק 23:58', size: 18, bold: false },
      { t: 'divider' },
      { t: 'row', label: 'מכירות', value: '', bold: true },
      { t: 'row', label: 'סה״כ', value: '₪12,480.00', bold: true },
      { t: 'divider' },
      { t: 'centred', text: 'הופק בענן', size: 17, bold: false },
    ]);
    expect(cloudPrintDocumentOf('x')).toBeNull();
    expect(printDocumentPath('m', 'z 1', { part: 'summary' })).toBe('sync/m/z-reports/z%201/print-document?part=summary');
    expect(printDocumentPath('m', 'z', { till: 't-1' })).toBe('sync/m/z-reports/z/print-document?till=t-1');
  });
});

/* ------------------------------------------------------------------ the service */

describe('the service through the engine', () => {
  it('opens behind "דוחות בקופה" (allowed), lists the shop\'s Zs (limit 30)', async () => {
    const { h } = await till({ answers: { 'GET sync/m/z-reports': () => LIST } });
    expect(cz(h).cloudZ).toBeUndefined();
    await h.ok(op('cloudZ.open'));
    await listed(h);
    const v = cz(h).cloudZ!;
    expect(v.rows.map((r) => r.title)).toEqual(['דו״ח Z ‏#58', 'דו״ח Z ‏#57', 'דו״ח Z ‏#56']);
    expect(v.rows[0].line).toBe('⁦2026-10-16⁩ · ⁦₪12,480.00⁩');
    expect(v.sequenceLabel).toBe('הדפס רצף (0)');
    expect(v.canSequence).toBe(false);
    expect(h.sent.find((s) => s.path === 'sync/m/z-reports')).toBeTruthy();
  });

  it('a manager\'s code when the role asks one; refused when denied', async () => {
    const { h } = await till({ viewReports: 'approval', answers: { 'GET sync/m/z-reports': () => LIST } });
    await h.ok(op('cloudZ.open'));
    const d = h.state().dialog!;
    expect(d.kind).toBe('manager_approval');
    expect(cz(h).cloudZ).toBeUndefined();
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    await listed(h);
    expect(cz(h).cloudZ!.rows).toHaveLength(3);
    h.stop();
    const denied = await till({ viewReports: 'deny', answers: { 'GET sync/m/z-reports': () => LIST } });
    const e = await denied.h.fail(op('cloudZ.open'));
    expect(e.code).toBe('permission_denied');
    expect(cz(denied.h).cloudZ).toBeUndefined();
  });

  it('offline: Android\'s words; an older cloud (404): unsupported, the row should go', async () => {
    const off = await till({});
    // No answer for the route: the fake cloud says 404.
    await off.h.ok(op('cloudZ.open'));
    await listed(off.h);
    expect(cz(off.h).cloudZ!.message).toBe(CLOUD_Z_TEXT.unavailable);
    expect(cz(off.h).cloudZ!.unsupported).toBe(true);
    expect(off.f.available()).toBe(false);
    h!.stop();
    const empty = await till({ answers: { 'GET sync/m/z-reports': () => ({ items: [], total: 0 }) } });
    await empty.h.ok(op('cloudZ.open'));
    await listed(empty.h);
    expect(cz(empty.h).cloudZ!.empty).toBe(CLOUD_Z_TEXT.empty);
    expect(empty.f.available()).toBe(true);
  });

  it('a Z without tills prints whole; its words after', async () => {
    const cap = capture();
    const { h } = await till({ answers: { 'GET sync/m/z-reports': () => LIST, 'GET sync/m/z-reports/z-57/print-document': () => DOC('דו״ח Z') } }, cap.print);
    await h.ok(op('cloudZ.open'));
    await listed(h);
    await h.ok(op('cloudZ.print'), { id: 'z-57' });
    await until(() => cz(h).cloudZ!.message !== null);
    expect(cap.printed).toHaveLength(1);
    expect(cap.printed[0].title).toBe('דו״ח Z #58');
    expect(cz(h).cloudZ!.message).toBe(CLOUD_Z_TEXT.printed(57));
    // The failed payments' sections stayed off the paper (the parameter is off).
    expect(cap.printed[0].doc.ops.some((o) => o.t === 'row' && o.label === 'עסקאות שלא הושלמו')).toBe(false);
  });

  it('a shop Z asks what to print: the summary, a till, every till apart in till order — cancel between them', async () => {
    const cap = capture();
    const { h } = await till(
      {
        answers: {
          'GET sync/m/z-reports': () => LIST,
          'GET sync/m/z-reports/z-58/print-document': () => DOC('דו״ח Z'),
        },
      },
      cap.print,
    );
    await h.ok(op('cloudZ.open'));
    await listed(h);
    await h.ok(op('cloudZ.print'), { id: 'z-58' });
    const ch = cz(h).cloudZ!.choice!;
    expect(ch.title).toBe('מה להדפיס מדו״ח Z ‏#58?');
    expect(ch.tills.map((t) => t.label)).toEqual(['פירוט #2 קופה ראשית', 'פירוט #10 בר', 'פירוט אחורית']);
    expect(ch.allLabel).toBe('פירוט כל הקופות, כל אחת בנפרד (3)');
    await h.ok(op('cloudZ.printSummary'), { id: 'z-58' });
    await until(() => cap.printed.length === 1 && cz(h).cloudZ!.message !== null);
    expect(cz(h).cloudZ!.choice).toBeNull();
    expect(cz(h).cloudZ!.message).toBe(CLOUD_Z_TEXT.printed(58));
    // Every till apart.
    await h.ok(op('cloudZ.printTills'), { id: 'z-58' });
    await until(() => cap.printed.length === 4 && !cz(h).cloudZ!.busy);
    expect(cz(h).cloudZ!.message).toBeNull();
    expect(h.sent.filter((x) => x.path.endsWith('print-document'))).toHaveLength(4);
    // Each till its own document, in till-number order (the refIds name the till).
    expect(cap.printed.slice(1).map((p) => p.refId.split(':')[2])).toEqual(['t-1', 't-3', 't-2']);
    // One till only, by its id; an id not in the Z is refused.
    expect((await h.fail(op('cloudZ.printTills'), { id: 'z-58', machineIds: ['nope'] })).code).toBe('invalid_args');
    await h.ok(op('cloudZ.printTills'), { id: 'z-58', machineIds: ['t-3'] });
    await until(() => cap.printed.length === 5 && !cz(h).cloudZ!.busy);
  });

  it('"ביטול" between tills: stops before the next one', async () => {
    const printed: string[] = [];
    const { h } = await till(
      { answers: { 'GET sync/m/z-reports': () => LIST, 'GET sync/m/z-reports/z-58/print-document': () => DOC('דו״ח Z') } },
      (_doc, refId) => {
        printed.push(refId);
        return 'j';
      },
    );
    await h.ok(op('cloudZ.open'));
    await listed(h);
    await h.ok(op('cloudZ.printTills'), { id: 'z-58' });
    // The run started (the first till is on its way); "ביטול" gets in after it.
    expect(cz(h).cloudZ!.busy).toBe(true);
    await h.ok(op('cloudZ.cancelTills'));
    await until(() => !cz(h).cloudZ!.busy);
    expect(printed.length).toBeGreaterThanOrEqual(1);
    expect(printed.length).toBeLessThan(3);
    expect(cz(h).cloudZ!.message).toBe(`ההדפסה הופסקה — הודפסו ${printed.length} מתוך 3`);
  });

  it('"הדפס רצף": ticked Zs in number order, a shop Z as its summary; a failure stops it and says why', async () => {
    const cap = capture();
    const { h } = await till(
      {
        answers: {
          'GET sync/m/z-reports': () => LIST,
          'GET sync/m/z-reports/z-58/print-document': () => DOC('דו״ח Z'),
          'GET sync/m/z-reports/z-57/print-document': () => DOC('דו״ח Z'),
        },
      },
      cap.print,
    );
    await h.ok(op('cloudZ.open'));
    await listed(h);
    await h.ok(op('cloudZ.selectAll'));
    expect(cz(h).cloudZ!.sequenceLabel).toBe('הדפס רצף (3)');
    await h.ok(op('cloudZ.toggle'), { id: 'z-56' });
    expect(cz(h).cloudZ!.rows.find((r) => r.id === 'z-56')!.checked).toBe(false);
    await h.ok(op('cloudZ.printSequence'));
    await until(() => !cz(h).cloudZ!.busy && cz(h).cloudZ!.message !== null && cz(h).cloudZ!.sequenceLabel.startsWith('הדפס'));
    expect(cz(h).cloudZ!.message).toBe('הודפסו 2 מתוך 2 דוחות Z.');
    const docs = h.sent.filter((s) => s.path.endsWith('print-document')).map((s) => s.path);
    expect(docs).toEqual(['sync/m/z-reports/z-57/print-document', 'sync/m/z-reports/z-58/print-document']);
    expect(cz(h).cloudZ!.rows.every((r) => !r.checked)).toBe(true);
    // z-56 has no document on this cloud (404): the run stops at it and says why.
    await h.ok(op('cloudZ.toggle'), { id: 'z-56' });
    await h.ok(op('cloudZ.toggle'), { id: 'z-57' });
    await h.ok(op('cloudZ.printSequence'));
    await until(() => (cz(h).cloudZ!.message ?? '').startsWith('הודפסו 0'));
    expect(cz(h).cloudZ!.message).toBe('הודפסו 0 מתוך 2 דוחות Z — הדוח לא הודפס: ההדפסה נכשלה (HTTP 404)');
    expect(cz(h).cloudZ!.rows.filter((r) => r.checked)).toHaveLength(2);
  });

  it('no receipt printer here: "אין מדפסת זמינה…"; another operator never sees the screen', async () => {
    const { h } = await till({ answers: { 'GET sync/m/z-reports': () => LIST, 'GET sync/m/z-reports/z-57/print-document': () => DOC('דו״ח Z') } });
    await h.ok(op('cloudZ.open'));
    await listed(h);
    await h.ok(op('cloudZ.print'), { id: 'z-57' });
    await until(() => cz(h).cloudZ!.message !== null);
    expect(cz(h).cloudZ!.message).toBe(CLOUD_Z_TEXT.notPrinted(CLOUD_Z_TEXT.noPrinter));
    await h.ok('session.logout');
    await h.ok('session.login', { pin: MANAGER_PIN });
    expect(cz(h).cloudZ).toBeUndefined();
    expect((await h.fail(op('cloudZ.print'), { id: 'z-57' })).code).toBe('permission_denied');
    expect((await h.fail(op('cloudZ.toggle'), {})).code).toBe('invalid_args');
  });
});

/* ------------------------------------------------------------------ the screen */

describe('the screen', () => {
  const noop = () => undefined;
  const actions = { toggle: noop, selectAll: noop, print: noop, printSequence: noop, printSummary: noop, printTill: noop, printAllTills: noop, dismissChoice: noop, cancelTills: noop };
  const items = cloudZListOf(LIST).items;

  it('the list, the ticks, the sequence', () => {
    const view = cloudZView({ loading: false, loaded: true, unsupported: false, items, message: null, selected: new Set(['z-57']), printingId: null, sequenceProgress: null, choosingFor: null, tillProgress: null, tillProgressDetail: null, cancelling: false });
    const html = renderToStaticMarkup(createElement(CloudZScreen, { view, actions, back: noop }));
    expect(html).toContain('דוחות Z');
    expect(html).toContain('דו״ח Z ‏#58');
    expect(html).toContain('הדפס רצף (1)');
    expect(html).toContain('בחר הכל');
    expect(html.match(/type="checkbox"/g)).toHaveLength(3);
    expect(html).toContain('checked=""');
    expect(html).toContain('חזרה');
  });

  it('the choice and the progress', () => {
    const view = cloudZView({ loading: false, loaded: true, unsupported: false, items, message: null, selected: new Set(), printingId: 'z-58', sequenceProgress: null, choosingFor: items[0], tillProgress: 'מדפיס קופה 2 מתוך 3…', tillProgressDetail: '#10 בר', cancelling: true });
    const html = renderToStaticMarkup(createElement(CloudZScreen, { view, actions, back: noop }));
    expect(html).toContain('סיכום (סה״כ הסניף ושורה לכל קופה)');
    expect(html).toContain('פירוט #2 קופה ראשית');
    expect(html).toContain('פירוט כל הקופות, כל אחת בנפרד (3)');
    expect(html).toContain('מדפיס קופה 2 מתוך 3…');
    expect(html).toContain('עוצר…');
    expect(html).toContain('מדפיס…');
  });

  it('loading, empty, nothing yet', () => {
    const loading = cloudZView({ loading: true, loaded: false, unsupported: false, items: [], message: null, selected: new Set(), printingId: null, sequenceProgress: null, choosingFor: null, tillProgress: null, tillProgressDetail: null, cancelling: false });
    expect(renderToStaticMarkup(createElement(CloudZScreen, { view: loading, actions, back: noop }))).toContain('טוען מהענן…');
    const empty = { ...loading, loading: false, loadingText: null, empty: CLOUD_Z_TEXT.empty };
    expect(renderToStaticMarkup(createElement(CloudZScreen, { view: empty, actions, back: noop }))).toContain('עדיין לא הופקו דוחות Z לסניף.');
    expect(renderToStaticMarkup(createElement(CloudZScreen, { view: null, actions, back: noop }))).toContain('…');
  });
});

