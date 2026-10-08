/**
 * The pinpad that moved, on the Windows kiosk (core/pinpadRelocation.ts, main/payment/pinpadRelocator.ts):
 * the Android till's rule (pos-android PinpadRelocationTest), plus "לפי המאק" — Windows reads its
 * ARP table, so the remembered MAC points at the new address first. The terminal number must still
 * match; nothing but reads ever reaches a pinpad.
 */
import { describe, expect, it } from 'vitest';
import {
  choose,
  cooldownMs,
  decide,
  IDENTITY_FRAMES,
  identityOf,
  match,
  normMac,
  parseArp,
  subnetHosts,
  target,
  type PinpadIdentity,
} from '../src/core/pinpadRelocation';
import { identifyPinpad, PinpadRelocator, type RelocatorDeps } from '../src/main/payment/pinpadRelocator';

const RUNNER: PinpadIdentity = { terminal: '1807770', merchant: 'ראנר' };

const WINDOWS_ARP = [
  '',
  'Interface: 192.168.0.235 --- 0x7',
  '  Internet Address      Physical Address      Type',
  '  192.168.0.1           10-20-30-40-50-60     dynamic',
  '  192.168.0.171         aa-bb-cc-dd-ee-01     dynamic',
  '  192.168.0.255         ff-ff-ff-ff-ff-ff     static',
  '  224.0.0.22            01-00-5e-00-00-16     static',
  '',
].join('\r\n');

describe('who the pinpad is', () => {
  it('reads the terminal, the business, the serial and a MAC its own replies name', () => {
    const id = identityOf({
      status: '{"jsonrpc":"2.0","id":"1","result":"ashraitReady"}',
      retailer: '{"jsonrpc":"2.0","id":"1","result":{"id":"1807770012","name":"ראנר","transmitTime":"02:00"}}',
      config: '{"jsonrpc":"2.0","id":"1","result":{"configApplied":true,"ashraitServer":"SHVA","tmsRetailer":"1807770"}}',
      info: '{"jsonrpc":"2.0","id":"1","result":{"device":{"model":"C4","serialNumber":"N4C1","MacAddress":"AA-BB-CC-DD-EE-01"}}}',
    });
    expect(id).toEqual({ terminal: '1807770', merchant: 'ראנר', serial: 'N4C1', mac: 'aa:bb:cc:dd:ee:01' });
    // Agamento as known: getInfo unknown, no MAC anywhere; the number from getConfig when getRetailerInfo is silent.
    expect(identityOf({ config: '{"result":{"tmsRetailer":"1807770"}}', info: '{"error":{"code":-32601,"message":"Method not found"}}' }))
      .toEqual({ terminal: '1807770', merchant: null, serial: null, mac: null });
  });

  it('sends nothing but reads', () => {
    const methods = Object.values(IDENTITY_FRAMES).map((f) => JSON.parse(f).method);
    expect(methods).toEqual(['getStatus', 'getInfo', 'getRetailerInfo', 'getConfig']);
    for (const f of Object.values(IDENTITY_FRAMES)) for (const w of ['doTransaction', 'setConfig', 'doEstablishment', 'amount', 'vuid']) expect(f).not.toContain(w);
  });

  it('matches by terminal number first; serial and a self-reported MAC are keys, an ARP MAC a hint', () => {
    expect(match(RUNNER, { terminal: '01807770' })).toBe('same');
    expect(match(RUNNER, { terminal: '1730030', mac: 'aa:bb:cc:dd:ee:01' })).toBe('different_terminal');
    expect(match({ ...RUNNER, serial: 'A' }, { terminal: '1807770', serial: 'B' })).toBe('different_device');
    expect(match({ ...RUNNER, mac: 'aa:bb:cc:dd:ee:01' }, { terminal: '1807770', mac: 'AA-BB-CC-DD-EE-02' })).toBe('different_device');
    expect(match({ ...RUNNER, arpMac: 'aa:bb:cc:dd:ee:01' }, { terminal: '1807770', arpMac: 'aa:bb:cc:dd:ee:02' })).toBe('same');
    expect(match({ terminal: null }, RUNNER)).toBe('unknown');
    expect(target('1807770', '01807770')).toBe('1807770');
    expect(target('1807770', '1730030')).toBeNull();
  });

  it('reads Windows arp -a, devices only', () => {
    const t = parseArp(WINDOWS_ARP);
    expect([...t.entries()]).toEqual([
      ['192.168.0.1', '10:20:30:40:50:60'],
      ['192.168.0.171', 'aa:bb:cc:dd:ee:01'],
    ]);
    expect(normMac('ff-ff-ff-ff-ff-ff')).toBeNull();
    expect(normMac('00:00:00:00:00:00')).toBeNull();
    expect(normMac('aabb.ccdd.ee01')).toBe('aa:bb:cc:dd:ee:01');
    expect(subnetHosts('192.168.0.235')).toHaveLength(253);
    expect(subnetHosts(null)).toEqual([]);
  });
});

