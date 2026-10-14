import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DisplayMediaCache, mediaToKeep, presenceReport, type CacheLike, type ResponseLike } from './customerDisplayMediaCache';

function response(text: string, ok = true): ResponseLike {
  const bytes = new TextEncoder().encode(text);
  return {
    ok,
    status: ok ? 200 : 404,
    clone: () => response(text, ok),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    blob: async () => new Blob([bytes]),
  };
}

function memoryCache() {
  const files = new Map<string, ResponseLike>();
  const cache: CacheLike = {
    match: async (url) => files.get(url),
    put: async (url, r) => void files.set(url, r),
    delete: async (url) => files.delete(url),
    keys: async () => [...files.keys()].map((url) => ({ url })),
  };
  return { files, cache };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const digest = async (data: ArrayBuffer) => createHash('sha256').update(Buffer.from(data)).digest('hex');

test('every listed file is fetched once and kept; one no longer listed is dropped', async () => {
  const { files, cache } = memoryCache();
  files.set('https://x/old.webp', response('old'));
  const fetched: string[] = [];
  const media = new DisplayMediaCache({
    open: async () => cache,
    fetchFile: async (url) => {
      fetched.push(url);
      return response(`bytes of ${url}`);
    },
    digest,
  });
  await media.sync([
    { url: 'https://x/a.webp', sha256: sha('bytes of https://x/a.webp') },
    { url: 'https://x/v.mp4', sha256: sha('bytes of https://x/v.mp4') },
    { url: 'https://x/a.webp' },
    { url: 'https://x/logo.png' },
  ]);
  assert.deepEqual([...files.keys()].sort(), ['https://x/a.webp', 'https://x/logo.png', 'https://x/v.mp4']);
  assert.deepEqual(media.heldHashes(), [sha('bytes of https://x/a.webp'), sha('bytes of https://x/v.mp4')].sort());
  // Again: nothing fetched again.
  await media.sync([{ url: 'https://x/a.webp', sha256: sha('bytes of https://x/a.webp') }]);
  assert.equal(fetched.length, 3);
  assert.deepEqual([...files.keys()], ['https://x/a.webp']);
  assert.deepEqual(media.heldHashes(), [sha('bytes of https://x/a.webp')]);
});

test('a file whose bytes do not match its hash is not kept; one deleted from the server is never asked for', async () => {
  const { files, cache } = memoryCache();
  const fetched: string[] = [];
  const media = new DisplayMediaCache({
    open: async () => cache,
    fetchFile: async (url) => {
      fetched.push(url);
      return url.includes('missing') ? response('', false) : response('tampered');
    },
    digest,
    log: () => undefined,
  });
  await media.sync([
    { url: 'https://x/a.webp', sha256: sha('original') },
    { url: 'https://x/gone.mp4', sha256: sha('gone'), onServer: false },
    { url: 'https://x/missing.png' },
  ]);
  assert.equal(files.size, 0);
  assert.deepEqual(fetched, ['https://x/a.webp', 'https://x/missing.png']);
  assert.deepEqual(media.heldHashes(), []);
  // A copy kept before the server let it go still counts and plays.
  files.set('https://x/gone.mp4', response('gone'));
  await media.sync([{ url: 'https://x/gone.mp4', sha256: sha('gone'), onServer: false }]);
  assert.deepEqual(media.heldHashes(), [sha('gone')]);
  assert.equal(media.isKept('https://x/gone.mp4'), true);
});

test('the player gets the kept copy as an object URL, else the URL; no cache at all: nothing kept, nothing breaks', async () => {
  const { cache } = memoryCache();
  const made: string[] = [];
  const revoked: string[] = [];
  const media = new DisplayMediaCache({
    open: async () => cache,
    fetchFile: async () => response('x'),
    createObjectURL: () => {
      made.push('blob:1');
      return 'blob:1';
    },
    revokeObjectURL: (u) => void revoked.push(u),
  });
  await media.sync([{ url: 'https://x/a.webp' }]);
  assert.equal(await media.srcFor('https://x/a.webp'), 'blob:1');
  assert.equal(await media.srcFor('https://x/other.webp'), 'https://x/other.webp');
  media.release('blob:1');
  media.release('https://x/other.webp');
  assert.deepEqual(revoked, ['blob:1']);

  const none = new DisplayMediaCache({ open: async () => null, fetchFile: async () => response('x') });
  await none.sync([{ url: 'https://x/a.webp' }]);
  assert.deepEqual(none.heldHashes(), []);
  assert.equal(await none.srcFor('https://x/a.webp'), 'https://x/a.webp');
});

test('a sync asked while one runs runs after it, with the latest list', async () => {
  const { files, cache } = memoryCache();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  const media = new DisplayMediaCache({
    open: async () => cache,
    fetchFile: async (url) => {
      if (url.endsWith('a.webp')) await gate;
      return response(url);
    },
  });
  const first = media.sync([{ url: 'https://x/a.webp' }]);
  const second = media.sync([{ url: 'https://x/b.webp' }]);
  media.sync([{ url: 'https://x/c.webp' }]);
  release();
  await first;
  await second;
  assert.deepEqual([...files.keys()], ['https://x/c.webp']);
});

test('the report: unique lowercase sha256s, sorted, at most 100', () => {
  const many = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(64, '0'));
  assert.equal(presenceReport(many).held.length, 100);
  assert.deepEqual(presenceReport(['b'.repeat(64), 'a'.repeat(64), 'a'.repeat(64), '', 'XYZ']), { screen: true, held: ['a'.repeat(64), 'b'.repeat(64)] });
  assert.deepEqual(mediaToKeep([{ url: 'a' }, { url: '' }, { url: 'a' }, { url: 'b' }]).map((e) => e.url), ['a', 'b']);
});
