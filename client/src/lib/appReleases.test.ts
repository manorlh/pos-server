/**
 * Run with `npm test`. "עדכוני גרסה" — the app-updates page's rules (lib/appReleases.ts),
 * twins of pos-server app/services/app_updates.py.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  behindCounts,
  checkInstallWindow,
  filterByPlatform,
  onlyBehind,
  parseRolloutPercent,
  platformOf,
  platformOfFile,
  versionFromInstallerName,
  windowsVersionCode,
} from './appReleases';

describe('platforms', () => {
  const rows = [
    { id: 'a', platform: 'android' },
    { id: 'w', platform: 'windows' },
    { id: 'old' }, // from before there were two platforms
    { id: 'n', platform: null },
  ];

  it('a row without a platform is Android', () => {
    assert.equal(platformOf({}), 'android');
    assert.equal(platformOf({ platform: null }), 'android');
    assert.equal(platformOf({ platform: 'windows' }), 'windows');
  });

  it('filters by platform, "all" keeps everything', () => {
    assert.deepEqual(filterByPlatform(rows, 'all').map((r) => r.id), ['a', 'w', 'old', 'n']);
    assert.deepEqual(filterByPlatform(rows, 'android').map((r) => r.id), ['a', 'old', 'n']);
    assert.deepEqual(filterByPlatform(rows, 'windows').map((r) => r.id), ['w']);
  });

  it('an .exe is a Windows installer, an .apk an Android build', () => {
    assert.equal(platformOfFile('R2M-Kiosk-0.2.0-setup.exe'), 'windows');
    assert.equal(platformOfFile('APP.EXE'), 'windows');
    assert.equal(platformOfFile('till-release.apk'), 'android');
    assert.equal(platformOfFile('notes.txt'), null);
    assert.equal(platformOfFile(undefined), null);
  });
});

describe('devices behind their target', () => {
  const rollout = [
    { platform: 'android', behind: true },
    { platform: 'android', behind: false },
    { platform: 'windows', behind: true },
    { platform: 'windows', behind: true },
    { behind: true },
    { platform: 'windows', behind: null },
  ];

  it('counts per platform', () => {
    assert.deepEqual(behindCounts(rollout), { android: 2, windows: 2 });
    assert.deepEqual(behindCounts([]), { android: 0, windows: 0 });
  });

  it('the "only behind" filter', () => {
    assert.equal(onlyBehind(rollout, true).length, 4);
    assert.equal(onlyBehind(rollout, false).length, rollout.length);
  });
});

describe('rollout percent', () => {
  it('a whole number 1..100; empty is the default 100', () => {
    assert.equal(parseRolloutPercent(''), 100);
    assert.equal(parseRolloutPercent(' 25 '), 25);
    assert.equal(parseRolloutPercent('1'), 1);
    assert.equal(parseRolloutPercent('100'), 100);
    for (const bad of ['0', '101', '-5', '12.5', 'abc', '1e2', '1000']) {
      assert.equal(parseRolloutPercent(bad), null, bad);
    }
  });
});

describe('the Windows version code', () => {
  it('a.b.c → a·1 000 000 + b·1 000 + c, suffixes ignored (the server and the app agree)', () => {
    assert.equal(windowsVersionCode('0.2.0'), 2_000);
    assert.equal(windowsVersionCode('1.2.3'), 1_002_003);
    assert.equal(windowsVersionCode('1.2.3+build.7'), 1_002_003);
    assert.equal(windowsVersionCode('1.2.3-beta.1'), 1_002_003);
    assert.equal(windowsVersionCode('12.0.999'), 12_000_999);
  });

  it('refuses what is not a.b.c', () => {
    for (const bad of ['1.2', 'v1.2.3', '1.1000.0', '1.2.1000', '0.0.0', 'abc', '']) {
      assert.equal(windowsVersionCode(bad), null, bad);
    }
  });

  it('reads the version from the built installer name', () => {
    assert.equal(versionFromInstallerName('R2M-Kiosk-0.2.0-setup.exe'), '0.2.0');
    assert.equal(versionFromInstallerName('R2M-POS-Windows-1.10.3-Setup.EXE'), '1.10.3');
    assert.equal(versionFromInstallerName('setup.exe'), null);
    assert.equal(versionFromInstallerName(null), null);
  });
});

describe('install window', () => {
  it('both ends or neither', () => {
    assert.deepEqual(checkInstallWindow('', ''), { ok: true, window: null });
    assert.deepEqual(checkInstallWindow('02:00', '05:30'), { ok: true, window: { start: '02:00', end: '05:30' } });
    // Crossing midnight is a window too.
    assert.deepEqual(checkInstallWindow('22:00', '05:00'), { ok: true, window: { start: '22:00', end: '05:00' } });
  });

  it('refuses half a window, a bad time and an empty window', () => {
    for (const [s, e] of [['02:00', ''], ['', '05:00'], ['24:00', '05:00'], ['2:00', '05:00'], ['03:00', '03:00']]) {
      assert.deepEqual(checkInstallWindow(s, e), { ok: false }, `${s}-${e}`);
    }
  });
});
