/**
 * A CashMag server in the test process (P:/specs/cashmag-windows.md §3): the WebSocket JSON-RPC as the protocol
 * notes describe it (P:/vendor/cashmag/windows-js-protocol-notes.md) — written here from the notes, none of the
 * vendor's code. The handshake with its session id, calls answered by job id, server signals, the busy close
 * ("Service occupé !"), the invalid-session refusal; each test scripts the payment.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { acceptKey, decodeFrames, encodeFrame } from '../../src/main/bridge/ws';

export interface ReceivedCall {
  conn: number;
  sessionId: string;
  fn: string;
  jobId: string;
  params: Record<string, unknown> | undefined;
}

export interface FakeConn {
  id: number;
  sessionId: string | null;
  send(obj: unknown): void;
  /** A server call (a signal): `API.crCashRecycler.<name>`. */
  signal(name: string, params: Record<string, unknown>): void;
  result(jobId: string, fn: string, status: number, result?: Record<string, unknown> | null, message?: string): void;
  close(code: number, reason: string): void;
  /** The TCP connection gone, no close frame (a cable pulled). */
  kill(): void;
  readonly open: boolean;
}

export type Handler = (call: ReceivedCall, conn: FakeConn) => void | Promise<void>;

export interface FakeServerOptions {
  /** Every new connection is closed at once as busy ("Service occupé !") while this says so. */
  busy?: () => boolean;
  /** The session ids this server still knows; a HELLO with another (non-empty) one gets ERROR (invalid session). */
  rejectUnknownSessions?: boolean;
  /** Function name → its handler (default: answered ok, no result). */
  handlers?: Record<string, Handler>;
  /** Sent right after WELCOME (e.g. the claim signal). */
  onWelcome?: (conn: FakeConn) => void;
}

export const BUSY_REASON = 'Service occupé !';
export const FN = {
  user: 'API.setUserName_a934b56a',
  start: 'API.crCashRecycler.start',
  pay: 'API.crCashRecycler.payTransaction_7f2a80d0',
  valid: 'API.crCashRecycler.dialogValid',
  cancel: 'API.crCashRecycler.dialogCancel',
} as const;

export class FakeCashMagServer {
  readonly calls: ReceivedCall[] = [];
  readonly steps: Array<{ conn: number; step: string; sessionId: string }> = [];
  readonly sessions = new Set<string>();
  readonly conns: FakeConn[] = [];
  connections = 0;
  closesSent = 0;
  private server: http.Server;
  private sockets = new Set<Duplex>();

