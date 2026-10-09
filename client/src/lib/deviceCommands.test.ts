import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  afterRehydrate,
  applyUpdates,
  cap,
  chipText,
  GIVE_UP_MS,
  giveUp,
  isFinal,
  isKeyReused,
  keyRing,
  MAX_TRACKED,
  phaseOfRebootRead,
  visibleTo,
  closePopup,
  inPopup,
  isOpen,
  POPUP_DONE_MS,
  POPUP_FAILED_MS,
  POPUP_PENDING_MS,
  popupItems,
  popupLine,
  popupNextChangeMs,
  popupStatus,
  latestForMachine,
  markSendFailed,
  openCount,
  openIds,
  phaseOfCard,
  phaseOfDevice,
  phaseOfKiosk,
  phaseOfPrintJobs,
  phaseOfRequest,
  phaseOfTillMessage,
  pollDelayMs,
  prune,
  resolveSend,
  retryableSendError,
  upsert,
  type PhaseUpdate,
  type TrackedCommand,
} from './deviceCommands';

const NOW = 1_800_000_000_000;

function cmd(over: Partial<TrackedCommand> = {}): TrackedCommand {
  return {
    key: over.key ?? 'k1',
    kind: 'device',
    id: 'c1',
    machineId: 'm1',
    machineName: 'קופה 1',
    action: 'sync_now',
    label: 'סנכרון',
    phase: 'sent',
    detail: null,
    sentAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    sendError: null,
    ...over,
  };
}

test('the chip says what was sent and that it is waiting, then the answer', () => {
  assert.equal(chipText(cmd()), 'פקודה נשלחה: סנכרון · ממתין');
  assert.equal(chipText(cmd({ phase: 'sending' })), 'פקודה נשלחה: סנכרון · ממתין');
  assert.equal(chipText(cmd({ phase: 'received' })), 'פקודה נשלחה: סנכרון · התקבל במכשיר');
  assert.equal(chipText(cmd({ phase: 'done' })), 'פקודה נשלחה: סנכרון · בוצע');
  assert.equal(chipText(cmd({ phase: 'failed', detail: 'נדחה — באמצע מכירה' })), 'פקודה נשלחה: סנכרון · נכשל: נדחה — באמצע מכירה');
  assert.equal(chipText(cmd({ phase: 'expired' })), 'פקודה נשלחה: סנכרון · פג תוקף');
  assert.equal(chipText(cmd({ phase: 'failed', sendError: 'אין חיבור לשרת' })), 'פקודה לא נשלחה: סנכרון · אין חיבור לשרת');
});

test('a device command moves נשלח → התקבל במכשיר → בוצע / נכשל / פג תוקף', () => {
  assert.deepEqual(phaseOfDevice('pending'), { phase: 'sent', detail: null });
  assert.deepEqual(phaseOfDevice('delivered'), { phase: 'received', detail: null });
  assert.deepEqual(phaseOfDevice('done'), { phase: 'done', detail: null });
  assert.deepEqual(phaseOfDevice('refused', 'sale_in_progress'), { phase: 'failed', detail: 'נדחה — באמצע מכירה' });
  assert.deepEqual(phaseOfDevice('failed', 'needs_permission'), { phase: 'failed', detail: 'נדרש אישור התקנה במכשיר' });
  assert.equal(phaseOfDevice('expired').phase, 'expired');
  assert.equal(phaseOfDevice('expired', 'not_answered').detail, 'נמסר ולא נענה');
  assert.equal(phaseOfDevice('cancelled').phase, 'cancelled');
});

test('a card command: delivered is "התקבל במכשיר"; busy / not found are failures with the till’s words', () => {
  assert.equal(phaseOfCard({ status: 'pending' }).phase, 'sent');
  assert.equal(phaseOfCard({ status: 'pending', deliveredAt: '2026-10-09T08:00:00Z' }).phase, 'received');
  assert.deepEqual(phaseOfCard({ status: 'done', verdictLabel: 'אושר במסוף' }), { phase: 'done', detail: 'אושר במסוף' });
  assert.deepEqual(phaseOfCard({ status: 'busy', statusLabel: 'הקופה עסוקה' }), { phase: 'failed', detail: 'הקופה עסוקה' });
  assert.equal(phaseOfCard({ status: 'not_found' }).phase, 'failed');
  assert.equal(phaseOfCard({ status: 'expired' }).phase, 'expired');
});

