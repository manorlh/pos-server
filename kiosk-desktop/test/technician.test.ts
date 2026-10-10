import { pbkdf2Sync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { attempt, codeMatches, hashCode, inTechnicianZone, LOCKOUT_MS, mayOpen, NO_LOCK, TapSequence } from '../src/core/technician';

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
