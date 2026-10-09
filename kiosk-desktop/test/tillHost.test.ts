/**
 * S0-5: the host layer — the engine's targets, `hw.*` carried out on a HardwarePort and answered,
 * the capability tiles (greyed with a reason), the engine links (in-process / IPC, WebSocket with
 * hello{since} and the resend of waiting ops with THEIR clientOpId), the lite flag, base64.
 */
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from '../src/shared/till/bytes';
import { MockTillEngine } from '../src/shared/till/mockEngine';
import type { EngineCall, HwRequest } from '../src/shared/till/protocol';
import { browserCaps, browserEnv, capabilityTiles, NO_CAPS } from '../src/renderer/host/caps';
import { endpointLink, newClientOpId, wsEngineLink, type WsLike } from '../src/renderer/host/engineLink';
import { DRAWER_KICK } from '../src/renderer/host/escpos';
import { composePorts, DemoPrinterPort, executeHw, HwError, parseTarget, type ByteChannel, type HardwarePort, type ParsedTarget } from '../src/renderer/host/HardwarePort';
import { liteMode } from '../src/renderer/host/lite';
import { EngineCallError } from '../src/renderer/host/TillHost';
import { createBrowserHost } from '../src/renderer/host/browser/browserHost';

describe('bytes on the wire', () => {
  it('round-trips base64 like Node does', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
      const b64 = bytesToBase64(bytes);
      expect(b64).toBe(Buffer.from(bytes).toString('base64'));
      expect(base64ToBytes(b64)).toEqual(bytes);
    }
    expect(() => base64ToBytes('a$b')).toThrow();
  });
});

describe('the engine\'s targets', () => {
  it('parses every kind, and nothing else', () => {
    expect(parseTarget('tcp://192.168.1.50:9100')).toMatchObject({ scheme: 'tcp', host: '192.168.1.50', port: 9100 });
    expect(parseTarget('spooler://SNBC%20BTP-880')).toMatchObject({ scheme: 'spooler', queue: 'SNBC BTP-880' });
    expect(parseTarget('usb://04b8:0e15')).toMatchObject({ scheme: 'usb', vendorId: 0x04b8, productId: 0x0e15 });
    expect(parseTarget('bt://00:11:22:aa:bb:cc')).toMatchObject({ scheme: 'bt', address: '00:11:22:AA:BB:CC' });
    expect(parseTarget('relay://3f2a1c4e-0000-4000-8000-000000000001')).toMatchObject({ scheme: 'relay', printerId: '3f2a1c4e-0000-4000-8000-000000000001' });
    expect(parseTarget('builtin')).toMatchObject({ scheme: 'builtin' });
    expect(parseTarget('lan')).toMatchObject({ scheme: 'lan' });
    expect(parseTarget('demo://printer')).toMatchObject({ scheme: 'demo', name: 'printer' });
    for (const bad of ['', 'tcp://x', 'tcp://h:0', 'tcp://h:70000', 'usb://4b8:e15', 'file:///c:/x', 'http://x', 'spooler://a/b', 42, null]) expect(parseTarget(bad)).toBeNull();
  });
});

class FakePort implements HardwarePort {
  readonly name = 'fake';
  readonly printed: Array<{ target: string; bytes: Uint8Array; kind: string; ticket?: string }> = [];
  readonly opened: string[] = [];
  constructor(private readonly schemes: string[], private readonly fail?: HwError) {}
  supports(t: ParsedTarget) {
    return this.schemes.includes(t.scheme);
  }
  async print(t: ParsedTarget, bytes: Uint8Array, job: { kind: string; ticket?: string }) {
    if (this.fail) throw this.fail;
    this.printed.push({ target: t.raw, bytes, kind: job.kind, ticket: job.ticket });
  }
  supportsChannel() {
    return true;
  }
  async openChannel(): Promise<ByteChannel> {
    const queue: Uint8Array[] = [];
    let closed = false;
    const id = `ch${this.opened.length + 1}`;
    this.opened.push(id);
    return {
      id,
      write: async (b) => void queue.push(b),
      read: async (max) => (closed ? new Uint8Array(0) : (queue.shift() ?? new Uint8Array(0)).slice(0, max)),
      close: async () => void (closed = true),
    };
  }
}

