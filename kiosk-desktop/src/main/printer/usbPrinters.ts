/**
 * A USB receipt printer found by itself on Windows (docs/SPEC_KIOSK.md §14.7) — no libusb, no
 * WinUSB, nothing downloaded: the spooler helper's `usb` op (transports.ts) lists
 *
 *  - the printer queues (Win32_Printer) — a USB printer with a driver has one on a USB port: Windows'
 *    "USB001", or its maker's own port monitor (SNBC's "BYUSBC_BTP-S70_1", Epson's "TMUSB001");
 *  - the USB printer devices present (Win32_PnPEntity: the "USB Printing Support" device, service
 *    `usbprint`, its `USBPRINT\…` child, and a receipt printer maker's device by its vendor id —
 *    ConfigManagerErrorCode 28 when no driver is installed);
 *  - the USB printer ports and whether a device is on each now (the usbprint interface's registry
 *    keys: "Port Number" and `Control\Linked`), when Windows lets it read them.
 *
 * Pure rules here ([pickUsbPrinter], [resolvePrinterTarget], [usbStatusText]) and a small watcher
 * ([UsbPrinterWatch]) that looks at start and every 15 s. A printer target set explicitly (a queue
 * name, or TCP) always wins; an empty one ("אוטומטי") takes the USB-port queue of the printer that
 * is plugged in, before guessing by name (SNBC / BTP, then Generic / Text Only — as before).
 */

import { guessQueue, type PrinterHealth, type PrinterTarget, type Transport } from './transports';

export interface QueueInfo {
  name: string;
  /** Win32_Printer.PortName: "USB001", "TMUSB001", "IP_192.168.1.60", "PORTPROMPT:"… */
  port: string | null;
  driver?: string | null;
  health: PrinterHealth;
}

export interface UsbDeviceInfo {
  name: string;
  /** PNPDeviceID: "USB\VID_154F&PID_1300\…" (usbprint, or a receipt printer maker's) or "USBPRINT\SNBCBTP-880\…". */
  id: string;
  /** Win32_PnPEntity.ConfigManagerErrorCode: 0 fine, 28 no driver installed. */
  error: number | null;
  service?: string | null;
  /** Win32_PnPEntity.PNPClass: "Printer", "USB", none while no driver… ("Image": a scanner). */
  cls?: string | null;
}

export interface UsbPortInfo {
  /** "USB001". */
  port: string;
  /** A device is on the port now. */
  linked: boolean;
  description?: string | null;
}

/** One look at the printers; `devices` / `ports` null: not known (not Windows, or not readable). */
export interface UsbScan {
  queues: QueueInfo[];
  devices: UsbDeviceInfo[] | null;
  ports: UsbPortInfo[] | null;
  at: number;
}

export type UsbState = 'connected' | 'not_found' | 'no_driver';

export interface UsbPick {
  state: UsbState;
  /** The queue a page goes to ("connected" only). */
  queue: string | null;
  /** What to call it: the device's name, else the queue's. */
  name: string | null;
}

/** Windows' own USB printer ports (usbmon): USB001, USB002… — whose presence the ports tell. */
export const STANDARD_USB_PORT = /^USB\d+$/i;

/**
 * A queue on a USB port: Windows' USB001…, or a printer maker's own USB port monitor — SNBC's
 * "BYUSBC_BTP-S70_1", Epson's "TMUSB001" — never a network one.
 */
export function isUsbQueue(q: Pick<QueueInfo, 'port'>): boolean {
  const port = q.port?.trim() ?? '';
  return /usb/i.test(port) && !/^(IP_|WSD|TCP|HTTP)/i.test(port);
}

/** USB vendor ids (hex, as Windows writes them) of receipt printer makers — the till's list (pos-android UsbPrinterFilter). */
export const PRINTER_VENDORS: ReadonlySet<string> = new Set(['1504', '04B8', '0519', '1D90', '2730', '0DD4', '154F', '0D3A', '0619']);

/** Device classes that are never a printer, though the maker may be one (an Epson scanner is "Image"). */
const NOT_A_PRINTER_CLASS = /^(image|camera|hidclass|keyboard|mouse|diskdrive|wpd|media|net|bluetooth|ports|biometric)$/i;

/** A USB printer device: the usbprint function, the printer usbprint found on it, or a receipt printer maker's device. */
export function isUsbPrinterDevice(d: UsbDeviceInfo): boolean {
  if (/^USBPRINT\\/i.test(d.id) || (d.service ?? '').toLowerCase() === 'usbprint') return true;
  const vid = /^USB\\VID_([0-9A-F]{4})&/i.exec(d.id)?.[1]?.toUpperCase();
  return !!vid && PRINTER_VENDORS.has(vid) && !NOT_A_PRINTER_CLASS.test(d.cls ?? '');
}

