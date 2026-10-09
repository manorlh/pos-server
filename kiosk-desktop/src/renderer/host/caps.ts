/**
 * What a host can do (`HostCaps`) and how the screens say it (§2.5, "כנות לגבי יכולות"): the
 * capability tiles — printing, drawer, card, scanner, working offline, customer display — each
 * either available or greyed WITH the reason, never a button that would fail.
 *
 * Browser capabilities are feature-detected (Chromium 108 has Web Serial, WebUSB, Wake Lock;
 * Safari has none of the hardware ones).
 */

import type { HostCaps, HostKind } from './TillHost';

export const NO_CAPS: HostCaps = {
  localEngine: false,
  print: { tcp: false, spooler: false, usb: false, btSpp: false, ble: false, airprint: false, relay: false, lanHost: false, system: false },
  drawer: { viaPrinter: false, devicePort: false },
  channels: { tcpTls: false, https: false, serial: false, usbCdc: false },
  terminals: { nayaxLan: false, nayaxUsb: false, synqpayLan: false, synqpaySerial: false, zcredit: false, agamento: false },
  scan: { hid: false, camera: false },
  customerDisplay: false,
  secureStore: false,
  backgroundSync: false,
};

/** What a browser offers, by feature detection only. */
export interface BrowserEnv {
  serial: boolean;
  usb: boolean;
  bluetooth: boolean;
  barcodeDetector: boolean;
  secureContext: boolean;
  wakeLock: boolean;
  /** Opened as an installed app (display-mode standalone / fullscreen). */
  standalone: boolean;
}

interface NavigatorLike {
  serial?: unknown;
  usb?: unknown;
  bluetooth?: unknown;
  wakeLock?: unknown;
}

interface WindowLike {
  isSecureContext?: boolean;
  BarcodeDetector?: unknown;
  matchMedia?: (q: string) => { matches: boolean };
}

export function browserEnv(nav: NavigatorLike, win: WindowLike): BrowserEnv {
  const media = (q: string) => {
    try {
      return win.matchMedia?.(q).matches === true;
    } catch {
      return false;
    }
  };
  return {
    serial: !!nav.serial,
    usb: !!nav.usb,
    bluetooth: !!nav.bluetooth,
    barcodeDetector: typeof win.BarcodeDetector === 'function',
    secureContext: win.isSecureContext === true,
    wakeLock: !!nav.wakeLock,
    standalone: media('(display-mode: standalone)') || media('(display-mode: fullscreen)'),
  };
}

/**
 * A browser host's capabilities. `relay`: the engine can reach the shop's print server through
 * the cloud; `bridge`: R2M POS for Windows runs as the bridge on this PC (§9.5); `lanHost`: the
 * engine is the main till on the LAN.
 */
export function browserCaps(env: BrowserEnv, opts: { relay?: boolean; bridge?: boolean; lanHost?: boolean; demo?: boolean } = {}): HostCaps {
  const bridge = opts.bridge === true;
  // Web Serial / WebUSB need a secure context (https, or localhost).
  const serial = env.serial && env.secureContext;
  const usb = env.usb && env.secureContext;
  return {
    localEngine: false,
    print: {
      tcp: bridge,
      spooler: bridge,
      usb: usb || bridge,
      btSpp: false,
      ble: false,
      airprint: false,
      relay: opts.relay === true,
      lanHost: opts.lanHost === true,
      system: true,
    },
    drawer: { viaPrinter: usb || bridge || opts.relay === true || opts.lanHost === true, devicePort: false },
    channels: { tcpTls: bridge, https: bridge, serial: serial || bridge, usbCdc: serial || bridge },
    terminals: {
      nayaxLan: bridge,
      nayaxUsb: serial || bridge,
      synqpayLan: bridge,
      synqpaySerial: bridge,
      // Z-Credit is a cloud gateway: the engine (in the cloud or on the main till) charges it.
      zcredit: !opts.demo,
      agamento: false,
    },
    scan: { hid: true, camera: env.barcodeDetector },
    customerDisplay: false,
    secureStore: false,
    backgroundSync: false,
  };
}

export type TileId = 'print' | 'drawer' | 'card' | 'scanner' | 'offline' | 'customerDisplay';

export interface CapabilityTile {
  id: TileId;
  label: string;
  available: boolean;
  /** Hebrew: what is there, or why it is greyed. */
  reason: string;
}

const any = (o: Record<string, boolean>) => Object.keys(o).some((k) => o[k]);

/** The tiles, in a fixed order; `demoTerminal`: the demo simulates a card terminal. */
export function capabilityTiles(caps: HostCaps, kind: HostKind, opts: { demo?: boolean; demoTerminal?: boolean } = {}): CapabilityTile[] {
  const printWays: string[] = [];
  if (caps.print.tcp) printWays.push('מדפסת רשת');
  if (caps.print.spooler) printWays.push('מדפסת Windows');
  if (caps.print.usb) printWays.push('USB');
  if (caps.print.ble) printWays.push('BLE');
  if (caps.print.relay) printWays.push('דרך הענן לשרת ההדפסות');
  if (caps.print.lanHost) printWays.push('דרך הקופה הראשית');
  const canPrint = printWays.length > 0 || opts.demo === true;
  const browser = kind === 'browser';
  const card = any(caps.terminals) || opts.demoTerminal === true;
  return [
    {
      id: 'print',
      label: 'הדפסת קבלות',
      available: canPrint,
      reason: printWays.length > 0 ? printWays.join(' · ') : opts.demo ? 'מדפסת מדומה (הדגמה)' : browser ? 'דפדפן לא מגיע למדפסת בעצמו — דרך הענן, הקופה הראשית או הגשר ל-Windows' : 'לא הוגדרה מדפסת',
    },
    {
      id: 'drawer',
      label: 'מגירת מזומן',
      available: caps.drawer.viaPrinter || caps.drawer.devicePort || opts.demo === true,
      reason: caps.drawer.devicePort ? 'מגירה במכשיר' : caps.drawer.viaPrinter ? 'נפתחת דרך המדפסת' : opts.demo ? 'מגירה מדומה (הדגמה)' : 'אין מדפסת שהמגירה מחוברת אליה',
    },
    {
      id: 'card',
      label: 'אשראי',
      available: card,
      reason: opts.demoTerminal ? 'מסופון מדומה (הדגמה)' : card ? 'מסופון זמין' : opts.demo ? 'אין מסופון במצב הדגמה' : browser ? 'אין מסופון שהדפדפן מגיע אליו' : 'לא הוגדר מסופון',
    },
    {
      id: 'scanner',
      label: 'סורק ברקוד',
      available: caps.scan.hid || caps.scan.camera,
      reason: caps.scan.camera ? 'סורק או מצלמה' : 'סורק שמתחבר כמקלדת',
    },
    {
      id: 'offline',
      label: 'עבודה בלי אינטרנט',
      available: caps.localEngine || caps.print.lanHost,
      reason: caps.localEngine ? 'מנוע הקופה במכשיר — עובדת גם בלי אינטרנט' : caps.print.lanHost ? 'דרך הקופה הראשית ברשת' : 'רק דרך קופה ראשית ברשת. בלעדיה — "הזמנות בלבד"',
    },
    {
      id: 'customerDisplay',
      label: 'מסך לקוח',
      available: caps.customerDisplay,
      reason: caps.customerDisplay ? 'מסך שני מחובר' : 'יגיע בשלב הבא',
    },
  ];
}
