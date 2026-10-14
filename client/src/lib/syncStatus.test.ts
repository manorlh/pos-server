/**
 * Run with `npm test`. "מצב סנכרון של מכשיר" (lib/syncStatus.ts; P:/specs/device-sync-status.md §3, §5.7):
 * a domain's mark and note, the list's "סנכרון" cell, the outbox line, and "סנכרן עכשיו" — each
 * domain's progress and how a run ends, for one device and for a shop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNC_RUN_TIMEOUT_MS,
  branchSummary,
  chunkIds,
  domainNote,
  domainProgress,
  listCell,
  markOf,
  outboxLine,
  outcomeText,
  runOutcome,
  type CommandView,
  type DeviceSyncStatus,
  type SyncDomainRow,
  type SyncState,
} from './syncStatus';

const time = (iso: string) => iso.slice(11, 16);
const T0 = Date.parse('2026-10-14T10:00:00Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function dom(domain: string, status: SyncState, extra: Partial<SyncDomainRow> = {}): SyncDomainRow {
  const labels: Record<string, string> = { catalog: 'קטלוג', parameters: 'פרמטרים', settings: 'הגדרות' };
  return {
    domain,
    label: labels[domain] ?? domain,
    status,
    pulledAt: null,
    changedAt: null,
    pendingSince: null,
    error: null,
    stale: false,
    keys: [],
    ...extra,
  };
}

function device(domains: SyncDomainRow[], extra: Partial<DeviceSyncStatus> = {}): DeviceSyncStatus {
  const pending = domains.filter((d) => d.status === 'pending').length;
  const errors = domains.filter((d) => d.status === 'error').length;
  return {
    machineId: 'm1',
    machineName: 'קופה 1',
    online: true,
    reported: domains.length > 0,
    reportedAt: at(-90),
    status: errors ? 'error' : pending ? 'pending' : domains.length ? 'up_to_date' : 'not_reported',
    pendingCount: pending,
    errorCount: errors,
    stale: false,
    staleSince: null,
    staleMinutes: 30,
    domains,
    outbox: null,
    ...extra,
  };
}

const cmd = (status: string, detail: string | null = null): CommandView => ({ status, detail });

test('a domain says ✓ / ⏳ / ✗, and what changed and when', () => {
  assert.deepEqual(markOf('up_to_date'), { mark: '✓', tone: 'ok' });
  assert.deepEqual(markOf('pending'), { mark: '⏳', tone: 'wait' });
  assert.deepEqual(markOf('error'), { mark: '✗', tone: 'error' });
  assert.equal(markOf('not_reported').mark, '—');
  assert.equal(domainNote(dom('catalog', 'pending', { changedAt: '2026-10-14T10:42:00Z' }), time), 'קטלוג השתנה ב-10:42');
  assert.equal(domainNote(dom('catalog', 'pending'), time), 'יש גרסה חדשה בענן');
  assert.equal(domainNote(dom('parameters', 'error', { error: 'HTTP 500' }), time), 'שגיאה: HTTP 500');
  assert.equal(domainNote(dom('catalog', 'up_to_date'), time), null);
});

test('the list cell: ✓, ⏳ with the number of domains waiting, ✗, or — for a device that does not report', () => {
  assert.equal(listCell(null).mark, '—');
  assert.equal(listCell(device([])).mark, '—');
  assert.deepEqual(
    (({ mark, count }) => ({ mark, count }))(listCell(device([dom('catalog', 'pending'), dom('settings', 'pending'), dom('parameters', 'up_to_date')]))),
    { mark: '⏳', count: 2 },
  );
  const failing = listCell(device([dom('catalog', 'pending'), dom('parameters', 'error')]));
  assert.equal(failing.mark, '✗');
  assert.match(failing.title, /פרמטרים/);
  assert.equal(listCell(device([dom('catalog', 'up_to_date')])).mark, '✓');
});

test('the outbox: "3 מסמכים, הישן מ-10:31", one of a kind, nothing left', () => {
  const base = { documents: 0, events: 0, attendance: 0, refunds: 0, total: 0, oldestAt: null, reportedAt: null };
  assert.equal(outboxLine({ ...base, documents: 3, total: 3, oldestAt: '2026-10-14T10:31:00Z' }, time), '3 מסמכים, הישן מ-10:31');
  assert.equal(outboxLine({ ...base, documents: 1, attendance: 2, total: 3 }, time), 'מסמך אחד, 2 דיווחי נוכחות');
  assert.equal(outboxLine(base, time), 'הכל הועלה לענן');
  assert.equal(outboxLine(null, time), null);
});

test('progress: ממתין until the device answers, then נמשך, then ✓ — ✗ only for an error it reported now', () => {
  const pending = dom('catalog', 'pending');
  const before = device([pending]);
  assert.equal(domainProgress(pending, before, T0, cmd('pending')), 'waiting');
  assert.equal(domainProgress(pending, before, T0, cmd('delivered')), 'pulling');
  assert.equal(domainProgress(dom('catalog', 'up_to_date'), before, T0, cmd('pending')), 'done');
  const oldError = dom('parameters', 'error', { error: 'x' });
  assert.equal(domainProgress(oldError, device([oldError]), T0, cmd('delivered')), 'pulling');
  assert.equal(domainProgress(oldError, device([oldError], { reportedAt: at(5) }), T0, cmd('delivered')), 'error');
});

test('a run ends in "הכל התקבל ✓" once every domain is up to date', () => {
  const s = device([dom('catalog', 'up_to_date'), dom('settings', 'up_to_date')], { reportedAt: at(4) });
  const o = runOutcome(s, T0, T0 + 5000, cmd('done'), time);
  assert.deepEqual(o, { kind: 'all_received' });
  assert.equal(outcomeText(o), 'הכל התקבל ✓');
});

test('a run keeps going while the device works, and lists what is missing and why when it is over', () => {
  const s = device([
    dom('catalog', 'pending', { changedAt: '2026-10-14T10:42:00Z' }),
    dom('parameters', 'error', { error: 'HTTP 500' }),
    dom('settings', 'up_to_date'),
  ]);
  assert.deepEqual(runOutcome(s, T0, T0 + 3000, cmd('delivered'), time), { kind: 'running' });
  // The device finished and reported after the run began: over, with the reasons.
  const after = { ...s, reportedAt: at(10) };
  const o = runOutcome(after, T0, T0 + 11_000, cmd('done'), time);
  assert.equal(o.kind, 'incomplete');
  assert.deepEqual(o.kind === 'incomplete' ? o.missing : [], [
    { domain: 'catalog', label: 'קטלוג', reason: 'עוד לא התקבל (השתנה ב-10:42)' },
    { domain: 'parameters', label: 'פרמטרים', reason: 'שגיאה: HTTP 500' },
  ]);
  assert.equal(outcomeText(o), 'עוד לא התקבל: קטלוג, פרמטרים');
  // 60 seconds with the device answering but not caught up: the same list.
  assert.equal(runOutcome(s, T0, T0 + SYNC_RUN_TIMEOUT_MS, cmd('delivered'), time).kind, 'incomplete');
});

test('"המכשיר לא ענה": nothing from the device in 60 seconds (no network)', () => {
  const s = device([dom('catalog', 'pending')]);
  assert.deepEqual(runOutcome(s, T0, T0 + 30_000, cmd('pending'), time), { kind: 'running' });
  const o = runOutcome(s, T0, T0 + SYNC_RUN_TIMEOUT_MS, cmd('pending'), time);
  assert.deepEqual(o, { kind: 'no_answer' });
  assert.equal(outcomeText(o), 'המכשיר לא ענה');
  // Not even the command could be sent's status yet: the same.
  assert.deepEqual(runOutcome(s, T0, T0 + SYNC_RUN_TIMEOUT_MS + 1, null, time), { kind: 'no_answer' });
});

test('a device that synced but does not report, a refusal', () => {
  const old = device([], { reported: false, reportedAt: null });
  assert.deepEqual(runOutcome(old, T0, T0 + 4000, cmd('done'), time), { kind: 'not_reporting' });
  const refused = runOutcome(device([dom('catalog', 'pending')]), T0, T0 + 4000, cmd('refused', 'sale_in_progress'), time);
  assert.deepEqual(refused, { kind: 'refused', detail: 'יש מכירה פתוחה' });
  assert.match(outcomeText(refused), /דחה/);
});

test('the shop: one line per device asked, and a summary', () => {
  const a = { ...device([dom('catalog', 'up_to_date')]), machineId: 'a', machineName: 'קופה 1' };
  const b = { ...device([dom('catalog', 'pending')]), machineId: 'b', machineName: 'קופה 2' };
  const screen = { ...device([]), machineId: 'kds', machineName: 'מסך' };
  const commands = new Map<string, CommandView>([['a', cmd('done')], ['b', cmd('pending')]]);
  const running = branchSummary([a, b, screen], commands, T0, T0 + 5000, time);
  assert.equal(running.rows.length, 2);
  assert.equal(running.done, false);
  assert.equal(running.text, '2 מכשירים: 1 קיבלו הכל, 1 עוד מסנכרנים');
  const over = branchSummary([a, b, screen], commands, T0, T0 + SYNC_RUN_TIMEOUT_MS, time);
  assert.equal(over.done, true);
  assert.deepEqual(over.counts, { received: 1, incomplete: 0, noAnswer: 1, notReporting: 0, refused: 0, running: 0 });
  assert.deepEqual(over.rows.map((r) => [r.name, r.outcome.kind]), [['קופה 1', 'all_received'], ['קופה 2', 'no_answer']]);
});

test('ids go to the server in chunks it takes', () => {
  const ids = Array.from({ length: 450 }, (_, i) => `m${i}`);
  assert.deepEqual(chunkIds(ids).map((c) => c.length), [200, 200, 50]);
  assert.deepEqual(chunkIds([]), []);
});
