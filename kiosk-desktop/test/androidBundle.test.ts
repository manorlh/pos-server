import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_KIND,
  MANIFEST,
  MIN_CHROME,
  buildManifest,
  bundleVersion,
  bundleZip,
  safeBundlePath,
  sha256Hex,
  unzipFiles,
  verifyManifest,
  zipFiles,
} from '../scripts/androidBundle';
import { ANDROID_BRIDGE_API } from '../src/renderer/bridges/android';

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * A tiny bundle, zipped the way build-android-bundle.mjs zips — the same bytes as pos-android
 * app/src/test/resources/kiosk_web_bundle_sample.zip, which the APK's tests unpack and verify.
 * `UPDATE_GOLDEN=1 npm test` rewrites it (then copy it to pos-android).
 */
const SAMPLE_FILES: Array<{ path: string; bytes: Uint8Array }> = [
  { path: 'index.html', bytes: enc('<!doctype html><html lang="he" dir="rtl"><body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>\n') },
  { path: 'assets/app.js', bytes: enc('window.R2MAndroid && window.R2MAndroid.send("ready", "{}");\n'.repeat(40)) },
  { path: 'kiosk/card_terminals.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]) },
];
const SAMPLE_INFO = { version: '2026.10.07-1530', versionCode: 928290, bridgeApi: 1, builtAt: new Date('2026-10-07T15:30:00.000Z') };
const GOLDEN = path.join(__dirname, 'fixtures/kiosk_web_bundle_sample.zip');

describe('the bundle\'s version', () => {
  it('the build time: a readable name, a code that only grows', () => {
    expect(bundleVersion(new Date('2026-10-07T15:30:59Z'))).toEqual({ versionName: '2026.10.07-1530', versionCode: 928290 });
    const a = bundleVersion(new Date('2026-10-07T15:30:00Z')).versionCode;
    const b = bundleVersion(new Date('2026-10-07T15:31:00Z')).versionCode;
    expect(b).toBe(a + 1);
    // Fits the cloud's versionCode column (32-bit) for a very long time.
    expect(bundleVersion(new Date('2999-12-31T23:59:00Z')).versionCode).toBeLessThan(2_147_483_647);
    expect(() => bundleVersion(new Date('2024-06-01T00:00:00Z'))).toThrow();
  });
});

describe('the manifest', () => {
  it('every file but itself, sorted, with its SHA-256 and size', () => {
    const m = buildManifest([...SAMPLE_FILES, { path: MANIFEST, bytes: enc('{}') }], SAMPLE_INFO);
    expect(m.kind).toBe(BUNDLE_KIND);
    expect(m.bridgeApi).toBe(ANDROID_BRIDGE_API);
    expect(m.minChrome).toBe(MIN_CHROME);
    expect(m.entry).toBe('index.html');
    expect(m.builtAt).toBe('2026-10-07T15:30:00.000Z');
    expect(m.files.map((f) => f.path)).toEqual(['assets/app.js', 'index.html', 'kiosk/card_terminals.png']);
    const html = m.files.find((f) => f.path === 'index.html')!;
    expect(html.sha256).toBe(sha256Hex(SAMPLE_FILES[0].bytes));
    expect(html.size).toBe(SAMPLE_FILES[0].bytes.byteLength);
  });

  it('refuses no entry, a bad version and unsafe paths', () => {
    expect(() => buildManifest(SAMPLE_FILES.slice(1), SAMPLE_INFO)).toThrow('entry');
    expect(() => buildManifest(SAMPLE_FILES, { ...SAMPLE_INFO, versionCode: 0 })).toThrow();
    expect(() => buildManifest(SAMPLE_FILES, { ...SAMPLE_INFO, version: 'x'.repeat(65) })).toThrow();
    expect(() => buildManifest([...SAMPLE_FILES, { path: '../evil.js', bytes: enc('x') }], SAMPLE_INFO)).toThrow('unsafe');
  });

  it('safe paths: relative, "/" only, no ".." / drive / control character', () => {
    for (const ok of ['index.html', 'assets/a-b_c.js', 'kiosk/card_terminals.png']) expect(safeBundlePath(ok)).toBe(true);
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a\\b', 'C:/x', './a', 'a/\u0000b']) expect(safeBundlePath(bad)).toBe(false);
  });

  it('verify: tampering, a missing file, an unlisted one and a wrong kind are all caught', () => {
    const m = buildManifest(SAMPLE_FILES, SAMPLE_INFO);
    const files = new Map(SAMPLE_FILES.map((f) => [f.path, f.bytes]));
    expect(verifyManifest(m, files)).toEqual([]);
    const tampered = new Map(files);
    tampered.set('assets/app.js', enc('alert(1)'));
    expect(verifyManifest(m, tampered).join()).toMatch(/size assets\/app\.js/);
    const sameSize = new Map(files);
    const b = new Uint8Array(files.get('index.html')!);
    b[0] ^= 1;
    sameSize.set('index.html', b);
    expect(verifyManifest(m, sameSize)).toEqual(['sha256 index.html']);
    const missing = new Map(files);
    missing.delete('kiosk/card_terminals.png');
    expect(verifyManifest(m, missing)).toEqual(['missing kiosk/card_terminals.png']);
    const extra = new Map(files);
    extra.set('evil.js', enc('x'));
    expect(verifyManifest(m, extra)).toEqual(['unlisted evil.js']);
    expect(verifyManifest({ ...m, kind: 'other' as never }, files)).toEqual(['kind other']);
  });
});

describe('the zip', () => {
  it('reads back exactly, and the same files always give the same bytes', () => {
    const entries = [...SAMPLE_FILES, { path: 'שלום/קובץ.txt', bytes: enc('שלום') }];
    const a = zipFiles(entries);
    const b = zipFiles(entries);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    const back = unzipFiles(a);
    expect([...back.keys()]).toEqual(entries.map((e) => e.path));
    for (const e of entries) expect(Buffer.from(back.get(e.path)!).equals(Buffer.from(e.bytes))).toBe(true);
  });

  it('the bundle zip: manifest.json first, then the files, and it verifies', () => {
    const m = buildManifest(SAMPLE_FILES, SAMPLE_INFO);
    const zip = bundleZip(m, new Map(SAMPLE_FILES.map((f) => [f.path, f.bytes])));
    const back = unzipFiles(zip);
    expect([...back.keys()][0]).toBe(MANIFEST);
    const parsed = JSON.parse(new TextDecoder().decode(back.get(MANIFEST)));
    expect(parsed).toEqual(m);
    expect(verifyManifest(parsed, back)).toEqual([]);
  });

  it('the golden sample the APK\'s tests unpack is this build of it', () => {
    const m = buildManifest(SAMPLE_FILES, SAMPLE_INFO);
    const zip = bundleZip(m, new Map(SAMPLE_FILES.map((f) => [f.path, f.bytes])));
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) writeFileSync(GOLDEN, zip);
    expect(sha256Hex(new Uint8Array(readFileSync(GOLDEN)))).toBe(sha256Hex(zip));
  });
});
