/**
 * The Android kiosk's web bundle (pos-android ui/kiosk/web; pos-server docs/SPEC_UPDATES.md):
 * the screens built for the WebView (vite.android.config.mts), described by a manifest and zipped
 * — what the cloud hosts as a `kiosk_web` release and what the APK ships as its fallback.
 *
 *   manifest.json  { kind, version, versionCode, bridgeApi, minChrome, entry, builtAt,
 *                    files: [{ path, sha256, size }] }   (every file but itself, sorted by path)
 *
 * The APK checks every file's SHA-256 and size before it switches to a bundle, refuses a bundle
 * whose `bridgeApi` it does not speak, and a WebView older than `minChrome`. Pure (Node only):
 * build-android-bundle.mjs runs it after the Vite build; the tests pin it.
 */

import { createHash } from 'node:crypto';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export const BUNDLE_KIND = 'r2m-kiosk-web';
export const MANIFEST = 'manifest.json';

/**
 * The oldest Android WebView (Chrome major) the screens draw right on: Tailwind 4's CSS (cascade
 * layers, color-mix, @property) needs Chrome 111. An older WebView keeps the built-in screens.
 */
export const MIN_CHROME = 111;

export interface BundleFile {
  path: string;
  sha256: string;
  size: number;
}

export interface BundleManifest {
  kind: typeof BUNDLE_KIND;
  version: string;
  versionCode: number;
  bridgeApi: number;
  minChrome: number;
  entry: string;
  builtAt: string;
  files: BundleFile[];
}

/** The minutes since this moment are a build's versionCode (fits the cloud's 32-bit column for millennia). */
export const VERSION_EPOCH_MS = Date.UTC(2025, 0, 1);

/**
 * A build's version from its time (UTC): versionName "YYYY.MM.DD-HHMM", versionCode the minutes
 * since 2025-01-01 — each later build is higher, as the cloud's "never offer a lower one" wants.
 */
export function bundleVersion(at: Date): { versionName: string; versionCode: number } {
  const p = (n: number) => String(n).padStart(2, '0');
  const versionName = `${at.getUTCFullYear()}.${p(at.getUTCMonth() + 1)}.${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}`;
  const versionCode = Math.floor((at.getTime() - VERSION_EPOCH_MS) / 60_000);
  if (versionCode < 1) throw new Error('build time before 2025');
  return { versionName, versionCode };
}

/** A path inside the bundle: relative, "/" only, no "..", no drive, no control characters. */
export function safeBundlePath(p: string): boolean {
  if (!p || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[a-zA-Z]:/.test(p)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function buildManifest(
  files: Array<{ path: string; bytes: Uint8Array }>,
  info: { version: string; versionCode: number; bridgeApi: number; builtAt: Date; entry?: string; minChrome?: number },
): BundleManifest {
  const entry = info.entry ?? 'index.html';
  const listed = files
    .filter((f) => f.path !== MANIFEST)
    .map((f) => {
      if (!safeBundlePath(f.path)) throw new Error(`unsafe path in the bundle: ${f.path}`);
      return { path: f.path, sha256: sha256Hex(f.bytes), size: f.bytes.byteLength };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!listed.some((f) => f.path === entry)) throw new Error(`the entry ${entry} is not in the bundle`);
  if (!Number.isInteger(info.versionCode) || info.versionCode < 1 || info.versionCode > 2_147_483_647) throw new Error('versionCode out of range');
  if (!info.version || info.version.length > 64) throw new Error('version must be 1..64 characters');
  return {
    kind: BUNDLE_KIND,
    version: info.version,
    versionCode: info.versionCode,
    bridgeApi: info.bridgeApi,
    minChrome: info.minChrome ?? MIN_CHROME,
    entry,
    builtAt: info.builtAt.toISOString(),
    files: listed,
  };
}

/** What a manifest says against the files themselves: the problems (empty = it holds). */
export function verifyManifest(manifest: BundleManifest, files: Map<string, Uint8Array>): string[] {
  const problems: string[] = [];
  if (manifest.kind !== BUNDLE_KIND) problems.push(`kind ${String(manifest.kind)}`);
  for (const f of manifest.files) {
    const bytes = files.get(f.path);
    if (!safeBundlePath(f.path)) problems.push(`unsafe ${f.path}`);
    else if (!bytes) problems.push(`missing ${f.path}`);
    else if (bytes.byteLength !== f.size) problems.push(`size ${f.path}`);
    else if (sha256Hex(bytes) !== f.sha256) problems.push(`sha256 ${f.path}`);
  }
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const p of files.keys()) if (p !== MANIFEST && !listed.has(p)) problems.push(`unlisted ${p}`);
  if (!listed.has(manifest.entry)) problems.push(`entry ${manifest.entry}`);
  return problems;
}

/* --------------------------------------------------------------------- zip */

// DOS date 1980-01-01 00:00: the same files always give the same zip (and the same SHA-256).
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
const UTF8_NAMES = 0x0800;

/**
 * A plain zip of [entries] (deflated, or stored when deflating does not help), names in UTF-8,
 * in the given order, no data descriptors — what java.util.zip on the APK reads.
 */
export function zipFiles(entries: Array<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const raw = Buffer.from(e.bytes.buffer, e.bytes.byteOffset, e.bytes.byteLength);
    const deflated = deflateRawSync(raw, { level: 9 });
    const stored = deflated.byteLength >= raw.byteLength;
    const data = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.byteLength, 18);
    local.writeUInt32LE(raw.byteLength, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(UTF8_NAMES, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.byteLength, 20);
    cd.writeUInt32LE(raw.byteLength, 24);
    cd.writeUInt16LE(name.byteLength, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.byteLength + name.byteLength + data.byteLength;
  }
  const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, ...central, end]));
}

/** The zip's entries back (the tests, and a check of a built zip): path → bytes. */
export function unzipFiles(zip: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, Uint8Array>();
  let at = 0;
  while (at + 4 <= buf.byteLength && buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const csize = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extraLen = buf.readUInt16LE(at + 28);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    const start = at + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + csize);
    out.set(name, new Uint8Array(method === 8 ? inflateRawSync(data) : data));
    at = start + csize;
  }
  return out;
}

/** The bundle zip: manifest.json first, then the files in the manifest's order. */
export function bundleZip(manifest: BundleManifest, files: Map<string, Uint8Array>): Uint8Array {
  const entries: Array<{ path: string; bytes: Uint8Array }> = [{ path: MANIFEST, bytes: new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`) }];
  for (const f of manifest.files) {
    const bytes = files.get(f.path);
    if (!bytes) throw new Error(`missing ${f.path}`);
    entries.push({ path: f.path, bytes });
  }
  return zipFiles(entries);
}