test('requests, kiosks, printer tests and till messages map to the same phases', () => {
  assert.equal(phaseOfRequest('waiting_close').phase, 'sent');
  assert.equal(phaseOfRequest('closing').phase, 'received');
  assert.equal(phaseOfRequest('in_progress').phase, 'received');
  assert.equal(phaseOfRequest('transmitting').phase, 'received');
  assert.equal(phaseOfRequest('completed').phase, 'done');
  assert.deepEqual(phaseOfRequest('failed', 'אין חיבור'), { phase: 'failed', detail: 'אין חיבור' });
  assert.equal(phaseOfKiosk('applied').phase, 'done');
  assert.equal(phaseOfKiosk('requested').phase, 'done'); // handed to the kiosk's own request: final here
  assert.equal(phaseOfKiosk('refused').phase, 'failed');
  assert.equal(phaseOfPrintJobs([{ status: 'pending' }]).phase, 'sent');
  assert.equal(phaseOfPrintJobs([{ status: 'printing' }, { status: 'pending' }]).phase, 'received');
  assert.equal(phaseOfPrintJobs([{ status: 'done' }, { status: 'done' }]).phase, 'done');
  assert.deepEqual(phaseOfPrintJobs([{ status: 'done' }, { status: 'failed', error: 'אין נייר' }]), { phase: 'failed', detail: 'אין נייר' });
  assert.equal(phaseOfTillMessage({ total: 3, delivered: 0, acknowledged: 0 }).phase, 'sent');
  assert.deepEqual(phaseOfTillMessage({ total: 3, delivered: 2, acknowledged: 1 }), { phase: 'received', detail: '1/3 אישרו' });
  assert.equal(phaseOfTillMessage({ total: 3, delivered: 3, acknowledged: 3 }).phase, 'done');
});

test('a send is never blocking: "sending" becomes one entry per device the server answered', () => {
  const sending = cmd({ key: 'send-1', id: null, machineId: null, phase: 'sending' });
  const list = upsert([cmd({ key: 'old', id: 'c0', machineId: 'm9' })], sending);
  assert.deepEqual(list.map((c) => c.key), ['send-1', 'old']);
  const made = [cmd({ key: 'send-1:c1', id: 'c1', machineId: 'm1' }), cmd({ key: 'send-1:c2', id: 'c2', machineId: 'm2' })];
  const out = resolveSend(list, 'send-1', made);
  assert.deepEqual(out.map((c) => c.key), ['send-1:c1', 'send-1:c2', 'old']);
  // Several commands at once, to the same device and to others: all followed.
  assert.deepEqual(openIds(out, 'device').sort(), ['c0', 'c1', 'c2']);
});

test('a send that failed keeps its key (a retry with it never sends twice) and is not polled', () => {
  const list = [cmd({ key: 'send-2', id: null, phase: 'sending' })];
  const out = markSendFailed(list, 'send-2', 'אין חיבור לשרת', NOW);
  assert.equal(out[0].key, 'send-2');
  assert.equal(out[0].sendError, 'אין חיבור לשרת');
  assert.equal(isOpen(out[0]), false);
  assert.deepEqual(openIds(out, 'device'), []);
  assert.equal(retryableSendError(undefined), true);
  assert.equal(retryableSendError(503), true);
  assert.equal(retryableSendError(403), false);
  assert.equal(retryableSendError(409), false);
});

test('updates move only open entries; a final answer is kept', () => {
  const list = [cmd({ id: 'c1' }), cmd({ key: 'k2', id: 'c2', phase: 'done' }), cmd({ key: 'k3', id: 'c3', kind: 'card' })];
  const updates = new Map<string, PhaseUpdate>([
    ['c1', { phase: 'received', detail: null }],
    ['c2', { phase: 'sent', detail: null }],
    ['c3', { phase: 'done', detail: null }],
  ]);
  const { list: out, changed } = applyUpdates(list, 'device', updates, NOW);
  assert.deepEqual(out.map((c) => c.phase), ['received', 'done', 'sent']);
  assert.deepEqual(changed.map((c) => c.id), ['c1']);
  assert.equal(out[0].updatedAt, NOW);
});

test('polling: fast right after a send, slower later, none when nothing waits', () => {
  assert.equal(pollDelayMs([], NOW), null);
  assert.equal(pollDelayMs([cmd({ phase: 'done' })], NOW), null);
  assert.equal(pollDelayMs([cmd({ sentAt: NOW - 5_000 })], NOW), 2_500);
  assert.equal(pollDelayMs([cmd({ sentAt: NOW - 5 * 60_000 })], NOW), 8_000);
  assert.equal(pollDelayMs([cmd({ sentAt: NOW - 30 * 60_000 })], NOW), 30_000);
});

