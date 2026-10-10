/**
 * The Nayax C4 on the kiosk's USB ("nayax_usb", src/main/payment/nayaxUsb.ts): TweezerComm frames
 * on the serial line, each request under its own id, no retries, and the LAN's money rules
 * (acknowledgement, lookup by vuid) unchanged. A fake C4 on a fake COM port only: nothing reaches
 * a real terminal, and `serialport` is never loaded.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { abortFrame, saleFrame, statusFrame } from '../src/core/nayax';
import { SPI } from '../src/core/tcSerialFraming';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { nayaxLanFactory } from '../src/main/payment/nayaxProvider';
import { idOf, NayaxUsbProvider, nayaxUsbFactory, withId } from '../src/main/payment/nayaxUsb';
import { PayService } from '../src/main/payment/payService';
import type { PaymentProvider, ProviderContext } from '../src/main/payment/provider';
import { PROVIDERS } from '../src/main/payment/registry';
import { loadSerialport, serialChannel, type LinkChannel } from '../src/main/payment/synqpay/transport';

const tick = () => new Promise<void>((r) => setImmediate(r));

/** A C4 (Agamento, ackTransaction on) on a COM port, scripted; it answers each frame under the id it came with. */
class FakeC4 {
  opens = 0;
  closed = false;
  missing = false;
  written: Array<{ method: string; id: string; vuid: string | null }> = [];
  /** Methods answered only when released. */
  hold = new Set<string>();
  held: Array<() => void> = [];
  /** Methods never answered. */
  silent = new Set<string>();
  /** The cable is pulled when this method arrives. */
  pullOn: string | null = null;
  private dataCb: ((b: Buffer) => void) | null = null;
  private closeCb: ((why: string) => void) | null = null;

  open = async (): Promise<LinkChannel> => {
    if (this.missing) throw new Error('לא נמצא מסוף USB סריאלי יחיד');
    this.opens++;
    this.closed = false;
    const decoder = SPI.decoder();
    return {
      write: (bytes) => {
        for (const r of decoder.feed(bytes)) if (r.kind === 'frame') this.receive(r.text);
      },
      close: () => {
        this.closed = true;
      },
      onData: (cb) => {
        this.dataCb = cb;
      },
      onClose: (cb) => {
        this.closeCb = cb;
      },
    };
  };

  pull() {
    this.closed = true;
    this.closeCb?.('serial port closed');
  }

  count(method: string) {
    return this.written.filter((w) => w.method === method).length;
  }

  /** Framed, in 64-byte packets, later (as the C4's bulk endpoint delivers them). */
  private send(json: string) {
    const f = SPI.frame(json);
    setImmediate(() => {
      for (let i = 0; i < f.length; i += 64) this.dataCb?.(f.subarray(i, i + 64));
    });
  }

  private receive(text: string) {
    const o = JSON.parse(text) as { method: string; id: unknown; params: unknown[] };
    const p = (o.params?.[1] ?? {}) as Record<string, unknown>;
    const vuid = typeof p.vuid === 'string' ? p.vuid : null;
    this.written.push({ method: o.method, id: String(o.id), vuid });
    if (this.pullOn === o.method) {
      setImmediate(() => this.pull());
      return;
    }
    if (this.silent.has(o.method)) return;
    const answer = () => this.send(JSON.stringify({ jsonrpc: '2.0', id: o.id, result: this.result(o.method, p, vuid) }));
    if (this.hold.has(o.method)) this.held.push(answer);
    else answer();
  }

  private result(method: string, p: Record<string, unknown>, vuid: string | null): Record<string, unknown> {
    switch (method) {
      case 'doTransaction':
        return { statusCode: 0, statusMessage: 'TRANSACTION APPROVED', vuid, amount: p.amount, uid: '26100722480918077706568', ackTransaction: true };
      case 'ackTransaction':
        return { statusCode: 0 };
      case 'abortTransaction':
        return { statusCode: 0, statusMessage: 'aborted' };
      case 'getTransactionByVuid':
        return { statusCode: 0, vuid, amount: 100, uid: 'u-1', transactionId: 'acq-1' };
      case 'getRetailerInfo':
        return { statusCode: 0, retailerName: 'TEST', terminalNumber: '0880000' };
      default:
        return { statusCode: 0, status: 'IDLE' };
    }
  }
}

