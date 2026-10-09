import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCreateBody,
  creditFor,
  defaultTarget,
  isCreditableDocument,
  isPendingRemoteCredit,
  newCommandId,
  remoteCreditStatusVariant,
  selectedLines,
  selectionAmount,
  selectionProblems,
  type RemoteCreditPrepare,
  type RemoteCreditSelection,
  type RemoteCreditTarget,
} from './remoteCredit';

const target = (over: Partial<RemoteCreditTarget> = {}): RemoteCreditTarget => ({
  machineId: 'm1',
  name: 'קופה 1',
  shopId: 's1',
  online: true,
  isOriginalTill: false,
  openShift: { id: 'sh1' },
  ...over,
});

const prepare = (over: Partial<RemoteCreditPrepare> = {}): RemoteCreditPrepare => ({
  transactionId: 't1',
  machineId: 'm1',
  createdAt: '2026-10-07T10:00:00Z',
  status: 'completed',
  creditable: true,
  collected: '75.00',
  creditedAmount: '0.00',
  pendingAmount: '0.00',
  remainingAmount: '75.00',
  lines: [
    { itemId: 'beer', productName: 'Beer', quantity: 2, credited: 0, pending: 0, remaining: 2, unitPrice: '30.00', collected: '60.00', remainingAmount: '60.00' },
    { itemId: 'chips', productName: 'Chips', quantity: 1, credited: 0, pending: 0, remaining: 1, unitPrice: '15.00', collected: '15.00', remainingAmount: '15.00' },
  ],
  tenders: [{ method: 'card', amount: '75.00' }],
  targets: [target({ isOriginalTill: true }), target({ machineId: 'm2', name: 'קופה 2' })],
  pendingRequests: [],
  reasons: [{ code: 'declined_at_terminal', label: 'העסקה נדחתה במסוף' }],
  preparedExpiryHours: 24,
  ...over,
});

const selection = (over: Partial<RemoteCreditSelection> = {}): RemoteCreditSelection => ({
  full: true,
  quantities: {},
  mode: 'no_money',
  machineId: 'm1',
  reasonCode: 'declined_at_terminal',
  reason: '',
  ...over,
});

describe('creditFor', () => {
  it('credits a line returned in pieces exactly what was paid', () => {
    const pieces = [0, 1, 2].map((k) => creditFor(1000, 3, k, 1));
    assert.deepEqual(pieces, [333, 334, 333]);
    assert.equal(pieces.reduce((a, b) => a + b, 0), 1000);
  });
  it('is nothing for nothing', () => {
    assert.equal(creditFor(1000, 3, 0, 0), 0);
    assert.equal(creditFor(1000, 0, 0, 1), 0);
  });
});

describe('selectionAmount / selectedLines', () => {
  it('full takes everything left on every line', () => {
    assert.equal(selectionAmount(prepare().lines, { full: true, quantities: {} }), '75.00');
    assert.deepEqual(selectedLines(prepare().lines, { full: true, quantities: {} }), [
      { itemId: 'beer', quantity: 2 },
      { itemId: 'chips', quantity: 1 },
    ]);
  });
  it('a partial pick is priced like the till prices it and never beyond what is left', () => {
    const lines = prepare().lines;
    assert.equal(selectionAmount(lines, { full: false, quantities: { beer: 1 } }), '30.00');
    assert.equal(selectionAmount(lines, { full: false, quantities: { beer: 5 } }), '60.00');
    assert.deepEqual(selectedLines(lines, { full: false, quantities: { beer: 1, chips: 0 } }), [
      { itemId: 'beer', quantity: 1 },
    ]);
  });
  it('earlier credits and pending requests count toward the rounding', () => {
    const lines = [
      { itemId: 'a', quantity: 3, credited: 1, pending: 1, remaining: 1, unitPrice: '3.33', collected: '10.00', remainingAmount: '3.33' },
    ];
    assert.equal(selectionAmount(lines, { full: false, quantities: { a: 1 } }), '3.33');
  });
});

describe('selectionProblems', () => {
  it('a complete selection has none', () => {
    assert.deepEqual(selectionProblems(prepare(), selection()), []);
  });
  it('names every missing piece', () => {
    const got = selectionProblems(
      prepare({ creditable: false }),
      selection({ full: false, quantities: {}, mode: null, machineId: null, reasonCode: null }),
    );
    assert.deepEqual(got, ['notCreditable', 'noLines', 'noMode', 'noTarget', 'reasonRequired']);
  });
  it('refuses more than is left on a line, and a till that is not offered', () => {
    assert.ok(selectionProblems(prepare(), selection({ full: false, quantities: { beer: 3 } })).includes('overLine'));
    assert.ok(selectionProblems(prepare(), selection({ machineId: 'kiosk' })).includes('noTarget'));
  });
  it('"other" needs words; a quick reason does not', () => {
    assert.ok(selectionProblems(prepare(), selection({ reasonCode: 'other', reason: ' ' })).includes('reasonRequired'));
    assert.deepEqual(selectionProblems(prepare(), selection({ reasonCode: 'other', reason: 'טעות' })), []);
  });
});

describe('buildCreateBody', () => {
  it('sends the lines only for a partial credit, and the trimmed reason', () => {
    assert.deepEqual(buildCreateBody(prepare(), selection({ reason: '  ' }), 'cmd'), {
      id: 'cmd', transactionId: 't1', machineId: 'm1', mode: 'no_money', full: true, lines: [],
      reason: null, reasonCode: 'declined_at_terminal',
    });
    const partial = buildCreateBody(prepare(), selection({ full: false, quantities: { chips: 1 }, mode: 'prepared', reason: ' x y ' }), 'c2');
    assert.deepEqual(partial.lines, [{ itemId: 'chips', quantity: 1 }]);
    assert.equal(partial.mode, 'prepared');
    assert.equal(partial.reason, 'x y');
  });
});

describe('defaultTarget', () => {
  it('prefers the document own till, else the only one, else none', () => {
    assert.equal(defaultTarget([target({ machineId: 'a' }), target({ machineId: 'b', isOriginalTill: true })]), 'b');
    assert.equal(defaultTarget([target({ machineId: 'only' })]), 'only');
    assert.equal(defaultTarget([target({ machineId: 'a' }), target({ machineId: 'b' })]), null);
    assert.equal(defaultTarget([]), null);
  });
});

describe('documents and statuses', () => {
  it('only a completed sale may be credited', () => {
    assert.equal(isCreditableDocument({ documentType: 320, status: 'completed' }), true);
    assert.equal(isCreditableDocument({ documentType: 400, status: 'partial_refund' }), true);
    assert.equal(isCreditableDocument({ documentType: 330, status: 'completed' }), false);
    assert.equal(isCreditableDocument({ documentType: -400, status: 'completed' }), false);
    assert.equal(isCreditableDocument({ documentType: 320, status: 'refunded' }), false);
    assert.equal(isCreditableDocument({ documentType: 320, status: 'cancelled' }), false);
    assert.equal(isCreditableDocument({ documentType: null, refundOfTransactionId: 'x', status: 'completed' }), false);
  });
  it('pending until the till answers', () => {
    assert.equal(isPendingRemoteCredit('queued'), true);
    assert.equal(isPendingRemoteCredit('received'), true);
    assert.equal(isPendingRemoteCredit('completed'), false);
    assert.equal(isPendingRemoteCredit(null), false);
    assert.equal(remoteCreditStatusVariant('failed'), 'destructive');
    assert.equal(remoteCreditStatusVariant('completed'), 'default');
  });
  it('command ids are unique v4 uuids', () => {
    const a = newCommandId();
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, newCommandId());
  });
});
