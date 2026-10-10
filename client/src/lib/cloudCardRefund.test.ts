import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRefundBody,
  canReleaseFromZ,
  canResend,
  cardDefaultTarget,
  cardLabel,
  cloudRefundIdOf,
  initialFull,
  isLiveRefund,
  isRefundableDocument,
  isZCreditLeg,
  refundAmount,
  refundProblems,
  refundStatusVariant,
  resendNeedsForce,
  type CloudCardRefund,
  type CloudCardRefundLeg,
  type CloudCardRefundPrepare,
  type CloudCardRefundSelection,
} from './cloudCardRefund';
import { isCancellableRemoteCredit, type RemoteCreditPrepare } from './remoteCredit';

const doc = (over: Partial<RemoteCreditPrepare> = {}): RemoteCreditPrepare => ({
  transactionId: 't1',
  machineId: 'm1',
  createdAt: '2026-10-08T10:00:00Z',
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
  tenders: [{ method: 'card', amount: '50.00' }, { method: 'card', amount: '25.00' }],
  targets: [{ machineId: 'm1', name: 'קופה 1', shopId: 's1', online: true, isOriginalTill: true }],
  pendingRequests: [],
  reasons: [{ code: 'product_returned', label: 'החזרת מוצר' }],
  preparedExpiryHours: 24,
  ...over,
});

const leg = (over: Partial<CloudCardRefundLeg> = {}): CloudCardRefundLeg => ({
  paymentId: 'p1',
  method: 'card',
  amount: '50.00',
  provider: 'zcredit',
  cardLast4: '4580',
  zcredit: true,
  refundable: true,
  refundedAmount: '0.00',
  inProgressAmount: '0.00',
  tillCardCredits: '0.00',
  remainingAmount: '50.00',
  ...over,
});

const prepare = (over: Partial<CloudCardRefundPrepare> = {}): CloudCardRefundPrepare => ({
  enabled: true,
  label: 'זוכה באשראי מהענן (Z-Credit)',
  legs: [leg()],
  credentials: { available: true, terminal: '09******01', source: 'shop' },
  document: doc(),
  refunds: [],
  ...over,
});

const selection = (over: Partial<CloudCardRefundSelection> = {}): CloudCardRefundSelection => ({
  full: false,
  quantities: { beer: 1 },
  machineId: 'm1',
  reasonCode: 'product_returned',
  reason: '',
  ...over,
});

const refund = (over: Partial<CloudCardRefund> = {}): CloudCardRefund =>
  ({
    id: 'r1',
    transactionId: 't1',
    paymentId: 'p1',
    provider: 'zcredit',
    terminal: '09******01',
    originalReference: '77001234',
    originalLegAmount: '50.00',
    amount: '30.00',
    fullCredit: false,
    lines: [],
    reason: 'החזרת מוצר',
    status: 'refunded',
    voided: false,
    queryCount: 0,
    createdAt: '2026-10-08T10:00:00Z',
    updatedAt: '2026-10-08T10:00:00Z',
    targetMachineId: 'm1',
    targetOnline: true,
    document: { requestId: 'q1', requestStatus: 'sent', landed: false },
    ...over,
  }) as CloudCardRefund;

describe('which legs', () => {
  it('offers only a card leg the till charged through Z-Credit', () => {
    assert.equal(isZCreditLeg({ method: 'card', nayaxMeta: { result: { provider: 'zcredit' } } }), true);
    assert.equal(isZCreditLeg({ method: 'Card', nayaxMeta: { provider: 'ZCredit' } }), true);
    // Another terminal of the same shop ("גם וגם"): the till's path.
    assert.equal(isZCreditLeg({ method: 'card', nayaxMeta: { result: { uid: 'A-1' } } }), false);
    assert.equal(isZCreditLeg({ method: 'cash', nayaxMeta: { result: { provider: 'zcredit' } } }), false);
    assert.equal(isZCreditLeg({ method: 'card', noMoneyMovement: true, nayaxMeta: { result: { provider: 'zcredit' } } }), false);
    assert.equal(isZCreditLeg({ method: 'card', nayaxMeta: null }), false);
  });

  it('marks a credit note leg that records a cloud refund', () => {
    assert.equal(cloudRefundIdOf({ nayaxMeta: { cloudCardRefundId: 'r1' } }), 'r1');
    assert.equal(cloudRefundIdOf({ nayaxMeta: {} }), null);
  });

  it('refunds only a completed sale', () => {
    assert.equal(isRefundableDocument({ status: 'completed', documentType: 320 }), true);
    assert.equal(isRefundableDocument({ status: 'partial_refund' }), true);
    assert.equal(isRefundableDocument({ status: 'completed', documentType: 330 }), false);
    assert.equal(isRefundableDocument({ status: 'completed', documentType: -400 }), false);
    assert.equal(isRefundableDocument({ status: 'refunded' }), false);
  });
});

