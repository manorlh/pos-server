/**
 * The technician's setup on Windows (P:/specs/windows-setup-parity.md): the rules (core/technicianSetup.ts), the PC's
 * facts read language-independently (main/technician/technicianTools.ts), and the service's actions — the server address
 * tested then switched, the drawer's pin and pulse, a manager's code for the cloud's writes (`elevation/sessions`, then
 * `X-Elevation-Token`), the logs to support, the till's own audited drawer test — on the one screen of every role.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  connectionKind,
  decideServerSwitch,
  DEFAULT_DRAWER_KICK,
  drawerKickBytes,
  logRangeMinutes,
  normalizeServerUrl,
  parseAdapterJson,
  parseDrawerKick,
  parseNetshWlan,
  signalLabel,
  symbologyOf,
  widthTestBitmap,
  cloudLight,
} from '../src/core/technicianSetup';
import { DRAWER_KICK } from '../src/core/escpos';
import { parseWmicList, scanLanPrinters, timedGet } from '../src/main/technician/technicianTools';
import { harness, MANAGER_PIN, type Harness } from './tillEngineHarness';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});

describe('"כתובת שרת"', () => {
  it('normalizes as Android keeps a server', () => {
    expect(normalizeServerUrl('https://POS.Example.com/api/v1/')).toBe('https://pos.example.com');
    expect(normalizeServerUrl(' http://10.0.0.5:8001 ')).toBe('http://10.0.0.5:8001');
    expect(normalizeServerUrl('pos.example.com')).toBeNull();
    expect(normalizeServerUrl('ftp://x')).toBeNull();
    expect(normalizeServerUrl('https://u:p@x.com')).toBeNull();
    expect(normalizeServerUrl('https://x.com/?a=1')).toBeNull();
  });

  it('decides as KioskServerAddress.decide: test first, the same cloud keeps the pairing, another asks and unpairs', () => {
    const cur = 'https://a.example.com';
    expect(decideServerSwitch(cur, 'nope', null, 0, false)).toBe('invalid');
    expect(decideServerSwitch(cur, 'https://a.example.com/api/v1', null, 0, false)).toBe('unchanged');
    expect(decideServerSwitch(cur, 'https://b.example.com', null, 0, false)).toBe('not_tested');
    const b = (reachable: boolean, sameCloud: boolean) => ({ url: 'https://b.example.com', reachable, sameCloud });
    expect(decideServerSwitch(cur, 'https://b.example.com', { ...b(true, true), url: 'https://c.example.com' }, 0, false)).toBe('not_tested');
    expect(decideServerSwitch(cur, 'https://b.example.com', b(false, false), 0, false)).toBe('unreachable');
    expect(decideServerSwitch(cur, 'https://b.example.com', b(true, true), 3, false)).toBe('switch_keep_pairing');
    expect(decideServerSwitch(cur, 'https://b.example.com', b(true, false), 3, true)).toBe('refused_unsynced');
    expect(decideServerSwitch(cur, 'https://b.example.com', b(true, false), 0, false)).toBe('confirm_new_cloud');
    expect(decideServerSwitch(cur, 'https://b.example.com', b(true, false), 0, true)).toBe('switch_and_unpair');
  });
});

describe('"מגירת כסף"', () => {
  it('kicks as before by default, on pin 5 when set, the pulse in 2 ms steps', () => {
    expect([...drawerKickBytes()]).toEqual([...DRAWER_KICK]);
    expect([...drawerKickBytes(DEFAULT_DRAWER_KICK)]).toEqual([0x1b, 0x70, 0x00, 25, 250]);
    expect([...drawerKickBytes({ pin: 5, onMs: 100, offMs: 500 })]).toEqual([0x1b, 0x70, 0x01, 50, 250]);
    expect([...drawerKickBytes({ pin: 2, onMs: 9_999, offMs: 0 })].slice(3)).toEqual([255, 1]);
  });

  it('reads a saved setting back, a bad one as the default', () => {
    expect(parseDrawerKick({ pin: 5, onMs: 150, offMs: 400 })).toEqual({ pin: 5, onMs: 150, offMs: 400 });
    expect(parseDrawerKick({ pin: 7, onMs: 'x' })).toEqual(DEFAULT_DRAWER_KICK);
    expect(parseDrawerKick(null)).toEqual(DEFAULT_DRAWER_KICK);
  });
});

describe('"בדיקת רוחב"', () => {
  it('draws four frames on the 80 mm raster, each its own width wide', () => {
    const bmp = widthTestBitmap();
    expect(bmp.width).toBe(576);
    expect(bmp.rowBytes).toBe(72);
    expect(bmp.height).toBe(4 * (72 + 24));
    const ink = (x: number, y: number) => (bmp.data[y * bmp.rowBytes + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
    // The first (widest, 576) frame's top edge runs the whole raster; the last (384) starts at (576 − 384) / 2.
    expect(ink(0, 0)).toBe(true);
    expect(ink(575, 0)).toBe(true);
    const top384 = 3 * 96;
    expect(ink(96, top384)).toBe(true);
    expect(ink(95, top384)).toBe(false);
    expect(ink(96 + 383, top384)).toBe(true);
    expect(ink(96 + 384, top384)).toBe(false);
  });
});

describe('"סורק ברקוד"', () => {
  it('names a scan by its digits and check digit', () => {
    expect(symbologyOf('7290000000015')).toBe('EAN-13');
    expect(symbologyOf('7290000000016')).toMatch(/ספרת ביקורת/);
    expect(symbologyOf('036000291452')).toBe('UPC-A');
    expect(symbologyOf('96385074')).toBe('EAN-8');
    expect(symbologyOf('CC:ABCD1234')).toMatch(/CC/);
    expect(symbologyOf('KO:5b1')).toMatch(/KO/);
    expect(symbologyOf('ABC-123')).toBe('Code 39 / Code 128');
    expect(symbologyOf('')).toBe('—');
  });
});

describe('"מידע רשת"', () => {
  it('reads netsh in any language (the values, not the labels)', () => {
    const he = ['    שם                   : Wi-Fi', '    SSID                   : Shop-5G', '    BSSID                  : aa:bb:cc:dd:ee:ff', '    אות                    : 82%'].join('\r\n');
    expect(parseNetshWlan(he)).toEqual({ ssid: 'Shop-5G', signal: 82 });
    expect(parseNetshWlan('There is no wireless interface on the system.')).toBeNull();
    expect(signalLabel(82)).toBe('מצוינת');
    expect(signalLabel(30)).toBe('בינונית');
  });

  it('reads the adapters from CIM JSON and from wmic, and tells the connection', () => {
    const json = JSON.stringify([
      { Description: 'Realtek PCIe GbE Family Controller', IPAddress: ['192.168.1.57', 'fe80::1'], DefaultIPGateway: ['192.168.1.1'], DNSServerSearchOrder: ['192.168.1.1', '8.8.8.8'] },
      { Description: 'VirtualBox Host-Only Ethernet Adapter', IPAddress: ['192.168.56.1'], DefaultIPGateway: null, DNSServerSearchOrder: null },
    ]);
    const a = parseAdapterJson(json);
    expect(a).toHaveLength(2);
    expect(a[0]).toMatchObject({ addresses: ['192.168.1.57'], gateways: ['192.168.1.1'], dns: ['192.168.1.1', '8.8.8.8'], wifi: false });
    expect(connectionKind(a)).toBe('ethernet');
    const wmic = ['', 'DefaultIPGateway={"10.0.0.1"}', 'Description=Intel(R) Wi-Fi 6 AX201 160MHz', 'DNSServerSearchOrder={"10.0.0.1"}', 'IPAddress={"10.0.0.12","fe80::2"}', '', ''].join('\r\n');
    const w = parseWmicList(wmic);
    expect(w).toEqual([{ name: 'Intel(R) Wi-Fi 6 AX201 160MHz', addresses: ['10.0.0.12'], gateways: ['10.0.0.1'], dns: ['10.0.0.1'], wifi: true }]);
    expect(connectionKind(w)).toBe('wifi');
    expect(connectionKind([])).toBe('none');
  });

  it('lights the cloud as Android: answered ok, the internet only warn, nothing bad', () => {
    expect(cloudLight(true, true)).toBe('ok');
    expect(cloudLight(false, true)).toBe('warn');
    expect(cloudLight(false, false)).toBe('bad');
    expect(cloudLight(null, null)).toBe('unknown');
  });

  it('times a request and says why one failed', async () => {
    let t = 1_000;
    const ok = await timedGet((async () => {
      t += 42;
      return new Response('{"a":1}', { status: 200 });
    }) as typeof fetch, 'http://x/health', null, 1_000, () => t);
    expect(ok).toMatchObject({ ok: true, code: 200, ms: 42, error: null, body: { a: 1 } });
    const bad = await timedGet((async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    }) as typeof fetch, 'http://x/health', null);
    expect(bad).toMatchObject({ ok: false, code: null, error: 'ECONNREFUSED' });
  });
});

describe('"חיפוש מדפסות ברשת"', () => {
  it('sweeps the /24 on 9100 (not itself), asks each its status, in address order', async () => {
    const swept: string[][] = [];
    const r = await scanLanPrinters({
      localIpv4: () => '192.168.1.57',
      sweep: async (hosts) => {
        swept.push(hosts);
        return ['192.168.1.88', '192.168.1.71'];
      },
      status: async (host) => (host.endsWith('.71') ? 'ok' : 'no_paper'),
    });
    expect(swept[0]).not.toContain('192.168.1.57');
    expect(r).toEqual({ ok: true, subnet: '192.168.1.0/24', printers: [{ host: '192.168.1.71', port: 9100, health: 'ok' }, { host: '192.168.1.88', port: 9100, health: 'no_paper' }] });
    expect(await scanLanPrinters({ localIpv4: () => null, sweep: async () => [], status: async () => 'ok' })).toEqual({ ok: false, error: 'not_on_lan' });
  });

  it('counts the logs’ "היום" from midnight', () => {
    expect(logRangeMinutes('hour', new Date(2026, 9, 17, 10, 0))).toBe(60);
    expect(logRangeMinutes('three', new Date(2026, 9, 17, 10, 0))).toBe(180);
    expect(logRangeMinutes('today', new Date(2026, 9, 17, 10, 30))).toBe(630);
  });
});

/* ------------------------------------------------------------ the service */

