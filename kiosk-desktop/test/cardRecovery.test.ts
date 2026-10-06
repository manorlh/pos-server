import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  blocksCard,
  cancelAction,
  cardBlocked,
  firstAnswerAction,
  LOOKUP_BACKOFF_MS,
  maySendSale,
  resolveAttempt,
  type CallFn,
} from '../src/core/cardRecovery';
import {
  cardAnswerOf,
  javaStringHash,
  parseCardResponse,
  parseReply,
  pinpadAddressOf,
  readLookupReply,
  saleFrame,
  saleOutcome,
  strictInt,
  vuidOf,
} from '../src/core/nayax';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { PayService } from '../src/main/payment/payService';
import type { PaymentProvider, Resolution, SaleResult } from '../src/main/payment/provider';

const reply = (result: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: '1', result });

describe('the sale reply (TweezerOutcome)', () => {
  const table: Array<[unknown, string, string]> = [
    [0, 'APPROVED', 'APPROVED'],
    [10, 'PARTIAL', 'APPROVED'],
    [126, 'CANCELLED', 'DECLINED'],
    [998, 'CANCELLED', 'DECLINED'],
    [-1, 'TERMINAL_BUSY', 'DECLINED'],
    [-5, 'TERMINAL_BUSY', 'DECLINED'],
    [995, 'DUPLICATE_VUID', 'DECLINED'],
    [993, 'TIMEOUT', 'UNKNOWN'],
    [162, 'UNKNOWN', 'UNKNOWN'],
    [-61, 'DECLINED', 'DECLINED'],
    [33, 'DECLINED', 'DECLINED'],
  ];
  for (const [code, outcome, answer] of table) {
    it(`statusCode ${String(code)} → ${outcome} / ${answer}`, () => {
      const o = saleOutcome(parseReply(reply({ statusCode: code })));
      expect(o).toBe(outcome);
      expect(cardAnswerOf(o)).toBe(answer);
    });
  }

  it('anything unreadable is unknown, never "approved"', () => {
    expect(cardAnswerOf(saleOutcome(parseReply('not json')))).toBe('UNKNOWN');
    expect(cardAnswerOf(saleOutcome(parseReply(JSON.stringify({ jsonrpc: '2.0', error: { code: -1 } }))))).toBe('UNKNOWN');
    expect(cardAnswerOf(saleOutcome(parseReply(reply({}))))).toBe('UNKNOWN');
    // org.json's optInt would read "abc" as 0 (approved!) — strictly: unknown.
    expect(cardAnswerOf(saleOutcome(parseReply(reply({ statusCode: 'abc' }))))).toBe('UNKNOWN');
    expect(strictInt('0')).toBe(0);
    expect(strictInt('1.5')).toBe(null);
  });

  it('reads the card: last 4, approval, uid kept losslessly, brand', () => {
    const body = '{"jsonrpc":"2.0","id":"1","result":{"statusCode":0,"uid":24071711405408830122531,"issuerAuthNum":"0123456","cardNumber":"542386***7407","amount":4590,"mutagName":"Mastercard","creditPayments":1}}';
    const c = parseCardResponse(parseReply(body));
    expect(c.last4).toBe('7407');
    expect(c.authNum).toBe('0123456');
    expect(c.uid).toBe('24071711405408830122531');
    expect(c.brand).toBe('mastercard');
    expect(c.creditPayments).toBe(null);
  });
});

