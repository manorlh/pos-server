/**
 * The kiosk's media on its own disk (docs/SPEC_KIOSK.md §6; pos-android KioskMediaCache.kt),
 * content-hashed: `<media dir>/<sha256>.<ext>` plus WebP variants for pictures. The screens
 * load them only through the `kiosk://media/<file>` protocol (main/protocol.ts) — a video is
 * never streamed from the network.
 *
 * One sync at a time. Each download goes to a scratch name, is hashed while it streams, checked
 * against the uploader's SHA-256 when there is one, and only then renamed to its content name;
 * a wrong or torn download never replaces anything. The index (SQLite) is written after the
 * file is in place, so it never names a file that is not there. Offline nothing changes.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CAP_BYTES,
  extensionFor,
  fileNameOf,
  filesInUse,
  MAX_FILE_BYTES,
  plan,
  VARIANT_WIDTHS,
  variantFileName,
  variantsWanted,
  verified,
  type MediaEntry,
  type MediaRefIn,
} from '../../core/mediaPlan';
import type { Db } from '../db/sqlite';

export interface MediaStatus {
  files: number;
  bytes: number;
  missing: number;
  overCap: number;
  lastSyncAtMs: number | null;
  lastError: string | null;
  ready: boolean;
}

/** Makes the resized variants of a picture; null when the picture cannot be read. */
export type VariantMaker = (src: string, width: number, dest: string) => Promise<boolean>;

/** sharp, loaded lazily (a native module: not on the startup path). */
export const sharpVariantMaker: VariantMaker = async (src, width, dest) => {
  const { default: sharp } = await import('sharp');
  const meta = await sharp(src, { failOn: 'none' }).metadata();
  if (!meta.width) return false;
  if (meta.width <= width) return false;
  await sharp(src, { failOn: 'none' }).rotate().resize({ width, withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).toFile(dest);
  return true;
};

export type Downloader = (url: string, dest: string, maxBytes: number) => Promise<{ bytes: number; sha256: string }>;

/** fetch → a file, hashing as it streams; refuses past maxBytes. */
export const httpDownloader: Downloader = async (url, dest, maxBytes) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > maxBytes) throw new Error(`too large (${len} bytes): ${url}`);
  const hash = createHash('sha256');
  const out = createWriteStream(dest);
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`too large (>${maxBytes} bytes): ${url}`);
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  // Durable before the rename names it.
  const fh = await open(dest, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
  return { bytes, sha256: hash.digest('hex') };
};

export class MediaStore {
  private syncing: Promise<MediaStatus> | null = null;
  private status: MediaStatus;
  private byUrl = new Map<string, MediaEntry>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly db: Db,
    readonly dir: string,
    private readonly download: Downloader = httpDownloader,
    private readonly makeVariant: VariantMaker = sharpVariantMaker,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    mkdirSync(dir, { recursive: true });
    this.reload();
    this.status = { files: this.byUrl.size, bytes: this.totalBytes(), missing: 0, overCap: 0, lastSyncAtMs: null, lastError: null, ready: true };
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private reload() {
    const rows = this.db.all<{ url: string; kind: string; sha256: string; ext: string; bytes: number; variants: string; stored_at: number }>(
      'SELECT url, kind, sha256, ext, bytes, variants, stored_at FROM media',
    );
    this.byUrl = new Map(
      rows.map((r) => [
        r.url,
        { url: r.url, kind: r.kind as MediaEntry['kind'], sha256: r.sha256, ext: r.ext, bytes: r.bytes, variants: safeArray(r.variants), storedAtMs: r.stored_at },
      ]),
    );
  }

  private totalBytes(): number {
    const seen = new Set<string>();
    let total = 0;
    for (const e of this.byUrl.values()) {
      if (seen.has(e.sha256)) continue;
      seen.add(e.sha256);
      total += e.bytes;
    }
    return total;
  }

  getStatus(): MediaStatus {
    return { ...this.status };
  }

  /** The entry for a URL when it is on disk (the screens fall back without it). */
  entry(url: string | null | undefined): MediaEntry | null {
    if (!url) return null;
    return this.byUrl.get(url) ?? null;
  }

  entries(): MediaEntry[] {
    return [...this.byUrl.values()];
  }

  /** The absolute path of a file the protocol serves; null for anything not in the index. */
  resolveFile(name: string): string | null {
    if (!/^[0-9a-f]{64}(\.w\d+\.webp|\.[a-z0-9]{2,5})$/.test(name)) return null;
    const p = path.join(this.dir, name);
    return existsSync(p) ? p : null;
  }

