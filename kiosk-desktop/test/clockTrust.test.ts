/**
 * Trusted time and "תיקון שעון" (core/clockTrust.ts, main/clock/*; the owner 17.10.2026: "האם יש דרך לתקן את השעה …
 * וגם בווינדוס אוטומטית?"). The rule is pinned by `clock_trust_golden.json` — byte-equal with pos-android's
 * (app/src/test/resources; ClockTrustTest pins the same SHA-256) and pos-server's tests/fixtures copy.
 *
 * No command runs here: every process is a fake runner.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_TIME_GRACE_MS,
  COOLDOWN_MS,
  FRESH_MS,
  SET_TIME_MIN_SDK,
  STEP_TOLERANCE_MS,
  TRUST_MS,
  clockRowView,
  fixAction,
  secureTimeSource,
  skewWords,
  trustedNow,
  type FixFacts,
} from '../src/core/clockTrust';
import {
  configureTrustedClock,
  lastFixView,
  measurementView,
  noteMeasurement,
  nowDate,
  nowIso,
  resetTrustedClock,
  trusted,
  type ClockStore,
  type LastFix,
  type StoredMeasurement,
} from '../src/main/clock/trustedClock';
import { clockFixCommand, clockFixScript, encodeCommand, isElevated, runClockFix, type Runner } from '../src/main/clock/windowsClockFix';
import { ClockFix, clockAutoFixOn } from '../src/main/clock/clockFix';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { Outbox } from '../src/main/sync/outbox';
import { Ledger } from '../src/main/fiscal/ledger';

const GOLDEN = path.join(__dirname, 'fixtures', 'clock_trust_golden.json');
const GOLDEN_SHA256 = '1e9432cefa78c4ae417fdda3968378cb896a2296bdb570462bc663a38c60a809';
const text = readFileSync(GOLDEN, 'utf8').replace(/\r\n/g, '\n');
const golden = JSON.parse(text) as {
  constants: Record<string, number>;
  vocabulary: Record<string, string[]>;
  trusted: Array<{ name: string; wallMs: number; monoMs: number; m: { skewMs: number; bootWallMs: number; secure: boolean } | null; expect: { nowMs: number; source: string; reason: string } }>;
  fix: Array<{ name: string; in: FixFacts; expect: { action: string; reason: string } }>;
};

afterEach(() => resetTrustedClock());

describe('the shared rule (golden)', () => {
  it('is the same bytes as pos-android and pos-server', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  it('the constants', () => {
    expect(golden.constants).toEqual({
      trustMs: TRUST_MS,
      stepToleranceMs: STEP_TOLERANCE_MS,
      freshMs: FRESH_MS,
      cooldownMs: COOLDOWN_MS,
      autoTimeGraceMs: AUTO_TIME_GRACE_MS,
      setTimeMinSdk: SET_TIME_MIN_SDK,
    });
  });

  for (const c of golden.trusted) {
    it(`trusted: ${c.name}`, () => {
      expect(trustedNow(c.wallMs, c.monoMs, c.m)).toEqual(c.expect);
      expect(golden.vocabulary.trustReasons).toContain(c.expect.reason);
    });
  }

  for (const c of golden.fix) {
    it(`fix: ${c.name}`, () => {
      expect(fixAction(c.in)).toEqual(c.expect);
      expect(golden.vocabulary.actions).toContain(c.expect.action);
      expect(golden.vocabulary.fixReasons).toContain(c.expect.reason);
    });
  }
});

describe('the time source must be verified', () => {
  it('TLS, or the loopback of a developer machine — never plain HTTP on a network', () => {
    expect(secureTimeSource('https://api.r2m.co.il/api/v1/')).toBe(true);
    expect(secureTimeSource('http://localhost:8001/api/v1/')).toBe(true);
    expect(secureTimeSource('http://127.0.0.1:3002/')).toBe(true);
    expect(secureTimeSource('http://192.168.0.10:8001/')).toBe(false);
    expect(secureTimeSource('http://api.example.com/')).toBe(false);
    expect(secureTimeSource('')).toBe(false);
    expect(secureTimeSource(null)).toBe(false);
    expect(secureTimeSource('not a url')).toBe(false);
  });

  it('the skew in words', () => {
    expect(skewWords(40_000)).toBe('מקדים ב-40 שניות');
    expect(skewWords(-420_000)).toBe('מאחר ב-7 דקות');
    expect(skewWords(3 * 3_600_000)).toBe('מקדים ב-3 שעות');
    expect(skewWords(-400 * 86_400_000)).toBe('מאחר ב-400 ימים');
  });
});

/** A fake pair of clocks: `wall` is what the computer says, `mono` the uptime. */
function clocks(wallMs: number, monoMs = 5_000_000) {
  const c = { wall: wallMs, mono: monoMs };
  configureTrustedClock({ wall: () => c.wall, mono: () => c.mono, store: null });
  return c;
}

