import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attempt, codeMatches, hashCode, inTechnicianZone, LOCKOUT_MS, mayOpen, NO_LOCK, TapSequence, TechnicianCorner, tillTechnicianArmed } from '../src/core/technician';
import { readFileSync } from 'node:fs';
import { APP_IPC } from '../src/shared/till/appBridge';

const pbkdf2 = (p: string, s: string, it: number, len: number) => pbkdf2Sync(p, s, it, len, 'sha256');

// The golden vector pinned in pos-server tests/test_kiosk_technician.py and the Android KioskTechnicianTest.
const GOLDEN_MACHINE = 'de93de29-19bb-4480-ab06-f73af2876841';
const GOLDEN_1995 = 'pbkdf2-sha256$10000$21802f21a7b5d44d5bb054d0b77447f571029bbf4f3e634aa46c33a193f60dd3';

describe('the technician code (KioskTechnicianCode)', () => {
  it('hashes exactly as the cloud and the till (golden vector)', () => {
    expect(hashCode('1995', GOLDEN_MACHINE, pbkdf2)).toBe(GOLDEN_1995);
    expect(hashCode('1995', ` ${GOLDEN_MACHINE.toUpperCase()} `, pbkdf2)).toBe(GOLDEN_1995);
  });

  it('1995 by default; the cloud’s hash when set; a malformed hash of ours is never compared as text', () => {
    expect(codeMatches('1995', null, GOLDEN_MACHINE, pbkdf2)).toBe(true);
    expect(codeMatches('1996', null, GOLDEN_MACHINE, pbkdf2)).toBe(false);
    expect(codeMatches('1995', GOLDEN_1995, GOLDEN_MACHINE, pbkdf2)).toBe(true);
    expect(codeMatches('4242', hashCode('4242', GOLDEN_MACHINE, pbkdf2), GOLDEN_MACHINE, pbkdf2)).toBe(true);
    expect(codeMatches('1995', 'pbkdf2-sha256$x$y', GOLDEN_MACHINE, pbkdf2)).toBe(false);
    expect(codeMatches('12', null, GOLDEN_MACHINE, pbkdf2)).toBe(false);
  });

  it('five wrong codes lock the pad for five minutes; a locked pad does not even check', () => {
    let lock = NO_LOCK;
    for (let i = 0; i < 4; i++) {
      const r = attempt(lock, 1000, () => false);
      expect(r.outcome).toBe('wrong');
      lock = r.lock;
    }
    const out = attempt(lock, 1000, () => false);
    expect(out.outcome).toBe('locked_out');
    let checked = false;
    expect(
      attempt(out.lock, 2000, () => {
        checked = true;
        return true;
      }).outcome,
    ).toBe('locked');
    expect(checked).toBe(false);
    expect(attempt(out.lock, 1000 + LOCKOUT_MS + 1, () => true).outcome).toBe('granted');
  });
});

describe('the six taps', () => {
  it('count only in the top-left L, six within three seconds', () => {
    expect(inTechnicianZone(5, 60)).toBe(true);
    expect(inTechnicianZone(60, 5)).toBe(true);
    expect(inTechnicianZone(40, 40)).toBe(false);
    const t = new TapSequence();
    for (let i = 0; i < 5; i++) expect(t.tap(i * 400)).toBe(false);
    expect(t.tap(2_000)).toBe(true);
    const slow = new TapSequence();
    for (let i = 0; i < 6; i++) expect(slow.tap(i * 1_000)).toBe(false);
  });

  it('never during a payment', () => {
    expect(mayOpen({ screen: 'pay', busy: false }, false)).toBe(false);
    expect(mayOpen({ screen: 'catalog', busy: true }, false)).toBe(false);
    expect(mayOpen({ screen: 'attract', busy: false }, true)).toBe(false);
    expect(mayOpen({ screen: 'attract', busy: false }, false)).toBe(true);
  });
});

describe('the till’s six taps (roles/till/TillApp.tsx — the PIN screen too)', () => {
  it('are armed on every till screen and with the engine not up yet, never while paying', () => {
    expect(tillTechnicianArmed(null)).toBe(true);
    expect(tillTechnicianArmed('idle')).toBe(true);
    expect(tillTechnicianArmed('done')).toBe(true);
    expect(tillTechnicianArmed('tender')).toBe(false);
    expect(tillTechnicianArmed('card_waiting')).toBe(false);
  });

  it('open on the sixth tap in the top-left corner within 3 s; outside the zone or unarmed they do not', () => {
    const c = new TechnicianCorner();
    for (let i = 0; i < 5; i++) expect(c.tap(5, 5, 1_000 + i * 100, true)).toBe(false);
    expect(c.tap(5, 5, 1_600, true)).toBe(true);
    // Elsewhere on the screen: not counted.
    const d = new TechnicianCorner();
    for (let i = 0; i < 10; i++) expect(d.tap(400, 300, 1_000 + i * 100, true)).toBe(false);
    // A payment in the middle starts the count over.
    const e = new TechnicianCorner();
    for (let i = 0; i < 5; i++) e.tap(5, 5, 1_000 + i * 100, true);
    expect(e.tap(5, 5, 1_550, false)).toBe(false);
    expect(e.tap(5, 5, 1_600, true)).toBe(false);
    // Too slow: the window is 3 s.
    const f = new TechnicianCorner();
    for (let i = 0; i < 6; i++) expect(f.tap(5, 5, i * 700, true)).toBe(false);
  });

  it('reach the shell through its own channel, the till view’s preload, the main process and the shell’s menu', () => {
    expect(APP_IPC.technician).toBe('app:technician');
    const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), 'utf8');
    expect(src('preload/app.ts')).toContain('openTechnician: () => ipcRenderer.send(APP_IPC.technician)');
    expect(src('main/roles/tillElectron.ts')).toContain("ipcMain.on(APP_IPC.technician, (e) => openShell(e, 'technician'))");
    expect(src('main/index.ts')).toContain("sendShell('shell:admin', { from: 'till', screen })");
    expect(src('renderer/staff/ShellStaff.tsx')).toContain("p?.screen === 'technician' ? 'technician' : 'admin'");
    expect(src('renderer/roles/till/TillApp.tsx')).toContain('host.ui.openTechnician()');
  });
});
