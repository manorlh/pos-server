import { describe, expect, it } from 'vitest';
import type { CallFn } from '../src/core/cardRecovery';
import {
  ACK_SETTLE_MARGIN_MS,
  ackAccepted,
  ackFrame,
  ackRequestedBy,
  acknowledgeApproval,
  TERMINAL_ACK_WINDOW_MS,
} from '../src/core/terminalAck';
import { NayaxLanProvider } from '../src/main/payment/nayaxProvider';
import type { ProviderContext } from '../src/main/payment/provider';

/**
 * "ackTransaction" on the Windows/Web kiosk (core/terminalAck.ts), as on Android (TerminalAck.kt):
 * an approval the terminal wants acknowledged is acknowledged at once; not taken, the ten seconds
 * are waited out and the sale is asked about by its vuid — approved completes, cancelled is not
 * charged. A fake terminal only: nothing reaches a real one.
 */

const reply = (result: Record<string, unknown>) => JSON.stringify({ jsonrpc: '2.0', id: '1', result });

/** The kiosk's C4 (Agamento 01.06.82) with ackTransaction on, scripted. */
class Terminal {
  calls: Array<{ method: string; vuid: string | null }> = [];
  /** What the acknowledgement gets: taken (0), refused (-1) or no answer. */
  ack: 'taken' | 'refused' | 'silent' = 'taken';
  /** What a lookup after the window finds: the sale kept, or cancelled by the terminal. */
  afterWindow: 'approved' | 'cancelled' = 'approved';
  approvedFlag = true;

  call: CallFn = async (frame) => {
    const o = JSON.parse(frame) as { method: string; params: unknown[] };
    const p = (o.params[1] ?? {}) as Record<string, unknown>;
    const vuid = typeof p.vuid === 'string' ? p.vuid : null;
    this.calls.push({ method: o.method, vuid });
    switch (o.method) {
      case 'doTransaction':
        return { ok: true, body: reply({ statusCode: 0, statusMessage: 'TRANSACTION APPROVED', vuid, amount: p.amount, uid: '26100722480918077706568', ...(this.approvedFlag ? { ackTransaction: true } : {}) }) };
      case 'ackTransaction':
        if (this.ack === 'silent') return { ok: false, error: 'timeout' };
        return { ok: true, body: reply({ statusCode: this.ack === 'taken' ? 0 : -1 }) };
      case 'getTransactionByVuid':
        return this.afterWindow === 'approved'
          ? { ok: true, body: reply({ statusCode: 0, vuid, amount: 100, uid: 'u-1', transactionId: 'acq-1' }) }
          : { ok: true, body: reply({ statusCode: 998, statusMessage: 'CANCELLED', vuid }) };
      case 'getInternalStatus':
        return { ok: true, body: reply({ status: 'IDLE' }) };
      default:
        return { ok: true, body: reply({ statusCode: -1 }) };
    }
  };

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
}

const slept: number[] = [];
const sleep = async (ms: number) => {
  slept.push(ms);
};

describe('the flag and the answer', () => {
  it('is read off the reply in every shape it may come in', () => {
    expect(ackRequestedBy({ ackTransaction: true })).toBe(true);
    expect(ackRequestedBy({ ackTransaction: 'true' })).toBe(true);
    expect(ackRequestedBy({ ackTransaction: 1 })).toBe(true);
    expect(ackRequestedBy({ ackTransaction: false })).toBe(false);
    expect(ackRequestedBy({})).toBe(false);
    expect(ackRequestedBy(null)).toBe(false);
  });

  it('is Agamento’s own method, with the sale’s vuid', () => {
    expect(JSON.parse(ackFrame('v1'))).toEqual({ jsonrpc: '2.0', method: 'ackTransaction', params: ['ashrait', { vuid: 'v1' }], id: '1' });
  });

  it('is taken only on statusCode 0', () => {
    expect(ackAccepted(reply({ statusCode: 0 }))).toBe(true);
    expect(ackAccepted(reply({ statusCode: -1 }))).toBe(false);
    expect(ackAccepted(JSON.stringify({ jsonrpc: '2.0', error: { code: -1 } }))).toBe(false);
    expect(ackAccepted('garbage')).toBe(false);
    expect(ackAccepted(null)).toBe(false);
  });
});

