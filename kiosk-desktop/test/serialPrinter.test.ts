/**
 * The serial (COM) receipt printer (main/printer/serialPrinter.ts, transports.ts `serial`): an all-in-one terminal's
 * built-in printer that Windows shows only as a COM port. A fake `serialport` module stands in for the port: a printer
 * on it answers DLE EOT at its own speed only; nothing real is ever opened.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  comPortIn,
  likelyPrinter,
  normalizeComPath,
  parseSerialAddress,
  portViews,
  serialTarget,
  SerialPrinters,
  type SerialPortHandle,
  type SerialPortInfo,
  type SerialPortModule,
} from '../src/main/printer/serialPrinter';
import { DefaultTransport, serialLineOf, type PrinterTarget } from '../src/main/printer/transports';
import { targetText } from '../src/main/printer/usbPrinters';
import { DRAWER_KICK } from '../src/core/escpos';
import { harness, type Harness } from './tillEngineHarness';

/* ------------------------------------------------------------------ the fake port */

interface FakePrinter {
  baud: number;
  /** The answers to DLE EOT n. */
  status: Record<number, number>;
  /** Silent on DLE EOT (some printers are). */
  silent?: boolean;
  /** drain never ends (RTS/CTS held: paper out). */
  stall?: boolean;
  /** Fails the write after this many bytes went. */
  failAfter?: number;
}

class FakeWorld {
  printers = new Map<string, FakePrinter>();
  infos: SerialPortInfo[] = [];
  /** Every byte that reached each printer, at the right speed. */
  received = new Map<string, number[]>();
  opens: Array<{ path: string; baudRate: number; rtscts: boolean }> = [];
  openNow = new Map<string, number>();
  maxOpen = 0;
  /** What happened in order: open / write / close per port. */
  trace: string[] = [];

  module(): SerialPortModule {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const world = this;
    class Port implements SerialPortHandle {
      private dataCbs: Array<(b: Buffer) => void> = [];
      private written = 0;
      constructor(private readonly o: { path: string; baudRate: number; rtscts: boolean }) {}
      open(cb: (err: Error | null) => void) {
        if (!world.printers.has(this.o.path) && !world.infos.some((i) => i.path === this.o.path)) return setImmediate(() => cb(new Error('File not found')));
        world.opens.push({ path: this.o.path, baudRate: this.o.baudRate, rtscts: this.o.rtscts });
        const n = (world.openNow.get(this.o.path) ?? 0) + 1;
        world.openNow.set(this.o.path, n);
        world.maxOpen = Math.max(world.maxOpen, n);
        world.trace.push(`open ${this.o.path}`);
        setImmediate(() => cb(null));
      }
      write(b: Buffer, cb?: (err: Error | null | undefined) => void) {
        const p = world.printers.get(this.o.path);
        world.trace.push(`write ${this.o.path} ${b.length}`);
        if (p?.failAfter !== undefined && this.written + b.length > p.failAfter) {
          this.written += b.length;
          setImmediate(() => cb?.(new Error('write failed')));
          return false;
        }
        this.written += b.length;
        if (p && p.baud === this.o.baudRate) {
          const got = world.received.get(this.o.path) ?? [];
          got.push(...b);
          world.received.set(this.o.path, got);
          // DLE EOT n → the status byte.
          if (b.length === 3 && b[0] === 0x10 && b[1] === 0x04 && !p.silent) {
            const ans = p.status[b[2]!];
            if (ans !== undefined) setImmediate(() => this.dataCbs.forEach((f) => f(Buffer.from([ans]))));
          }
        } else if (p && b.length === 3 && b[0] === 0x10 && b[1] === 0x04) {
          // The wrong speed: framing noise.
          setImmediate(() => this.dataCbs.forEach((f) => f(Buffer.from([0xff, 0x00]))));
        }
        setImmediate(() => cb?.(null));
        return true;
      }
      drain(cb: (err: Error | null) => void) {
        if (world.printers.get(this.o.path)?.stall) return;
        setImmediate(() => cb(null));
      }
      close(cb?: (err: Error | null) => void) {
        world.openNow.set(this.o.path, (world.openNow.get(this.o.path) ?? 1) - 1);
        world.trace.push(`close ${this.o.path}`);
        setImmediate(() => cb?.(null));
      }
      on(evt: string, cb: (x: never) => void) {
        if (evt === 'data') this.dataCbs.push(cb as (b: Buffer) => void);
        return this;
      }
    }
    return {
      SerialPort: Object.assign(Port, { list: async () => world.infos }) as unknown as SerialPortModule['SerialPort'],
    };
  }

