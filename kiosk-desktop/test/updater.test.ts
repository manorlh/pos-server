import { describe, expect, it } from 'vitest';
import { acceptOffer, newer, parseLatestYml, versionCodeOf } from '../src/main/update/updater';

describe('updates', () => {
  it('takes a cloud offer only when it is a Windows release (never the Android APK)', () => {
    const offer = { available: true, releaseId: 'r', versionCode: 2000, versionName: '0.2.0', sha256: 'a'.repeat(64), sizeBytes: 1, autoInstall: false };
    expect(acceptOffer({ ...offer, platform: 'windows' }, '0.1.0')).toBe(true);
    expect(acceptOffer(offer, '0.1.0')).toBe(false); // a server without the platform field
    expect(acceptOffer({ ...offer, platform: 'android' }, '0.1.0')).toBe(false);
    expect(acceptOffer({ ...offer, platform: 'windows' }, '0.2.0')).toBe(false);
  });

  it('reads electron-builder’s latest.yml', () => {
    const yml = "version: 0.2.0\nfiles:\n  - url: R2M-Kiosk-0.2.0-setup.exe\n    sha512: abc==\n    size: 1\npath: R2M-Kiosk-0.2.0-setup.exe\nsha512: XYZ+/==\nreleaseDate: '2026-10-06T10:00:00.000Z'\n";
    expect(parseLatestYml(yml)).toEqual({ version: '0.2.0', path: 'R2M-Kiosk-0.2.0-setup.exe', sha512: 'XYZ+/==' });
    expect(parseLatestYml('nothing')).toBe(null);
  });

  it('versions compare numerically', () => {
    expect(versionCodeOf('1.2.3')).toBe(1_002_003);
    expect(newer('0.9.0', '0.10.0')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
  });
});