describe('when and where', () => {
  const facts = (o: Partial<Parameters<typeof decide>[0]> = {}) => ({
    nowMs: 600_000, networkPinpad: true, failingSinceMs: 0, inPayment: false, terminal: '1807770', online: true, lastScanAtMs: null, fruitlessScans: 0, ...o,
  });

  it('two minutes silent, idle, known, online, not just searched', () => {
    expect(decide(facts())).toEqual({ scan: true });
    expect(decide(facts({ nowMs: 119_999 }))).toEqual({ scan: false, why: 'not_long_enough' });
    expect(decide(facts({ inPayment: true }))).toEqual({ scan: false, why: 'payment' });
    expect(decide(facts({ terminal: null }))).toEqual({ scan: false, why: 'no_identity' });
    expect(decide(facts({ online: false }))).toEqual({ scan: false, why: 'offline' });
    expect(decide(facts({ lastScanAtMs: 600_000 - 9 * 60_000 }))).toEqual({ scan: false, why: 'cooldown' });
    expect(cooldownMs(1)).toBe(20 * 60_000);
    expect(cooldownMs(9)).toBe(60 * 60_000);
  });

  it('only the one that is this terminal; a tie broken by MAC, else never guessed', () => {
    const a = { host: '192.168.0.40', port: 8080, identity: { terminal: '1807770', arpMac: 'aa:bb:cc:dd:ee:07' } };
    const b = { host: '192.168.0.41', port: 8080, identity: { terminal: '1807770', arpMac: 'aa:bb:cc:dd:ee:08' } };
    const other = { host: '192.168.0.42', port: 8080, identity: { terminal: '1730030' } };
    expect(choose(RUNNER, '192.168.0.167:8080', [other])).toEqual({ kind: 'not_found', others: 1 });
    expect(choose(RUNNER, '192.168.0.167:8080', [a, other])).toEqual({ kind: 'switch', to: a });
    expect(choose(RUNNER, null, [a, b])).toEqual({ kind: 'ambiguous', labels: ['192.168.0.40:8080', '192.168.0.41:8080'] });
    expect(choose({ ...RUNNER, arpMac: 'AA-BB-CC-DD-EE-08' }, null, [a, b])).toEqual({ kind: 'switch', to: b });
  });
});