const values = new Map<string, string>();
const ctx = {
  machineId: 'm-1',
  nextSequence: () => 20,
  getValue: (k: string) => values.get(k) ?? null,
  setValue: (k: string, v: string) => {
    values.set(k, v);
  },
  parameter: () => null,
  log: () => undefined,
} as unknown as ProviderContext;

const noSleep = async () => undefined;
const usb = (c4: FakeC4, device: string | null = null) => new NayaxUsbProvider(device, ctx, { open: c4.open, sleep: noSleep });

describe('the C4 on USB: the link', () => {
  it('each request under its own id, the reply as the terminal wrote it', async () => {
    const c4 = new FakeC4();
    const p = usb(c4);
    const a = await p.link.call(statusFrame(), 1_000);
    const b = await p.link.call(statusFrame(), 1_000);
    expect(a.ok && b.ok).toBe(true);
    expect(c4.written.map((w) => w.id)).toEqual(['u1', 'u2']);
    if (a.ok) expect(idOf(a.body)).toBe('u1');
    expect(p.link.lastRaw).toContain('"id":"u2"');
    expect(c4.opens).toBe(1);
  });

  it('an abort while the sale waits is its own request, and each gets its own answer', async () => {
    const c4 = new FakeC4();
    const p = usb(c4);
    c4.hold.add('doTransaction');
    const sale = p.link.call(saleFrame(100, 'v1'), 5_000);
    while (c4.count('doTransaction') === 0) await tick();
    const abort = await p.link.call(abortFrame('v1'), 1_000);
    expect(abort.ok && JSON.parse(abort.body).result.statusMessage).toBe('aborted');
    for (const release of c4.held) release();
    const s = await sale;
    expect(s.ok && JSON.parse(s.body).result.statusMessage).toBe('TRANSACTION APPROVED');
    expect(new Set(c4.written.map((w) => w.id)).size).toBe(2);
  });

  it('no answer: written once, never again, and the next call opens a clean link', async () => {
    const c4 = new FakeC4();
    const p = usb(c4);
    c4.silent.add('getStatus');
    const r = await p.link.call(statusFrame(), 30);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('timeout');
    expect(c4.count('getStatus')).toBe(1);
    expect(c4.closed).toBe(true);
    c4.silent.clear();
    expect((await p.link.call(statusFrame(), 1_000)).ok).toBe(true);
    expect(c4.opens).toBe(2);
  });

  it('the cable pulled while a frame waits: no answer, said', async () => {
    const c4 = new FakeC4();
    const p = usb(c4);
    c4.hold.add('getStatus');
    const waiting = p.link.call(statusFrame(), 5_000);
    while (c4.count('getStatus') === 0) await tick();
    c4.pull();
    const r = await waiting;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('the USB link closed');
  });

  it('no C4 on the cable: nothing sent', async () => {
    const c4 = new FakeC4();
    c4.missing = true;
    const r = await usb(c4).check();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('אין חיבור למסוף (USB)');
    expect(c4.written).toEqual([]);
  });

  it('the id is set on the frame and read off the reply', () => {
    expect(JSON.parse(withId(statusFrame(), 'u9')!).id).toBe('u9');
    expect(JSON.parse(withId(statusFrame(), 'u9')!).method).toBe('getStatus');
    expect(withId('not json', 'u1')).toBeNull();
    expect(idOf('{"id":"u3","result":{}}')).toBe('u3');
    expect(idOf('{"result":{}}')).toBeNull();
  });
});

