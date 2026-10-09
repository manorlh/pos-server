import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyUpdates,
  chipText,
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
  assert.equal(phaseOfKiosk('requested').phase, 'sent');
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
  assert.equal(pollDelayMs([cmd({ sentAt: NOW - 60 * 60_000 })], NOW), 30_000);
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
