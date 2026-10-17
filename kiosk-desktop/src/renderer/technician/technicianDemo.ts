/**
 * The technician's screen in the browser demo (`npm run dev:web`, code 1995): made-up facts, every action answered as
 * "הדגמה" — nothing here reaches a device or a cloud. `?tech=till` shows it as a till's ("טכנאי").
 */

import type { TechnicianAction, TechnicianActionResult, TechnicianSetupView } from '../../shared/bridge';
import { pickerView, type PickerView } from '../../core/printerPicker';

/**
 * "מדפסות" in the demo: a view a smoke run captured from a real device (`window.__R2M_PICKER__`, set by printerPicker.html),
 * else made-up printers.
 */
export function demoPicker(): PickerView {
  const snap = typeof window !== 'undefined' ? (window as unknown as { __R2M_PICKER__?: PickerView }).__R2M_PICKER__ : undefined;
  if (snap) return snap;
  return pickerView(
    {
      queues: [
        { name: 'SNBC BTP-R880NPV', port: 'BYUSBC_BTP-S70_1', health: 'ok' },
        { name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', health: 'ok' },
      ],
      usbNoDriver: [],
      serial: [{ path: 'COM3', name: 'USB-SERIAL CH340 (COM3)' }],
      network: [
        { host: '192.168.1.71', port: 9100, health: 'ok' },
        { host: '192.168.1.88', port: 9100, health: 'no_paper' },
      ],
      saved: [{ host: '192.168.1.71', port: 9100, health: 'ok', name: 'מטבח חם' }],
      chosen: { receipt: null, bon: { transport: 'tcp', host: '192.168.1.71', port: 9100 }, ticket: null },
      autoQueue: 'SNBC BTP-R880NPV',
    },
    { widthDots: 576, widths: [576, 512, 432, 384], scannedAt: Date.now(), lanScanning: false, subnet: '192.168.1.0/24' },
  );
}

const role = (): TechnicianSetupView['role'] => (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('tech') === 'till' ? 'till' : 'kiosk');

export function demoTechnicianSetup(): TechnicianSetupView {
  const r = role();
  return {
    role: r,
    appVersion: '0.5.18',
    lights: { cloud: 'ok', pinpad: 'ok', printer: 'ok', media: 'warn', mediaFiles: 42, mediaMissing: 1 },
    identity: {
      company: 'עסק הדגמה בע״מ',
      shop: 'סניף הדגמה',
      machineName: r === 'till' ? 'קופה 2' : 'קיוסק כניסה',
      machineId: '549e903c-0000-4000-8000-00000000demo',
      posNumber: r === 'till' ? '2' : '7',
      documentPrefix: r === 'till' ? '2' : '7',
      role: r,
      zMode: 'cloud',
      lastSyncAt: Date.now() - 45_000,
      configVersion: '2026-10-17T09:12:00Z',
      serverUrl: 'https://api.example.invalid',
      products: 76,
      catalogAt: Date.now() - 300_000,
      staff: 9,
    },
    quickSupportPath: 'C:\\Program Files\\TeamViewer\\TeamViewer.exe',
    computer: { hostname: 'POS-DEMO-01', os: 'Windows_NT 10.0.19045 x64', cpu: 'Intel(R) Celeron(R) J4125 CPU @ 2.00GHz', memoryGb: 8, serial: '3F9A1C77D2E04B61', clockSkewMs: 640, battery: null },
    autostart: { enabled: true },
    tax: { dealer: 'חברה בע״מ (ח.פ.)', vatPercent: 18 },
    printer: { kind: 'usb', branch: null, widthDots: 576, cut: true, lastOkAt: Date.now() - 3_600_000, lastFailure: null, port: null },
    drawer: { via: 'מדפסת הקבלות (חיבור RJ11) · USB: SNBC BTP-R880NPV', pin: 2, onMs: 50, pulses: [50, 100, 150, 200], audited: r === 'till' },
    pinpad: { network: true, usb: false, cardless: false, host: '192.168.1.60', port: 8080, expectedTerminal: '1815155', auto: 'אם המסופון לא עונה 2 דקות, המכשיר מחפש את מסוף 1815155 ברשת ועובר אליו לבד', lastMove: null, certPin: 'sha256/9c1f0a7d4b3e…' },
    kitchen: {
      printers: [
        { id: 'k1', name: 'מטבח חם', where: 'רשת · 192.168.1.71:9100', network: { host: '192.168.1.71', port: 9100 } },
        { id: 'k2', name: 'בר', where: 'דרך קופה 1', network: null },
      ],
      hostsRelay: false,
    },
    cash: null,
    cashmag: null,
    synqpay: null,
    kioskZ: r === 'kiosk' ? { kind: 'shop', shiftOpen: true, owed: false, customerBusy: false } : null,
    audit: [
      { at: Date.now() - 60_000, access: 'granted' },
      { at: Date.now() - 86_400_000, access: 'wrong' },
    ],
    outbox: 0,
  };
}

export async function demoTechnicianAction(a: TechnicianAction): Promise<TechnicianActionResult> {
  switch (a.type) {
    case 'serialPorts':
      return {
        ok: true,
        serialPorts: [
          { path: 'COM3', label: 'POS Printer (COM3)', manufacturer: 'SNBC', usbId: null, likely: 'likely', inUse: null },
          { path: 'COM1', label: 'Communications Port (COM1)', manufacturer: '(Standard port types)', usbId: null, likely: 'possible', inUse: null },
          { path: 'COM5', label: 'USB-SERIAL CH340 (COM5)', manufacturer: 'wch.cn', usbId: '1A86:7523', likely: 'possible', inUse: 'בשימוש המסופון' },
        ],
      };
    case 'serialDetect':
      return { ok: true, message: `המדפסת ב-${a.comPort} ענתה ב-19200`, baudRate: 19200 };
    case 'serialTest':
      return { ok: true, message: `דף בדיקה נשלח ל-${a.comPort} (${a.baudRate ?? 9600})` };
    case 'networkCheck':
      return {
        ok: true,
        network: {
          connection: 'ethernet',
          ssid: null,
          signal: null,
          adapters: [{ name: 'Realtek PCIe GbE Family Controller', addresses: ['192.168.1.57'], gateways: ['192.168.1.1'], dns: ['192.168.1.1', '8.8.8.8'] }],
          internet: { url: 'https://api.example.invalid/health', ok: true, code: 200, ms: 84, error: null },
          api: { url: 'https://api.example.invalid/api/v1/sync/m/kiosk/technician', ok: true, code: 200, ms: 131, error: null },
          lan: { label: 'קופה 1 · 192.168.1.20:8399', check: { url: 'http://192.168.1.20:8399/health', ok: true, code: 200, ms: 6, error: null } },
          identity: {
            tenant: 'דייר הדגמה',
            company: 'עסק הדגמה בע״מ',
            shop: 'סניף הדגמה',
            branchCode: '001',
            area: 'בר',
            machineName: role() === 'till' ? 'קופה 2' : 'קיוסק כניסה',
            posNumber: role() === 'till' ? '2' : '7',
            documentPrefix: role() === 'till' ? '2' : '7',
            role: role(),
            zRole: 'shop_z',
            controllers: role() === 'kiosk' ? ['קופה 1 #1'] : null,
          },
        },
      };
    case 'pinpadProbe':
      return {
        ok: true,
        message: 'המסופון עונה',
        pinpad: { kind: 'nayax_lan', address: '192.168.1.60:8080', tcp: { ok: true, ms: 4, error: null }, status: { ok: true, ms: 212, detail: null }, terminal: '1815155', merchant: 'עסק הדגמה', serial: 'P400-0001', skipped: null },
      };
    case 'printerScan':
      return { ok: true, printers: { subnet: '192.168.1.0/24', found: [{ host: '192.168.1.71', port: 9100, health: 'ok', known: 'מטבח חם' }, { host: '192.168.1.88', port: 9100, health: 'ok', known: null }] } };
    case 'pinpadSearch':
      return { ok: true, pinpads: [{ host: '192.168.1.60', port: 8080, terminal: '1815155', merchant: 'עסק הדגמה', serial: 'P400-0001', match: 'same' }] };
    case 'printerDiscover':
    case 'printerChoose':
    case 'printerWidth':
      return { ok: true, picker: demoPicker() };
    case 'printerTestTarget':
      return { ok: true, message: 'הדגמה — דף בדיקה' };
    case 'appLog':
      return { ok: true, log: ['2026-10-17T09:00:00.000Z log [kiosk] sync: heartbeat ok', '2026-10-17T09:00:30.000Z log [kiosk] printer: ok'] };
    default:
      return { ok: false, message: 'הדגמה — לא בוצע' };
  }
}
