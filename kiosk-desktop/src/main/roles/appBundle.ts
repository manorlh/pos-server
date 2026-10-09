/**
 * The one app bundle (`r2m-app`, P:/specs/web-till-spec-v2.md §8.1) on disk: its manifest, the
 * check of every file against it before a single file is served (the APK's
 * `KioskWebBundle.verifyDir`), and the Ed25519 signature of the manifest's bytes (§8.1 — the
 * release key lives in CI, its public half is pinned in the shells).
 *
 *   manifest.json  { kind: "r2m-app", version, versionCode, roles, protocol, shellApi,
 *                    bridgeApi, minChrome, minSafari, entry, builtAt,
 *                    files: [{ path, sha256, size }] }   (every file but itself, sorted)
 *   manifest.sig   the signature (raw 64 bytes, or base64) — optional until decision 11 names
 *                  the key's keeper; with a pinned key a bundle without a good signature is refused.
 *
 * Node only (node:crypto, node:fs) and nothing newer than Node 16 — the Windows 7 build runs
 * Electron 22 (§13.2). Imported by the main process (roles/till.ts) and by
 * scripts/build-app-bundle.mjs, so it imports no other file of this tree.
 */

import { createHash, createPublicKey, verify as verifySig } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const APP_BUNDLE_KIND = 'r2m-app';
export const APP_MANIFEST = 'manifest.json';
export const APP_SIGNATURE = 'manifest.sig';

export interface AppBundleFile {
  path: string;
  sha256: string;
  size: number;
}

export interface AppBundleManifest {
  kind: typeof APP_BUNDLE_KIND;
  version: string;
  versionCode: number;
  roles: string[];
  protocol: number;
  shellApi: Record<string, number>;
  bridgeApi: number;
  minChrome: number;
  minSafari: string;
  entry: string;
  builtAt: string;
  files: AppBundleFile[];
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A path inside the bundle: relative, "/" only, no "..", no drive, no control characters. */
export function safeBundlePath(p: string): boolean {
  if (!p || p.length > 300) return false;
  if (p.startsWith('/') || p.includes('\\') || /^[a-zA-Z]:/.test(p)) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function buildAppManifest(
  files: Array<{ path: string; bytes: Uint8Array }>,
  info: { version: string; versionCode: number; builtAt: Date; roles: string[]; protocol: number; shellApi: Record<string, number>; bridgeApi: number; minChrome: number; minSafari: string; entry?: string },
): AppBundleManifest {
  const entry = info.entry ?? 'index.html';
  const listed = files
    .filter((f) => f.path !== APP_MANIFEST && f.path !== APP_SIGNATURE)
    .map((f) => {
      if (!safeBundlePath(f.path)) throw new Error(`unsafe path in the bundle: ${f.path}`);
      return { path: f.path, sha256: sha256Hex(f.bytes), size: f.bytes.byteLength };
    })
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!listed.some((f) => f.path === entry)) throw new Error(`the entry ${entry} is not in the bundle`);
  if (!Number.isInteger(info.versionCode) || info.versionCode < 1 || info.versionCode > 2_147_483_647) throw new Error('versionCode out of range');
  return {
    kind: APP_BUNDLE_KIND,
    version: info.version,
    versionCode: info.versionCode,
    roles: info.roles.slice(),
    protocol: info.protocol,
    shellApi: { ...info.shellApi },
    bridgeApi: info.bridgeApi,
    minChrome: info.minChrome,
    minSafari: info.minSafari,
    entry,
    builtAt: info.builtAt.toISOString(),
    files: listed,
  };
}

/** Every file under `dir`, as "a/b.js" paths (no symlinks followed out). */
export function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listFiles(full, rel));
    else if (st.isFile()) out.push(rel);
  }
  return out;
}

