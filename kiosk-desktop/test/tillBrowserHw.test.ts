/**
 * S0-5: the browser's hardware ports over fakes of the browser APIs — WebUSB (a printer allowed
 * once in the chooser), Web Serial (a byte channel to a C4 on USB), the cloud relay and the
 * Windows bridge (the engine's ticket passed through, never made by the page).
 */
import { describe, expect, it } from 'vitest';
import { base64ToBytes } from '../src/shared/till/bytes';
import { parseTarget } from '../src/renderer/host/HardwarePort';
import { BridgeHardwarePort, type BridgeRequester } from '../src/renderer/host/browser/bridgeClient';
import { RelayPrintPort, type HttpFn } from '../src/renderer/host/browser/relayClient';
import { parseSerialAddress, WebSerialPort, type SerialLike, type SerialPortLike } from '../src/renderer/host/browser/webSerial';
import { findBulkOut, WebUsbPrinterPort, type UsbDeviceLike, type UsbLike } from '../src/renderer/host/browser/webUsbPrinter';

function usbPrinter(vendorId = 0x04b8, productId = 0x0e15) {
  const writes: Array<{ ep: number; data: Uint8Array }> = [];
  const dev: UsbDeviceLike & { writes: typeof writes; claimed: number[] } = {
    vendorId,
    productId,
    opened: false,
    configuration: null,
    writes,
    claimed: [],
    async open() {
      this.opened = true;
    },
    async selectConfiguration() {
      this.configuration = {
        configurationValue: 1,
        interfaces: [
          { interfaceNumber: 0, alternate: { interfaceClass: 3, endpoints: [{ endpointNumber: 1, direction: 'in', type: 'interrupt' }] } },
          {
            interfaceNumber: 1,
            alternate: {
              interfaceClass: 7,
              endpoints: [
                { endpointNumber: 2, direction: 'in', type: 'bulk' },
                { endpointNumber: 3, direction: 'out', type: 'bulk' },
              ],
            },
          },
        ],
      };
    },
    async claimInterface(n) {
      this.claimed.push(n);
    },
    async transferOut(ep, data) {
      writes.push({ ep, data: data.slice() });
      return { status: 'ok' as const, bytesWritten: data.length };
    },
    async close() {
      this.opened = false;
    },
  };
  return dev;
}

describe('WebUSB printer', () => {
  it('finds the printer interface\'s bulk OUT', () => {
    expect(findBulkOut(null)).toBeNull();
    const d = usbPrinter();
    void d.selectConfiguration(1);
    expect(findBulkOut(d.configuration)).toEqual({ interfaceNumber: 1, endpointNumber: 3 });
  });

  it('sends the job in slices to the allowed printer, claiming it once', async () => {
    const dev = usbPrinter();
    const usb: UsbLike = { getDevices: async () => [dev], requestDevice: async () => dev };
    const port = new WebUsbPrinterPort(usb, 1000);
    const bytes = Uint8Array.from({ length: 2500 }, (_, i) => i & 0xff);
    await port.print(parseTarget('usb://04b8:0e15')!, bytes, { jobId: 'j', kind: 'receipt' });
    expect(dev.claimed).toEqual([1]);
    expect(dev.writes.map((w) => [w.ep, w.data.length])).toEqual([
      [3, 1000],
      [3, 1000],
      [3, 500],
    ]);
    expect(await port.pair()).toBe('usb://04b8:0e15');
  });

  it('a printer the browser was never allowed: "not_permitted", with the way to allow it', async () => {
    const port = new WebUsbPrinterPort({ getDevices: async () => [], requestDevice: async () => usbPrinter() });
    await expect(port.print(parseTarget('usb://04b8:0e15')!, Uint8Array.of(1), { jobId: 'j', kind: 'receipt' })).rejects.toMatchObject({ code: 'not_permitted' });
  });

  it('a printer Windows holds (claim fails): "no_device"', async () => {
    const dev = usbPrinter();
    dev.claimInterface = async () => {
      throw new Error('Unable to claim interface.');
    };
    const port = new WebUsbPrinterPort({ getDevices: async () => [dev], requestDevice: async () => dev });
    await expect(port.print(parseTarget('usb://04b8:0e15')!, Uint8Array.of(1), { jobId: 'j', kind: 'receipt' })).rejects.toMatchObject({ code: 'no_device' });
  });
});