function memoryStore(): ClockStore & { m: StoredMeasurement | null; fix: LastFix | null } {
  const s = {
    m: null as StoredMeasurement | null,
    fix: null as LastFix | null,
    load: () => ({ m: s.m, lastFix: s.fix }),
    save: (m: StoredMeasurement | null, fix: LastFix | null) => {
      s.m = m;
      s.fix = fix;
    },
  };
  return s;
}

describe('the trusted clock (main/clock/trustedClock.ts)', () => {
  it('the device clock until measured; the server-corrected time from 90 s of skew over TLS', () => {
    const c = clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    expect(nowIso()).toBe('2026-10-17T10:00:00.000Z');
    noteMeasurement(-420_000, true); // 7 minutes behind
    expect(trusted()).toMatchObject({ source: 'server', reason: 'applied' });
    expect(nowIso()).toBe('2026-10-17T10:07:00.000Z');
    c.wall += 1_000;
    c.mono += 1_000;
    expect(nowIso()).toBe('2026-10-17T10:07:01.000Z');
  });

  it('a small skew and a plain-HTTP answer leave the device clock', () => {
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    noteMeasurement(30_000, true);
    expect(trusted().reason).toBe('small');
    noteMeasurement(-420_000, false);
    expect(trusted().reason).toBe('insecure');
    expect(nowIso()).toBe('2026-10-17T10:00:00.000Z');
  });

  it('someone fixed the clock since: back to the device clock (never corrected twice)', () => {
    const c = clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    noteMeasurement(-420_000, true);
    c.wall += 420_000; // the clock moved by hand / NTP
    expect(trusted()).toMatchObject({ source: 'device', reason: 'stepped' });
    expect(nowIso()).toBe('2026-10-17T10:07:00.000Z');
  });

  it('kept across a restart of the app; dropped after the computer restarted', () => {
    const store = memoryStore();
    const c = { wall: Date.parse('2026-10-17T10:00:00.000Z'), mono: 5_000_000 };
    configureTrustedClock({ wall: () => c.wall, mono: () => c.mono, store });
    noteMeasurement(-420_000, true);
    expect(store.m).toMatchObject({ skewMs: -420_000, secure: true, monoMs: 5_000_000 });
    // The app restarts a minute later, same boot.
    resetTrustedClock();
    c.wall += 60_000;
    c.mono += 60_000;
    configureTrustedClock({ wall: () => c.wall, mono: () => c.mono, store });
    expect(nowIso()).toBe('2026-10-17T10:08:00.000Z');
    expect(measurementView().ageMs).toBe(60_000);
    // The computer restarted (uptime from zero).
    c.mono = 30_000;
    expect(trusted().reason).toBe('stepped');
    expect(measurementView().ageMs).toBeNull();
  });

  it('documents, shifts and their business date are stamped with it (the ledger)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clock-'));
    const db = openDb(path.join(dir, 'k.db'));
    migrate(db);
    const ledger = new Ledger(db, new Kv(db), new Outbox(db));
    // The computer thinks it is 23:55 on the 16th (Israel); it is 00:05 on the 17th.
    clocks(Date.parse('2026-10-16T20:55:00.000Z'));
    noteMeasurement(-600_000, true);
    const shift = ledger.openShift({ id: 'u', name: 'קופאי' });
    expect(shift.opened_at).toBe('2026-10-16T21:05:00.000Z');
    expect(nowDate().toISOString()).toBe('2026-10-16T21:05:00.000Z');
  });
});

