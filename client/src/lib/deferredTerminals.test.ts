import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authorizationText,
  declinedCount,
  formatHm,
  isOpenCommand,
  lastAppliedText,
  nearLimit,
  outcomeText,
  pendingText,
  pollMs,
  reasonText,
  skipText,
  sourceLabel,
  switchSummary,
  switchable,
  terminalText,
  visibleTills,
  type DeferredTill,
  type LastCommand,
} from './deferredTerminals';

const cmd = (over: Partial<LastCommand>): LastCommand => ({
  id: 'c1', on: true, status: 'done', state: 'done', receivedAt: null, createdAt: null, deliveredAt: null,
  doneAt: null, expiresAt: null, createdBy: 'admin', detail: null, result: null, ...over,
});

const till = (over: Partial<DeferredTill>): DeferredTill => ({
  machineId: 'm1', name: 'קופה 1', posNumber: '1', label: '1 · קופה 1', isKiosk: false, online: true, lastSeenAt: null,
  capable: true, isController: false, kind: 'nayax_lan', model: 'C4', eligible: true, reason: null, reasonText: null,
  mode: 'online', pending: 0, txLimit: 50, txLeft: 50, lastApplied: null, reportedAt: null, lastCommand: null, ...over,
});

describe('why a till is left out (§8.2)', () => {
  it('says the spec\'s words, the model in other_model', () => {
    assert.equal(reasonText('zcredit'), 'Z-Credit — לא נתמך');
    assert.equal(reasonText('unknown_model'), 'דגם לא מזוהה — לא נכלל');
    assert.equal(reasonText('other_model', 'VX520'), 'דגם VX520 — לא נתמך');
    assert.equal(reasonText('needs_update'), 'הקופה צריכה עדכון');
    assert.equal(reasonText('not_allowed'), 'Nayax לא התירו מצב לא מקוון במסוף');
    assert.equal(reasonText('something_new'), 'something_new');
    assert.equal(reasonText(null), null);
  });

  it('a switch\'s skip reasons', () => {
    assert.equal(skipText('not_eligible:synqpay'), 'SynqPay — לא נתמך');
    assert.equal(skipText('needs_update'), 'הקופה צריכה עדכון');
    assert.equal(skipText('kiosk_excluded'), 'קיוסק — לא נכלל');
    assert.equal(skipText('not_found'), 'לא נמצאה בסניף');
  });

  it('kiosks left out are not listed; only an included, capable till is switched', () => {
    const rows = [till({}), till({ machineId: 'k', isKiosk: true, eligible: false, reason: 'kiosk_excluded' })];
    assert.deepEqual(visibleTills(rows).map((t) => t.machineId), ['m1']);
    assert.equal(switchable(till({})), true);
    assert.equal(switchable(till({ capable: false })), false);
    assert.equal(switchable(till({ eligible: null })), false);
    assert.equal(switchable(till({ eligible: false, reason: 'zcredit' })), false);
  });

  it('the terminal in words', () => {
    assert.equal(terminalText('nayax_usb', 'T50'), 'Nayax ב-USB · T50');
    assert.equal(terminalText('agamento', null), 'אשראי מובנה (Agamento)');
    assert.equal(terminalText(null, null), 'לא ידוע');
  });
});

describe('the last command (§8.5, §8.7)', () => {
  it('open while pending or received', () => {
    assert.equal(isOpenCommand(cmd({ state: 'pending', status: 'pending' })), true);
    assert.equal(isOpenCommand(cmd({ state: 'received', status: 'delivered' })), true);
    assert.equal(isOpenCommand(cmd({})), false);
    assert.equal(outcomeText(cmd({ state: 'received', status: 'delivered' })), null);
  });

  it('back online: approved and declined; declines counted for the red', () => {
    const back = cmd({ on: false, result: { authorization: { ok: true, approved: 5, declined: 1, approvedAmount: '412.50' } } });
    assert.equal(outcomeText(back), 'אושרו 5 · נדחו 1');
    assert.equal(declinedCount(back), 1);
    assert.equal(declinedCount(cmd({ on: false, result: { authorization: { approved: 3, declined: 0 } } })), 0);
    assert.equal(authorizationText({ ok: false }), 'שליחת העסקאות לאישור נכשלה');
    assert.equal(outcomeText(cmd({ on: true })), 'בוצע');
  });

  it('already in that mode', () => {
    assert.equal(outcomeText(cmd({ result: { unchanged: true } })), 'כבר במצב הזה');
  });

  it('a conflict names who won', () => {
    const lost = cmd({
      state: 'failed', status: 'refused', detail: 'conflict',
      result: { supersededBy: { source: 'lan', from: { machineId: 'm9', name: 'קופה 1' }, issuedAt: '2026-10-14T17:14:00Z' } },
    });
    assert.equal(outcomeText(lost), 'בוטל ע״י קופה 1');
    const auto = cmd({ state: 'failed', status: 'refused', detail: 'conflict', result: { supersededBy: { source: 'auto' } } });
    assert.equal(outcomeText(auto), 'בוטל ע״י אוטומטי');
  });

  it('stale or superseded: by whom and when, in Israel\'s time', () => {
    const stale = cmd({
      state: 'failed', status: 'refused', detail: 'stale',
      result: { supersededBy: { source: 'local', issuedAt: '2026-10-14T17:14:00Z' } },
    });
    assert.equal(outcomeText(stale), 'הוחלפה ע״י מנהל בקופה ב-20:14');
    const byCloud = cmd({
      state: 'failed', status: 'refused', detail: 'superseded',
      result: { supersededBy: { source: 'cloud', from: { machineId: null, name: 'דשבורד' }, issuedAt: '2026-01-14T17:14:00Z' } },
    });
    assert.equal(outcomeText(byCloud), 'הוחלפה ע״י דשבורד ב-19:14');
    assert.equal(outcomeText(cmd({ state: 'cancelled', status: 'cancelled', detail: 'superseded' })), 'הוחלפה בהוראה חדשה');
  });

  it('no line, busy, not eligible, the terminal\'s own error', () => {
    assert.equal(outcomeText(cmd({ state: 'failed', status: 'refused', detail: 'no_line' })), 'אין קו — נשאר לא מקוון');
    assert.equal(outcomeText(cmd({ state: 'failed', status: 'failed', detail: 'timeout_busy' })), 'המסופון היה עסוק עד שפג תוקף הפקודה');
    assert.equal(outcomeText(cmd({ state: 'failed', status: 'refused', detail: 'not_eligible:zcredit' })), 'Z-Credit — לא נתמך');
    assert.equal(outcomeText(cmd({ state: 'failed', status: 'failed', detail: null, result: { error: 'SPI 12' } })), 'SPI 12');
    assert.equal(outcomeText(cmd({ state: 'failed', status: 'expired', detail: 'not_answered' })), 'לא נענתה בזמן');
  });
});