describe('hw.* carried out by the host', () => {
  it('prints the engine\'s bytes, opens the drawer with the kick, answers every request', async () => {
    const port = new FakePort(['tcp']);
    const channels = new Map<string, ByteChannel>();
    const bytes = Uint8Array.of(1, 2, 3, 250);
    const r1 = await executeHw(port, { type: 'hw.print', requestId: 'a', jobId: 'j', target: 'tcp://10.0.0.5:9100', kind: 'receipt', bytesB64: bytesToBase64(bytes), ticket: 'T' }, channels);
    expect(r1).toEqual({ requestId: 'a', ok: true });
    expect(port.printed[0]).toMatchObject({ target: 'tcp://10.0.0.5:9100', kind: 'receipt', ticket: 'T' });
    expect(port.printed[0].bytes).toEqual(bytes);
    const r2 = await executeHw(port, { type: 'hw.drawer', requestId: 'b', target: 'tcp://10.0.0.5:9100' }, channels);
    expect(r2.ok).toBe(true);
    expect(port.printed[1]).toMatchObject({ kind: 'drawer' });
    expect(port.printed[1].bytes).toEqual(DRAWER_KICK);
    expect(await executeHw(port, { type: 'hw.print', requestId: 'c', jobId: 'j', target: 'nope', kind: 'receipt', bytesB64: '' }, channels)).toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('runs a byte channel for the engine: open, write, read, close; a closed id is refused', async () => {
    const port = new FakePort([]);
    const channels = new Map<string, ByteChannel>();
    const open = await executeHw(port, { type: 'hw.channel.open', requestId: '1', kind: 'serial', address: 'usb:0416:b002', serial: { baudRate: 115200 } }, channels);
    expect(open).toMatchObject({ ok: true, channelId: 'ch1' });
    expect(await executeHw(port, { type: 'hw.channel.write', requestId: '2', channelId: 'ch1', bytesB64: bytesToBase64(Uint8Array.of(9, 8, 7)) }, channels)).toMatchObject({ ok: true });
    const read = await executeHw(port, { type: 'hw.channel.read', requestId: '3', channelId: 'ch1', max: 2, timeoutMs: 10 }, channels);
    expect(base64ToBytes(read.bytesB64!)).toEqual(Uint8Array.of(9, 8));
    expect(await executeHw(port, { type: 'hw.channel.close', requestId: '4', channelId: 'ch1' }, channels)).toMatchObject({ ok: true });
    expect(await executeHw(port, { type: 'hw.channel.read', requestId: '5', channelId: 'ch1' }, channels)).toMatchObject({ ok: false, code: 'unknown_channel' });
  });

  it('a port\'s failure is an answer, never a throw', async () => {
    const port = new FakePort(['tcp'], new HwError('offline', 'המדפסת לא עונה'));
    const r = await executeHw(port, { type: 'hw.print', requestId: 'x', jobId: 'j', target: 'tcp://1.2.3.4:9100', kind: 'receipt', bytesB64: '' }, new Map());
    expect(r).toEqual({ requestId: 'x', ok: false, code: 'offline', message: 'המדפסת לא עונה' });
  });

  it('composes ports: the first that takes the target wins; none → unsupported', async () => {
    const usb = new FakePort(['usb']);
    const tcp = new FakePort(['tcp', 'usb']);
    const port = composePorts([usb, tcp]);
    await port.print(parseTarget('usb://0001:0002')!, Uint8Array.of(1), { jobId: 'j', kind: 'receipt' });
    await port.print(parseTarget('tcp://1.1.1.1:9100')!, Uint8Array.of(2), { jobId: 'j', kind: 'receipt' });
    expect(usb.printed).toHaveLength(1);
    expect(tcp.printed).toHaveLength(1);
    await expect(port.print(parseTarget('bt://00:11:22:33:44:55')!, Uint8Array.of(3), { jobId: 'j', kind: 'receipt' })).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('capabilities, honestly', () => {
  const env = { serial: true, usb: true, bluetooth: false, barcodeDetector: false, secureContext: true, wakeLock: true, standalone: false };

  it('detects the browser\'s features', () => {
    expect(browserEnv({ serial: {}, usb: {}, wakeLock: {} }, { isSecureContext: true, matchMedia: () => ({ matches: true }) })).toMatchObject({ serial: true, usb: true, wakeLock: true, secureContext: true, standalone: true });
    expect(browserEnv({}, {})).toMatchObject({ serial: false, usb: false, secureContext: false, standalone: false });
  });

  it('a plain browser: no network printer, no drawer, card only through the engine; reasons in Hebrew', () => {
    const caps = browserCaps({ ...env, usb: false, serial: false });
    const tiles = capabilityTiles(caps, 'browser');
    const by = Object.fromEntries(tiles.map((t) => [t.id, t]));
    expect(by.print.available).toBe(false);
    expect(by.print.reason).toContain('דפדפן');
    expect(by.drawer.available).toBe(false);
    expect(by.offline.available).toBe(false);
    expect(by.offline.reason).toContain('קופה ראשית');
    expect(by.scanner.available).toBe(true);
    expect(by.customerDisplay.available).toBe(false);
    for (const t of tiles) expect(t.reason).toMatch(/[\u0590-\u05FF]/);
  });

  it('Web Serial / WebUSB need a secure context; the bridge opens the rest', () => {
    expect(browserCaps({ ...env, secureContext: false }).print.usb).toBe(false);
    expect(browserCaps(env).terminals.nayaxUsb).toBe(true);
    const bridged = browserCaps({ ...env, usb: false, serial: false }, { bridge: true });
    expect(bridged.print.tcp && bridged.print.spooler && bridged.drawer.viaPrinter && bridged.terminals.nayaxLan).toBe(true);
  });

  it('the demo says its printer and terminal are simulated', () => {
    const tiles = capabilityTiles(NO_CAPS, 'browser', { demo: true, demoTerminal: true });
    expect(tiles.find((t) => t.id === 'print')).toMatchObject({ available: true, reason: 'מדפסת מדומה (הדגמה)' });
    expect(tiles.find((t) => t.id === 'card')).toMatchObject({ available: true, reason: 'מסופון מדומה (הדגמה)' });
    expect(capabilityTiles(NO_CAPS, 'browser', { demo: true }).find((t) => t.id === 'card')).toMatchObject({ available: false });
  });

  it('a host with its own engine works offline', () => {
    expect(capabilityTiles({ ...NO_CAPS, localEngine: true }, 'electron').find((t) => t.id === 'offline')).toMatchObject({ available: true });
  });
});

describe('engine links', () => {
  it('in-process: the first state at once, a clientOpId on every changing op, refusals as EngineCallError', async () => {
    const engine = new MockTillEngine();
    const calls: EngineCall[] = [];
    const link = endpointLink({ hello: (s) => engine.hello(s), on: (fn) => engine.on(fn), call: (c) => (calls.push(c), engine.call(c)) });
    expect(link.status()).toBe('ready');
    expect(link.snapshot()?.state.session.demo).toBe(true);
    await link.call('sell.add', { productId: 'p1' });
    await link.call('catalog.snapshot', {});
    expect(calls[0].clientOpId).toMatch(/^[0-9a-f]{32}$/);
    expect(calls[1].clientOpId).toBeUndefined();
    expect(link.snapshot()?.state.sell.lines).toHaveLength(1);
    await expect(link.call('z.produce', {})).rejects.toBeInstanceOf(EngineCallError);
    await expect(link.call('z.produce', {})).rejects.toMatchObject({ code: 'z_not_in_demo' });
  });

  it('an engine on another protocol: "mismatch", and nothing is sold', async () => {
    const engine = new MockTillEngine();
    const link = endpointLink({ hello: () => ({ ...engine.hello(), protocol: 99 }), on: (fn) => engine.on(fn), call: (c) => engine.call(c) });
    expect(link.status()).toBe('mismatch');
    await expect(link.call('sell.add', { productId: 'p1' })).rejects.toMatchObject({ code: 'protocol_mismatch' });
  });

  it('client op ids are unique', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newClientOpId()));
    expect(ids.size).toBe(500);
  });

  it('WebSocket: hello{since}, then the waiting ops again WITH THEIR clientOpId after a reconnect', async () => {
    const engine = new MockTillEngine();
    const sockets: Array<WsLike & { sent: string[]; serve(): void; drop(): void }> = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const connect = (): WsLike => {
      const s = {
        sent: [] as string[],
        onopen: null as WsLike['onopen'],
        onmessage: null as WsLike['onmessage'],
        onclose: null as WsLike['onclose'],
        onerror: null as WsLike['onerror'],
        send(d: string) {
          this.sent.push(d);
        },
        close() {
          this.onclose?.({});
        },
        serve() {
          // The engine answers everything sent so far.
          for (const raw of this.sent.splice(0)) {
            const c = JSON.parse(raw) as EngineCall;
            void engine.call(c).then((r) => this.onmessage?.({ data: JSON.stringify(c.op === 'session.hello' ? { id: c.id, ok: true, value: engine.hello() } : r) }));
          }
        },
        drop() {
          this.onclose?.({});
        },
      };
      sockets.push(s);
      return s;
    };
    engine.on((e) => sockets[sockets.length - 1]?.onmessage?.({ data: JSON.stringify(e) }));
    const link = wsEngineLink({ url: 'wss://engine/v1/till/m', connect, schedule: (fn, ms) => (timers.push({ fn, ms }), () => undefined), callTimeoutMs: 60_000 });
    sockets[0].onopen?.({});
    const hello = JSON.parse(sockets[0].sent[0]) as EngineCall;
    expect(hello.op).toBe('session.hello');
    sockets[0].serve();
    await new Promise((r) => setTimeout(r, 0));
    expect(link.status()).toBe('ready');

    // An op goes out; the line drops before the answer.
    const pending = link.call('sell.add', { productId: 'p1' });
    const first = JSON.parse(sockets[0].sent[0]) as EngineCall;
    sockets[0].drop();
    expect(link.status()).toBe('offline');
    timers.find((t) => t.ms === 500)!.fn(); // the reconnect (not the call's 60 s timeout)
    sockets[1].onopen?.({});
    const hello2 = JSON.parse(sockets[1].sent[0]) as EngineCall;
    expect((hello2.args as { since?: number }).since).toBe(1);
    sockets[1].serve(); // hello answered → the waiting op is sent again
    await new Promise((r) => setTimeout(r, 0));
    const resent = JSON.parse(sockets[1].sent[0]) as EngineCall;
    expect(resent.clientOpId).toBe(first.clientOpId);
    // The engine got it twice in effect (the first send may have arrived): still one line.
    await engine.call(first);
    sockets[1].serve();
    await pending;
    expect(engine.snapshot().sell.lines[0].qty).toBe(1);
    expect(link.snapshot()?.state.sell.lines).toHaveLength(1);
    link.close();
  });
});

describe('the browser host', () => {
  it('demo: carries out the engine\'s hw.* on the virtual printer and answers the engine', async () => {
    const host = createBrowserHost({ engine: { kind: 'demo' }, env: browserEnv({}, {}), lite: true });
    expect(host.demo).toBe(true);
    expect(host.device.lite).toBe(true);
    await host.engine.call('sell.add', { productId: 'p2' });
    await host.engine.call('checkout.start', {});
    await host.engine.call('checkout.cash', { amountAgorot: 1200 });
    await new Promise((r) => setTimeout(r, 0));
    expect(host.demoPrinter!.jobs.map((j) => j.kind)).toEqual(['receipt', 'drawer']);
    expect(host.demoEngine!.hwResults.every((r) => r.ok)).toBe(true);
    const caps = await host.capabilities();
    expect(caps.localEngine).toBe(false);
    host.dispose();
  });

  it('reports at rest / busy to the engine and to the PWA\'s gate', async () => {
    const seen: Array<[boolean, boolean]> = [];
    const host = createBrowserHost({ engine: { kind: 'demo' }, env: browserEnv({}, {}), lite: false, onIdleReport: (i, b) => seen.push([i, b]) });
    host.bundle.reportIdle(false, true);
    host.bundle.reportIdle(true, false);
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual([
      [false, true],
      [true, false],
    ]);
    expect(host.demoEngine!.hostReportsIdle).toEqual({ idle: true, busy: false });
  });

  it('the screens get no hardware: hw events are the host\'s own business', () => {
    const host = createBrowserHost({ engine: { kind: 'demo' }, env: browserEnv({}, {}), lite: false });
    expect(Object.keys(host)).not.toContain('hardware');
    const hw: HwRequest = { type: 'hw.drawer', requestId: 'x', target: 'demo://printer' };
    expect(hw.type).toBe('hw.drawer');
  });
});

describe('the lite flag', () => {
  it('address, then the device, then the host\'s hint or reduced motion', () => {
    expect(liteMode({ search: '?lite=1' })).toBe(true);
    expect(liteMode({ search: '?lite=0', hint: true, reducedMotion: true })).toBe(false);
    expect(liteMode({ stored: '1' })).toBe(true);
    expect(liteMode({ stored: '0', hint: true })).toBe(false);
    expect(liteMode({ hint: true })).toBe(true);
    expect(liteMode({ reducedMotion: true })).toBe(true);
    expect(liteMode({})).toBe(false);
  });
});

describe('DemoPrinterPort', () => {
  it('keeps the last 20 jobs', async () => {
    const p = new DemoPrinterPort();
    for (let i = 0; i < 25; i++) await p.print(parseTarget('demo://printer')!, Uint8Array.of(i), { jobId: `${i}`, kind: 'receipt' });
    expect(p.jobs).toHaveLength(20);
  });
});