describe('Windows: "תיקון שעון" (main/clock/windowsClockFix.ts)', () => {
  it('the elevated script: the server time relative to the clock, then automatic time and a resync', () => {
    const s = clockFixScript(420_000);
    expect(s).toContain('Set-Date -Adjust ([TimeSpan]::FromMilliseconds(420000))');
    expect(s).toContain('sc.exe config w32time start= auto');
    expect(s).toContain('net start w32time');
    expect(s).toContain('w32tm /config /manualpeerlist:"time.windows.com,0x9" /syncfromflags:manual /update');
    expect(s).toContain('w32tm /resync /rediscover');
    expect(s.indexOf('Set-Date')).toBeLessThan(s.indexOf('w32tm /resync'));
    expect(clockFixScript(null)).not.toContain('Set-Date');
    expect(clockFixScript(0)).not.toContain('Set-Date');
  });

  it('through UAC unless elevated; the script is passed encoded', () => {
    const asked = clockFixCommand(-60_000, false);
    expect(asked.file).toBe('powershell.exe');
    const cmd = asked.args[asked.args.indexOf('-Command') + 1];
    expect(cmd).toContain('Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru');
    expect(cmd).toContain(encodeCommand(clockFixScript(-60_000)));
    const direct = clockFixCommand(-60_000, true);
    expect(direct.args).toContain('-EncodedCommand');
    expect(direct.args.join(' ')).not.toContain('RunAs');
    expect(Buffer.from(direct.args[direct.args.length - 1], 'base64').toString('utf16le')).toBe(clockFixScript(-60_000));
  });

  it('the outcomes: done, declined at the UAC prompt, the adjustment failed, not run', async () => {
    const fake = (code: number | null): Runner => async () => ({ code, stdout: '', stderr: '' });
    expect((await runClockFix(fake(0), 5_000, false)).result).toBe('ok');
    expect(await runClockFix(fake(1223), 5_000, false)).toMatchObject({ result: 'refused' });
    expect((await runClockFix(fake(2), 5_000, true)).result).toBe('failed');
    expect((await runClockFix(async () => Promise.reject(new Error('ENOENT')), null, true)).result).toBe('failed');
  });

  it('elevated: `net session` answers', async () => {
    expect(await isElevated(async (f, a) => ({ code: f === 'net.exe' && a[0] === 'session' ? 0 : 1, stdout: '', stderr: '' }))).toBe(true);
    expect(await isElevated(async () => ({ code: 2, stdout: '', stderr: 'Access is denied.' }))).toBe(false);
    expect(await isElevated(async () => Promise.reject(new Error('x')))).toBe(false);
  });

  it('`clockAutoFix`: on unless the cloud says off', () => {
    expect(clockAutoFixOn(undefined)).toBe(true);
    expect(clockAutoFixOn(null)).toBe(true);
    expect(clockAutoFixOn(true)).toBe(true);
    expect(clockAutoFixOn('true')).toBe(true);
    expect(clockAutoFixOn(false)).toBe(false);
    expect(clockAutoFixOn('false')).toBe(false);
    expect(clockAutoFixOn('0')).toBe(false);
  });
});