function serialPort(info: { usbVendorId?: number; usbProductId?: number }) {
  let push: ((b: Uint8Array) => void) | null = null;
  const written: Uint8Array[] = [];
  const port: SerialPortLike & { feed(b: Uint8Array): void; written: Uint8Array[]; openedWith: unknown } = {
    readable: null,
    writable: null,
    written,
    openedWith: null,
    getInfo: () => info,
    async open(o) {
      this.openedWith = o;
      this.readable = new ReadableStream<Uint8Array>({
        start(c) {
          push = (b) => c.enqueue(b);
        },
      });
      this.writable = new WritableStream<Uint8Array>({ write: (b) => void written.push(b) });
    },
    async close() {
      this.readable = null;
    },
    feed(b) {
      push?.(b);
    },
  };
  return port;
}

describe('Web Serial channel', () => {
  it('parses the addresses', () => {
    expect(parseSerialAddress('usb:0416:b002')).toEqual({ vendorId: 0x0416, productId: 0xb002 });
    expect(parseSerialAddress('port:1')).toEqual({ index: 1 });
    expect(parseSerialAddress('COM3')).toBeNull();
  });

  it('opens the allowed C4 port, writes frames, reads what came, times out empty', async () => {
    const c4 = serialPort({ usbVendorId: 0x0416, usbProductId: 0xb002 });
    const serial: SerialLike = { getPorts: async () => [serialPort({}), c4], requestPort: async () => c4 };
    const port = new WebSerialPort(serial);
    expect(port.supportsChannel({ kind: 'serial', address: 'usb:0416:b002' })).toBe(true);
    expect(port.supportsChannel({ kind: 'tcp', address: 'x' })).toBe(false);
    const ch = await port.openChannel({ kind: 'serial', address: 'usb:0416:b002', serial: { baudRate: 9600 } });
    expect(c4.openedWith).toMatchObject({ baudRate: 9600, dataBits: 8, parity: 'none' });
    await ch.write(Uint8Array.of(0x02, 0x10, 0x03));
    expect(c4.written[0]).toEqual(Uint8Array.of(0x02, 0x10, 0x03));
    c4.feed(Uint8Array.of(1, 2, 3, 4, 5));
    await new Promise((r) => setTimeout(r, 0));
    expect(await ch.read(3, 50)).toEqual(Uint8Array.of(1, 2, 3));
    expect(await ch.read(10, 50)).toEqual(Uint8Array.of(4, 5));
    expect(await ch.read(10, 20)).toEqual(new Uint8Array(0));
    // A read waiting when bytes arrive returns them at once.
    const waiting = ch.read(10, 5_000);
    c4.feed(Uint8Array.of(9));
    expect(await waiting).toEqual(Uint8Array.of(9));
    await ch.close();
    expect(await port.pair()).toBe('usb:0416:b002');
  });

  it('a port never allowed: "not_permitted"', async () => {
    const port = new WebSerialPort({ getPorts: async () => [], requestPort: async () => serialPort({}) });
    await expect(port.openChannel({ kind: 'serial', address: 'usb:0416:b002' })).rejects.toMatchObject({ code: 'not_permitted' });
  });
});

describe('the cloud relay', () => {
  const target = parseTarget('relay://3f2a1c4e-0000-4000-8000-000000000001')!;

  function relay(status: number, body = '{}', fail = false) {
    const sent: Array<{ url: string; init: Parameters<HttpFn>[1] }> = [];
    const http: HttpFn = async (url, init) => {
      sent.push({ url, init });
      if (fail) throw new Error('Failed to fetch');
      return { ok: status >= 200 && status < 300, status, text: async () => body };
    };
    return { port: new RelayPrintPort({ apiBase: 'https://api.example.com/api/v1/', machineId: 'm-1', token: async () => 'tok', http }), sent };
  }

  it('posts the engine\'s job (its id, the printer, the bytes) with the access token', async () => {
    const { port, sent } = relay(201);
    await port.print(target, Uint8Array.of(0x1b, 0x40), { jobId: 'job-1', kind: 'bon' });
    expect(sent[0].url).toBe('https://api.example.com/api/v1/sync/m-1/print-jobs');
    expect(sent[0].init.headers.Authorization).toBe('Bearer tok');
    const body = JSON.parse(sent[0].init.body!) as { id: string; printerId: string; rawEscPosB64: string; kind: string };
    expect(body).toMatchObject({ id: 'job-1', printerId: '3f2a1c4e-0000-4000-8000-000000000001', kind: 'bon' });
    expect(base64ToBytes(body.rawEscPosB64)).toEqual(Uint8Array.of(0x1b, 0x40));
  });

  it('409 = the same job already there (a retried upload); 422 refused; 5xx and no network offline', async () => {
    await expect(relay(409).port.print(target, Uint8Array.of(1), { jobId: 'j', kind: 'bon' })).resolves.toBeUndefined();
    await expect(relay(422, '{"detail":"bad ticket"}').port.print(target, Uint8Array.of(1), { jobId: 'j', kind: 'bon' })).rejects.toMatchObject({ code: 'refused', message: 'bad ticket' });
    await expect(relay(503).port.print(target, Uint8Array.of(1), { jobId: 'j', kind: 'bon' })).rejects.toMatchObject({ code: 'offline' });
    await expect(relay(200, '', true).port.print(target, Uint8Array.of(1), { jobId: 'j', kind: 'bon' })).rejects.toMatchObject({ code: 'offline' });
  });
});