describe('the C4 on USB: the money rules are the LAN\'s', () => {
  it('a sale approved and acknowledged on the cable', async () => {
    const c4 = new FakeC4();
    let answered = false;
    const r = await usb(c4).sale({ amountAgorot: 100, reference: 'v20', payments: 1, onAnswered: () => (answered = true) });
    expect(r.answer).toBe('APPROVED');
    expect(answered).toBe(true);
    expect(c4.written.map((w) => w.method)).toEqual(['doTransaction', 'ackTransaction']);
    if (r.answer === 'APPROVED') expect(r.card.uid).toBe('26100722480918077706568');
  });

  it('a sale whose answer is lost is unknown, then settled by its vuid, never sent again', async () => {
    const c4 = new FakeC4();
    const p = usb(c4);
    c4.pullOn = 'doTransaction';
    const r = await p.sale({ amountAgorot: 100, reference: 'v21', payments: 1 });
    expect(r.answer).toBe('UNKNOWN');
    c4.pullOn = null;
    const settled = await p.resolve({ reference: 'v21', amountAgorot: 100, terminalTip: false });
    expect(settled.kind).toBe('approved');
    if (settled.kind === 'approved') expect(settled.card.meta.recoveredByLookup).toBe(true);
    expect(c4.count('doTransaction')).toBe(1);
    expect(c4.count('getTransactionByVuid')).toBe(1);
    expect(c4.opens).toBe(2);
  });

  it('"בדיקת מסופון USB": getStatus and getRetailerInfo only, the raw replies and the framing', async () => {
    const c4 = new FakeC4();
    const c = await usb(c4).diagnose(1_000);
    expect(c.answered).toBe(true);
    expect(c.replies.map((x) => x.method)).toEqual(['getStatus', 'getRetailerInfo']);
    expect(c.replies[1].raw).toContain('"retailerName":"TEST"');
    expect(c.framing).toContain('CRC poly A001 init 0000 over LEN+payload, high first');
    expect(c4.written.map((w) => w.method)).toEqual(['getStatus', 'getRetailerInfo']);

    const quiet = new FakeC4();
    quiet.silent.add('getStatus');
    const q = await usb(quiet).diagnose(30);
    expect(q.answered).toBe(false);
    expect(q.replies.map((x) => x.method)).toEqual(['getStatus']);
    expect(quiet.written.map((w) => w.method)).toEqual(['getStatus']);
  });
});

describe('the C4 on USB: chosen by the cloud settings', () => {
  it('nayax_usb is the USB provider (the C4 named or the only USB serial port), and never the LAN one', () => {
    const p = nayaxUsbFactory({ paymentIntegration: 'nayax_usb', nayaxUsbDevice: '0b00:0080' }, ctx);
    expect(p).toBeInstanceOf(NayaxUsbProvider);
    expect(p?.describe()).toEqual({ kind: 'nayax_usb', address: 'USB 0B00:0080' });
    expect(nayaxUsbFactory({ paymentIntegration: 'nayax_usb' }, ctx)?.describe()).toEqual({ kind: 'nayax_usb', address: 'USB' });
    expect(nayaxUsbFactory({ paymentIntegration: 'nayax_lan' }, ctx)).toBeNull();
    expect(nayaxUsbFactory({}, ctx)).toBeNull();
    expect(nayaxLanFactory({ paymentIntegration: 'nayax_usb', nayaxDeviceHost: '192.168.0.5' }, ctx)).toBeNull();
    let first: PaymentProvider | null = null;
    for (const f of PROVIDERS) if ((first = f({ paymentIntegration: 'nayax_usb', nayaxDeviceHost: '192.168.0.5' }, ctx))) break;
    expect(first).toBeInstanceOf(NayaxUsbProvider);
  });

  it('replaced by another terminal, the COM port is let go', async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), 'kd-usb-')), 'k.db'));
    migrate(db);
    const svc = new PayService(db);
    const c4 = new FakeC4();
    const p = usb(c4);
    svc.setProvider(p, 'nayax_usb');
    expect((await p.check()).ok).toBe(true);
    expect(c4.closed).toBe(false);
    svc.setProvider(usb(new FakeC4(), '1234:5678'), 'nayax_usb');
    expect(c4.closed).toBe(true);
  });
});

/* ------------------------------------------------- a link that never opens */

type SerialLoader = NonNullable<Parameters<typeof serialChannel>[1]>;

/** A `serialport` package that lists [ports] and whose open fails with [openError] (null: it opens). */
const fakeSerialport =
  (ports: Array<{ path: string; vendorId?: string; productId?: string }>, openError: string | null): SerialLoader =>
  async () =>
    ({
      SerialPort: class {
        static list = async () => ports;
        open(cb: (err: Error | null) => void) {
          cb(openError ? new Error(openError) : null);
        }
        write() {}
        close() {}
        on() {}
      },
    }) as unknown as Awaited<ReturnType<SerialLoader>>;

/** The USB provider over the real serial channel, the `serialport` package as [load] has it; each frame it tries, by method. */
function overSerial(load: SerialLoader, device: string | null = null) {
  const tried: string[] = [];
  const pauses: number[] = [];
  const p = new NayaxUsbProvider(device, ctx, {
    open: () => serialChannel(device, load),
    sleep: async (ms) => {
      pauses.push(ms);
    },
  });
  const call = p.link.call;
  p.link.call = (frame, timeoutMs) => {
    tried.push((JSON.parse(frame) as { method: string }).method);
    return call(frame, timeoutMs);
  };
  return { p, tried, pauses };
}