describe('Windows: the service (main/clock/clockFix.ts)', () => {
  function service(o: { elevated: boolean; enabled?: boolean; busy?: boolean; code?: number }) {
    const calls: Array<{ file: string; args: string[] }> = [];
    const run: Runner = async (file, args) => {
      calls.push({ file, args });
      if (file === 'net.exe') return { code: o.elevated ? 0 : 2, stdout: '', stderr: '' };
      return { code: o.code ?? 0, stdout: '', stderr: '' };
    };
    const logs: string[] = [];
    const fix = new ClockFix({ run, enabled: () => o.enabled ?? true, busy: () => o.busy ?? false, log: (m) => logs.push(m) });
    return { fix, calls, logs };
  }
  const scripts = (calls: Array<{ file: string; args: string[] }>) =>
    calls.filter((c) => c.file === 'powershell.exe').map((c) => c.args.join(' '));

  it('never changes the clock by itself without admin rights — the technician is offered the fix', async () => {
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const { fix, calls } = service({ elevated: false });
    await fix.init();
    noteMeasurement(3_600_000, true);
    await fix.afterMeasurement();
    expect(scripts(calls)).toEqual([]);
    expect(fix.report()).toMatchObject({ source: 'server', offsetMs: -3_600_000, autoFix: 'none', pending: 'prompt', pendingReason: 'manual' });
    expect(clockRowView(3_600_000, fix.report())).toMatchObject({ offerFix: true, corrected: true, light: 'bad' });
  });

  it('elevated + clockAutoFix: fixes once, then waits the cooldown', async () => {
    const c = clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const { fix, calls } = service({ elevated: true });
    await fix.init();
    noteMeasurement(3_600_000, true);
    await fix.afterMeasurement();
    expect(scripts(calls)).toHaveLength(1);
    expect(scripts(calls)[0]).not.toContain('RunAs');
    expect(lastFixView().fix).toMatchObject({ action: 'set_time', result: 'ok', fromMs: 3_600_000 });
    c.mono += 60_000;
    noteMeasurement(3_600_000, true);
    await fix.afterMeasurement();
    expect(scripts(calls)).toHaveLength(1);
    expect(fix.report()).toMatchObject({ autoFix: 'elevated', pending: 'none', pendingReason: 'cooldown', lastFixResult: 'ok' });
  });

  it('elevated but off, under a payment, or on plain HTTP: nothing runs', async () => {
    for (const o of [{ enabled: false }, { busy: true }]) {
      clocks(Date.parse('2026-10-17T10:00:00.000Z'));
      const { fix, calls } = service({ elevated: true, ...o });
      await fix.init();
      noteMeasurement(3_600_000, true);
      await fix.afterMeasurement();
      expect(scripts(calls)).toEqual([]);
    }
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const { fix, calls } = service({ elevated: true });
    await fix.init();
    noteMeasurement(3_600_000, false);
    await fix.afterMeasurement();
    expect(scripts(calls)).toEqual([]);
  });

  it('the technician: through UAC, the server time only from a fresh TLS measurement off by 90 s', async () => {
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const { fix, calls } = service({ elevated: false });
    await fix.init();
    noteMeasurement(-420_000, true);
    expect(await fix.technicianFix()).toMatchObject({ ok: true });
    const [cmd] = scripts(calls);
    expect(cmd).toContain('RunAs');
    expect(cmd).toContain(encodeCommand(clockFixScript(420_000)));
    expect(lastFixView().fix).toMatchObject({ action: 'set_time', result: 'ok', fromMs: -420_000 });

    // Plain HTTP: automatic time only.
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const b = service({ elevated: false });
    await b.fix.init();
    noteMeasurement(-420_000, false);
    await b.fix.technicianFix();
    expect(scripts(b.calls)[0]).toContain(encodeCommand(clockFixScript(null)));
    expect(lastFixView().fix?.action).toBe('enable_auto_time');

    // The UAC prompt declined.
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const d = service({ elevated: false, code: 1223 });
    await d.fix.init();
    noteMeasurement(-420_000, true);
    expect(await d.fix.technicianFix()).toMatchObject({ ok: false, message: 'Windows לא אישר (בקשת ההרשאה נדחתה)' });
    expect(lastFixView().fix?.result).toBe('refused');
  });

  it('the technician: never under a payment, and not on a build that cannot run it', async () => {
    clocks(Date.parse('2026-10-17T10:00:00.000Z'));
    const { fix, calls } = service({ elevated: false, busy: true });
    expect(await fix.technicianFix()).toEqual({ ok: false, message: 'לא בזמן תשלום' });
    expect(calls).toEqual([]);
    const none = new ClockFix({ run: null, enabled: () => true, busy: () => false, log: () => undefined });
    await none.init();
    expect(none.capability()).toBe('none');
    expect((await none.technicianFix()).ok).toBe(false);
  });

  it('the technician row', () => {
    expect(clockRowView(null, null)).toMatchObject({ text: 'לא נמדד', light: null, offerFix: false });
    expect(clockRowView(800, null)).toMatchObject({ text: 'תקין', light: 'ok' });
    expect(clockRowView(40_000, null)).toMatchObject({ text: 'מקדים ב-40 שניות', light: 'ok', offerFix: false });
    expect(clockRowView(-420_000, { source: 'server', reason: 'applied', offsetMs: 420_000, autoFix: 'none', autoFixEnabled: true })).toMatchObject({
      text: 'מאחר ב-7 דקות · המסמכים נחתמים לפי שעון השרת',
      light: 'bad',
      offerFix: true,
      corrected: true,
    });
  });
});
