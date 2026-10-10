/**
 * The USB receipt printer found by itself on Windows (src/main/printer/usbPrinters.ts,
 * docs/SPEC_KIOSK.md §14.7): which queue is a USB printer plugged in, a device with no driver,
 * "אוטומטי" against a printer set by hand, the words the staff see, and the kiosk service printing
 * through it. Nothing reaches a real printer: the transports are fakes.
 */

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KioskService } from '../src/main/service';
import type { PrinterTarget, Transport } from '../src/main/printer/transports';
import {
  isAutoTarget,
  isUsbPrinterDevice,
  isUsbQueue,
  pickUsbPrinter,
  resolvePrinterTarget,
  scanOf,
  targetText,
  usbStatusText,
  UsbPrinterWatch,
  type QueueInfo,
  type UsbDeviceInfo,
  type UsbPortInfo,
  type UsbScan,
} from '../src/main/printer/usbPrinters';

const q = (name: string, port: string | null, health: QueueInfo['health'] = 'ok', driver: string | null = null): QueueInfo => ({ name, port, health, driver });
const scan = (queues: QueueInfo[], devices: UsbDeviceInfo[] | null = null, ports: UsbPortInfo[] | null = null): UsbScan => ({ queues, devices, ports, at: 0 });
const usbprint = (error = 0): UsbDeviceInfo => ({ name: 'USB Printing Support', id: 'USB\\VID_154F&PID_1300\\SN01', error, service: 'usbprint', cls: 'USB' });
const child = (name: string, error = 0): UsbDeviceInfo => ({ name, id: 'USBPRINT\\SNBCBTP-880\\7&1A2B&0&USB001', error, service: null, cls: error === 0 ? 'Printer' : null });

/** The PC's printers as Windows has them besides the receipt printer. */
const OFFICE = [q('Microsoft Print to PDF', 'PORTPROMPT:'), q('OneNote (Desktop)', 'nul:'), q('Brother MFC-L3760CDW', 'WSD-67c349d5-1d34')];

describe('which queues and devices are USB printers', () => {
  it('a queue on a USB port: Windows’ own, or a printer maker’s port monitor — never a network one', () => {
    expect(isUsbQueue({ port: 'USB001' })).toBe(true);
    expect(isUsbQueue({ port: 'usb012' })).toBe(true);
    expect(isUsbQueue({ port: 'TMUSB001' })).toBe(true);
    // SNBC's own driver (BTP-S70 on a real Windows PC here).
    expect(isUsbQueue({ port: 'BYUSBC_BTP-S70_1' })).toBe(true);
    for (const port of ['PORTPROMPT:', 'nul:', 'IP_192.168.1.60', 'WSD-67c349d5', 'COM3:', 'LPT1:', null]) {
      expect(isUsbQueue({ port })).toBe(false);
    }
  });

  it('a USB printer device: usbprint, its USBPRINT child, or a receipt printer maker that is not a scanner', () => {
    expect(isUsbPrinterDevice(usbprint())).toBe(true);
    expect(isUsbPrinterDevice(child('SNBC BTP-880'))).toBe(true);
    expect(isUsbPrinterDevice({ name: 'BTP-S70', id: 'USB\\VID_154F&PID_1003\\X', error: 0, service: 'BYUSBC', cls: 'USB' })).toBe(true);
    expect(isUsbPrinterDevice({ name: 'Epson scanner', id: 'USB\\VID_04B8&PID_0142\\X', error: 0, service: 'usbscan', cls: 'Image' })).toBe(false);
    expect(isUsbPrinterDevice({ name: 'Integrated Webcam', id: 'USB\\VID_1BCF&PID_2A03&MI_02\\X', error: 0, service: 'usbvideo', cls: 'Camera' })).toBe(false);
    expect(isUsbPrinterDevice({ name: 'Generic USB Hub', id: 'USB\\VID_0BDA&PID_5411\\X', error: 0, service: 'USBHUB3', cls: 'USB' })).toBe(false);
  });
});