const ESC_POS_NAME = /btp|snbc|bixolon|epson|\btm-|star|citizen|xprinter|posiflex|receipt|thermal|pos-?80|80\s?mm/i;
const GENERIC_TEXT = /generic.*text only/i;
const UNHEALTHY: ReadonlySet<PrinterHealth> = new Set(['offline', 'unavailable', 'error']);

/** The best of several USB queues: healthy, then a receipt printer's name, then Generic / Text Only, then by name. */
function rank(a: QueueInfo, b: QueueInfo): number {
  const score = (q: QueueInfo) =>
    (UNHEALTHY.has(q.health) ? 0 : 4) + (ESC_POS_NAME.test(q.name) || ESC_POS_NAME.test(q.driver ?? '') ? 2 : 0) + (GENERIC_TEXT.test(q.name) ? 1 : 0);
  return score(b) - score(a) || a.name.localeCompare(b.name);
}

/**
 * The USB printer as it is now:
 *  - **connected** — a USB-port queue whose printer is plugged in (its port linked; or, when the
 *    ports cannot be read, a USB printer device present; or, when nothing but the queues is
 *    known, the queue itself) — the best one when there are several;
 *  - **no_driver** — a USB printer is plugged in and has no queue (a linked port with no queue, a
 *    `USBPRINT` device Windows has no driver for, or a usbprint device and no USB queue at all):
 *    install "Generic / Text Only" on its port;
 *  - **not_found** — nothing plugged in.
 */
export function pickUsbPrinter(scan: UsbScan): UsbPick {
  const usbQueues = scan.queues.filter(isUsbQueue);
  const printers = scan.devices?.filter(isUsbPrinterDevice) ?? null;
  const devicePresent = printers ? printers.some((d) => (d.error ?? 0) === 0) : null;
  const linked = scan.ports ? new Set(scan.ports.filter((p) => p.linked).map((p) => p.port.toUpperCase())) : null;
  const healthy = (q: QueueInfo) => q.health !== 'offline' && q.health !== 'unavailable';
  const present = usbQueues.filter((q) => {
    const port = (q.port ?? '').trim().toUpperCase();
    // Windows' own port: on it now, when the ports say.
    if (linked && STANDARD_USB_PORT.test(port)) return linked.has(port);
    // A maker's port monitor (or no ports to read): a USB printer device is present.
    if (devicePresent !== null) return devicePresent && healthy(q);
    // Nothing but the queues (not Windows, a test): the queue itself.
    return healthy(q);
  });
  if (present.length > 0) {
    const best = [...present].sort(rank)[0];
    return { state: 'connected', queue: best.name, name: best.name };
  }
  const queuePorts = new Set(usbQueues.map((q) => (q.port ?? '').trim().toUpperCase()));
  const bareLinked = scan.ports?.find((p) => p.linked && !queuePorts.has(p.port.toUpperCase())) ?? null;
  const driverless = printers?.find((d) => d.error !== null && d.error !== 0) ?? null;
  const queueless = devicePresent && usbQueues.length === 0 ? (printers?.find((d) => (d.error ?? 0) === 0) ?? null) : null;
  if (bareLinked || driverless || queueless) {
    return { state: 'no_driver', queue: null, name: driverless?.name ?? queueless?.name ?? bareLinked?.description ?? null };
  }
  return { state: 'not_found', queue: null, name: null };
}

/** "אוטומטי": no printer target set, or a Windows queue with no name. */
export function isAutoTarget(t: PrinterTarget | null | undefined): boolean {
  return !t || (t.transport === 'spooler' && !t.queueName?.trim());
}

export interface PrinterResolution {
  target: PrinterTarget;
  /** The target was found by itself (the setting is "אוטומטי"). */
  auto: boolean;
  /** setting: as set · usb: the USB printer plugged in · name: guessed by name · none: nothing found. */
  via: 'setting' | 'usb' | 'name' | 'none';
}

/** Where a page goes: the target set wins; "אוטומטי" — the USB printer plugged in, then a name guess. */
export function resolvePrinterTarget(configured: PrinterTarget | null | undefined, scan: UsbScan | null): PrinterResolution {
  if (configured && !isAutoTarget(configured)) return { target: configured, auto: false, via: 'setting' };
  const pick = scan ? pickUsbPrinter(scan) : null;
  if (pick?.queue) return { target: { transport: 'spooler', queueName: pick.queue }, auto: true, via: 'usb' };
  const guessed = guessQueue(scan?.queues.map((q) => q.name) ?? []);
  if (guessed) return { target: { transport: 'spooler', queueName: guessed }, auto: true, via: 'name' };
  return { target: { transport: 'spooler', queueName: null }, auto: true, via: 'none' };
}