function rig(o: Parameters<typeof harness>[0] = {}) {
  const h = harness(o);
  open.push(h);
  expect(h.svc.technicianUnlock('1995').outcome).toBe('granted');
  return h;
}

describe('the technician’s actions', () => {
  it('needs the technician’s code', async () => {
    const h = harness();
    open.push(h);
    expect(await h.svc.technicianAction({ type: 'drawerTest' })).toEqual({ ok: false, message: 'נדרש קוד טכנאי' });
  });

  it('shows the setup view on a till: its role, the drawer, the tax', async () => {
    const h = rig();
    const info = await h.svc.technicianInfo();
    expect(info.setup).toMatchObject({ role: 'till', drawer: { pin: 2, onMs: 50, audited: true }, tax: { vatPercent: 18 }, identity: { machineName: 'קופה 2', posNumber: '2' } });
    expect(info.setup?.printer.widthDots).toBe(576);
  });

  it('saves the drawer’s pin and pulse, and the till kicks with them', async () => {
    const h = rig();
    expect(await h.svc.technicianAction({ type: 'drawerSet', pin: 5, onMs: 100 })).toMatchObject({ ok: true });
    expect(h.svc.localSettings().drawer).toEqual({ pin: 5, onMs: 100, offMs: 500 });
    h.printer.sent.length = 0;
    await h.svc.openDrawer();
    expect([...h.printer.sent[0]]).toEqual([0x1b, 0x70, 0x01, 50, 250]);
  });

  it('tests the drawer through the till’s drawer service (audited, the technician’s)', async () => {
    const h = rig();
    h.printer.sent.length = 0;
    const r = await h.svc.technicianAction({ type: 'drawerTest' });
    expect(r).toMatchObject({ ok: true });
    expect(h.printer.sent.some((b) => b[0] === 0x1b && b[1] === 0x70)).toBe(true);
  });

  it('tests a server address, then keeps the pairing on the same cloud', async () => {
    const h = rig({
      answers: {
        'GET health': () => ({ status: 'ok' }),
        'GET sync/m/kiosk/technician': () => ({ machine: { id: '549e903c-4aba-4528-bc4a-c61b4019a64e' } }),
      },
    });
    expect(await h.svc.technicianAction({ type: 'serverSave', url: 'http://127.0.0.1:8001' })).toMatchObject({ ok: false, message: 'בדקו את החיבור לכתובת לפני השמירה' });
    const t = await h.svc.technicianAction({ type: 'serverTest', url: 'http://127.0.0.1:8001/api/v1' });
    expect(t.server).toMatchObject({ url: 'http://127.0.0.1:8001', sameCloud: true, health: { ok: true, code: 200 } });
    const s = await h.svc.technicianAction({ type: 'serverSave', url: 'http://127.0.0.1:8001' });
    expect(s).toMatchObject({ ok: true });
    expect(h.svc.cloud.credentials()?.serverUrl).toBe('http://127.0.0.1:8001');
    expect(h.svc.paired).toBe(true);
  });

  it('asks before another cloud, and refuses it while documents wait', async () => {
    const h = rig({ answers: { 'GET health': () => ({ status: 'ok' }), 'GET sync/m/kiosk/technician': () => ({ __status: 401, detail: 'unknown machine' }) } });
    await h.svc.technicianAction({ type: 'serverTest', url: 'https://other.example.com' });
    const s = await h.svc.technicianAction({ type: 'serverSave', url: 'https://other.example.com' });
    expect(s).toMatchObject({ ok: false, confirm: 'נתק ועבור לענן החדש' });
    expect(h.svc.cloud.credentials()?.serverUrl).toBe('http://localhost:8001');
  });

  it('sets the pinpad with a manager’s code the cloud checks', async () => {
    const h = rig({ answers: { 'POST elevation/sessions': () => ({ token: 'grant-1', userName: 'אבי לוי' }), 'PUT sync/m/payment-terminal': () => ({ nayaxEnabled: true, host: '192.168.1.60', port: 8080 }) } });
    expect(await h.svc.technicianAction({ type: 'pinpadSetup', connection: 'lan', host: '192.168.1.60', port: 8080, code: '0000' })).toMatchObject({ ok: false, message: 'קוד שגוי' });
    const r = await h.svc.technicianAction({ type: 'pinpadSetup', connection: 'lan', host: '192.168.1.60', port: 8080, code: MANAGER_PIN });
    expect(r).toMatchObject({ ok: true });
    const grant = h.sent.find((x) => x.path === 'elevation/sessions');
    expect(grant?.body).toMatchObject({ posUserId: 'u-manager', pin: MANAGER_PIN, scopes: ['catalog:write'] });
    expect(h.sent.find((x) => x.method === 'PUT' && x.path === 'sync/m/payment-terminal')?.body).toEqual({ host: '192.168.1.60', port: 8080, connection: 'lan' });
  });

  it('says why when the cloud refuses the manager', async () => {
    const h = rig({ answers: { 'POST elevation/sessions': () => ({ __status: 403, detail: 'not_permitted_here' }) } });
    const r = await h.svc.technicianAction({ type: 'printerAdd', host: '192.168.1.88', port: 9100, name: 'בר', purpose: 'kitchen', code: MANAGER_PIN });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/אין הרשאה/);
    expect(h.sent.some((x) => x.path === 'sync/m/printers')).toBe(false);
  });

  it('adds a printer found to the shop', async () => {
    const h = rig({ answers: { 'POST elevation/sessions': () => ({ token: 'g' }), 'POST sync/m/printers': () => ({ id: 'p1' }) } });
    const r = await h.svc.technicianAction({ type: 'printerAdd', host: '192.168.1.88', port: 9100, name: 'בר', purpose: 'kitchen', code: MANAGER_PIN });
    expect(r).toMatchObject({ ok: true });
    expect(h.sent.find((x) => x.path === 'sync/m/printers')?.body).toEqual({ name: 'בר', host: '192.168.1.88', port: 9100, purpose: 'kitchen' });
  });

  it('sends the logs to support (manual, with the note)', async () => {
    const h = rig({ answers: { 'POST sync/m/device-logs': () => ({ id: 'log-1' }) } });
    const r = await h.svc.technicianAction({ type: 'sendLogs', range: 'hour', note: 'המדפסת לא מדפיסה' });
    expect(r).toMatchObject({ ok: true });
    expect(h.sent.find((x) => x.path === 'sync/m/device-logs')?.body).toMatchObject({ reason: 'manual', note: 'המדפסת לא מדפיסה', content_encoding: 'gzip+base64' });
  });

  it('restarts only through the platform, never mid-payment', async () => {
    let restarts = 0;
    const h = rig({ platform: { restartApp: () => void restarts++ } });
    expect(await h.svc.technicianAction({ type: 'restart' })).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 350));
    expect(restarts).toBe(1);
    const bare = rig();
    expect(await bare.svc.technicianAction({ type: 'restart' })).toEqual({ ok: false, message: 'לא נתמך' });
  });

  it('shows the pinpad’s pinned certificate and forgets it on "איפוס הצמדת התעודה"', async () => {
    const h = rig({ settings: { nayaxDeviceHost: '192.168.1.60', nayaxDevicePort: 8080 } });
    (h.svc as unknown as { kv: { set(k: string, v: string): void } }).kv.set('provider.pinpad.pin:192.168.1.60:8080', 'sha256/abc');
    expect((await h.svc.technicianInfo()).setup?.pinpad).toMatchObject({ network: true, host: '192.168.1.60', port: 8080, certPin: 'sha256/abc' });
    expect(await h.svc.technicianAction({ type: 'pinpadPinReset' })).toMatchObject({ ok: true });
    expect((await h.svc.technicianInfo()).setup?.pinpad.certPin).toBeNull();
  });

  it('turns autostart on through the platform', async () => {
    let on = false;
    const h = rig({ platform: { autostart: () => ({ enabled: on }), setAutostart: (v: boolean) => void (on = v) } });
    expect((await h.svc.technicianInfo()).setup?.autostart).toEqual({ enabled: false });
    expect(await h.svc.technicianAction({ type: 'autostartOn' })).toMatchObject({ ok: true });
    expect(on).toBe(true);
  });
});