describe('the selection', () => {
  it('prices the lines with the till rule', () => {
    assert.equal(refundAmount(doc(), selection()), '30.00');
    assert.equal(refundAmount(doc(), selection({ full: true })), '75.00');
  });

  it('starts full only when the card leg covers what is left', () => {
    assert.equal(initialFull(prepare(), leg()), false); // 75 left, 50 on the card
    assert.equal(initialFull(prepare(), leg({ remainingAmount: '75.00' })), true);
    assert.equal(initialFull(prepare(), null), false);
  });

  it('says why it cannot be sent', () => {
    assert.deepEqual(refundProblems(prepare(), leg(), selection()), []);
    assert.deepEqual(refundProblems(prepare(), leg(), selection({ full: true })), ['overLeg']);
    assert.deepEqual(refundProblems(prepare({ enabled: false }), leg(), selection()), ['disabled']);
    assert.deepEqual(
      refundProblems(prepare({ credentials: { available: false } }), leg(), selection()),
      ['noCredentials'],
    );
    assert.deepEqual(refundProblems(prepare(), leg({ refundable: false }), selection()), ['notRefundable']);
    assert.deepEqual(refundProblems(prepare(), leg(), selection({ quantities: {} })), ['noLines']);
    assert.deepEqual(refundProblems(prepare(), leg(), selection({ quantities: { beer: 3 } })), ['overLine', 'overLeg']);
    assert.deepEqual(refundProblems(prepare(), leg(), selection({ machineId: 'gone' })), ['noTarget']);
    assert.deepEqual(refundProblems(prepare(), leg(), selection({ reasonCode: 'other', reason: ' ' })), ['reasonRequired']);
  });

  it('builds the body the server takes', () => {
    assert.deepEqual(buildRefundBody(prepare(), 'p1', selection({ reason: ' הלקוח החזיר ' }), 'id-1'), {
      id: 'id-1',
      transactionId: 't1',
      paymentId: 'p1',
      machineId: 'm1',
      full: false,
      lines: [{ itemId: 'beer', quantity: 1 }],
      reason: 'הלקוח החזיר',
      reasonCode: 'product_returned',
    });
    assert.deepEqual(buildRefundBody(prepare(), 'p1', selection({ full: true }), 'id-2').lines, []);
  });
});

describe('the refund, live', () => {
  it('polls while it runs or its credit note is on its way', () => {
    assert.equal(isLiveRefund(refund({ status: 'in_flight' })), true);
    assert.equal(isLiveRefund(refund()), true);
    assert.equal(isLiveRefund(refund({ document: { requestStatus: 'completed', creditTransactionId: 'c1', landed: true } })), false);
    assert.equal(isLiveRefund(refund({ document: { requestStatus: 'failed', landed: false } })), false);
    assert.equal(isLiveRefund(refund({ status: 'unknown' })), false);
  });

  it('sends the credit note again only for a refunded card with no note', () => {
    assert.equal(canResend(refund({ document: { requestStatus: 'failed', landed: false } })), true);
    assert.equal(canResend(refund({ document: { requestStatus: 'completed', creditTransactionId: 'c1', landed: false } })), false);
    assert.equal(canResend(refund({ status: 'unknown' })), false);
    assert.equal(resendNeedsForce(refund()), true);
    assert.equal(resendNeedsForce(refund({ document: { requestStatus: 'expired', landed: false } })), false);
  });

  it('a card_refunded request is never cancelled from the dashboard', () => {
    assert.equal(isCancellableRemoteCredit({ status: 'sent', mode: 'card_refunded' }), false);
    assert.equal(isCancellableRemoteCredit({ status: 'sent', mode: 'prepared' }), true);
    assert.equal(isCancellableRemoteCredit({ status: 'completed', mode: 'no_money' }), false);
  });

  it('labels', () => {
    assert.equal(refundStatusVariant('refunded'), 'default');
    assert.equal(refundStatusVariant('unknown'), 'destructive');
    assert.equal(cardLabel('4580'), '****4580');
    assert.equal(cardLabel(null), '—');
  });
});


describe('the next shift and the next Z (SPEC_REMOTE_CREDIT.md §11.8–§11.10)', () => {
  const targets = [
    { machineId: 'own', name: 'קופה 1', shopId: 's1', online: true, isOriginalTill: true, landing: 'next_shift' as const },
    { machineId: 'bar', name: 'קופה 2', shopId: 's1', online: true, isOriginalTill: false, landing: 'open_shift' as const },
  ];

  it("starts on the server's proposal, none when it proposes none, the old rule from an older server", () => {
    assert.equal(cardDefaultTarget(prepare({ document: doc({ targets, defaultTargetId: 'bar' }) })), 'bar');
    assert.equal(cardDefaultTarget(prepare({ document: doc({ targets, defaultTargetId: null }) })), null);
    assert.equal(cardDefaultTarget(prepare({ document: doc({ targets, defaultTargetId: 'gone' }) })), null);
    assert.equal(cardDefaultTarget(prepare({ document: doc({ targets }) })), 'own');
  });

  it("support releases a refund from the next Z only while its note is owed and holds it", () => {
    const owed = refund({ document: { requestStatus: 'received', landed: false }, blocksNextZ: true });
    assert.equal(canReleaseFromZ(owed, 'super_admin'), true);
    assert.equal(canReleaseFromZ(owed, 'company_manager'), false);
    assert.equal(canReleaseFromZ({ ...owed, zGateReleased: true }, 'super_admin'), false);
    assert.equal(canReleaseFromZ({ ...owed, blocksNextZ: false }, 'super_admin'), false);
    assert.equal(canReleaseFromZ(refund({ document: { creditTransactionId: 'c1', landed: true } }), 'super_admin'), false);
    assert.equal(canReleaseFromZ(refund({ status: 'unknown' }), 'super_admin'), false);
  });
});