describe('the frames', () => {
  it('a sale is the till’s frame byte for byte (amount in agorot, currency "376", id "1")', () => {
    expect(saleFrame(4590, '4120000000123')).toBe(
      '{"jsonrpc":"2.0","method":"doTransaction","params":["ashrait",{"amount":4590,"vuid":"4120000000123","currency":"376","creditTerms":1,"tranCode":1,"tranType":1,"cardNumber":"","expDate":"","cvv":""}],"id":"1"}',
    );
    expect(JSON.parse(saleFrame(9000, 'v', 3)).params[1]).toMatchObject({ creditTerms: 8, creditPayments: 3 });
  });

  it('the vuid: 3 digits of the machine (Java hashCode), then a 10-digit counter', () => {
    expect(javaStringHash('hello')).toBe(99162322);
    expect(vuidOf('de93de29-19bb-4480-ab06-f73af2876841', 42)).toMatch(/^\d{3}0000000042$/);
    expect(vuidOf(null, 1).slice(0, 3)).toBe(String(Math.abs(javaStringHash('unpaired')) % 1000).padStart(3, '0'));
  });

  it('the pinpad address from the settings: scheme, inline port/path, defaults 8080 and /SPICy', () => {
    expect(pinpadAddressOf('192.168.0.167')).toEqual({ host: '192.168.0.167', port: 8080, path: '/SPICy', tls: true });
    expect(pinpadAddressOf('http://10.0.0.5:9000/X')).toEqual({ host: '10.0.0.5', port: 9000, path: '/X', tls: false });
    expect(pinpadAddressOf('pinpad.local', '8443', 'SPICy')).toEqual({ host: 'pinpad.local', port: 8443, path: '/SPICy', tls: true });
    expect(pinpadAddressOf('')).toBe(null);
    expect(pinpadAddressOf('300.1.1.1')).toBe(null);
  });
});

describe('a lookup by vuid (readLookupReply)', () => {
  it('approved in the amount sent → approved; another amount → still unknown', () => {
    expect(readLookupReply(reply({ statusCode: 0, amount: 4590, vuid: 'v' }), 'v', 4590).kind).toBe('approved');
    expect(readLookupReply(reply({ statusCode: 0, amount: 4000 }), 'v', 4590).kind).toBe('unknown');
    expect(readLookupReply(reply({ statusCode: 0, amount: 5000 }), 'v', 4590, true).kind).toBe('approved');
  });

  it('not found = -61 (or found:false); an answer about another vuid proves nothing', () => {
    expect(readLookupReply(reply({ statusCode: -61 }), 'v', 1).kind).toBe('not_found');
    expect(readLookupReply(reply({ found: false }), 'v', 1).kind).toBe('not_found');
    expect(readLookupReply(reply({ statusCode: 0, vuid: 'other' }), 'v', 1).kind).toBe('unknown');
  });

  it('a code about the request (not the transaction) is unknown; a decline is declined', () => {
    for (const code of [-51, -64, 4000, 5003, -1, -5, 993, 995, 162]) expect(readLookupReply(reply({ statusCode: code }), 'v', 1).kind).toBe('unknown');
    expect(readLookupReply(reply({ statusCode: 33 }), 'v', 1).kind).toBe('declined');
  });
});

/** A scripted terminal: answers frames by method, recording them. */
function terminal(script: Partial<Record<string, Array<string | 'down'>>>) {
  const sent: string[] = [];
  const call: CallFn = async (frame) => {
    const method = JSON.parse(frame).method as string;
    sent.push(method);
    const queue = script[method] ?? [];
    const next = queue.length > 1 ? queue.shift()! : (queue[0] ?? 'down');
    return next === 'down' ? { ok: false, error: 'timeout' } : { ok: true, body: next };
  };
  return { sent, call };
}

const noSleep = async () => undefined;

