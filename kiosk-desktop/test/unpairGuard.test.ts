/**
 * "ניתוק הקיוסק מהענן" with rows still in the outbox (core/unpairGuard.ts, KioskService.unpair): the owner's kiosk was
 * paired to a dev server that is gone, 5 `till_event` rows could never drain, and the unpair was refused for ever —
 * without the refusal even being seen. Now: what waits and why, "ניתוק בכל זאת" behind the technician's code and a
 * confirmation (a second one for money records), a backup of everything pending first.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupStem, forceRefusal, pendingLines, pendingSummary, UNPAIR_TEXT, unpairCheck, unpairMessage } from '../src/core/unpairGuard';
import { harness, type Harness, type HarnessOptions } from './tillEngineHarness';

describe('the rules', () => {
  const events = pendingSummary([{ kind: 'till_event', n: 5 }]);
  const money = pendingSummary([
    { kind: 'till_event', n: 2 },
    { kind: 'transaction', n: 3 },
    { kind: 'cash_movement', n: 1 },
  ]);

  it('sorts what waits into money and events, money first', () => {
    expect(events).toEqual({ total: 5, money: 0, events: 5, byKind: { till_event: 5 } });
    expect(money).toMatchObject({ total: 6, money: 4, events: 2 });
    expect(pendingLines(money)).toEqual(['1 × תנועות מזומן', '3 × מסמכים (חשבוניות / קבלות)', '2 × אירועי קופה (יומן)']);
    expect(pendingSummary([{ kind: 'mystery', n: 1 }, { kind: 'till_event', n: 0 }])).toMatchObject({ total: 1, events: 1, byKind: { mystery: 1 } });
  });

  it('lets an empty outbox go at once', () => {
    expect(unpairCheck(pendingSummary([]), 'reachable', null)).toBeNull();
    expect(unpairCheck(pendingSummary([]), 'unreachable', null)).toBeNull();
  });

  it('offers "ניתוק בכל זאת" for events only, whatever the server', () => {
    for (const server of ['reachable', 'unreachable'] as const) {
      const c = unpairCheck(events, server, 'http://localhost:8001')!;
      expect(c).toMatchObject({ canForce: true, needsMoneyConfirm: false, money: 0, events: 5 });
      expect(unpairMessage(c)).toContain(UNPAIR_TEXT.refused);
      expect(unpairMessage(c)).toContain('5 × אירועי קופה (יומן)');
    }
    expect(unpairCheck(events, 'unreachable', 'http://localhost:8001')!.reason).toContain('http://localhost:8001');
  });

  it('never forces money records while the server answers; with the server gone, a second confirmation', () => {
    const up = unpairCheck(money, 'reachable', null)!;
    expect(up).toMatchObject({ canForce: false, needsMoneyConfirm: false, reason: UNPAIR_TEXT.moneyWait });
    expect(forceRefusal(up, { codeOk: true, confirm: true, confirmMoney: true })).toBe(UNPAIR_TEXT.notForceable);
    const down = unpairCheck(money, 'unreachable', null)!;
    expect(down).toMatchObject({ canForce: true, needsMoneyConfirm: true });
    expect(forceRefusal(down, { codeOk: true, confirm: true, confirmMoney: false })).toBe(UNPAIR_TEXT.moneyConfirmNeeded);
    expect(forceRefusal(down, { codeOk: true, confirm: true, confirmMoney: true })).toBeNull();
  });

  it('needs the code and the confirmation to force', () => {
    const c = unpairCheck(events, 'unreachable', null)!;
    expect(forceRefusal(c, { codeOk: false, confirm: true, confirmMoney: false })).toBe(UNPAIR_TEXT.codeNeeded);
    expect(forceRefusal(c, { codeOk: true, confirm: false, confirmMoney: false })).toBe(UNPAIR_TEXT.confirmNeeded);
    expect(forceRefusal(c, { codeOk: true, confirm: true, confirmMoney: false })).toBeNull();
  });

  it('names the backup by its time, safe for a Windows file name', () => {
    expect(backupStem(Date.UTC(2026, 9, 17, 21, 4, 5, 123))).toBe('unpair-2026-10-17T21-04-05-123Z');
  });
});

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

/** The owner's server: gone (http://localhost:8001 — nothing listens; every request fails at the network). */
const DEAD: HarnessOptions['answers'] = {
  'GET *': () => {
    throw new TypeError('fetch failed');
  },
  'POST *': () => {
    throw new TypeError('fetch failed');
  },
};

