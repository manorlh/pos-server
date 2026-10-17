/**
 * A receipt printer on a serial port (COMn): the built-in printer of an all-in-one POS terminal, which
 * Windows often shows only as a COM port (an onboard UART or a USB-serial bridge) with no printer
 * driver, so neither the spooler nor TCP 9100 reaches it.
 *
 *  - the bytes: ESC/POS as they are, 8N1, no parity, flow control none or RTS/CTS, written in 1 KB
 *    slices and drained (the job takes as long as the line speed needs: ~1 ms a byte at 9600);
 *  - status: DLE EOT 1 / 2 / 4, one byte each, as over TCP (escpos.ts parseStatus) — never during a
 *    job: every use of a port waits for the one before it ends (one lock per port);
 *  - "זיהוי אוטומטי": DLE EOT 1 at 9600, 19200, 38400, 115200 — the first speed that answers with a
 *    real status byte (its fixed bits right) is the printer's;
 *  - the list: `SerialPort.list()` with Windows' friendly name and the maker, the likely printers
 *    marked (a printer maker's USB id or a printer's words in the name).
 *
 * The `serialport` package is loaded at run time (as the payment terminals' serial link is), in the
 * normal build and the Windows 7 one alike; the tests pass a fake one. Electron-free.
 */

import { parseStatus, STATUS_OFFLINE, STATUS_PAPER, STATUS_PRINTER, validStatusByte, type PrinterStatusBits } from '../../core/escpos';

export const SERIAL_BAUDS = [9600, 19200, 38400, 115200] as const;
export const DEFAULT_BAUD = 9600;
export type SerialFlow = 'none' | 'rtscts';

/** One serial printer: the port and its line. Always 8 data bits, no parity, 1 stop bit. */
export interface SerialLine {
  path: string;
  baudRate: number;
  flow: SerialFlow;
}

/** What `SerialPort.list()` gives (the parts read here). */
export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  friendlyName?: string;
  serialNumber?: string;
  pnpId?: string;
  vendorId?: string;
  productId?: string;
}

export interface SerialPortHandle {
  open(cb: (err: Error | null) => void): void;
  write(b: Buffer, cb?: (err: Error | null | undefined) => void): unknown;
  drain(cb: (err: Error | null) => void): void;
  close(cb?: (err: Error | null) => void): void;
  on(evt: 'data', cb: (b: Buffer) => void): unknown;
  on(evt: 'error', cb: (e: Error) => void): unknown;
}

export interface SerialPortModule {
  SerialPort: {
    new (o: { path: string; baudRate: number; dataBits: 8; parity: 'none'; stopBits: 1; rtscts: boolean; autoOpen: false }): SerialPortHandle;
    list(): Promise<SerialPortInfo[]>;
  };
}