  constructor(private readonly o: FakeServerOptions = {}) {
    this.server = http.createServer((_req, res) => {
      res.writeHead(426);
      res.end();
    });
    this.server.on('upgrade', (req, socket) => this.upgrade(req, socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    return (this.server.address() as AddressInfo).port;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  setHandler(fn: string, h: Handler) {
    (this.o.handlers ??= {})[fn] = h;
  }

  /** The last connection still open. */
  live(): FakeConn | null {
    return [...this.conns].reverse().find((c) => c.open) ?? null;
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex) {
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') return socket.destroy();
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
    const id = ++this.connections;
    let open = true;
    const write = (b: Buffer) => {
      if (open) socket.write(b);
    };
    const conn: FakeConn = {
      id,
      sessionId: null,
      send: (obj) => write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj), 'utf8'))),
      signal: (name, params) => conn.send({ cm_ws_rpc_call: { session_id: conn.sessionId ?? '', function: `API.crCashRecycler.${name}`, job_id: randomUUID(), params } }),
      result: (jobId, fn, status, result = null, message = '') =>
        conn.send({ cm_ws_rpc_result: { job_id: jobId, function: fn, status: { ii_status: status, ilst_warnings: [], is_message: message }, result: result ?? {} } }),
      close: (code, reason) => {
        const r = Buffer.from(reason, 'utf8');
        const body = Buffer.alloc(2 + r.length);
        body.writeUInt16BE(code, 0);
        r.copy(body, 2);
        this.closesSent++;
        write(encodeFrame(0x8, body));
        open = false;
        setTimeout(() => socket.end(), 20);
      },
      kill: () => {
        open = false;
        socket.destroy();
      },
      get open() {
        return open;
      },
    };
    this.conns.push(conn);
    socket.on('close', () => (open = false));
    if (this.o.busy?.()) {
      conn.close(1000, BUSY_REASON);
      return;
    }
    let buf: Buffer = Buffer.alloc(0);
    socket.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const r = decodeFrames(buf);
      buf = r.rest;
      for (const f of r.frames) {
        if (f.opcode === 0x8) {
          if (open) {
            write(encodeFrame(0x8, f.payload.subarray(0, 2)));
            open = false;
            socket.end();
          }
          return;
        }
        if (f.opcode === 0x9) write(encodeFrame(0xa, f.payload));
        if (f.opcode === 0x1) void this.onText(conn, f.payload.toString('utf8'));
      }
    });
  }

  private async onText(conn: FakeConn, text: string) {
    const msg = JSON.parse(text) as { cm_ws_rpc_call?: { session_id: string; function: string; job_id: string; params?: Record<string, unknown> } };
    const c = msg.cm_ws_rpc_call;
    if (!c) return;
    const step = (fn: string, extra: Record<string, unknown> = {}) =>
      conn.send({ cm_ws_rpc_call: { session_id: conn.sessionId ?? '', function: fn, job_id: randomUUID(), ...extra } });
    if (c.function === 'HELLO') {
      this.steps.push({ conn: conn.id, step: 'HELLO', sessionId: c.session_id });
      if (this.o.rejectUnknownSessions && c.session_id && !this.sessions.has(c.session_id)) {
        step('ERROR', { params: { status: { ii_status: -100000001, ilst_warnings: [], is_message: 'Invalid session' } } });
        return;
      }
      conn.sessionId = c.session_id || null;
      step('WHOAREYOU');
      return;
    }
    if (c.function === 'IAM') {
      this.steps.push({ conn: conn.id, step: 'IAM', sessionId: c.session_id });
      const id = conn.sessionId ?? `sess-${randomUUID().slice(0, 8)}`;
      conn.sessionId = id;
      this.sessions.add(id);
      conn.send({ cm_ws_rpc_call: { session_id: id, function: 'WELCOME', job_id: randomUUID() } });
      this.o.onWelcome?.(conn);
      return;
    }
    if (c.function === 'GOODBYE') {
      this.steps.push({ conn: conn.id, step: 'GOODBYE', sessionId: c.session_id });
      return;
    }
    const call: ReceivedCall = { conn: conn.id, sessionId: c.session_id, fn: c.function, jobId: c.job_id, params: c.params };
    this.calls.push(call);
    if (this.o.rejectUnknownSessions && !this.sessions.has(c.session_id)) {
      conn.result(c.job_id, c.function, -100000001, null, 'Invalid session');
      return;
    }
    const h = this.o.handlers?.[c.function];
    if (h) await h(call, conn);
    else conn.result(c.job_id, c.function, 0);
  }
}

/** A pay answer's body: the lists as the server sends them (values as text, as the docs warn). */
export function payResult(o: { balance: string | number; deposits?: Array<[string | number, number, number?]>; dispensed?: Array<[string | number, number, number?]>; currency?: string }): Record<string, unknown> {
  const item = ([v, q, t]: [string | number, number, number?]) => ({ idc_value: v, ib_manual: true, ii_qty: q, ie_fund_type: t ?? 3, is_currency: o.currency ?? 'ILS', is_data: '' });
  return {
    adc_transaction_amount_balance: o.balance,
    alst_transaction_deposits: (o.deposits ?? []).map(item),
    alst_transaction_dispensed: (o.dispensed ?? []).map(item),
    is_currency: o.currency ?? 'ILS',
  };
}