describe('resolving an unknown outcome (SPEC_CARD_RECOVERY §3)', () => {
  it('an answered transaction is believed at once — no abort (Nayax would print "עסקה בוטלה")', async () => {
    const t = terminal({ getTransactionByVuid: [reply({ statusCode: 0, amount: 100 })] });
    const r = await resolveAttempt({ vuid: 'v', amountAgorot: 100, terminalTip: false }, t.call, noSleep);
    expect(r.kind).toBe('approved');
    expect(t.sent).toEqual(['getTransactionByVuid']);
    expect(t.sent).not.toContain('doTransaction');
  });

  it('"not found" is believed only when idle and said twice ≥ 5 s apart; the abort goes once, after the first lookup', async () => {
    const slept: number[] = [];
    const t = terminal({ getTransactionByVuid: [reply({ statusCode: -61 })], getInternalStatus: [reply({ status: 'IDLE' })], abortTransaction: [reply({ statusCode: 0 })] });
    const r = await resolveAttempt({ vuid: 'v', amountAgorot: 100, terminalTip: false }, t.call, async (ms) => void slept.push(ms));
    expect(r).toMatchObject({ kind: 'not_charged', outcome: 'not_found' });
    expect(t.sent.filter((m) => m === 'abortTransaction')).toHaveLength(1);
    expect(t.sent.indexOf('abortTransaction')).toBeGreaterThan(t.sent.indexOf('getTransactionByVuid'));
    expect(slept).toEqual([2_000, 4_000]); // first "not found" at 0, believed at 6 s
    expect(t.sent).not.toContain('doTransaction');
  });

  it('a busy terminal never confirms "not found": unknown, held for a person', async () => {
    const t = terminal({ getTransactionByVuid: [reply({ statusCode: -61 })], getInternalStatus: [reply({ status: 'BUSY' })] });
    const r = await resolveAttempt({ vuid: 'v', amountAgorot: 100, terminalTip: false }, t.call, noSleep);
    expect(r.kind).toBe('unknown');
    expect(t.sent.filter((m) => m === 'getTransactionByVuid')).toHaveLength(LOOKUP_BACKOFF_MS.length + 1);
  });

  it('a terminal that does not answer: unknown after 4 lookups, never a sale', async () => {
    const t = terminal({});
    const r = await resolveAttempt({ vuid: 'v', amountAgorot: 100, terminalTip: false }, t.call, noSleep);
    expect(r.kind).toBe('unknown');
    expect(t.sent.filter((m) => m === 'getTransactionByVuid')).toHaveLength(4);
    expect(t.sent).not.toContain('doTransaction');
  });

  it('a decline found by the lookup → not charged', async () => {
    const t = terminal({ getTransactionByVuid: [reply({ statusCode: 33 })] });
    expect((await resolveAttempt({ vuid: 'v', amountAgorot: 100, terminalTip: false }, t.call, noSleep)).kind).toBe('not_charged');
  });
});

describe('the rules around a charge', () => {
  it('an unresolved attempt blocks every card; a person’s or a superseded one does not', () => {
    expect(blocksCard({ state: 'sent', supersededBy: null })).toBe(true);
    expect(blocksCard({ state: 'unknown', supersededBy: null })).toBe(true);
    expect(blocksCard({ state: 'needs_person', supersededBy: null })).toBe(false);
    expect(blocksCard({ state: 'unknown', supersededBy: 'x' })).toBe(false);
    expect(cardBlocked([{ state: 'unknown', supersededBy: null }])).toBe(true);
    expect(maySendSale({ frameInFlight: false, attempts: [{ state: 'unknown', supersededBy: null }], amountAgorot: 100 })).toEqual({ ok: false, reason: 'unresolved' });
    expect(maySendSale({ frameInFlight: true, attempts: [], amountAgorot: 100 })).toEqual({ ok: false, reason: 'in_flight' });
    expect(maySendSale({ frameInFlight: false, attempts: [], amountAgorot: 0 })).toEqual({ ok: false, reason: 'amount' });
  });

  it('the first answer: approved completes, declined voids, anything else is resolved by vuid', () => {
    expect(firstAnswerAction('APPROVED')).toBe('complete');
    expect(firstAnswerAction('DECLINED')).toBe('void');
    expect(firstAnswerAction('UNKNOWN')).toBe('resolve');
  });

  it('cancel: nothing before the frame; abort-and-wait after it; never once answered', () => {
    expect(cancelAction({ sent: false, answered: false })).toBe('drop');
    expect(cancelAction({ sent: true, answered: false })).toBe('abort_and_wait');
    expect(cancelAction({ sent: true, answered: true })).toBe('none');
  });
});

/** A provider whose sale and lookup answers are scripted; records what it was asked. */
function provider(sale: SaleResult | (() => Promise<SaleResult>), resolution: Resolution = { kind: 'unknown', message: 'x' }) {
  const asked: string[] = [];
  let seq = 0;
  const p: PaymentProvider = {
    kind: 'nayax_lan',
    describe: () => ({ kind: 'nayax_lan', address: 'https://10.0.0.5:8080/SPICy' }),
    newReference: () => `ref${++seq}`,
    check: async () => ({ ok: true, detail: null }),
    sale: async () => {
      asked.push('sale');
      return typeof sale === 'function' ? sale() : sale;
    },
    resolve: async () => {
      asked.push('resolve');
      return resolution;
    },
    abort: async () => void asked.push('abort'),
  };
  return { p, asked };
}