describe('the USB printer as it is now', () => {
  it('plugged in, with a queue on its port: connected, and that queue', () => {
    const s = scan([...OFFICE, q('SNBC BTP-880', 'USB001')], [usbprint(), child('SNBC BTP-880')], [{ port: 'USB001', linked: true }]);
    expect(pickUsbPrinter(s)).toEqual({ state: 'connected', queue: 'SNBC BTP-880', name: 'SNBC BTP-880' });
  });

  it('unplugged: its queue stays in Windows but the port is empty — not found', () => {
    const s = scan([...OFFICE, q('SNBC BTP-880', 'USB001')], [], [{ port: 'USB001', linked: false }]);
    expect(pickUsbPrinter(s)).toEqual({ state: 'not_found', queue: null, name: null });
  });

  it('plugged in with no driver: a port with no queue, or a USBPRINT device Windows has no driver for', () => {
    const bare = scan(OFFICE, [usbprint(), child('BTP-880', 28)], [{ port: 'USB002', linked: true }]);
    expect(pickUsbPrinter(bare).state).toBe('no_driver');
    expect(pickUsbPrinter(bare).queue).toBeNull();
    // The ports could not be read: the device says it.
    expect(pickUsbPrinter(scan(OFFICE, [usbprint(), child('BTP-880', 28)], null)).state).toBe('no_driver');
    // usbprint up and no USB queue at all.
    expect(pickUsbPrinter(scan(OFFICE, [usbprint()], null)).state).toBe('no_driver');
    expect(usbStatusText(pickUsbPrinter(bare))).toBe('מדפסת USB: נמצא מכשיר בלי דרייבר — התקינו Generic / Text Only');
  });

  it('a printer maker’s own USB driver: connected while its device is present', () => {
    const snbc: UsbDeviceInfo = { name: 'BTP-S70', id: 'USB\\VID_154F&PID_1003\\X', error: 0, service: 'BYUSBC', cls: 'USB' };
    const queues = [...OFFICE, q('BTP-S70(U)1', 'BYUSBC_BTP-S70_1')];
    expect(pickUsbPrinter(scan(queues, [snbc], [])).queue).toBe('BTP-S70(U)1');
    // As on the PC this was written on: the queue, no device — not found (the name guess still prints there).
    expect(pickUsbPrinter(scan(queues, [], [])).state).toBe('not_found');
  });

  it('several plugged in: a healthy one with a receipt printer’s name first', () => {
    const s = scan(
      [q('Old label printer', 'USB003', 'offline'), q('Generic / Text Only', 'USB002'), q('SNBC BTP-880', 'USB001')],
      [usbprint(), child('SNBC BTP-880')],
      [{ port: 'USB001', linked: true }, { port: 'USB002', linked: true }, { port: 'USB003', linked: true }],
    );
    expect(pickUsbPrinter(s).queue).toBe('SNBC BTP-880');
  });

  it('nothing known but the queues (not Windows, a test): a healthy USB queue is the printer', () => {
    expect(pickUsbPrinter(scan([...OFFICE, q('POS-80', 'USB001')])).queue).toBe('POS-80');
    expect(pickUsbPrinter(scan([...OFFICE, q('POS-80', 'USB001', 'unavailable')])).state).toBe('not_found');
    expect(pickUsbPrinter(scan(OFFICE)).state).toBe('not_found');
  });

  it('the staff’s words', () => {
    expect(usbStatusText({ state: 'connected', queue: 'SNBC BTP-880', name: 'SNBC BTP-880' })).toBe('מדפסת USB: SNBC BTP-880 מחוברת');
    expect(usbStatusText({ state: 'not_found', queue: null, name: null })).toBe('מדפסת USB: לא נמצאה');
    expect(usbStatusText(null)).toBe('מדפסת USB: לא נמצאה');
    expect(usbStatusText({ state: 'no_driver', queue: null, name: 'BTP-880' })).toBe('מדפסת USB: נמצא מכשיר בלי דרייבר — התקינו Generic / Text Only');
  });
});