/** The `serialport` package (a dependency of both builds), or null where it cannot load. */
export async function loadSerialportModule(): Promise<SerialPortModule | null> {
  const name = 'serialport';
  try {
    const m = (await import(/* @vite-ignore */ name)) as SerialPortModule & { default?: SerialPortModule };
    return m.SerialPort ? m : (m.default ?? null);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- the settings */

/** "com3", " COM12 ", "\\.\COM10" → "COM3", "COM12", "COM10"; anything else null. */
export function normalizeComPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = /^(?:\\\\\.\\)?COM(\d{1,3})$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 256 ? `COM${n}` : null;
}

/** A speed the printers use; anything else the default 9600. */
export function normalizeBaud(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && (SERIAL_BAUDS as readonly number[]).includes(n) ? n : DEFAULT_BAUD;
}

export function normalizeFlow(v: unknown): SerialFlow {
  return v === 'rtscts' ? 'rtscts' : 'none';
}

/** "COM3", "COM3:19200", "COM3:19200:rtscts" (the cloud's printer address) → the line; else null. */
export function parseSerialAddress(raw: string): SerialLine | null {
  const parts = raw.trim().split(':');
  const path = normalizeComPath(parts[0]);
  if (!path || parts.length > 3) return null;
  if (parts[1] !== undefined && !(SERIAL_BAUDS as readonly number[]).includes(Number(parts[1]))) return null;
  if (parts[2] !== undefined && !/^(rtscts|none)$/i.test(parts[2])) return null;
  return { path, baudRate: normalizeBaud(parts[1]), flow: normalizeFlow(parts[2]?.toLowerCase()) };
}

/** "COM3 · 9600" / "COM3 · 115200 · RTS/CTS". */
export function serialLineText(l: { path: string | null; baudRate?: number | null; flow?: SerialFlow | null }): string {
  return `${l.path ?? '—'} · ${normalizeBaud(l.baudRate)}${l.flow === 'rtscts' ? ' · RTS/CTS' : ''}`;
}

/* ------------------------------------------------------------------- the list */

/** USB vendor ids of receipt printer makers (as the spooler helper's list): SNBC, Epson, Star, Citizen, Custom, Bixolon, Sewoo, Xprinter, Rongta, HPRT. */
const PRINTER_VIDS = new Set(['1504', '04B8', '0519', '1D90', '0DD4', '0419', '0FE6', '20D1', '2730', '154F', '0D3A', '0619']);
const PRINTER_WORDS = /printer|receipt|thermal|pos[\s-]?print|escpos|esc\/pos|snbc|btp|epson|tm-|star\s?micronics|bixolon|citizen|sewoo|xprinter|rongta|hprt|posiflex|sunmi|imin|custom\s?spa|מדפסת/i;
/** A USB-serial bridge or a board's own UART: it may be the printer, nothing says so. */
const BRIDGE_WORDS = /ch34\d|wch|prolific|pl2303|ftdi|ft232|cp210|silicon labs|usb.?serial|communications port|serial port|קו תקשורת|יציאת תקשורת/i;

export type Likely = 'likely' | 'possible' | null;

export function likelyPrinter(p: SerialPortInfo): Likely {
  const vid = (p.vendorId ?? '').toUpperCase();
  const words = `${p.friendlyName ?? ''} ${p.manufacturer ?? ''} ${p.pnpId ?? ''}`;
  if ((vid && PRINTER_VIDS.has(vid)) || PRINTER_WORDS.test(words)) return 'likely';
  if (BRIDGE_WORDS.test(words) || /^ACPI\\PNP050[01]/i.test(p.pnpId ?? '')) return 'possible';
  return null;
}

export interface SerialPortView {
  path: string;
  /** Windows' friendly name ("USB-SERIAL CH340 (COM3)"), else the maker. */
  label: string;
  manufacturer: string | null;
  usbId: string | null;
  likely: Likely;
}

/** The ports in COM order, the likely printers first. */
export function portViews(ports: readonly SerialPortInfo[]): SerialPortView[] {
  const rank = (l: Likely) => (l === 'likely' ? 0 : l === 'possible' ? 1 : 2);
  const num = (p: string) => Number(/(\d+)$/.exec(p)?.[1] ?? 999);
  return ports
    .filter((p) => normalizeComPath(p.path))
    .map((p) => ({
      path: normalizeComPath(p.path)!,
      label: (p.friendlyName ?? '').trim() || (p.manufacturer ?? '').trim() || normalizeComPath(p.path)!,
      manufacturer: p.manufacturer?.trim() || null,
      usbId: p.vendorId && p.productId ? `${p.vendorId.toUpperCase()}:${p.productId.toUpperCase()}` : null,
      likely: likelyPrinter(p),
    }))
    .sort((a, b) => rank(a.likely) - rank(b.likely) || num(a.path) - num(b.path));
}

/* ------------------------------------------------------------------- the port */

export class SerialPrinterError extends Error {
  constructor(
    message: string,
    /** Some of the job may have reached the printer (it failed after the first byte went). */
    readonly partial = false,
  ) {
    super(message);
  }
}

export interface SerialPrintersOptions {
  load?: () => Promise<SerialPortModule | null>;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
  /** Bytes per write (1 KB). */
  chunk?: number;
  /** A status byte's wait after each question (150 ms), and after the last (250 ms). */
  answerMs?: number;
  /** "זיהוי אוטומטי": the wait for an answer at each speed (400 ms). */
  probeMs?: number;
  /** How long a slice may be held back past the time the line needs (RTS/CTS: paper out, cover open) — 10 s. */
  stallMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Every serial printer of the device: one lock per port, the port opened for a use and closed after it. */
export class SerialPrinters {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly load: () => Promise<SerialPortModule | null>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: (m: string) => void;
  private mod: SerialPortModule | null | undefined;

  constructor(private readonly o: SerialPrintersOptions = {}) {
    this.load = o.load ?? loadSerialportModule;
    this.sleep = o.sleep ?? realSleep;
    this.log = o.log ?? (() => undefined);
  }

  private async module(): Promise<SerialPortModule> {
    if (this.mod === undefined || this.mod === null) this.mod = await this.load();
    if (!this.mod) throw new SerialPrinterError('רכיב היציאות הטוריות (serialport) לא נטען — אין הדפסה ל-COM');
    return this.mod;
  }

  /** The port's uses one after the other: a status question never lands inside a job. */
  private async locked<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(path) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(path, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(path) === tail) this.locks.delete(path);
    }
  }

  /** A use of [line]'s port: opened, [fn], always closed. */
  private async withPort<T>(line: SerialLine, fn: (port: SerialPortHandle, answers: number[]) => Promise<T>): Promise<T> {
    const path = normalizeComPath(line.path);
    if (!path) throw new SerialPrinterError(`יציאה לא תקינה: ${line.path}`);
    const mod = await this.module();
    return this.locked(path, async () => {
      const port = new mod.SerialPort({ path, baudRate: normalizeBaud(line.baudRate), dataBits: 8, parity: 'none', stopBits: 1, rtscts: line.flow === 'rtscts', autoOpen: false });
      const answers: number[] = [];
      let failure: Error | null = null;
      port.on('data', (b: Buffer) => answers.push(...b));
      port.on('error', (e: Error) => {
        failure = e;
      });
      await new Promise<void>((resolve, reject) =>
        port.open((err) => (err ? reject(new SerialPrinterError(`לא ניתן לפתוח את ${path}: ${err.message}`)) : resolve())),
      );
      try {
        const out = await fn(port, answers);
        if (failure) throw new SerialPrinterError(`${path}: ${(failure as Error).message}`, true);
        return out;
      } finally {
        await new Promise<void>((r) => port.close(() => r()));
      }
    });
  }

  private write(port: SerialPortHandle, b: Buffer): Promise<void> {
    return new Promise((resolve, reject) => port.write(b, (err) => (err ? reject(err) : resolve())));
  }

  private drain(port: SerialPortHandle): Promise<void> {
    return new Promise((resolve, reject) => port.drain((err) => (err ? reject(err) : resolve())));
  }

  /**
   * A job's bytes to the printer: in slices, each drained; a slice that the printer holds back (RTS/CTS — paper out, cover
   * open) longer than the line needs plus 10 s fails the job. Throws [SerialPrinterError] (`partial` once a byte went).
   */
  async send(line: SerialLine, bytes: Uint8Array): Promise<void> {
    const chunk = this.o.chunk ?? 1024;
    await this.withPort(line, async (port) => {
      const perByteMs = 10_000 / normalizeBaud(line.baudRate);
      let sent = 0;
      for (let i = 0; i < bytes.length; i += chunk) {
        const slice = Buffer.from(bytes.subarray(i, i + chunk));
        const limit = Math.ceil(slice.length * perByteMs) + (this.o.stallMs ?? 10_000);
        try {
          await this.timed(
            (async () => {
              await this.write(port, slice);
              await this.drain(port);
            })(),
            limit,
            'המדפסת לא קיבלה את הנתונים (זמן קצוב)',
          );
        } catch (e) {
          throw new SerialPrinterError(`${line.path}: ${e instanceof Error ? e.message : String(e)}`, sent > 0);
        }
        sent += slice.length;
      }
      // What the UART still holds goes out before the port closes.
      await this.sleep(150);
    });
  }

  private async timed<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([p, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** DLE EOT 1 / 2 / 4 (never during a job: after it); null — no answer at all (or the port did not open). */
  async status(line: SerialLine): Promise<PrinterStatusBits | null> {
    const wait = this.o.answerMs ?? 150;
    try {
      return await this.withPort(line, async (port, answers) => {
        const got: Array<number | null> = [];
        for (const q of [STATUS_PRINTER, STATUS_OFFLINE, STATUS_PAPER]) {
          const before = answers.length;
          await this.write(port, Buffer.from(q));
          await this.sleep(wait);
          got.push(answers.length > before ? (answers[before] ?? null) : null);
        }
        if (got.every((b) => b === null)) return null;
        return parseStatus(got[0] ?? null, got[1] ?? null, got[2] ?? null);
      });
    } catch (e) {
      this.log(`serial status ${line.path}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * "זיהוי אוטומטי": DLE EOT 1 at each speed; the first answered with a real status byte. Null — no speed answered
   * (not a printer, switched off, or a printer that keeps silent on status).
   */
  async detectBaud(path: string, flow: SerialFlow = 'none'): Promise<number | null> {
    const wait = this.o.probeMs ?? 400;
    for (const baudRate of SERIAL_BAUDS) {
      try {
        const ok = await this.withPort({ path, baudRate, flow }, async (port, answers) => {
          await this.write(port, Buffer.from(STATUS_PRINTER));
          await this.sleep(wait);
          return answers.length > 0 && answers.every((b) => validStatusByte(b));
        });
        if (ok) return baudRate;
      } catch (e) {
        // The port itself did not open: no other speed opens it either.
        if (e instanceof SerialPrinterError && /לא ניתן לפתוח|לא נטען|לא תקינה/.test(e.message)) throw e;
        this.log(`serial probe ${path} @${baudRate}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return null;
  }

  async list(): Promise<SerialPortView[]> {
    const mod = await this.module();
    return portViews(await mod.SerialPort.list());
  }
}

/** A serial printer target from a technician's choice; null — no valid COM port named. */
export function serialTarget(comPort: unknown, baudRate: unknown, flow: unknown): { transport: 'serial'; comPort: string; baudRate: number; flow: SerialFlow } | null {
  const path = normalizeComPath(comPort);
  return path ? { transport: 'serial', comPort: path, baudRate: normalizeBaud(baudRate), flow: normalizeFlow(flow) } : null;
}

/** The COM port a payment terminal's address names ("USB COM5", "COM5 (…)"), if any. */
export function comPortIn(address: string | null | undefined): string | null {
  const m = /\bCOM(\d{1,3})\b/i.exec(address ?? '');
  return m ? `COM${Number(m[1])}` : null;
}