describe('acknowledgeApproval', () => {
  it('no flag: nothing is sent, the approval stands', async () => {
    const t = new Terminal();
    expect(await acknowledgeApproval({ vuid: 'v1', amountAgorot: 100, result: { statusCode: 0 } }, t.call, sleep)).toEqual({ kind: 'final' });
    expect(t.calls).toEqual([]);
  });

  it('taken: final at once, no lookup', async () => {
    const t = new Terminal();
    expect(await acknowledgeApproval({ vuid: 'v1', amountAgorot: 100, result: { ackTransaction: true } }, t.call, sleep)).toEqual({ kind: 'final' });
    expect(t.calls.map((c) => c.method)).toEqual(['ackTransaction']);
  });

  it('not taken: the ten seconds waited out, then the vuid asked — approved is final', async () => {
    const t = new Terminal();
    t.ack = 'refused';
    slept.length = 0;
    const out = await acknowledgeApproval({ vuid: 'v1', amountAgorot: 100, result: { ackTransaction: true } }, t.call, sleep);
    expect(out.kind).toBe('approved');
    expect(slept[0]).toBe(TERMINAL_ACK_WINDOW_MS + ACK_SETTLE_MARGIN_MS);
    expect(t.calls.map((c) => c.method)).toEqual(['ackTransaction', 'getTransactionByVuid']);
    expect(t.calls.every((c) => c.vuid === 'v1')).toBe(true);
  });

  it('no answer to it, and the terminal cancelled the sale: not charged', async () => {
    const t = new Terminal();
    t.ack = 'silent';
    t.afterWindow = 'cancelled';
    const out = await acknowledgeApproval({ vuid: 'v1', amountAgorot: 100, result: { ackTransaction: true } }, t.call, sleep);
    expect(out.kind).toBe('not_charged');
    expect(t.count('doTransaction')).toBe(0);
  });
});

describe('the Nayax provider', () => {
  const values = new Map<string, string>();
  const ctx = {
    machineId: 'm-1',
    nextSequence: () => 20,
    getValue: (k: string) => values.get(k) ?? null,
    setValue: (k: string, v: string) => {
      values.set(k, v);
    },
    parameter: (k: string) => (k === 'pinpadAllowHttp' ? 'true' : null),
  } as unknown as ProviderContext;

  function provider(t: Terminal) {
    const p = new NayaxLanProvider({ host: '192.168.0.167', port: 8080, path: '/SPICy', tls: false }, ctx, sleep);
    // The transport: the scripted terminal instead of the pinpad's HTTP (nothing leaves the test).
    (p as unknown as { call: CallFn }).call = t.call;
    return p;
  }

  it('acknowledges an approval before it answers, and the sale completes', async () => {
    const t = new Terminal();
    let answered = false;
    const r = await provider(t).sale({ amountAgorot: 100, reference: 'v20', payments: 1, onAnswered: () => (answered = true) });
    expect(r.answer).toBe('APPROVED');
    expect(answered).toBe(true);
    expect(t.calls.map((c) => c.method)).toEqual(['doTransaction', 'ackTransaction']);
  });

  it('an acknowledgement not taken and a sale the terminal cancelled is declined, never charged again', async () => {
    const t = new Terminal();
    t.ack = 'refused';
    t.afterWindow = 'cancelled';
    const r = await provider(t).sale({ amountAgorot: 100, reference: 'v21', payments: 1 });
    expect(r.answer).toBe('DECLINED');
    expect(t.count('doTransaction')).toBe(1);
  });

  it('an acknowledgement not taken and a lookup that says approved completes, recovered', async () => {
    const t = new Terminal();
    t.ack = 'silent';
    const r = await provider(t).sale({ amountAgorot: 100, reference: 'v22', payments: 1 });
    expect(r.answer).toBe('APPROVED');
    if (r.answer === 'APPROVED') expect(r.card.meta.recoveredByLookup).toBe(true);
  });
});
