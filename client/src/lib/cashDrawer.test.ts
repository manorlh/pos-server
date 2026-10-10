import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawerQuery, isNotable, movementSign, runningExpected, type TimelineItem } from './cashDrawer';

test('the filters become query parameters, empty ones left out', () => {
  assert.deepEqual(drawerQuery({}), {});
  assert.deepEqual(
    drawerQuery({
      from: '2026-10-01', to: '2026-10-07', shopId: 's', eventType: ['MANUAL', 'CHANGE'], managerApproval: false,
      withSale: null, result: ['denied'], exceptionsOnly: true, employee: '',
    }),
    {
      from: '2026-10-01', to: '2026-10-07', shopId: 's', eventType: 'MANUAL,CHANGE', managerApproval: 'false',
      result: 'denied', exceptionsOnly: 'true',
    },
  );
});

test('movements move the expected balance; a count does not', () => {
  assert.equal(movementSign('cash_in'), 1);
  assert.equal(movementSign('cash_out'), -1);
  assert.equal(movementSign('deposit'), -1);
  assert.equal(movementSign('count'), 0);
});

const ev = (over: Partial<TimelineItem & { kind: 'event' }>): TimelineItem =>
  ({
    kind: 'event', id: 'e', category: 'drawer', eventType: 'MANUAL', permission: null, decision: null, result: 'approved',
    resultReason: null, shopId: null, shopName: null, machineId: 'm', machineName: null, drawerName: null, deviceId: null,
    shiftId: 's', employeeId: null, employeeName: null, employeeRole: null, approverId: null, approverName: null,
    tableId: null, saleId: null, paymentId: null, originalSaleId: null, reason: null, reasonNote: null, movementId: null,
    cashMovementType: null, amount: null, expectedBalance: null, offline: false, occurredAt: null, exceptions: [],
    ...over,
  }) as TimelineItem;

const mv = (type: 'cash_in' | 'cash_out' | 'deposit' | 'count', amount: number, expectedAfter: number | null = null): TimelineItem =>
  ({
    kind: 'movement', id: 'm', type, amount, expectedBefore: null, expectedAfter, variance: null, blind: false, reason: null,
    note: null, source: null, shopName: null, machineId: 'm', machineName: null, shiftId: 's', employeeId: null,
    employeeName: null, approverId: null, approverName: null, drawerEventId: null, offline: false, occurredAt: null,
  }) as TimelineItem;

test('the running expected balance: snapshots win, openings alone never move it', () => {
  const items = [ev({}), mv('cash_in', 200), ev({ expectedBalance: 750 }), mv('cash_out', 50), mv('deposit', 100, 590), mv('count', 580)];
  assert.deepEqual(runningExpected(items, 500), [500, 700, 750, 700, 590, 590]);
  assert.deepEqual(runningExpected([mv('cash_out', 10)], null), [null]);
});

test('notable rows', () => {
  assert.equal(isNotable({ result: 'approved', eventType: 'CASH_SALE', exceptions: [] }), false);
  assert.equal(isNotable({ result: 'denied', eventType: 'MANUAL', exceptions: [] }), true);
  assert.equal(isNotable({ result: 'approved', eventType: 'AFTER_CLOSE', exceptions: [] }), true);
  assert.equal(isNotable({ result: 'approved', eventType: 'MANUAL', exceptions: ['drawer_open'] }), true);
});
