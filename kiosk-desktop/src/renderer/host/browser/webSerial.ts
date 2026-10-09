/**
 * A byte channel over Web Serial (Chrome / Edge on a PC; Chromium 108 has it): a Nayax C4 on USB
 * (CDC-ACM, a COM port), later SynqPay on serial. The engine speaks the terminal's protocol and
 * keeps every card rule (pending document first, never a second charge on an unknown result,
 * §3.4); this only moves its frames. A dropped cable mid-frame is "unknown" to the engine, never
 * a retry.
 *
 * The port must have been allowed once in the browser's chooser (`pair()`, from a tap). Addresses:
 * `usb:<vid>:<pid>` (hex, as the device reports) or `port:<n>` (the n-th allowed port).
 */

import { HwError, type ByteChannel, type ChannelSpec, type HardwarePort, type ParsedTarget } from '../HardwarePort';

export interface SerialPortLike {
  open(o: { baudRate: number; dataBits?: number; stopBits?: number; parity?: 'none' | 'even' | 'odd'; flowControl?: 'none' | 'hardware' }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo(): { usbVendorId?: number; usbProductId?: number };
}

export interface SerialLike {
  getPorts(): Promise<SerialPortLike[]>;
  requestPort(o?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPortLike>;
}

export function parseSerialAddress(address: string): { vendorId: number; productId: number } | { index: number } | null {
  const usb = /^usb:([0-9a-fA-F]{4}):([0-9a-fA-F]{4})$/.exec(address);
  if (usb) return { vendorId: parseInt(usb[1], 16), productId: parseInt(usb[2], 16) };
  const idx = /^port:(\d{1,2})$/.exec(address);
  if (idx) return { index: Number(idx[1]) };
  return null;
}

export class WebSerialChannel implements ByteChannel {
  private buffer: Uint8Array[] = [];
  private buffered = 0;
  private waiter: (() => void) | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private closed = false;
  private failed: Error | null = null;

  constructor(
    readonly id: string,
    private readonly port: SerialPortLike,
  ) {}

  /** Starts the read loop (bytes kept until the engine reads them). */
  start() {
    const readable = this.port.readable;
    if (!readable) throw new HwError('io', 'הפורט לא פתוח לקריאה');
    this.reader = readable.getReader();
    void this.pump();
  }

  private async pump() {
    try {
      while (!this.closed && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          this.buffer.push(value);
          this.buffered += value.length;
          this.wake();
        }
      }
    } catch (e) {
      this.failed = e instanceof Error ? e : new Error(String(e));
    } finally {
      this.wake();
    }
  }

  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  private take(max: number): Uint8Array {
    const n = Math.min(max, this.buffered);
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.buffer[0];
      const want = n - at;
      if (head.length <= want) {
        out.set(head, at);
        at += head.length;
        this.buffer.shift();
      } else {
        out.set(head.subarray(0, want), at);
        this.buffer[0] = head.subarray(want);
        at += want;
      }
    }
    this.buffered -= n;
    return out;
  }

  async read(max: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.buffered === 0 && !this.closed && !this.failed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          if (this.waiter === done) this.waiter = null;
          resolve();
        }, timeoutMs);
        const done = () => {
          clearTimeout(t);
          resolve();
        };
        this.waiter = done;
      });
    }
    if (this.buffered > 0) return this.take(max);
    if (this.failed) throw new HwError('io', `הפורט נותק: ${this.failed.message}`);
    return new Uint8Array(0);
  }

  async write(bytes: Uint8Array): Promise<void> {
    const writable = this.port.writable;
    if (!writable || this.closed) throw new HwError('io', 'הפורט סגור');
    const writer = writable.getWriter();
    try {
      await writer.write(bytes);
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* already gone */
    }
    this.reader?.releaseLock();
    this.reader = null;
    this.wake();
    await this.port.close().catch(() => undefined);
  }
}

export class WebSerialPort implements HardwarePort {
  readonly name = 'webserial';
  private seq = 0;

  constructor(private readonly serial: SerialLike) {}

  supports(_t: ParsedTarget): boolean {
    return false;
  }

  supportsChannel(s: ChannelSpec): boolean {
    return s.kind === 'serial' && parseSerialAddress(s.address) !== null;
  }

  /** The browser's chooser (needs a tap); returns the address to save. */
  async pair(): Promise<string> {
    const p = await this.serial.requestPort();
    const info = p.getInfo();
    if (info.usbVendorId !== undefined && info.usbProductId !== undefined) {
      return `usb:${info.usbVendorId.toString(16).padStart(4, '0')}:${info.usbProductId.toString(16).padStart(4, '0')}`;
    }
    const ports = await this.serial.getPorts();
    return `port:${Math.max(0, ports.indexOf(p))}`;
  }

  print(): Promise<void> {
    return Promise.reject(new HwError('unsupported', 'הדפסה בפורט טורי אינה נתמכת'));
  }

  async openChannel(s: ChannelSpec): Promise<ByteChannel> {
    const where = parseSerialAddress(s.address);
    if (!where) throw new HwError('unsupported', `כתובת לא מוכרת: ${s.address}`);
    const ports = await this.serial.getPorts();
    const port =
      'index' in where
        ? ports[where.index]
        : ports.find((p) => {
            const i = p.getInfo();
            return i.usbVendorId === where.vendorId && i.usbProductId === where.productId;
          });
    if (!port) throw new HwError('not_permitted', 'הפורט לא אושר בדפדפן הזה — "חיבור מסופון USB" בתפריט הטכנאי');
    try {
      await port.open({ baudRate: s.serial?.baudRate ?? 115_200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    } catch (e) {
      throw new HwError('no_device', `אי אפשר לפתוח את הפורט: ${e instanceof Error ? e.message : String(e)}`);
    }
    this.seq += 1;
    const ch = new WebSerialChannel(`serial-${this.seq}`, port);
    ch.start();
    return ch;
  }
}
