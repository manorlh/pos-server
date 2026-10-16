/**
 * A USB receipt printer from the browser (WebUSB — Chrome / Edge on a PC, Chrome on Android;
 * Chromium 108 has it; Safari does not). The printer must have been allowed once in the
 * browser's chooser (`pair()`, from a tap — the technician's "חיבור מדפסת USB"); after that the
 * page finds it by vendor:product (`usb://04b8:0e15`) without asking again.
 *
 * Bytes only: the engine drew the receipt; this sends them to the printer interface's bulk OUT
 * endpoint in slices. Windows keeps a printer that has a driver to itself — WebUSB then cannot
 * claim it ("no_device"): such a PC prints through the bridge or a network printer instead.
 */

import { chunk } from '../escpos';
import { HwError, type HardwarePort, type ParsedTarget, type PrintJobInfo } from '../HardwarePort';

export const USB_PRINTER_CLASS = 7;
export const USB_VENDOR_SPECIFIC_CLASS = 0xff;

export interface UsbEndpointLike {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}

export interface UsbAlternateLike {
  interfaceClass: number;
  endpoints: UsbEndpointLike[];
}

export interface UsbInterfaceLike {
  interfaceNumber: number;
  claimed?: boolean;
  alternate: UsbAlternateLike;
}

export interface UsbConfigurationLike {
  configurationValue: number;
  interfaces: UsbInterfaceLike[];
}

export interface UsbDeviceLike {
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: UsbConfigurationLike | null;
  open(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: Uint8Array): Promise<{ status: 'ok' | 'stall' | 'babble'; bytesWritten?: number }>;
  close(): Promise<void>;
}

export interface UsbLike {
  getDevices(): Promise<UsbDeviceLike[]>;
  requestDevice(o: { filters: Array<{ classCode?: number; vendorId?: number; productId?: number }> }): Promise<UsbDeviceLike>;
}

/** The interface to print on: the printer class first, a vendor-specific one with a bulk OUT next. */
export function findBulkOut(config: UsbConfigurationLike | null): { interfaceNumber: number; endpointNumber: number } | null {
  if (!config) return null;
  const pick = (cls: number) => {
    for (const itf of config.interfaces) {
      if (itf.alternate.interfaceClass !== cls) continue;
      const ep = itf.alternate.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (ep) return { interfaceNumber: itf.interfaceNumber, endpointNumber: ep.endpointNumber };
    }
    return null;
  };
  return pick(USB_PRINTER_CLASS) ?? pick(USB_VENDOR_SPECIFIC_CLASS);
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0');

export class WebUsbPrinterPort implements HardwarePort {
  readonly name = 'webusb';
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly usb: UsbLike,
    private readonly chunkSize = 16_384,
  ) {}

  supports(t: ParsedTarget): boolean {
    return t.scheme === 'usb';
  }

  /** The browser's chooser (needs a tap): printers first; returns the target to save. */
  async pair(): Promise<string> {
    const d = await this.usb.requestDevice({ filters: [{ classCode: USB_PRINTER_CLASS }] });
    return `usb://${hex4(d.vendorId)}:${hex4(d.productId)}`;
  }

  print(t: ParsedTarget, bytes: Uint8Array, _job: PrintJobInfo): Promise<void> {
    // One job at a time per port: two receipts never interleave on the wire.
    const run = this.queue.then(() => this.send(t, bytes));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async send(t: ParsedTarget, bytes: Uint8Array): Promise<void> {
    const devices = await this.usb.getDevices();
    const dev = devices.find((d) => d.vendorId === t.vendorId && d.productId === t.productId);
    if (!dev) throw new HwError('not_permitted', 'המדפסת לא אושרה בדפדפן הזה — "חיבור מדפסת USB" בתפריט הטכנאי');
    try {
      if (!dev.opened) await dev.open();
      if (!dev.configuration) await dev.selectConfiguration(1);
      const out = findBulkOut(dev.configuration);
      if (!out) throw new HwError('no_device', 'למכשיר אין ממשק מדפסת');
      const itf = dev.configuration?.interfaces.find((i) => i.interfaceNumber === out.interfaceNumber);
      if (!itf?.claimed) await dev.claimInterface(out.interfaceNumber);
      for (const part of chunk(bytes, this.chunkSize)) {
        const r = await dev.transferOut(out.endpointNumber, part);
        if (r.status !== 'ok') throw new HwError('io', `המדפסת לא קיבלה (${r.status})`);
      }
    } catch (e) {
      if (e instanceof HwError) throw e;
      // Windows holds a printer with a driver: claiming it fails.
      throw new HwError('no_device', `אין גישה למדפסת USB: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
