/**
 * The CashMag WebSocket client (P:/specs/cashmag-windows.md §3) against an in-process fake server written from the
 * protocol notes (test/support/cashmagFakeServer.ts): the framing, the handshake and its session, job matching,
 * timeouts, the busy close (no reconnect loop), the reconnect with the payment out, the invalid session, signals.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { CASHMAG_FUNCTIONS, cashmagFunctionsOf, decodeMessage, encodeCall, isBusyClose, signalNameOf, statusName, statusOf } from '../src/core/cash/cashmagWire';
import { CashMagWsClient, memorySession, type CashMagSignal } from '../src/main/cash/cashmagClient';
import { BUSY_REASON, FakeCashMagServer, FN, type FakeConn, type FakeServerOptions } from './support/cashmagFakeServer';

const stoppers: Array<() => unknown> = [];
afterEach(async () => {
  for (const s of stoppers.splice(0).reverse()) await s();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async <T>(fn: () => T | null | undefined | false, ms = 5_000): Promise<T> => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await wait(10);
  }
};

async function server(o: FakeServerOptions = {}) {
  const s = new FakeCashMagServer(o);
  await s.listen();
  stoppers.push(() => s.close());
  return s;
}

function client(port: number, o: Partial<ConstructorParameters<typeof CashMagWsClient>[0]> = {}) {
  const c = new CashMagWsClient({ url: `ws://127.0.0.1:${port}`, connectTimeoutMs: 2_000, handshakeTimeoutMs: 2_000, reconnectBaseMs: 50, reconnectGraceMs: 2_000, ...o });
  stoppers.push(() => c.disconnect());
  return c;
}

describe('the wire', () => {
  it('the envelope: a call out, results / steps / signals in', () => {
    const out = JSON.parse(encodeCall({ sessionId: 's1', fn: FN.pay, jobId: 'j1', params: { adc_transaction_amount: 57.3, as_transaction_currency: 'ILS' } }));
    expect(out).toEqual({ cm_ws_rpc_call: { session_id: 's1', function: FN.pay, job_id: 'j1', params: { adc_transaction_amount: 57.3, as_transaction_currency: 'ILS' } } });
    // No params: none sent; no session yet: empty.
    expect(JSON.parse(encodeCall({ sessionId: null, fn: 'HELLO', jobId: 'j2' }))).toEqual({ cm_ws_rpc_call: { session_id: '', function: 'HELLO', job_id: 'j2' } });
    const r = decodeMessage(JSON.stringify({ cm_ws_rpc_result: { job_id: 'j1', function: FN.pay, status: { ii_status: 0, ilst_warnings: ['w'], is_message: '' }, result: { a: 1 } } }));
    expect(r).toMatchObject({ kind: 'result', jobId: 'j1', status: { code: 0, warnings: ['w'], message: null }, result: { a: 1 } });
    // A handshake step comes as a call or as a result.
    expect(decodeMessage(JSON.stringify({ cm_ws_rpc_call: { session_id: 'abc', function: 'WELCOME', job_id: 'x' } }))).toMatchObject({ kind: 'step', step: 'WELCOME', sessionId: 'abc' });
    expect(decodeMessage(JSON.stringify({ cm_ws_rpc_result: { function: 'WHOAREYOU', job_id: 'x' } }))).toMatchObject({ kind: 'step', step: 'WHOAREYOU' });
    expect(decodeMessage(JSON.stringify({ cm_ws_rpc_call: { function: 'ERROR', params: { status: { ii_status: -100000001 } } } }))).toMatchObject({ kind: 'step', step: 'ERROR', status: { code: -100000001 } });
    expect(decodeMessage(JSON.stringify({ cm_ws_rpc_call: { function: 'API.crCashRecycler.signalDeposits', params: { deposits: [] } } }))).toMatchObject({ kind: 'signal', name: 'signalDeposits' });
    expect(decodeMessage('nope')).toEqual({ kind: 'invalid', why: 'not json' });
    expect(decodeMessage('{"x":1}')).toEqual({ kind: 'invalid', why: 'no envelope' });
  });

  it('statuses, names, the busy reason, the function table', () => {
    expect(statusOf({ ii_status: '-100000001' }).code).toBe(-100000001);
    expect(statusOf(undefined).code).toBe(-1);
    expect(statusName(-100000001)).toBe('INVALID_SESSION');
    expect(statusName(-100000004)).toBe('FUNCTION_NOT_IMPLEMENTED');
    expect(statusName(12)).toBe('CM_STATUS_12');
    expect(signalNameOf('API.crCashRecycler.signalClaimStateChanged')).toBe('signalClaimStateChanged');
    expect(isBusyClose(BUSY_REASON)).toBe(true);
    expect(isBusyClose(' Service occupé ! ')).toBe(true);
    expect(isBusyClose('Service occupe\u0301 !')).toBe(true);
    expect(isBusyClose('bye')).toBe(false);
    expect(isBusyClose('Service occupé ! (another client)')).toBe(true);
    // One table; a kiosk may name a server's other hashes, a malformed name is ignored.
    expect(CASHMAG_FUNCTIONS.transferToCassette).toBe('API.crCashRecycler.transferFromRecyclerToCassette_d4697ee5');
    const f = cashmagFunctionsOf({ pay: 'API.crCashRecycler.payTransaction_deadbeef', start: 'bad name; drop', nope: 'x' });
    expect(f.pay).toBe('API.crCashRecycler.payTransaction_deadbeef');
    expect(f.start).toBe(CASHMAG_FUNCTIONS.start);
    expect('nope' in f).toBe(false);
  });
});

describe('the client against a fake CashMag server', () => {
  it('the handshake: HELLO → WHOAREYOU, IAM → WELCOME; the session id reused on every call and the next connection', async () => {
    const s = await server();
    const session = memorySession();
    const c = client(s.port, { session });
    const out = await c.connect();
    expect(out.kind).toBe('ready');
    const id = session.get();
    expect(id).toMatch(/^sess-/);
    expect(s.steps.map((x) => x.step)).toEqual(['HELLO', 'IAM']);
    expect(s.steps[0].sessionId).toBe('');
    const r = await c.call(FN.start);
    expect(r).toMatchObject({ kind: 'answer', status: { code: 0 } });
    expect(s.calls[0]).toMatchObject({ fn: FN.start, sessionId: id });
    await c.disconnect();
    await until(() => s.steps.some((x) => x.step === 'GOODBYE'));
    // A new connection says who it was.
    const c2 = client(s.port, { session });
    expect((await c2.connect()).kind).toBe('ready');
    expect(s.steps.filter((x) => x.step === 'HELLO')[1].sessionId).toBe(id);
    expect(session.get()).toBe(id);
  });

  it('answers matched by job id, in any order; an answer to no call ignored; a call with no answer times out', async () => {
    const held: Array<{ jobId: string; fn: string; conn: FakeConn }> = [];
    const s = await server({
      handlers: {
        'API.a': (call, conn) => void held.push({ jobId: call.jobId, fn: call.fn, conn }),
        'API.b': (call, conn) => void held.push({ jobId: call.jobId, fn: call.fn, conn }),
        'API.never': () => undefined,
      },
    });
    const c = client(s.port);
    await c.connect();
    const a = c.call('API.a', { n: 1 });
    const b = c.call('API.b', { n: 2 });
    await until(() => held.length === 2);
    s.live()!.result('not-a-job', 'API.x', 0, { stray: true });
    held[1].conn.result(held[1].jobId, 'API.b', 0, { who: 'b' });
    held[0].conn.result(held[0].jobId, 'API.a', 0, { who: 'a' });
    expect(await a).toMatchObject({ kind: 'answer', result: { who: 'a' } });
    expect(await b).toMatchObject({ kind: 'answer', result: { who: 'b' } });
    expect(await c.call('API.never', null, { timeoutMs: 100 })).toEqual({ kind: 'timeout' });
    // Still connected after all that.
    expect(c.state).toBe('ready');
  });

  it('busy ("Service occupé !") at connect: busy, and never reconnected by itself', async () => {
    const s = await server({ busy: () => true });
    const c = client(s.port);
    expect(await c.connect()).toEqual({ kind: 'busy' });
    await wait(400);
    expect(s.connections).toBe(1);
    expect(c.state).toBe('busy');
  });

  it('busy close with a call out: it ends disconnected (busy) — no reconnect loop', async () => {
    const s = await server({ handlers: { [FN.pay]: () => undefined } });
    const c = client(s.port);
    await c.connect();
    const pay = c.call(FN.pay, { adc_transaction_amount: 10, as_transaction_currency: 'ILS' }, { timeoutMs: null, keep: true });
    await until(() => s.calls.some((x) => x.fn === FN.pay));
    s.live()!.close(1000, BUSY_REASON);
    expect(await pay).toEqual({ kind: 'disconnected', busy: true });
    await wait(300);
    expect(s.connections).toBe(1);
  });

  it('a dropped connection with the payment out: back with the same session, the answer taken on the new one', async () => {
    let jobId = '';
    const s = await server({
      handlers: {
        [FN.pay]: (call) => {
          jobId = call.jobId;
        },
      },
    });
    const session = memorySession();
    const c = client(s.port, { session });
    await c.connect();
    const id = session.get();
    const pay = c.call(FN.pay, {}, { timeoutMs: null, keep: true });
    await until(() => jobId);
    s.live()!.kill();
    await until(() => s.connections === 2 && s.steps.filter((x) => x.step === 'IAM').length === 2);
    expect(s.steps.filter((x) => x.step === 'HELLO')[1].sessionId).toBe(id);
    s.live()!.result(jobId, FN.pay, 0, { adc_transaction_amount_balance: '0' });
    expect(await pay).toMatchObject({ kind: 'answer', status: { code: 0 } });
  });

  it('a dropped connection with no payment out: the calls end, nothing reconnects', async () => {
    const s = await server({ handlers: { 'API.slow': () => undefined } });
    const c = client(s.port);
    await c.connect();
    const r = c.call('API.slow', null, { timeoutMs: 5_000 });
    await until(() => s.calls.length === 1);
    s.live()!.kill();
    expect(await r).toEqual({ kind: 'disconnected', busy: false });
    await wait(300);
    expect(s.connections).toBe(1);
  });

  it('the payment out past the reconnect grace: disconnected (no telling), never a hang', async () => {
    const s = await server({ handlers: { [FN.pay]: () => undefined } });
    const c = client(s.port, { reconnectGraceMs: 300 });
    await c.connect();
    const pay = c.call(FN.pay, {}, { timeoutMs: null, keep: true });
    await until(() => s.calls.length === 1);
    await s.close();
    expect(await pay).toEqual({ kind: 'disconnected', busy: false });
  });

  it('a session the server forgot: ERROR (invalid session) → the handshake again with none → ready', async () => {
    const s = await server({ rejectUnknownSessions: true });
    const session = memorySession();
    session.set('stale-session');
    const c = client(s.port, { session });
    const out = await c.connect();
    expect(out.kind).toBe('ready');
    expect(s.steps.filter((x) => x.step === 'HELLO').map((x) => x.sessionId)).toEqual(['stale-session', '']);
    expect(session.get()).not.toBe('stale-session');
  });

  it('a call refused for its session: the handshake again, the call once more', async () => {
    let refused = 0;
    const s = await server({
      handlers: {
        [FN.start]: (call, conn) => {
          if (refused++ === 0) conn.result(call.jobId, call.fn, -100000001, null, 'Invalid session');
          else conn.result(call.jobId, call.fn, 0);
        },
      },
    });
    const c = client(s.port);
    await c.connect();
    const r = await c.call(FN.start);
    expect(r).toMatchObject({ kind: 'answer', status: { code: 0 } });
    expect(s.calls.filter((x) => x.fn === FN.start)).toHaveLength(2);
    expect(s.steps.filter((x) => x.step === 'HELLO')).toHaveLength(2);
  });

  it('the server’s signals are handed on (deposits, question, claim)', async () => {
    const s = await server();
    const c = client(s.port);
    const seen: CashMagSignal[] = [];
    c.onSignal((x) => seen.push(x));
    await c.connect();
    s.live()!.signal('signalDeposits', { deposits: [{ idc_value: '20', ii_qty: 1, ie_fund_type: 3, is_currency: 'ILS' }] });
    s.live()!.signal('signalQuestionNotification', { title: 'שאלה', text: 'להמשיך?' });
    s.live()!.signal('signalClaimStateChanged', { ie_claim_state: 3 });
    await until(() => seen.length === 3);
    expect(seen.map((x) => x.name)).toEqual(['signalDeposits', 'signalQuestionNotification', 'signalClaimStateChanged']);
  });

  it('nobody listening: unreachable, quickly', async () => {
    const s = await server();
    const port = s.port;
    await s.close();
    const c = client(port);
    expect((await c.connect()).kind).toBe('unreachable');
  });
});
