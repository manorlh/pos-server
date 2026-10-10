import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { extensionFor, MAX_FILE_BYTES, pickVariant, plan, priority, UNKNOWN_SIZE_GUESS, variantFileName, verified, type MediaEntry, type MediaRefIn } from '../src/core/mediaPlan';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { httpDownloader, MediaStore, sharpVariantMaker, type Downloader } from '../src/main/media/mediaStore';

const ref = (url: string, kind: MediaRefIn['kind'] = 'image', extra: Partial<MediaRefIn> = {}): MediaRefIn => ({ url, kind, sha256: null, bytes: 1000, ...extra });
const entry = (url: string, sha: string, bytes = 1000, kind: MediaEntry['kind'] = 'image'): MediaEntry => ({ url, kind, sha256: sha, ext: 'png', bytes, variants: [], storedAtMs: 0 });

describe('the media plan (KioskMediaPlan)', () => {
  it('fonts first, then pictures, then videos — each in the order named', () => {
    const p = plan([ref('v.mp4', 'video'), ref('a.png'), ref('f.ttf', 'font'), ref('b.png')], []);
    expect(p.download.map((r) => r.url)).toEqual(['f.ttf', 'a.png', 'b.png', 'v.mp4']);
    expect(priority('font')).toBeLessThan(priority('image'));
  });

  it('keeps what is on disk and current, fetches what changed, forgets what is no longer named', () => {
    const p = plan([ref('a.png'), ref('b.png', 'image', { sha256: 'NEW' })], [entry('a.png', 'aa'), entry('b.png', 'old'), entry('gone.png', 'gg')]);
    expect(p.keep.map((e) => e.url)).toEqual(['a.png']);
    expect(p.download.map((r) => r.url)).toEqual(['b.png']);
    // b.png's old row stays until the new one is verified (the screens keep showing it).
    expect(p.forget.map((e) => e.url)).toEqual(['gone.png']);
  });

  it('a file missing from disk is fetched again', () => {
    expect(plan([ref('a.png')], [entry('a.png', 'aa')], undefined, () => false).download).toHaveLength(1);
  });

  it('stops at the cap; a file over 30 MB never comes', () => {
    const p = plan([ref('a.png', 'image', { bytes: 600 }), ref('b.png', 'image', { bytes: 600 }), ref('c.mp4', 'video', { bytes: MAX_FILE_BYTES + 1 })], [], 1000);
    expect(p.download.map((r) => r.url)).toEqual(['a.png']);
    expect(p.overCap.map((r) => r.url)).toEqual(['b.png', 'c.mp4']);
    expect(plan([ref('x.png', 'image', { bytes: null })], [], UNKNOWN_SIZE_GUESS - 1).overCap).toHaveLength(1);
  });

  it('counts one content once against the cap (two URLs, one file)', () => {
    const p = plan([ref('a.png', 'image', { sha256: 'same', bytes: 800 }), ref('b.png', 'image', { sha256: 'same', bytes: 800 })], [], 1000);
    expect(p.overCap).toHaveLength(0);
  });

  it('checks the uploader’s checksum when there is one', () => {
    expect(verified(null, 'abc')).toBe(true);
    expect(verified('ABC', 'abc')).toBe(true);
    expect(verified('abd', 'abc')).toBe(false);
  });

  it('keeps the extension players and fonts need', () => {
    expect(extensionFor('https://x/a/clip.MP4?x=1', 'video')).toBe('mp4');
    expect(extensionFor('https://x/a/noext', 'font')).toBe('ttf');
    expect(extensionFor('https://x/a/noext', 'image')).toBe('img');
  });

  it('picks the smallest variant big enough for the device pixels, else the original', () => {
    const e = { sha256: 'h', ext: 'jpg', variants: [480, 960] };
    expect(pickVariant(e, 240, 2)).toBe(variantFileName('h', 480));
    expect(pickVariant(e, 480, 2)).toBe(variantFileName('h', 960));
    expect(pickVariant(e, 800, 2)).toBe('h.jpg');
    expect(pickVariant({ ...e, variants: [] }, 100, 1)).toBe('h.jpg');
  });
});

/* A local origin serving pictures and a video, to download for real. */
let server: http.Server;
let base = '';
let png: Buffer;
let png2: Buffer;
const video = Buffer.alloc(200_000, 7);
let hits: string[] = [];