test('the device row chip: the newest open command, else one just finished', () => {
  const older = cmd({ key: 'a', id: 'a', sentAt: NOW - 50_000, phase: 'sent' });
  const newer = cmd({ key: 'b', id: 'b', sentAt: NOW - 10_000, phase: 'received', action: 'refresh_catalog', label: 'רענון קטלוג' });
  assert.equal(latestForMachine([older, newer], 'm1', NOW)?.key, 'b');
  assert.equal(latestForMachine([older, newer], 'm2', NOW), null);
  const finished = cmd({ phase: 'done', updatedAt: NOW - 30_000 });
  assert.equal(latestForMachine([finished], 'm1', NOW)?.phase, 'done');
  assert.equal(latestForMachine([cmd({ phase: 'done', updatedAt: NOW - 10 * 60_000 })], 'm1', NOW), null);
  // A send that failed stays on the row (with "נסה שוב" in the tray).
  assert.equal(latestForMachine([cmd({ phase: 'failed', sendError: 'x', updatedAt: NOW - 10 * 60_000 })], 'm1', NOW)?.sendError, 'x');
});

test('the centred popup: what was sent and to whom, live, as one list', () => {
  const a = cmd({ key: 'a', popupAt: NOW - 1_000, machineName: 'קופה 2' });
  const b = cmd({ key: 'b', popupAt: NOW - 500, machineName: 'קופה 3', label: 'רענון קטלוג' });
  assert.equal(popupLine(a), 'נשלחה פקודה: סנכרון → קופה 2');
  assert.equal(popupLine({ label: 'סנכרון', machineName: null }), 'נשלחה פקודה: סנכרון');
  assert.equal(popupStatus(a), 'ממתין');
  assert.equal(popupStatus({ ...a, phase: 'received' }), 'התקבל');
  assert.equal(popupStatus({ ...a, phase: 'done' }), 'בוצע ✓');
  assert.equal(popupStatus({ ...a, phase: 'failed', detail: 'נדחה — באמצע מכירה' }), 'נכשל — נדחה — באמצע מכירה');
  // Several sends quickly: stacked in the same popup, oldest first.
  assert.deepEqual(popupItems([b, a, cmd({ key: 'c' })], NOW).map((c) => c.key), ['a', 'b']);
});

test('the popup leaves on its own: 3 s after בוצע, a waiting one shrinks into the tray after 5 s', () => {
  const sent = cmd({ popupAt: NOW });
  assert.equal(inPopup(sent, NOW + 4_900), true);
  assert.equal(inPopup(sent, NOW + POPUP_PENDING_MS), false);
  const done = cmd({ popupAt: NOW, phase: 'done', updatedAt: NOW + 2_000 });
  assert.equal(inPopup(done, NOW + 4_900), true);
  assert.equal(inPopup(done, NOW + 2_000 + POPUP_DONE_MS), false);
  // A failure stays longer (with "נסה שוב").
  const failed = cmd({ popupAt: NOW, phase: 'failed', updatedAt: NOW + 1_000 });
  assert.equal(inPopup(failed, NOW + 1_000 + POPUP_DONE_MS + 1), true);
  assert.equal(inPopup(failed, NOW + 1_000 + POPUP_FAILED_MS), false);
  // One that shrank into the tray never pops back when it finishes later.
  assert.equal(inPopup(cmd({ popupAt: NOW, phase: 'done', updatedAt: NOW + 20_000 }), NOW + 20_500), false);
  // Closed by hand.
  assert.equal(inPopup(closePopup([sent], sent.key)[0], NOW + 100), false);
  assert.equal(popupNextChangeMs([sent], NOW + 1_000), 4_000);
  assert.equal(popupNextChangeMs([cmd()], NOW), null);
});

test('the tray keeps the recent ones only and counts the waiting', () => {
  const list = [
    cmd({ key: 'a' }),
    cmd({ key: 'b', phase: 'done', updatedAt: NOW - 2 * 60 * 60_000 }),
    cmd({ key: 'c', phase: 'failed', updatedAt: NOW - 60_000 }),
  ];
  assert.deepEqual(prune(list, NOW).map((c) => c.key), ['a', 'c']);
  assert.equal(openCount(list), 1);
  const many = Array.from({ length: 60 }, (_, i) => cmd({ key: `k${i}` }));
  assert.equal(upsert([], ...many).length, 40);
});

// ── The review's follow-ups ──────────────────────────────────────────────────

test('a shared PC: only the signed-in user’s commands in the active tenant', () => {
  const mine = cmd({ key: 'm', userId: 'u1', tenantId: 't1' });
  const otherTenant = cmd({ key: 'o', userId: 'u1', tenantId: 't2' });
  const otherUser = cmd({ key: 'x', userId: 'u2', tenantId: 't1' });
  const unstamped = cmd({ key: 'n' });
  const list = [mine, otherTenant, otherUser, unstamped];
  assert.deepEqual(visibleTo(list, 'u1', 't1').map((c) => c.key), ['m']);
  assert.deepEqual(visibleTo(list, 'u1', 't2').map((c) => c.key), ['o']);
  assert.deepEqual(visibleTo(list, null, 't1'), []);
  assert.deepEqual(visibleTo(list, 'u1', null), []);
});