/** "מדפסת USB: …" for the staff layer and the bridge window. */
export function usbStatusText(pick: UsbPick | null): string {
  if (!pick || pick.state === 'not_found') return 'מדפסת USB: לא נמצאה';
  if (pick.state === 'no_driver') return 'מדפסת USB: נמצא מכשיר בלי דרייבר — התקינו Generic / Text Only';
  return `מדפסת USB: ${pick.name ?? pick.queue ?? 'USB'} מחוברת`;
}

/** The target in words: "Windows: SNBC BTP-880 (USB · אוטומטי)", "TCP 192.168.1.50:9100"… */
export function targetText(r: PrinterResolution): string {
  const t = r.target;
  if (t.transport === 'tcp') return `TCP ${t.host ?? '—'}:${t.port ?? 9100}`;
  if (t.transport !== 'spooler') return '—';
  if (!r.auto) return `Windows: ${t.queueName ?? '—'}`;
  if (r.via === 'usb') return `Windows: ${t.queueName} (USB · אוטומטי)`;
  if (r.via === 'name') return `Windows: ${t.queueName} (אוטומטי)`;
  return 'אוטומטי — לא נמצאה מדפסת';
}

/* --------------------------------------------------------------- the helper's answer */

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** PowerShell's ConvertTo-Json gives one object, not a one-item array: either is a list here. */
const list = (v: unknown): Array<Record<string, unknown>> =>
  (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');

/** The `usb` op's answer as a scan (`health` from the queue's Win32 state, as `list`). */
export function scanOf(raw: Record<string, unknown>, health: (q: Record<string, unknown>) => PrinterHealth, at: number): UsbScan {
  const queues = list(raw.queues).map((q) => ({ name: str(q.name) ?? '', port: str(q.port), driver: str(q.driver), health: health(q) })).filter((q) => q.name);
  const devices =
    raw.devices === undefined || raw.devices === null
      ? null
      : list(raw.devices).map((d) => ({ name: str(d.name) ?? '', id: str(d.id) ?? '', error: num(d.error), service: str(d.service), cls: str(d.cls) }));
  const ports =
    raw.ports === undefined || raw.ports === null
      ? null
      : list(raw.ports)
          .map((p) => ({ port: (str(p.port) ?? '').toUpperCase(), linked: p.linked === true, description: str(p.description) }))
          .filter((p) => p.port);
  return { queues, devices, ports, at };
}

/* --------------------------------------------------------------------- the watcher */

/** How often the printers are looked at (a plug-in is seen within this). */
export const USB_SCAN_INTERVAL_MS = 15_000;

/**
 * The printers as last seen: at start, every [USB_SCAN_INTERVAL_MS], and on demand ("רענון",
 * a test print). Never while a page is on its way through the same helper ([busy]). A transport
 * without the `usb` op (tests, a demo) is looked at through its queue list.
 */
export class UsbPrinterWatch {
  private last: UsbScan | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<UsbScan | null> | null = null;
  private listeners = new Set<() => void>();
  private signature = '';

  constructor(
    private readonly transport: Transport,
    private readonly log: (m: string) => void = () => undefined,
    private readonly busy: () => boolean = () => false,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(intervalMs = USB_SCAN_INTERVAL_MS) {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => {
      if (!this.busy()) void this.refresh();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  current(): UsbScan | null {
    return this.last;
  }

  pick(): UsbPick | null {
    return this.last ? pickUsbPrinter(this.last) : null;
  }

  /** Look now (one look at a time: a second caller gets the same answer). */
  refresh(): Promise<UsbScan | null> {
    if (this.running) return this.running;
    this.running = this.look().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async look(): Promise<UsbScan | null> {
    let scan: UsbScan | null;
    try {
      scan = this.transport.usbScan
        ? await this.transport.usbScan()
        : { queues: await this.transport.list(), devices: null, ports: null, at: this.now() };
    } catch (e) {
      this.log(`usb printers: not looked at (${e instanceof Error ? e.message : String(e)})`);
      return this.last;
    }
    const pick = pickUsbPrinter(scan);
    const signature = JSON.stringify([pick, scan.queues.map((q) => [q.name, q.port, q.health])]);
    const before = this.last ? pickUsbPrinter(this.last) : null;
    this.last = scan;
    if (signature !== this.signature) {
      this.signature = signature;
      if (!before || before.state !== pick.state || before.queue !== pick.queue) this.log(`usb printers: ${usbStatusText(pick)}${pick.queue ? ` (${pick.queue})` : ''}`);
      for (const fn of this.listeners) fn();
    }
    return scan;
  }
}