beforeAll(async () => {
  png = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#cc3355' } }).png().toBuffer();
  png2 = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#3355cc' } }).png().toBuffer();
  server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/big.png' || req.url === '/alias.png') return res.end(png);
    if (req.url === '/small.png') return res.end(png2);
    if (req.url === '/clip.mp4') return res.end(video);
    if (req.url === '/torn.png') {
      res.write(png.subarray(0, 100));
      return res.destroy();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

function store(downloader: Downloader = httpDownloader) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-media-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  return { db, dir: path.join(dir, 'media'), store: new MediaStore(db, path.join(dir, 'media'), downloader, sharpVariantMaker) };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('MediaStore (content-hashed, on disk)', () => {
  it('downloads, names each file by its content, makes the picture variants, and serves only indexed names', async () => {
    const { store: s, dir } = store();
    const status = await s.sync([ref(`${base}/big.png`), ref(`${base}/clip.mp4`, 'video')]);
    expect(status).toMatchObject({ files: 2, missing: 0, ready: true });
    const big = s.entry(`${base}/big.png`)!;
    expect(big.sha256).toBe(sha(png));
    expect(big.variants).toEqual([480, 960]);
    const files = readdirSync(dir).sort();
    expect(files).toEqual([`${sha(png)}.png`, variantFileName(sha(png), 480), variantFileName(sha(png), 960), `${sha(video)}.mp4`].sort());
    const meta = await sharp(path.join(dir, variantFileName(sha(png), 480))).metadata();
    expect(meta.width).toBe(480);
    expect(meta.format).toBe('webp');
    expect(s.resolveFile(`${sha(video)}.mp4`)).toBe(path.join(dir, `${sha(video)}.mp4`));
    expect(s.resolveFile('../k.db')).toBe(null);
  });

  it('two URLs of the same picture are one file', async () => {
    const { store: s, dir } = store();
    await s.sync([ref(`${base}/big.png`), ref(`${base}/alias.png`)]);
    expect(s.entry(`${base}/alias.png`)!.sha256).toBe(s.entry(`${base}/big.png`)!.sha256);
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toHaveLength(1);
  });

  it('a wrong checksum never lands; a torn download never replaces anything', async () => {
    const { store: s, dir } = store();
    await s.sync([ref(`${base}/small.png`)]);
    const before = s.entry(`${base}/small.png`)!;
    const st = await s.sync([ref(`${base}/small.png`, 'image', { sha256: '0'.repeat(64) }), ref(`${base}/torn.png`)]);
    expect(st.missing).toBe(2);
    expect(s.entry(`${base}/small.png`)).toEqual(before); // the good file stays
    expect(s.entry(`${base}/torn.png`)).toBe(null);
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false);
  });

  it('a small picture gets no variants (never enlarged); the screens use the original', async () => {
    const { store: s } = store();
    await s.sync([ref(`${base}/small.png`)]);
    expect(s.entry(`${base}/small.png`)!.variants).toEqual([]);
  });

  it('what is no longer named is deleted, strays too; offline, nothing changes', async () => {
    const { store: s, dir, db } = store();
    await s.sync([ref(`${base}/big.png`), ref(`${base}/small.png`)]);
    writeFileSync(path.join(dir, 'stray.bin'), 'x');
    await s.sync([ref(`${base}/small.png`)]);
    expect(s.entry(`${base}/big.png`)).toBe(null);
    expect(existsSync(path.join(dir, `${sha(png)}.png`))).toBe(false);
    expect(existsSync(path.join(dir, 'stray.bin'))).toBe(false);
    const offline: Downloader = async () => {
      throw new Error('offline');
    };
    const again = new MediaStore(db, dir, offline, sharpVariantMaker);
    await again.sync([ref(`${base}/small.png`)]);
    expect(again.entry(`${base}/small.png`)).not.toBe(null);
  });

  it('only downloads what changed', async () => {
    const { store: s } = store();
    await s.sync([ref(`${base}/small.png`)]);
    hits = [];
    await s.sync([ref(`${base}/small.png`)]);
    expect(hits).toEqual([]);
  });

  it('verifyAll drops a file whose bytes no longer match its name', async () => {
    const { store: s, dir } = store();
    await s.sync([ref(`${base}/small.png`)]);
    writeFileSync(path.join(dir, `${sha(png2)}.png`), 'corrupt');
    expect(await s.verifyAll()).toBe(1);
    expect(s.entry(`${base}/small.png`)).toBe(null);
  });
});