  /** Bring the disk in line with `wanted`. Never runs twice at once. */
  sync(wanted: readonly MediaRefIn[], capBytes: number = DEFAULT_CAP_BYTES): Promise<MediaStatus> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync(wanted, capBytes).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async doSync(wanted: readonly MediaRefIn[], capBytes: number): Promise<MediaStatus> {
    const p = plan(wanted, [...this.byUrl.values()], capBytes, (e) => existsSync(path.join(this.dir, fileNameOf(e))));
    // Forget first (the index), then the files nothing else uses.
    if (p.forget.length > 0) {
      this.db.tx(() => {
        for (const e of p.forget) this.db.run('DELETE FROM media WHERE url = ?', e.url);
      });
      this.reload();
      this.emit();
    }
    let failed = 0;
    let lastError: string | null = null;
    for (const ref of p.download) {
      try {
        await this.fetchOne(ref);
      } catch (e) {
        failed++;
        lastError = e instanceof Error ? e.message : String(e);
        this.log(`media: ${lastError}`);
      }
    }
    this.removeStrays();
    this.status = {
      files: this.byUrl.size,
      bytes: this.totalBytes(),
      missing: failed + p.overCap.length,
      overCap: p.overCap.length,
      lastSyncAtMs: Date.now(),
      lastError,
      ready: failed + p.overCap.length === 0,
    };
    this.emit();
    return this.getStatus();
  }

  private async fetchOne(ref: MediaRefIn): Promise<void> {
    const ext = extensionFor(ref.url, ref.kind);
    const part = path.join(this.dir, `${randomUUID()}.part`);
    let got: { bytes: number; sha256: string };
    try {
      got = await this.download(ref.url, part, MAX_FILE_BYTES);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    if (!verified(ref.sha256, got.sha256)) {
      rmSync(part, { force: true });
      throw new Error(`checksum mismatch: ${ref.url}`);
    }
    const name = `${got.sha256}.${ext}`;
    const target = path.join(this.dir, name);
    if (existsSync(target)) rmSync(part, { force: true });
    else renameSync(part, target);
    const variants: number[] = [];
    if (variantsWanted(ref.kind, ext)) {
      for (const w of VARIANT_WIDTHS) {
        const dest = path.join(this.dir, variantFileName(got.sha256, w));
        if (existsSync(dest)) {
          variants.push(w);
          continue;
        }
        const tmp = `${dest}.${randomUUID()}.part`;
        try {
          if (await this.makeVariant(target, w, tmp)) {
            renameSync(tmp, dest);
            variants.push(w);
          } else {
            rmSync(tmp, { force: true });
          }
        } catch (e) {
          rmSync(tmp, { force: true });
          this.log(`media: variant ${w} of ${ref.url}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const entry: MediaEntry = { url: ref.url, kind: ref.kind, sha256: got.sha256, ext, bytes: got.bytes, variants, storedAtMs: Date.now() };
    this.db.run(
      'INSERT INTO media (url, kind, sha256, ext, bytes, variants, stored_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET kind = excluded.kind, sha256 = excluded.sha256, ext = excluded.ext, bytes = excluded.bytes, variants = excluded.variants, stored_at = excluded.stored_at',
      entry.url,
      entry.kind,
      entry.sha256,
      entry.ext,
      entry.bytes,
      JSON.stringify(entry.variants),
      entry.storedAtMs,
    );
    this.byUrl.set(entry.url, entry);
    this.emit();
  }

  /** Files the index does not name (an interrupted download, an old version): deleted. */
  private removeStrays() {
    const keep = filesInUse([...this.byUrl.values()]);
    let names: string[] = [];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (keep.has(name)) continue;
      const p = path.join(this.dir, name);
      try {
        if (statSync(p).isFile()) rmSync(p, { force: true });
      } catch {
        /* in use: next time */
      }
    }
  }

  /** Files whose bytes no longer match their name (a corrupt disk): forgotten, fetched again later. */
  async verifyAll(): Promise<number> {
    const bad: MediaEntry[] = [];
    for (const e of this.byUrl.values()) {
      const p = path.join(this.dir, fileNameOf(e));
      if (!existsSync(p) || (await sha256File(p)) !== e.sha256) bad.push(e);
    }
    if (bad.length > 0) {
      this.db.tx(() => {
        for (const e of bad) this.db.run('DELETE FROM media WHERE url = ?', e.url);
      });
      for (const e of bad) rmSync(path.join(this.dir, fileNameOf(e)), { force: true });
      this.reload();
      this.emit();
    }
    return bad.length;
  }
}

export async function sha256File(p: string): Promise<string> {
  const fh = await open(p, 'r');
  try {
    const hash = createHash('sha256');
    const buf = Buffer.alloc(1 << 16);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

function safeArray(raw: string): number[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'number') : [];
  } catch {
    return [];
  }
}