describe('"אוטומטי" against a printer set by hand', () => {
  const plugged = scan([...OFFICE, q('POS-80', 'USB001'), q('Generic / Text Only', 'USB002')], [usbprint(), child('POS-80')], [{ port: 'USB001', linked: true }, { port: 'USB002', linked: false }]);
  const unplugged = scan([...OFFICE, q('POS-80', 'USB001'), q('Generic / Text Only', 'USB002')], [], [{ port: 'USB001', linked: false }, { port: 'USB002', linked: false }]);

  it('empty, or a Windows queue with no name, is automatic', () => {
    expect(isAutoTarget(null)).toBe(true);
    expect(isAutoTarget({ transport: 'spooler', queueName: null })).toBe(true);
    expect(isAutoTarget({ transport: 'spooler', queueName: '  ' })).toBe(true);
    expect(isAutoTarget({ transport: 'spooler', queueName: 'POS-80' })).toBe(false);
    expect(isAutoTarget({ transport: 'tcp', host: '192.168.1.50', port: 9100 })).toBe(false);
  });

  it('automatic: the USB printer plugged in, before any name guess', () => {
    expect(resolvePrinterTarget({ transport: 'spooler', queueName: null }, plugged)).toEqual({ target: { transport: 'spooler', queueName: 'POS-80' }, auto: true, via: 'usb' });
    expect(resolvePrinterTarget(null, plugged).via).toBe('usb');
  });

  it('automatic, unplugged: back to the name guess, as before (Generic / Text Only)', () => {
    expect(resolvePrinterTarget(null, unplugged)).toEqual({ target: { transport: 'spooler', queueName: 'Generic / Text Only' }, auto: true, via: 'name' });
    expect(resolvePrinterTarget(null, scan(OFFICE))).toEqual({ target: { transport: 'spooler', queueName: null }, auto: true, via: 'none' });
    expect(resolvePrinterTarget(null, null).via).toBe('none');
  });

  it('a queue or an address set by hand always wins', () => {
    const pdf: PrinterTarget = { transport: 'spooler', queueName: 'Microsoft Print to PDF' };
    expect(resolvePrinterTarget(pdf, plugged)).toEqual({ target: pdf, auto: false, via: 'setting' });
    const tcp: PrinterTarget = { transport: 'tcp', host: '192.168.1.50', port: 9100 };
    expect(resolvePrinterTarget(tcp, plugged)).toEqual({ target: tcp, auto: false, via: 'setting' });
  });

  it('the target in words', () => {
    expect(targetText(resolvePrinterTarget(null, plugged))).toBe('Windows: POS-80 (USB · אוטומטי)');
    expect(targetText(resolvePrinterTarget(null, unplugged))).toBe('Windows: Generic / Text Only (אוטומטי)');
    expect(targetText(resolvePrinterTarget(null, scan(OFFICE)))).toBe('אוטומטי — לא נמצאה מדפסת');
    expect(targetText(resolvePrinterTarget({ transport: 'spooler', queueName: 'POS-80' }, plugged))).toBe('Windows: POS-80');
    expect(targetText(resolvePrinterTarget({ transport: 'tcp', host: '10.0.0.5', port: 9100 }, plugged))).toBe('TCP 10.0.0.5:9100');
  });
});

describe('the spooler helper’s answer', () => {
  const health = () => 'ok' as const;

  it('one queue or device comes as an object, not a list; null devices or ports are "not known"', () => {
    const s = scanOf({ ok: true, queues: { name: 'POS-80', port: 'USB001', driver: 'Generic / Text Only' }, devices: { name: 'USB Printing Support', id: 'USB\\VID_154F&PID_1300\\1', error: 0, service: 'usbprint', cls: 'USB' }, ports: null }, health, 5);
    expect(s.queues).toEqual([{ name: 'POS-80', port: 'USB001', driver: 'Generic / Text Only', health: 'ok' }]);
    expect(s.devices).toHaveLength(1);
    expect(s.ports).toBeNull();
    expect(s.at).toBe(5);
  });

  it('empty lists are "none there", and ports are upper-cased', () => {
    const s = scanOf({ ok: true, queues: [], devices: [], ports: [{ port: 'usb001', linked: true, description: 'Virtual printer port for USB' }] }, health, 0);
    expect(s.devices).toEqual([]);
    expect(s.ports).toEqual([{ port: 'USB001', linked: true, description: 'Virtual printer port for USB' }]);
  });
});

/* -------------------------------------------------------------- the watcher and the service */