  printers_(path: string, p: FakePrinter, info: Partial<SerialPortInfo> = {}) {
    this.printers.set(path, p);
    this.infos.push({ path, ...info });
  }
}

const OK_STATUS = { 1: 0x16, 2: 0x12, 4: 0x12 };
const fast = () => Promise.resolve();

function rig(o: { stallMs?: number } = {}) {
  const world = new FakeWorld();
  const serial = new SerialPrinters({ load: async () => world.module(), sleep: fast, answerMs: 0, probeMs: 0, stallMs: o.stallMs });
  return { world, serial };
}

/* ------------------------------------------------------------------ settings */

describe('the serial settings', () => {
  it('reads COM port names, the cloud address form and the payment terminal’s port', () => {
    expect(normalizeComPath(' com3 ')).toBe('COM3');
    expect(normalizeComPath('\\\\.\\COM12')).toBe('COM12');
    expect(normalizeComPath('LPT1')).toBeNull();
    expect(normalizeComPath('COM0')).toBeNull();
    expect(parseSerialAddress('COM3')).toEqual({ path: 'COM3', baudRate: 9600, flow: 'none' });
    expect(parseSerialAddress('com4:115200:RTSCTS')).toEqual({ path: 'COM4', baudRate: 115200, flow: 'rtscts' });
    expect(parseSerialAddress('COM4:12345')).toBeNull();
    expect(parseSerialAddress('192.168.1.50')).toBeNull();
    expect(serialTarget('com2', 'x', 'weird')).toEqual({ transport: 'serial', comPort: 'COM2', baudRate: 9600, flow: 'none' });
    expect(comPortIn('USB COM5')).toBe('COM5');
    expect(comPortIn('USB auto')).toBeNull();
  });

  it('marks the likely printers and lists them first', () => {
    const views = portViews([
      { path: 'COM1', friendlyName: 'Communications Port (COM1)', manufacturer: '(Standard port types)', pnpId: 'ACPI\\PNP0501\\1' },
      { path: 'COM7', friendlyName: 'Intel(R) Active Management Technology - SOL (COM7)', manufacturer: 'Intel' },
      { path: 'COM3', friendlyName: 'POS Printer (COM3)', manufacturer: 'SNBC' },
      { path: 'COM5', friendlyName: 'USB-SERIAL CH340 (COM5)', manufacturer: 'wch.cn', vendorId: '1a86', productId: '7523' },
      { path: 'COM9', vendorId: '04b8', productId: '0e28' },
      { path: '/dev/ttyS0' },
    ]);
    expect(views.map((v) => [v.path, v.likely])).toEqual([
      ['COM3', 'likely'],
      ['COM9', 'likely'],
      ['COM1', 'possible'],
      ['COM5', 'possible'],
      ['COM7', null],
    ]);
    expect(views.find((v) => v.path === 'COM5')).toMatchObject({ label: 'USB-SERIAL CH340 (COM5)', usbId: '1A86:7523' });
    expect(likelyPrinter({ path: 'COM2', manufacturer: 'Posiflex' })).toBe('likely');
  });

  it('says where the page goes', () => {
    const t: PrinterTarget = { transport: 'serial', comPort: 'COM3', baudRate: 19200, flow: 'rtscts' };
    expect(targetText({ target: t, auto: false, via: 'setting' })).toBe('סריאלי: COM3 · 19200 · RTS/CTS');
    expect(serialLineOf({ transport: 'serial', comPort: 'COM3' })).toEqual({ path: 'COM3', baudRate: 9600, flow: 'none' });
    expect(serialLineOf({ transport: 'spooler', queueName: 'x' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ the port */

describe('a job, the status, the speed', () => {
  it('sends the bytes in slices at the line set (8N1, flow control as set), then closes the port', async () => {
    const { world, serial } = rig();
    world.printers_('COM3', { baud: 9600, status: OK_STATUS });
    const bytes = Uint8Array.from({ length: 2500 }, (_, i) => i % 256);
    await serial.send({ path: 'COM3', baudRate: 9600, flow: 'rtscts' }, bytes);
    expect(world.received.get('COM3')).toEqual([...bytes]);
    expect(world.opens).toEqual([{ path: 'COM3', baudRate: 9600, rtscts: true }]);
    expect(world.trace.filter((t) => t.startsWith('write'))).toEqual(['write COM3 1024', 'write COM3 1024', 'write COM3 452']);
    expect(world.trace.at(-1)).toBe('close COM3');
  });

  it('reads DLE EOT 1 / 2 / 4 over the line (paper out, cover open), none when nothing answers', async () => {
    const { world, serial } = rig();
    world.printers_('COM3', { baud: 19200, status: { 1: 0x16, 2: 0x16, 4: 0x72 } });
    expect(await serial.status({ path: 'COM3', baudRate: 19200, flow: 'none' })).toMatchObject({ valid: true, paper: 'out', coverOpen: true });
    world.printers_('COM4', { baud: 9600, status: OK_STATUS, silent: true });
    expect(await serial.status({ path: 'COM4', baudRate: 9600, flow: 'none' })).toBeNull();
    // A port that does not open: null, never a throw.
    expect(await serial.status({ path: 'COM8', baudRate: 9600, flow: 'none' })).toBeNull();
  });

  it('never asks the status inside a job: the port’s uses run one after the other', async () => {
    const { world, serial } = rig();
    world.printers_('COM3', { baud: 9600, status: OK_STATUS });
    const job = serial.send({ path: 'COM3', baudRate: 9600, flow: 'none' }, new Uint8Array(5000));
    const st = serial.status({ path: 'COM3', baudRate: 9600, flow: 'none' });
    const job2 = serial.send({ path: 'COM3', baudRate: 9600, flow: 'none' }, new Uint8Array(10));
    await Promise.all([job, st, job2]);
    expect(world.maxOpen).toBe(1);
    // The status's three questions come after every slice of the first job, and the second job after them.
    const writes = world.trace.filter((t) => t.startsWith('write')).map((t) => Number(t.split(' ')[2]));
    expect(writes).toEqual([1024, 1024, 1024, 1024, 904, 3, 3, 3, 10]);
    expect(await st).toMatchObject({ valid: true, paper: 'ok' });
  });

  it('"זיהוי אוטומטי" finds the speed the printer answers at, and none for a silent port', async () => {
    const { world, serial } = rig();
    world.printers_('COM3', { baud: 38400, status: OK_STATUS });
    expect(await serial.detectBaud('COM3')).toBe(38400);
    expect(world.opens.map((o) => o.baudRate)).toEqual([9600, 19200, 38400]);
    world.printers_('COM4', { baud: 9600, status: OK_STATUS, silent: true });
    expect(await serial.detectBaud('COM4')).toBeNull();
    await expect(serial.detectBaud('COM8')).rejects.toThrow(/לא ניתן לפתוח את COM8/);
  });

  it('fails a job held back too long (RTS/CTS), and says when part of it went', async () => {
    const { world, serial } = rig({ stallMs: 20 });
    world.printers_('COM3', { baud: 115200, status: OK_STATUS, stall: true });
    await expect(serial.send({ path: 'COM3', baudRate: 115200, flow: 'rtscts' }, new Uint8Array(10))).rejects.toMatchObject({ partial: false });
    expect(world.openNow.get('COM3')).toBe(0);
    world.printers_('COM4', { baud: 9600, status: OK_STATUS, failAfter: 1500 });
    await expect(serial.send({ path: 'COM4', baudRate: 9600, flow: 'none' }, new Uint8Array(3000))).rejects.toMatchObject({ partial: true });
  });

  it('without the serialport package: a clear refusal', async () => {
    const serial = new SerialPrinters({ load: async () => null });
    await expect(serial.send({ path: 'COM3', baudRate: 9600, flow: 'none' }, new Uint8Array(1))).rejects.toThrow(/serialport/);
    await expect(serial.list()).rejects.toThrow(/serialport/);
  });
});

/* ------------------------------------------------------------------ the transport and the device */

/** The real transport on the fake ports, with no Windows spooler (no PowerShell in the tests). */
class TestTransport extends DefaultTransport {
  override async list() {
    return [];
  }
  override async usbScan() {
    return { queues: [], devices: null, ports: null, at: 0 };
  }
}

describe('the transport', () => {
  it('sends, reads the status and kicks the drawer through the COM port; a partial write reads as the spooler’s "write:"', async () => {
    const { world, serial } = rig();
    world.printers_('COM3', { baud: 19200, status: { 1: 0x16, 2: 0x12, 4: 0x1e } });
    const t = new TestTransport(() => undefined, serial);
    const target: PrinterTarget = { transport: 'serial', comPort: 'COM3', baudRate: 19200 };
    await t.send(target, DRAWER_KICK);
    expect(world.received.get('COM3')).toEqual([...DRAWER_KICK]);
    expect(await t.status(target)).toEqual({ health: 'paper_low', detail: 'COM3' });
    expect(await t.status({ ...target, comPort: 'COM8' })).toEqual({ health: 'unavailable', detail: 'COM8' });
    await expect(t.send({ transport: 'serial', comPort: null }, DRAWER_KICK)).rejects.toThrow(/no serial port/);
    world.printers_('COM4', { baud: 9600, status: OK_STATUS, failAfter: 1100 });
    await expect(t.send({ transport: 'serial', comPort: 'COM4' }, new Uint8Array(3000))).rejects.toThrow(/^write: /);
    t.dispose();
  });
});

describe('the technician screen', () => {
  const open: Harness[] = [];
  afterEach(() => {
    for (const h of open.splice(0)) h.stop();
  });

  function device(parameters: Record<string, unknown> = {}) {
    const { world, serial } = rig();
    const transport = new TestTransport(() => undefined, serial);
    const h = harness({ parameters, transport });
    open.push(h);
    expect(h.svc.technicianUnlock('1995').outcome).toBe('granted');
    return { h, world };
  }

  it('lists the COM ports, finds the speed, chooses the port; the width test and the drawer go through it', async () => {
    const { h, world } = device();
    world.printers_('COM3', { baud: 19200, status: OK_STATUS }, { friendlyName: 'POS Printer (COM3)', manufacturer: 'SNBC' });
    world.infos.push({ path: 'COM1', friendlyName: 'Communications Port (COM1)' });
    const list = await h.svc.technicianAction({ type: 'serialPorts' });
    expect(list.serialPorts?.map((p) => [p.path, p.likely, p.inUse])).toEqual([
      ['COM3', 'likely', null],
      ['COM1', 'possible', null],
    ]);
    expect(await h.svc.technicianAction({ type: 'serialDetect', comPort: 'com3' })).toMatchObject({ ok: true, baudRate: 19200 });
    // Detecting saves nothing.
    expect(h.svc.localSettings().printer.transport).toBe('spooler');
    expect(await h.svc.technicianAction({ type: 'setPrinter', transport: 'serial', comPort: 'LPT1' })).toEqual({ ok: false, message: 'יציאת COM לא תקינה' });
    expect(await h.svc.technicianAction({ type: 'setPrinter', transport: 'serial', comPort: 'com3', baudRate: 19200 })).toEqual({ ok: true });
    expect(h.svc.localSettings().printer).toEqual({ transport: 'serial', comPort: 'COM3', baudRate: 19200, flow: 'none' });
    expect(h.svc.hasOwnReceiptPrinter()).toBe(true);
    const info = await h.svc.technicianInfo();
    expect(info.setup?.printer).toMatchObject({ kind: 'serial', serial: { comPort: 'COM3', baudRate: 19200, flow: 'none' } });
    expect(info.printer.target).toBe('סריאלי: COM3 · 19200');
    world.received.clear();
    expect(await h.svc.technicianAction({ type: 'printerWidthTest' })).toEqual({ ok: true, message: 'בדיקת רוחב נשלחה למדפסת' });
    expect((world.received.get('COM3') ?? []).length).toBeGreaterThan(1000);
    world.received.clear();
    await h.svc.openDrawer();
    expect(world.received.get('COM3')?.slice(0, 3)).toEqual([0x1b, 0x70, 0x00]);
    expect(await h.svc.receiptPrinterStatus()).toEqual({ health: 'ok', busy: false });
  });

  it('the cloud’s printer address may name a COM port', () => {
    const { h } = device({ receiptPrinterAddress: 'COM2:38400' });
    expect(h.svc.localSettings().printer).toEqual({ transport: 'serial', comPort: 'COM2', baudRate: 38400, flow: 'none' });
  });

  it('never offers, probes or prints on the payment terminal’s COM port', async () => {
    const { h, world } = device();
    world.printers_('COM5', { baud: 9600, status: OK_STATUS });
    (h.svc as unknown as { pay: { describe: () => unknown } }).pay.describe = () => ({ kind: 'nayax_usb', address: 'USB COM5', integration: null });
    expect((await h.svc.technicianAction({ type: 'serialPorts' })).serialPorts?.[0]).toMatchObject({ path: 'COM5', inUse: 'בשימוש המסופון' });
    expect(await h.svc.technicianAction({ type: 'serialDetect', comPort: 'COM5' })).toEqual({ ok: false, message: 'COM5 בשימוש המסופון' });
    expect(await h.svc.technicianAction({ type: 'serialTest', comPort: 'COM5' })).toEqual({ ok: false, message: 'COM5 בשימוש המסופון' });
    expect(await h.svc.technicianAction({ type: 'setPrinter', transport: 'serial', comPort: 'COM5' })).toEqual({ ok: false, message: 'COM5 בשימוש המסופון' });
    expect(world.opens).toEqual([]);
  });
});