describe('the Windows bridge', () => {
  function bridge(reply: Awaited<ReturnType<BridgeRequester['request']>>) {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const client: BridgeRequester = {
      request: async (method, path, body) => {
        calls.push({ method, path, body });
        return reply as never;
      },
    };
    return { port: new BridgeHardwarePort(client), calls };
  }

  it('without the engine\'s ticket it sends nothing', async () => {
    const { port, calls } = bridge({ kind: 'ok', status: 200, body: {} });
    await expect(port.print(parseTarget('tcp://10.0.0.9:9100')!, Uint8Array.of(1), { jobId: 'j', kind: 'receipt' })).rejects.toMatchObject({ code: 'not_permitted' });
    expect(calls).toHaveLength(0);
  });

  it('prints on /print and opens the drawer on /drawer, the ticket passed through', async () => {
    const { port, calls } = bridge({ kind: 'ok', status: 200, body: {} });
    await port.print(parseTarget('spooler://Receipt')!, Uint8Array.of(7, 7), { jobId: 'j1', kind: 'receipt', ticket: 'T1' });
    await port.print(parseTarget('tcp://10.0.0.9:9100')!, Uint8Array.of(0x1b, 0x70), { jobId: 'd1', kind: 'drawer', ticket: 'T2' });
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/print', body: { target: 'spooler://Receipt', jobId: 'j1', kind: 'receipt', engineTicket: 'T1' } });
    expect(base64ToBytes((calls[0].body as { rawB64: string }).rawB64)).toEqual(Uint8Array.of(7, 7));
    expect(calls[1]).toMatchObject({ path: '/drawer', body: { target: 'tcp://10.0.0.9:9100', engineTicket: 'T2' } });
  });

  it('maps the bridge\'s refusals: auth → not_permitted, others refused, no answer offline', async () => {
    const t = parseTarget('tcp://10.0.0.9:9100')!;
    await expect(bridge({ kind: 'refused', status: 403, body: null, error: 'role', message: 'אין הרשאה' }).port.print(t, Uint8Array.of(1), { jobId: 'j', kind: 'receipt', ticket: 'T' })).rejects.toMatchObject({ code: 'not_permitted' });
    await expect(bridge({ kind: 'refused', status: 409, body: null, error: 'x', message: null }).port.print(t, Uint8Array.of(1), { jobId: 'j', kind: 'receipt', ticket: 'T' })).rejects.toMatchObject({ code: 'refused' });
    await expect(bridge({ kind: 'offline', reason: 'x' }).port.print(t, Uint8Array.of(1), { jobId: 'j', kind: 'receipt', ticket: 'T' })).rejects.toMatchObject({ code: 'offline' });
  });

  it('opens a byte channel through the bridge for the engine', async () => {
    const { port, calls } = bridge({ kind: 'ok', status: 200, body: { channelId: 'c-9', bytesB64: 'AQI=' } });
    const ch = await port.openChannel({ kind: 'tls', address: '192.168.0.167:8080', tls: { pinSha256: 'ab' }, ticket: 'T' });
    expect(ch.id).toBe('c-9');
    expect(await ch.read(10, 100)).toEqual(Uint8Array.of(1, 2));
    expect(calls[0]).toMatchObject({ path: '/channel/open', body: { kind: 'tls', address: '192.168.0.167:8080', engineTicket: 'T' } });
  });
});
