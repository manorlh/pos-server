/**
 * Run with `npm test`. The pairing-code QR (lib/pairingCodeQr.ts, pos-server docs/SPEC_PAIRING_QR.md §2)
 * against the golden fixture the till reads too (server/tests/fixtures/pairing_qr_golden.json, the same
 * bytes in pos-android app/src/test/resources; each side pins the LF-normalised SHA-256).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  PAIRING_QR_PREFIX,
  buildPairingQr,
  expiryEpochSeconds,
  isLoopbackServer,
  parsePairingQr,
  pairingQrServer,
  percentEncode,
  resolvePairingServer,
} from './pairingCodeQr';

/** The same constant in pos-server tests/test_pairing_qr_name.py and pos-android's DashboardPairingQrTest. */
const GOLDEN_SHA256 = '084bf292182c974a623f4cf752c4a4a763c096644eeabcb29b2a5cec79ea9d1c';

const raw = readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'pairing_qr_golden.json'), 'utf8');
const golden = JSON.parse(raw) as {
  build: { name: string; server: string; code: string; exp: number; payload: string }[];
  refusedBuild: { name: string; server: string; code: string; exp: number; payload: null }[];
  parse: { name: string; payload: string; now: number; result: Record<string, unknown> }[];
};

describe('the golden fixture', () => {
  it('is the bytes pos-android pins', () => {
    assert.equal(createHash('sha256').update(raw.replace(/\r\n/g, '\n'), 'utf8').digest('hex'), GOLDEN_SHA256);
  });

  it('covers every outcome', () => {
    assert.deepEqual([...new Set(golden.parse.map((c) => c.result.outcome))].sort(), ['expired', 'unrecognized', 'valid']);
  });
});

describe('what the dashboard draws', () => {
  for (const c of golden.build) {
    it(c.name, () => {
      assert.equal(buildPairingQr({ server: c.server, code: c.code, exp: c.exp }), c.payload);
      // And the till reads back what was put in (the address as normalised).
      assert.deepEqual(parsePairingQr(c.payload, c.exp - 1), {
        outcome: 'valid',
        server: c.server.replace(/\/+$/, ''),
        code: c.code,
        exp: c.exp,
      });
    });
  }

  for (const c of golden.refusedBuild) {
    it(`draws nothing: ${c.name}`, () => {
      assert.equal(buildPairingQr({ server: c.server, code: c.code, exp: c.exp }), null);
    });
  }

  it('is a link, in the order v, server, code, exp', () => {
    const payload = buildPairingQr({ server: 'https://api.example.test/api/v1', code: 'AB12CD34', exp: 1791634500 });
    assert.equal(
      payload,
      'r2mpos://pair?v=1&server=https%3A%2F%2Fapi.example.test%2Fapi%2Fv1&code=AB12CD34&exp=1791634500',
    );
    assert.ok(payload?.startsWith(PAIRING_QR_PREFIX));
  });
});

describe('what the till decides', () => {
  for (const c of golden.parse) {
    it(c.name, () => {
      assert.deepEqual(parsePairingQr(c.payload, c.now), c.result);
    });
  }
});

describe('the pieces', () => {
  it('percent-encodes everything but the unreserved characters, in upper-case hex', () => {
    assert.equal(percentEncode('AZaz09-_.~'), 'AZaz09-_.~');
    assert.equal(percentEncode('a b/c?d#e&f=g'), 'a%20b%2Fc%3Fd%23e%26f%3Dg');
    assert.equal(percentEncode("!'()*"), '%21%27%28%29%2A');
    assert.equal(percentEncode('קופה'), '%D7%A7%D7%95%D7%A4%D7%94');
  });

  it('an address: http(s), a host, nothing after the path', () => {
    assert.equal(pairingQrServer('https://api.example.test/api/v1/'), 'https://api.example.test/api/v1');
    assert.equal(pairingQrServer('HTTP://Api.Example.test'), 'HTTP://Api.Example.test');
    assert.equal(pairingQrServer('http://[fd00::20]:8001/api/v1'), 'http://[fd00::20]:8001/api/v1');
    for (const bad of ['ftp://x.test', 'https://', 'https:///a', 'https://u:p@x.test', 'https://x.test/a?b', 'https://x.test/#a', 'https://x.test/a b', 'x.test', '']) {
      assert.equal(pairingQrServer(bad), null, bad);
    }
  });

  it('loopback is recognised, a LAN address is not', () => {
    for (const lo of ['http://localhost:8001', 'http://LOCALHOST/api', 'http://127.0.0.1:8001/api/v1', 'http://127.8.8.8', 'http://[::1]:8001', 'http://0.0.0.0:1', 'http://pos.localhost']) {
      assert.equal(isLoopbackServer(lo), true, lo);
    }
    for (const ok of ['http://192.168.1.20:8001', 'https://api.example.test', 'http://[fd00::20]:8001', 'http://10.0.2.2:8001']) {
      assert.equal(isLoopbackServer(ok), false, ok);
    }
  });

  it('the server is the dashboard\'s own API base, a relative one resolved against the page', () => {
    assert.equal(resolvePairingServer('https://api.example.test/api/v1/', 'https://dash.example.test'), 'https://api.example.test/api/v1');
    assert.equal(resolvePairingServer(' https://api.example.test/api/v1 ', ''), 'https://api.example.test/api/v1');
    assert.equal(resolvePairingServer('/api/v1', 'https://dash.example.test'), 'https://dash.example.test/api/v1');
    assert.equal(resolvePairingServer('/api/v1', ''), null);
    assert.equal(resolvePairingServer('', 'https://dash.example.test'), null);
    assert.equal(resolvePairingServer(undefined, 'https://dash.example.test'), null);
    // A development box: no device can reach it, so there is nothing to scan.
    assert.equal(resolvePairingServer('http://localhost:8000/api/v1', 'http://localhost:3002'), null);
    assert.equal(resolvePairingServer('/api/v1', 'http://localhost:3002'), null);
    assert.equal(resolvePairingServer('ftp://files.example.test', ''), null);
  });

  it('the expiry is the server\'s own, as epoch seconds', () => {
    assert.equal(expiryEpochSeconds('2026-10-10T12:15:00+00:00'), 1791634500);
    assert.equal(expiryEpochSeconds('2026-10-10T12:15:00Z'), 1791634500);
    assert.equal(expiryEpochSeconds('2026-10-10T15:15:00+03:00'), 1791634500);
    assert.equal(expiryEpochSeconds('2026-10-10T12:15:00.250000Z'), 1791634500);
    // No zone: UTC, never the browser's.
    assert.equal(expiryEpochSeconds('2026-10-10T12:15:00'), 1791634500);
    assert.equal(expiryEpochSeconds(''), null);
    assert.equal(expiryEpochSeconds(null), null);
    assert.equal(expiryEpochSeconds('tomorrow'), null);
    assert.equal(expiryEpochSeconds(1791634500), null);
  });

  it('a code or expiry the format cannot carry draws nothing', () => {
    const base = { server: 'https://api.example.test/api/v1', code: 'AB12CD34', exp: 1791634500 };
    assert.notEqual(buildPairingQr(base), null);
    assert.equal(buildPairingQr({ ...base, code: 'ab12cd34' }), null);
    assert.equal(buildPairingQr({ ...base, code: '' }), null);
    assert.equal(buildPairingQr({ ...base, exp: 1791634500.5 }), null);
    assert.equal(buildPairingQr({ ...base, exp: -1 }), null);
    assert.equal(buildPairingQr({ ...base, exp: 1791634500000 }), null);
    assert.equal(buildPairingQr({ ...base, exp: Number.NaN }), null);
  });
});