describe('the sources (§8.7)', () => {
  it('cloud, lan by its till, auto, local, direct', () => {
    assert.equal(sourceLabel('cloud'), 'דשבורד');
    assert.equal(sourceLabel('lan', 'קופה 1'), 'קופה 1');
    assert.equal(sourceLabel('lan', { machineId: 'x', name: 'קופה 2' }), 'קופה 2');
    assert.equal(sourceLabel('lan'), 'קופה מנהלת');
    assert.equal(sourceLabel('auto'), 'אוטומטי');
    assert.equal(sourceLabel('local'), 'מנהל בקופה');
    assert.equal(sourceLabel('direct'), 'ישירות במסופון');
  });

  it('the order last carried out', () => {
    const text = lastAppliedText({ on: true, source: 'lan', from: 'קופה 1', issuedAt: '2026-10-14T17:14:00Z', doneAt: '2026-10-14T17:15:00Z' });
    assert.equal(text, 'לא מקוון · קופה 1 · 20:15');
    assert.equal(lastAppliedText({ on: false, source: 'cloud' }), 'מקוון · דשבורד');
    assert.equal(lastAppliedText(null), null);
    assert.equal(formatHm('not a date'), null);
  });
});

describe('the page (read as text: the React parts are not compiled here)', () => {
  const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

  it('the confirmation says exactly the owner\'s words (§2)', () => {
    const he = JSON.parse(src('messages/he.json'));
    assert.equal(he.deferredTerminals.confirmOffline, 'העסקאות יאושרו רק כשהחיבור יחזור, ועסקה עלולה להידחות אחר כך');
    assert.equal(he.deferredTerminals.allOffline, 'העבר הכל ללא מקוון');
    assert.equal(he.deferredTerminals.allOnline, 'החזר הכל למקוון');
    assert.equal(he.dashboardAccess.sections.terminals_offline, 'מסופונים — מצב לא מקוון');
  });

  it('is in the menu under its section, and the device page has its card', () => {
    assert.match(src('lib/navigation.ts'), /href: '\/dashboard\/deferred-terminals'/);
    assert.match(src('lib/dashboardAccess.ts'), /id: 'terminals_offline', pages: \['\/dashboard\/deferred-terminals'\]/);
    assert.match(src('app/dashboard/machines/[id]/page.tsx'), /<DeferredTerminalCard machineId=\{machine\.id\}/);
    // The shop's level: the device card's switch goes through the shop's controllers route.
    assert.match(src('lib/deferredTerminalsApi.ts'), /\/deferred-terminals\/controllers/);
  });
});

describe('counts and polling', () => {
  it('deferred of the limit, near the limit', () => {
    assert.equal(pendingText(3, 50), '3 מתוך 50');
    assert.equal(pendingText(3, null), '3');
    assert.equal(pendingText(null, 50), '—');
    assert.equal(nearLimit({ pending: 41, txLimit: 50, txLeft: 9 }), true);
    assert.equal(nearLimit({ pending: 10, txLimit: 50, txLeft: 40 }), false);
    assert.equal(nearLimit({ pending: null, txLimit: 20, txLeft: 3 }), true);
  });

  it('polls fast only while a command is open', () => {
    assert.equal(pollMs({ open: true }), 3000);
    assert.equal(pollMs({ open: false }), 30000);
  });

  it('a switch summarised', () => {
    const names: Record<string, string> = { a: 'קופה 1', b: 'קופה 2' };
    const nameOf = (id: string) => names[id] ?? id;
    assert.equal(switchSummary({ batchId: null, on: true, created: [{ machineId: 'a', commandId: 'x' }], skipped: [] }, nameOf), 'נשלח ל-1 קופה');
    assert.equal(
      switchSummary({ batchId: 'z', on: true, created: [], skipped: [{ machineId: 'b', reason: 'not_eligible:zcredit' }] }, nameOf),
      'נשלח ל-0 קופות · לא נשלח — קופה 2: Z-Credit — לא נתמך',
    );
  });
});