/** A PC whose USB printer is plugged in and out by the test; every page is kept with its target. */
function fakePc() {
  const state = { plugged: true, sent: [] as Array<{ target: PrinterTarget; bytes: number }>, scans: 0 };
  const transport: Transport = {
    send: async (target, bytes) => void state.sent.push({ target, bytes: bytes.length }),
    status: async () => ({ health: 'ok', detail: null }),
    list: async () => [],
    usbScan: async () => {
      state.scans++;
      return scan(
        [...OFFICE, q('POS-80', 'USB001'), q('Generic / Text Only', 'USB002')],
        state.plugged ? [usbprint(), child('POS-80')] : [],
        [{ port: 'USB001', linked: state.plugged }, { port: 'USB002', linked: false }],
      );
    },
    dispose: () => undefined,
  };
  return { state, transport };
}

const until = async (ok: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('the watcher', () => {
  it('says a change once, and one look at a time', async () => {
    const pc = fakePc();
    const watch = new UsbPrinterWatch(pc.transport);
    let changes = 0;
    watch.onChange(() => changes++);
    await Promise.all([watch.refresh(), watch.refresh()]);
    expect(pc.state.scans).toBe(1);
    expect(watch.pick()?.state).toBe('connected');
    await watch.refresh();
    expect(changes).toBe(1);
    pc.state.plugged = false;
    await watch.refresh();
    expect(watch.pick()?.state).toBe('not_found');
    expect(changes).toBe(2);
  });

  it('a transport without the usb look is watched through its queue list', async () => {
    const watch = new UsbPrinterWatch({ send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [{ name: 'SNBC BTP-880', port: 'USB001', health: 'ok' }], dispose: () => undefined });
    await watch.refresh();
    expect(watch.pick()).toEqual({ state: 'connected', queue: 'SNBC BTP-880', name: 'SNBC BTP-880' });
  });

  it('a failed look keeps the last one', async () => {
    let fail = false;
    const watch = new UsbPrinterWatch({
      send: async () => undefined,
      status: async () => ({ health: 'ok', detail: null }),
      list: async () => [],
      usbScan: async () => {
        if (fail) throw new Error('helper exited');
        return scan([q('POS-80', 'USB001')]);
      },
      dispose: () => undefined,
    });
    await watch.refresh();
    fail = true;
    await watch.refresh();
    expect(watch.pick()?.queue).toBe('POS-80');
  });
});

describe('the kiosk service prints on the USB printer by itself', () => {
  const open: KioskService[] = [];
  afterEach(() => {
    for (const s of open.splice(0)) s.stop();
  });
  const renderer = async () => ({ width: 16, height: 16, rgba: new Uint8Array(16 * 16 * 4).fill(255) });

  function service(transport: Transport) {
    const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-usb-')), appVersion: '0.3.0', deviceInfo: { platform: 'windows' }, transport, renderer, downloader: async () => { throw new Error('no media'); } });
    open.push(svc);
    return svc;
  }

  it('automatic: the test page goes to the USB queue; unplugged, to the name guess; a queue set by hand wins', async () => {
    const pc = fakePc();
    const svc = service(pc.transport);
    expect(svc.localSettings().printer).toEqual({ transport: 'spooler', queueName: null });
    await svc.printTest();
    await until(() => pc.state.sent.length === 1);
    expect(pc.state.sent[0].target).toEqual({ transport: 'spooler', queueName: 'POS-80' });
    expect(svc.adminInfo().printer).toMatchObject({ target: 'Windows: POS-80 (USB · אוטומטי)', usb: 'מדפסת USB: POS-80 מחוברת', auto: true });

    pc.state.plugged = false;
    await svc.printTest();
    await until(() => pc.state.sent.length === 2);
    expect(pc.state.sent[1].target).toEqual({ transport: 'spooler', queueName: 'Generic / Text Only' });
    expect(svc.adminInfo().printer.usb).toBe('מדפסת USB: לא נמצאה');
    // Nothing found by itself was saved: plugged back in, it is taken again.
    expect(svc.localSettings().printer).toEqual({ transport: 'spooler', queueName: null });

    pc.state.plugged = true;
    svc.setLocalSettings({ printer: { transport: 'spooler', queueName: 'Microsoft Print to PDF' } });
    await svc.printTest();
    await until(() => pc.state.sent.length === 3);
    expect(pc.state.sent[2].target).toEqual({ transport: 'spooler', queueName: 'Microsoft Print to PDF' });
    expect(svc.adminInfo().printer).toMatchObject({ target: 'Windows: Microsoft Print to PDF', auto: false, usb: 'מדפסת USB: POS-80 מחוברת' });
  });
});