test('the tray gives up after a few hours ("לא ידוע — בדוק במכשיר") and backs off to minutes before', () => {
  const old = cmd({ sentAt: NOW - 2 * 60 * 60_000 });
  assert.equal(pollDelayMs([old], NOW), 120_000);
  const ancient = cmd({ key: 'a', sentAt: NOW - GIVE_UP_MS });
  assert.equal(pollDelayMs([ancient], NOW), null);
  const [given] = giveUp([ancient], NOW);
  assert.equal(given.phase, 'unknown');
  assert.equal(isFinal(given.phase), true);
  assert.equal(chipText(given), 'פקודה נשלחה: סנכרון · לא ידוע — בדוק במכשיר');
  assert.equal(popupStatus(given), 'לא ידוע — בדוק במכשיר');
  // Nothing to give up on: the same array (no re-render).
  const fresh = [cmd()];
  assert.equal(giveUp(fresh, NOW), fresh);
  assert.equal(prune(fresh, NOW), fresh);
});

test('a till message ends at its expiry, a kiosk "requested" and a replaced reboot are final', () => {
  assert.equal(phaseOfTillMessage({ total: 3, delivered: 1, acknowledged: 1 }, { expiresAt: new Date(NOW - 1).toISOString(), now: NOW }).phase, 'expired');
  assert.equal(phaseOfTillMessage({ total: 3, delivered: 1, acknowledged: 1 }, { status: 'expired', now: NOW }).phase, 'expired');
  assert.equal(phaseOfTillMessage({ total: 3, delivered: 1, acknowledged: 1 }, { expiresAt: new Date(NOW + 60_000).toISOString(), now: NOW }).phase, 'received');
  assert.equal(phaseOfTillMessage({ total: 3, delivered: 3, acknowledged: 3 }, { status: 'expired', now: NOW }).phase, 'done');
  assert.equal(isFinal(phaseOfKiosk('requested').phase), true);
  assert.deepEqual(phaseOfRebootRead('r1', { id: 'r2', status: 'pending' }), { phase: 'cancelled', detail: 'הוחלפה בבקשה חדשה' });
  assert.equal(phaseOfRebootRead('r1', null).phase, 'unknown');
  assert.equal(phaseOfRebootRead('r1', { id: 'r1', status: 'deferred', reason: 'busy_sale' }).phase, 'received');
});

test('after a reload a send still "sending" is offered again with its own key', () => {
  const list = [cmd({ key: 'send-9', id: null, phase: 'sending', popupAt: NOW - 1_000 }), cmd({ key: 'ok' })];
  const out = afterRehydrate(list, NOW);
  assert.equal(out[0].key, 'send-9');
  assert.equal(out[0].phase, 'failed');
  assert.ok(out[0].sendError);
  assert.equal(out[0].popupAt, null);
  assert.equal(out[1], list[1]);
  const none = [cmd()];
  assert.equal(afterRehydrate(none, NOW), none);
});

test('trimming to the limit drops finished entries first', () => {
  const open = Array.from({ length: MAX_TRACKED }, (_, i) => cmd({ key: `open${i}` }));
  const done = cmd({ key: 'done-old', phase: 'done' });
  const out = cap([...open, done]);
  assert.equal(out.length, MAX_TRACKED);
  assert.equal(out.some((c) => c.key === 'done-old'), false);
  // A newer finished one still goes before an older open one.
  const out2 = cap([cmd({ key: 'done-new', phase: 'done' }), ...open]);
  assert.deepEqual(out2.map((c) => c.key), open.map((c) => c.key));
});

test('nothing moved: the same array (no re-render of every chip)', () => {
  const list = [cmd({ id: 'c1' })];
  const same = applyUpdates(list, 'device', new Map([['c1', { phase: 'sent', detail: null }]]), NOW);
  assert.equal(same.list, list);
  assert.deepEqual(same.changed, []);
});

test('one key per user action: the same request keeps its key, an edited one gets a new key', () => {
  let n = 0;
  const ring = keyRing(() => `key-${++n}`);
  const a = { body: 'מבצע היום', targetId: 's1' };
  assert.equal(ring.keyFor(a), 'key-1');
  assert.equal(ring.keyFor({ ...a }), 'key-1');
  assert.equal(ring.keyFor({ ...a, body: 'מבצע מחר' }), 'key-2');
  ring.forget(a);
  assert.equal(ring.keyFor(a), 'key-3');
  ring.forget();
  assert.equal(ring.keyFor(a), 'key-4');
  assert.equal(isKeyReused({ response: { status: 422, data: { detail: { code: 'idempotency_key_reused' } } } }), true);
  assert.equal(isKeyReused({ response: { status: 422, data: { detail: { code: 'other' } } } }), false);
  assert.equal(isKeyReused(new Error('network')), false);
});