describe('the relocator', () => {
  function world(over: Partial<RelocatorDeps> & { pinpads?: Record<string, PinpadIdentity>; arp?: string } = {}) {
    const kv = new Map<string, string>();
    const asked: string[] = [];
    const saved: Array<{ host: string; port: number; terminal: string | null; previous: string }> = [];
    let now = 1_000_000;
    const pinpads = over.pinpads ?? {};
    const deps: RelocatorDeps = {
      now: () => now,
      kvGet: (k) => kv.get(k) ?? null,
      kvSet: (k, v) => (v === null ? kv.delete(k) : kv.set(k, v)),
      readArp: async () => over.arp ?? '',
      localIpv4: () => '192.168.0.235',
      sweep: async () => Object.keys(pinpads),
      identify: async (host) => {
        asked.push(host);
        return pinpads[host] ?? null;
      },
      save: async (host, port, id, previous) => {
        saved.push({ host, port, terminal: id.terminal, previous });
        return 'ok';
      },
      log: () => undefined,
      ...over,
    };
    return { kv, asked, saved, deps, tick: (ms: number) => (now += ms), r: new PinpadRelocator(deps) };
  }
  const silent = (inPayment = false) => ({
    configured: { host: '192.168.0.167', port: 8080 },
    answering: false,
    lastOkAtMs: null,
    inPayment: () => inPayment,
    online: true,
    expectedTerminal: '1807770',
  });

  it('finds the moved pinpad by its MAC in the ARP table, checks who it is, and saves it', async () => {
    const w = world({ pinpads: { '192.168.0.171': { terminal: '1807770', merchant: 'ראנר' } }, arp: WINDOWS_ARP, sweep: async () => [] });
    w.kv.set('pinpad.relocate.arpMac', 'aa:bb:cc:dd:ee:01');
    await w.r.tick(silent());
    expect(w.saved).toEqual([]); // silent just now: not yet
    w.tick(2 * 60_000);
    const out = await w.r.tick(silent());
    expect(out).toContain('moved 192.168.0.167:8080 -> 192.168.0.171:8080');
    expect(w.asked).toEqual(['192.168.0.171']); // the ARP hint first, no sweep needed
    expect(w.saved).toEqual([{ host: '192.168.0.171', port: 8080, terminal: '1807770', previous: '192.168.0.167:8080' }]);
    expect(w.r.lastMove()?.to).toBe('192.168.0.171:8080');
  });

  it('never moves to another terminal, even at the remembered MAC', async () => {
    const w = world({ pinpads: { '192.168.0.171': { terminal: '1730030' } }, arp: WINDOWS_ARP });
    w.kv.set('pinpad.relocate.arpMac', 'aa:bb:cc:dd:ee:01');
    await w.r.tick(silent());
    w.tick(3 * 60_000);
    expect(await w.r.tick(silent())).toContain('not found');
    expect(w.saved).toEqual([]);
    // And not again before the cooldown.
    w.tick(60_000);
    expect(await w.r.tick(silent())).toBeNull();
  });

  it('sweeps the /24 when the ARP table does not know it, and never during a payment', async () => {
    const w = world({ pinpads: { '192.168.0.180': { terminal: '01807770' } } });
    await w.r.tick(silent(true));
    w.tick(3 * 60_000);
    expect(await w.r.tick(silent(true))).toBeNull();
    expect(w.asked).toEqual([]);
    expect(await w.r.tick(silent())).toContain('moved 192.168.0.167:8080 -> 192.168.0.180:8080');
  });

  it('while the pinpad answers it learns who it is (a stranger never teaches it), and its ARP MAC', async () => {
    const w = world({ pinpads: { '192.168.0.167': { terminal: '1807770', serial: 'N4C1' } }, arp: WINDOWS_ARP.replace('192.168.0.171', '192.168.0.167') });
    await w.r.tick({ ...silent(), answering: true });
    expect(w.r.remembered()).toMatchObject({ terminal: '1807770', serial: 'N4C1', arpMac: 'aa:bb:cc:dd:ee:01' });
    const stranger = world({ pinpads: { '192.168.0.167': { terminal: '1730030', serial: 'X' } } });
    await stranger.r.tick({ ...silent(), answering: true });
    expect(stranger.r.remembered().terminal).toBeNull();
    expect(stranger.r.remembered().serial).toBeNull();
  });

  it('identifies over HTTPS with nothing pinned, plain HTTP only for a private address that refuses TLS', async () => {
    const sent: string[] = [];
    const post = async (a: { tls: boolean }, body: string) => {
      sent.push(`${a.tls ? 'https' : 'http'}:${JSON.parse(body).method}`);
      if (a.tls) throw Object.assign(new Error('wrong version number'), { code: 'EPROTO' });
      const m = JSON.parse(body).method;
      return { status: 200, body: m === 'getRetailerInfo' ? '{"result":{"id":"1807770012","name":"ראנר"}}' : '{"result":"ashraitReady"}' };
    };
    const id = await identifyPinpad('192.168.0.171', 8080, '/SPICy', post as never);
    expect(id?.terminal).toBe('1807770');
    expect(sent).toEqual(['https:getStatus', 'http:getStatus', 'http:getInfo', 'http:getRetailerInfo', 'http:getConfig']);
    expect(await identifyPinpad('8.8.8.8', 8080, '/SPICy', post as never)).toBeNull();
  });
});