function payService(p: PaymentProvider) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-pay-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  const svc = new PayService(db);
  svc.setProvider(p, 'nayax_lan');
  return { db, svc };
}

const card = { brand: 'visa' as const, last4: '1234', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: 100, meta: { vuid: 'ref1' } };

describe('PayService (whatever the terminal)', () => {
  it('writes the attempt to disk BEFORE the frame leaves', async () => {
    let seenOnDisk = 0;
    const holder: { svc: PayService | null } = { svc: null };
    const { p } = provider(async () => {
      seenOnDisk = holder.svc!.attempts().length;
      return { answer: 'APPROVED', card, raw: '' };
    });
    const { svc } = payService(p);
    holder.svc = svc;
    const r = await svc.charge({ transactionId: 'd1', orderId: 'o1', amountAgorot: 100, tipAgorot: 0 });
    expect(r.kind).toBe('approved');
    expect(seenOnDisk).toBe(1);
  });

  it('an unknown answer is resolved by the same reference — never a second sale', async () => {
    const { p, asked } = provider({ answer: 'UNKNOWN', message: 'timeout', raw: null }, { kind: 'approved', card });
    const { svc } = payService(p);
    const r = await svc.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 });
    expect(r).toMatchObject({ kind: 'approved', recovered: true });
    expect(asked).toEqual(['sale', 'resolve']);
  });

  it('still unknown → held: the attempt stays on disk and every next card is refused before anything is sent', async () => {
    const { p, asked } = provider({ answer: 'UNKNOWN', message: 'timeout', raw: null });
    const { svc } = payService(p);
    expect((await svc.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 })).kind).toBe('unknown');
    expect(svc.blocked()).toBe(true);
    expect(svc.attempts()[0]).toMatchObject({ transactionId: 'd1', state: 'unknown' });
    expect(await svc.charge({ transactionId: 'd2', orderId: null, amountAgorot: 100, tipAgorot: 0 })).toEqual({ kind: 'refused', reason: 'unresolved' });
    expect(asked.filter((a) => a === 'sale')).toHaveLength(1);
  });

  it('a manager’s "not approved" voids and releases the kiosk', async () => {
    const { p } = provider({ answer: 'UNKNOWN', message: 'timeout', raw: null });
    const { svc } = payService(p);
    await svc.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 });
    const voided: string[] = [];
    expect(svc.markNotApproved('ref1', { id: 'u', name: 'מנהל' }, (a, meta) => voided.push(`${a.transactionId}:${String(meta.outcome)}`))).toBe(true);
    expect(voided).toEqual(['d1:marked_not_approved']);
    expect(svc.blocked()).toBe(false);
  });

  it('no usable terminal: refused before anything is written', async () => {
    const { p } = provider({ answer: 'APPROVED', card, raw: '' });
    const { svc } = payService(p);
    svc.setProvider(null, 'nayax_lan');
    expect(await svc.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 })).toEqual({ kind: 'refused', reason: 'terminal' });
    expect(svc.attempts()).toHaveLength(0);
  });

  it('after a restart, an orphan attempt is settled by vuid first (approved → completed)', async () => {
    const { p } = provider({ answer: 'UNKNOWN', message: 'x', raw: null }, { kind: 'unknown', message: 'x' });
    const { svc, db } = payService(p);
    await svc.charge({ transactionId: 'd1', orderId: null, amountAgorot: 100, tipAgorot: 0 });
    // The process "restarts": a new service on the same database, the terminal now knows.
    const later = new PayService(db);
    const { p: p2 } = provider({ answer: 'DECLINED', message: 'x', raw: null, statusCode: 33 }, { kind: 'approved', card });
    later.setProvider(p2, 'nayax_lan');
    const completed: string[] = [];
    const r = await later.resolveOrphans({ isPending: () => true, complete: (a) => completed.push(a.transactionId), void: () => undefined });
    expect(r).toEqual({ settled: 1, unknown: 0 });
    expect(completed).toEqual(['d1']);
    expect(later.blocked()).toBe(false);
  });
});