/** The 44-byte DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Whether `sig` is the Ed25519 signature of `data` under the raw 32-byte public key. */
export function ed25519Valid(data: Uint8Array, sig: Uint8Array, publicKeyRaw: Uint8Array): boolean {
  if (publicKeyRaw.byteLength !== 32 || sig.byteLength !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyRaw)]), format: 'der', type: 'spki' });
    return verifySig(null, Buffer.from(data), key, Buffer.from(sig));
  } catch {
    return false;
  }
}

export interface VerifyOptions {
  /** The protocols the engine on this device speaks (§8.4). */
  protocols: readonly number[];
  /** The role to run: the bundle must carry it. */
  role?: string;
  /** The pinned release key (raw 32 bytes); null: unsigned bundles accepted (until decision 11). */
  publicKey?: Uint8Array | null;
}

export type VerifyResult = { ok: true; manifest: AppBundleManifest } | { ok: false; problems: string[] };

/** Checks a bundle folder: the manifest (and its signature), then EVERY file, before any is served. */
export function verifyAppBundleDir(dir: string, o: VerifyOptions): VerifyResult {
  const mPath = path.join(dir, APP_MANIFEST);
  if (!existsSync(mPath)) return { ok: false, problems: ['no manifest'] };
  const raw = readFileSync(mPath);
  if (o.publicKey) {
    const sPath = path.join(dir, APP_SIGNATURE);
    if (!existsSync(sPath)) return { ok: false, problems: ['no signature'] };
    const sigFile = readFileSync(sPath);
    const sig = sigFile.byteLength === 64 ? sigFile : Buffer.from(sigFile.toString('utf8').trim(), 'base64');
    if (!ed25519Valid(raw, sig, o.publicKey)) return { ok: false, problems: ['bad signature'] };
  }
  let m: AppBundleManifest;
  try {
    m = JSON.parse(raw.toString('utf8')) as AppBundleManifest;
  } catch {
    return { ok: false, problems: ['manifest not JSON'] };
  }
  const problems: string[] = [];
  if (m.kind !== APP_BUNDLE_KIND) problems.push(`kind ${String(m.kind)}`);
  if (!o.protocols.includes(m.protocol)) problems.push(`protocol ${String(m.protocol)}`);
  if (o.role && !(Array.isArray(m.roles) && m.roles.includes(o.role))) problems.push(`role ${o.role}`);
  if (!Array.isArray(m.files)) return { ok: false, problems: [...problems, 'no files'] };
  const listed = new Set<string>();
  for (const f of m.files) {
    listed.add(f.path);
    if (!safeBundlePath(f.path)) {
      problems.push(`unsafe ${f.path}`);
      continue;
    }
    const full = path.join(dir, ...f.path.split('/'));
    if (!existsSync(full)) {
      problems.push(`missing ${f.path}`);
      continue;
    }
    // A link could point the verified name at another file later: links are refused.
    if (lstatSync(full).isSymbolicLink()) {
      problems.push(`link ${f.path}`);
      continue;
    }
    const bytes = readFileSync(full);
    if (bytes.byteLength !== f.size) problems.push(`size ${f.path}`);
    else if (sha256Hex(bytes) !== f.sha256) problems.push(`sha256 ${f.path}`);
  }
  for (const p of listFiles(dir)) if (p !== APP_MANIFEST && p !== APP_SIGNATURE && !listed.has(p)) problems.push(`unlisted ${p}`);
  if (!listed.has(m.entry)) problems.push(`entry ${m.entry}`);
  return problems.length ? { ok: false, problems } : { ok: true, manifest: m };
}

/**
 * `r2m://app/<path>` → the file inside the verified bundle, or null (never outside it, never a
 * file the manifest does not list).
 */
export function resolveAppPath(dir: string, manifest: AppBundleManifest, urlPath: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel === '') rel = manifest.entry;
  if (!safeBundlePath(rel)) return null;
  if (!manifest.files.some((f) => f.path === rel)) return null;
  return path.join(dir, ...rel.split('/'));
}