const NO_PACKAGE = 'אין חיבור למסוף (USB): חבילת serialport אינה מותקנת בקיוסק — חיבור USB סריאלי אינו זמין';

describe('the C4 on USB: a link that never opens is "not sent", never "unknown"', () => {
  it('no serialport package: the sale is NOT_SENT with its reason — no abort, no lookup', async () => {
    const { p, tried, pauses } = overSerial(async () => null);
    const r = await p.sale({ amountAgorot: 100, reference: 'v30', payments: 1 });
    expect(r).toEqual({ answer: 'NOT_SENT', message: NO_PACKAGE });
    expect(tried).toEqual(['doTransaction']);
    expect(pauses).toEqual([]);
  });

  it('no such port, the port busy, or no C4 on the cable: NOT_SENT as well, nothing written', async () => {
    const none = await overSerial(fakeSerialport([], null)).p.sale({ amountAgorot: 100, reference: 'v31', payments: 1 });
    expect(none.answer).toBe('NOT_SENT');
    if (none.answer === 'NOT_SENT') expect(none.message).toContain('לא נמצא מסוף USB סריאלי יחיד');

    const busy = await overSerial(fakeSerialport([{ path: 'COM3', vendorId: '0b00', productId: '0080' }], 'Access denied'), 'COM3').p.sale({
      amountAgorot: 100,
      reference: 'v32',
      payments: 1,
    });
    expect(busy.answer).toBe('NOT_SENT');
    if (busy.answer === 'NOT_SENT') expect(busy.message).toContain('לא ניתן לפתוח את COM3: Access denied');

    const c4 = new FakeC4();
    c4.missing = true;
    expect((await usb(c4).sale({ amountAgorot: 100, reference: 'v33', payments: 1 })).answer).toBe('NOT_SENT');
    expect(c4.written).toEqual([]);
  });

  it("the kiosk's charge: voided with the reason, the attempt dropped — nothing to settle, no alert", async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), 'kd-usb-')), 'k.db'));
    migrate(db);
    const logs: string[] = [];
    const svc = new PayService(db, (m) => logs.push(m));
    svc.setLockOnUnresolved(() => true);
    const { p, tried, pauses } = overSerial(async () => null);
    svc.setProvider(p, 'nayax_usb');
    const out = await svc.charge({ transactionId: 't-30', orderId: 'o-30', amountAgorot: 100, tipAgorot: 0 });
    expect(out).toEqual({ kind: 'declined', message: NO_PACKAGE, voidMeta: null });
    expect(tried).toEqual(['doTransaction']);
    expect(pauses).toEqual([]);
    expect(svc.attempts()).toEqual([]);
    expect(svc.unresolved()).toBe(false);
    expect(svc.blocked()).toBe(false);
    expect(svc.cardInFlight).toBe(false);
    expect(logs.join('\n')).toContain('card: not sent');
  });

  it('written, then the reply lost: still unknown, and settled by its vuid', async () => {
    const db = openDb(path.join(mkdtempSync(path.join(os.tmpdir(), 'kd-usb-')), 'k.db'));
    migrate(db);
    const svc = new PayService(db);
    const c4 = new FakeC4();
    c4.pullOn = 'doTransaction';
    svc.setProvider(usb(c4), 'nayax_usb');
    const out = await svc.charge({ transactionId: 't-31', orderId: 'o-31', amountAgorot: 100, tipAgorot: 0 });
    expect(out.kind).toBe('approved');
    if (out.kind === 'approved') expect(out.recovered).toBe(true);
    expect(c4.count('doTransaction')).toBe(1);
    expect(c4.count('getTransactionByVuid')).toBe(1);
  });
});

describe('the serialport package (a dependency from 0.4.1)', () => {
  it('resolves for both USB links (nayax_usb and SynqPay USB load it through serialChannel) — no port opened', async () => {
    const mod = await loadSerialport();
    expect(mod).not.toBeNull();
    expect(typeof mod?.SerialPort).toBe('function');
    expect(typeof mod?.SerialPort.list).toBe('function');
  });
});