function rig(o: HarnessOptions = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-unpair-'));
  const h = harness({ answers: DEAD, ...o, unpairBackupDir: dir });
  open.push(h);
  expect(h.svc.technicianUnlock('1995').outcome).toBe('granted');
  return { h, dir };
}

/** The owner's case: desktop-exit audit events for a server that is gone. */
function tillEvents(h: Harness, n: number) {
  for (let i = 0; i < n; i++) {
    h.svc.kv.setJson(`tillEvent:e${i}`, { id: `e${i}`, type: 'desktop_exit', at: '2026-10-17T20:00:00Z' });
    h.svc.outbox.enqueue('till_event', `e${i}`);
  }
}

function transmission(h: Harness, id: string) {
  h.svc.kv.setJson(`transmission:${id}`, { id, ok: true });
  h.svc.outbox.enqueue('transmission', id);
}

const REACHABLE = { 'GET machines/me': () => ({ machineId: 'm' }) };

describe('KioskService unpair', () => {
  it('unpairs at once when nothing waits', async () => {
    const { h } = rig();
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    expect(h.svc.cloud.credentials()).toBeNull();
  });

  it('still needs the technician’s code', async () => {
    const h = harness();
    open.push(h);
    expect(await h.svc.technicianAction({ type: 'unpair' })).toEqual({ ok: false, message: 'נדרש קוד טכנאי' });
    expect(h.svc.cloud.credentials()).not.toBeNull();
  });

  it('refuses with what waits and why when the server is gone — and offers to force', async () => {
    const { h } = rig();
    tillEvents(h, 5);
    const r = await h.svc.technicianAction({ type: 'unpair' });
    expect(r.ok).toBe(false);
    expect(r.message).toContain(UNPAIR_TEXT.refused);
    expect(r.message).toContain('5 × אירועי קופה (יומן)');
    expect(r.message).toContain('http://localhost:8001');
    expect(r.unpair).toMatchObject({ server: 'unreachable', canForce: true, needsMoneyConfirm: false, events: 5, money: 0 });
    expect(h.svc.cloud.credentials()).not.toBeNull();
    expect(h.svc.outbox.count()).toBe(5);
  });

  it('delivers first when the server answers: what drains does not refuse', async () => {
    // The server answers machines/me; the events go (an unknown route is 404 — a side row's final answer).
    const { h } = rig({ answers: REACHABLE });
    tillEvents(h, 2);
    expect(await h.svc.technicianAction({ type: 'unpair' })).toMatchObject({ ok: true });
    expect(h.svc.outbox.count()).toBe(0);
    expect(h.svc.cloud.credentials()).toBeNull();
  });

  it('forces with the code and a confirmation: backup first, event rows dropped', async () => {
    const { h, dir } = rig();
    tillEvents(h, 5);
    expect(await h.svc.technicianAction({ type: 'unpair', force: true, confirm: true })).toMatchObject({ ok: false, message: UNPAIR_TEXT.codeNeeded });
    expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '0000', confirm: true })).toMatchObject({ ok: false, message: UNPAIR_TEXT.codeNeeded });
    expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995' })).toMatchObject({ ok: false, message: UNPAIR_TEXT.confirmNeeded });
    expect(h.svc.cloud.credentials()).not.toBeNull();
    expect(readdirSync(dir)).toEqual([]);

    const r = await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true });
    expect(r.ok).toBe(true);
    expect(h.svc.cloud.credentials()).toBeNull();
    expect(h.svc.outbox.count()).toBe(0);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    const json = files.find((f) => f.endsWith('.json'))!;
    const db = files.find((f) => f.endsWith('.kiosk.db'))!;
    expect(r.message).toBe(UNPAIR_TEXT.done(path.join(dir, json)));
    const backup = JSON.parse(readFileSync(path.join(dir, json), 'utf8'));
    expect(backup).toMatchObject({ kind: 'r2m-kiosk-unpair-backup', serverUrl: 'http://localhost:8001', server: 'unreachable', kioskDbCopy: db, pending: { money: 0, events: 5 } });
    expect(backup.outbox).toHaveLength(5);
    expect(backup.outbox[0]).toMatchObject({ kind: 'till_event', ref_id: 'e0', record: { path: 'events', body: { id: 'e0', type: 'desktop_exit' } } });
    expect(existsSync(path.join(dir, db))).toBe(true);
    // Logged in the technician's audit.
    expect(h.svc.kv.getJson<Array<{ access: string }>>('technician.audit')!.at(-1)).toMatchObject({ access: 'unpair_forced', pending: { till_event: 5 } });
  });

  it('never forces money records while the server answers', async () => {
    const { h, dir } = rig({ answers: { ...REACHABLE, 'POST sync/m/transmissions': () => ({ __status: 500 }) } });
    transmission(h, 't1');
    const r = await h.svc.technicianAction({ type: 'unpair' });
    expect(r).toMatchObject({ ok: false, unpair: { canForce: false, money: 1, server: 'reachable' } });
    expect(r.message).toContain(UNPAIR_TEXT.moneyWait);
    expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true, confirmMoney: true })).toMatchObject({ ok: false, message: UNPAIR_TEXT.notForceable });
    expect(h.svc.cloud.credentials()).not.toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('forces money records with the server gone only on the second confirmation, and keeps them', async () => {
    const { h, dir } = rig();
    transmission(h, 't1');
    tillEvents(h, 1);
    const r = await h.svc.technicianAction({ type: 'unpair' });
    expect(r.unpair).toMatchObject({ canForce: true, needsMoneyConfirm: true, money: 1, events: 1 });
    expect(r.message).toContain('1 × שידורי אשראי');
    expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true })).toMatchObject({ ok: false, message: UNPAIR_TEXT.moneyConfirmNeeded });
    expect(await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true, confirmMoney: true })).toMatchObject({ ok: true });
    expect(h.svc.cloud.credentials()).toBeNull();
    // The money row stays on the device; the event row is in the backup only.
    expect(h.svc.outbox.count('transmission')).toBe(1);
    expect(h.svc.outbox.count('till_event')).toBe(0);
    const json = readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const backup = JSON.parse(readFileSync(path.join(dir, json), 'utf8'));
    expect(backup.outbox.map((x: { kind: string }) => x.kind).sort()).toEqual(['till_event', 'transmission']);
    expect(backup.outbox.find((x: { kind: string }) => x.kind === 'transmission').record).toEqual({ path: 'transmissions', body: { id: 't1', ok: true } });
  });

  it('backs up a pending document with its record', async () => {
    const { h, dir } = rig();
    h.svc.db.run(
      "INSERT INTO documents (id, document_type, series, number, status, created_at, updated_at, total_agorot, payload) VALUES ('d1', 320, 1, 7, 'final', 'x', 'x', 4200, '{\"lines\":[]}')",
    );
    h.svc.outbox.enqueue('transaction', 'd1');
    await h.svc.technicianAction({ type: 'unpair', force: true, code: '1995', confirm: true, confirmMoney: true });
    const json = readdirSync(dir).find((f) => f.endsWith('.json'))!;
    const backup = JSON.parse(readFileSync(path.join(dir, json), 'utf8'));
    expect(backup.outbox[0]).toMatchObject({ kind: 'transaction', ref_id: 'd1', record: { id: 'd1', number: 7, total_agorot: 4200, payload: { lines: [] } } });
    expect(h.svc.outbox.count('transaction')).toBe(1);
  });
});
