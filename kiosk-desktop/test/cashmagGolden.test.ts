/**
 * The CashMag contract (P:/specs/cashmag.md §12, P:/specs/cashmag-windows.md §6): every client reads the server's
 * answer to a payment the same way. `cashmag_outcomes_golden.json` is byte-equal with pos-android's
 * (app/src/test/resources, CashMagGoldenTest pins the same SHA-256); `cashmag_wire_golden.json` is this side's —
 * the WebSocket's raw answers, the claim and deposits signals.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  balanceOf,
  cashmagAgorot,
  cashmagMayWait,
  cashmagOutcome,
  cashmagPayable,
  type CashMagOutcome,
  type CashMagPayRequest,
  type CashRecyclerReply,
} from '../src/core/cash/cashmag';
import { claimOf, dispensePossibleParams, payReplyOf, piecesOf, statusOf, totalOf } from '../src/core/cash/cashmagWire';

const FIXTURES = path.join(__dirname, 'fixtures');
const OUTCOMES_SHA256 = 'c1d427554c355b740fc9ea478f86bb74f0738524c94b6cc03b421383301d8f68';
const WIRE_SHA256 = '5dd4e48ecb163070407c4789b5e389b158232513ceb9e886af50ca928733e470';

const read = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8').replace(/\r\n/g, '\n');
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

type J = Record<string, unknown>;

/** A golden reply as pos-android's CashMagGoldenTest reads it. */
function replyOf(o: J): CashRecyclerReply {
  const b = o.balance as J | undefined;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    valid: o.valid === true,
    error: typeof o.error === 'string' && o.error ? o.error : null,
    message: null,
    reachedDevice: o.reachedDevice === undefined ? true : o.reachedDevice === true,
    balance: b
      ? balanceOf({
          currency: typeof b.currency === 'string' && b.currency ? b.currency : null,
          transactionAgorot: n(b.transactionAgorot),
          roundedAgorot: n(b.roundedAgorot),
          cashInAgorot: n(b.cashInAgorot) ?? 0,
          cashOutAgorot: n(b.cashOutAgorot) ?? 0,
          customerBalanceAgorot: n(b.customerBalanceAgorot),
          merchantBalanceAgorot: n(b.merchantBalanceAgorot),
          overDispensedAgorot: n(b.overDispensedAgorot),
        })
      : null,
    fields: {},
  };
}

function expectOutcome(name: string, o: CashMagOutcome, e: J) {
  expect(o.kind, name).toBe(e.outcome);
  if (o.kind === 'paid') {
    expect({ r: o.receivedAgorot, c: o.changeAgorot, w: o.changeOwedAgorot, x: o.roundingAgorot }, name).toEqual({ r: e.receivedAgorot, c: e.changeAgorot, w: e.changeOwedAgorot, x: e.roundingAgorot });
  } else if (o.kind === 'cancelled') {
    expect(o.refundedAgorot, name).toBe(e.refundedAgorot);
  } else if (o.kind === 'unavailable') {
    expect(o.reason, name).toBe(e.reason);
  } else {
    expect({ h: o.heldAgorot, r: o.reason, l: o.lost }, name).toEqual({ h: e.heldAgorot, r: e.reason, l: e.lost });
  }
}

const requestOf = (q: J): CashMagPayRequest => ({ txId: 'tx-golden', amountAgorot: q.amountAgorot as number, dueAgorot: q.dueAgorot as number, stationId: 'cashmag:golden:1', currency: q.currency as string });

describe('cashmag_outcomes_golden.json — the contract shared with pos-android', () => {
  const text = read('cashmag_outcomes_golden.json');
  const golden = JSON.parse(text) as J;

  it('is the pinned one (byte-equal with pos-android, version 1)', () => {
    expect(sha(text)).toBe(OUTCOMES_SHA256);
    expect(golden.version).toBe(1);
  });

  it('rounding as the contract says', () => {
    for (const r of golden.rounding as J[]) expect(cashmagPayable(r.mode as 'none' | 'nearest_10', r.amountAgorot as number), JSON.stringify(r)).toBe(r.dueAgorot);
  });

  it('decimals as the contract says (a point or a comma)', () => {
    for (const r of golden.decimals as J[]) expect(cashmagAgorot(r.text), JSON.stringify(r)).toBe(r.agorot);
  });

  it('the waits as the contract says: only a refusal with no money in waits', () => {
    for (const r of golden.waits as J[]) expect(cashmagMayWait(replyOf(r.reply as J)), r.name as string).toBe(r.mayWait);
  });

  it('every answer read as the contract says', () => {
    const cases = golden.cases as J[];
    expect(cases.length).toBe(19);
    for (const c of cases) expectOutcome(c.name as string, cashmagOutcome(requestOf(c.request as J), replyOf(c.reply as J)), c.expect as J);
  });
});

describe('cashmag_wire_golden.json — the WebSocket as this kiosk reads it', () => {
  const text = read('cashmag_wire_golden.json');
  const golden = JSON.parse(text) as J;

  it('is the pinned one', () => {
    expect(sha(text)).toBe(WIRE_SHA256);
    expect(golden.version).toBe(1);
  });

  it('each raw payment answer → the outcome (balance < 0 change owed, > 0 not paid, 0 a document)', () => {
    for (const c of golden.pay as J[]) {
      const a = c.answer as J;
      const req = requestOf(c.request as J);
      const reply = payReplyOf({ status: statusOf(a.status), result: (a.result as J | undefined) ?? null }, req.dueAgorot);
      expectOutcome(c.name as string, cashmagOutcome(req, reply), c.expect as J);
    }
  });

  it('the claim signal → who has the machine', () => {
    for (const c of golden.claims as J[]) expect(claimOf(c.params as J), JSON.stringify(c.params)).toBe(c.claim);
  });

  it('the deposits signal → what went in (the whole list so far)', () => {
    for (const c of golden.deposits as J[]) expect(totalOf(piecesOf((c.params as J).deposits) ?? []), JSON.stringify(c.params)).toBe(c.insertedAgorot);
  });

  it("isDispensePossible's parameters (the 2024-02-13 connector)", () => {
    for (const c of golden.dispensePossible as J[]) expect(dispensePossibleParams(c.amountAgorot as number, c.currency as string)).toEqual(c.params);
  });
});
