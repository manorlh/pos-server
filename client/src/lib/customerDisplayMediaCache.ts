/**
 * "מסך לקוח" in a browser (`/display`): its own copy of the slideshow's files
 * (P:/specs/customer-display-transitions.md §3, §5.3, §5.4) — kept in the browser's Cache Storage,
 * so the slideshow plays without a network, and reported to the cloud in the heartbeat
 * (`customerDisplayMedia: {screen: true, held: [sha256…]}`) like the Android screens do.
 *
 *  - every file the configuration lists (`media[]`) is fetched once and kept; one no longer listed
 *    is dropped;
 *  - a file with a `sha256` is checked against it before it is kept (where the browser can hash:
 *    a secure context); one that does not match is not kept;
 *  - `onServer: false` (deleted from the server by its retention): never asked of the cloud — a
 *    browser cannot reach the shop's LAN; a copy already kept still plays;
 *  - the player asks `srcFor(url)`: the kept copy as an object URL (released with `release`), else
 *    the URL itself.
 *
 * Pure of React; the browser's facts (Cache Storage, fetch, SubtleCrypto) come in through `deps`,
 * so the node tests drive it with fakes. No `@/` imports.
 */

export interface ResponseLike {
  ok: boolean;
  status?: number;
  clone(): ResponseLike;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

export interface CacheLike {
  match(url: string): Promise<ResponseLike | undefined>;
  put(url: string, response: ResponseLike): Promise<void>;
  delete(url: string): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

export interface MediaEntry {
  url: string;
  kind?: string;
  sha256?: string | null;
  onServer?: boolean;
}

export interface MediaCacheDeps {
  /** The cache (null where the browser has none: an insecure context, a private window). */
  open: () => Promise<CacheLike | null>;
  fetchFile: (url: string) => Promise<ResponseLike>;
  /** sha256 of the bytes as lowercase hex; absent (or null) where the browser cannot hash. */
  digest?: (data: ArrayBuffer) => Promise<string | null>;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  log?: (msg: string) => void;
}

/** The entries worth keeping: each URL once, the ones with a URL. */
export function mediaToKeep(entries: readonly MediaEntry[]): MediaEntry[] {
  const seen = new Set<string>();
  const out: MediaEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e.url !== 'string' || !e.url || seen.has(e.url)) continue;
    seen.add(e.url);
    out.push(e);
  }
  return out;
}

/** The heartbeat's report: the hashes held, sorted, at most 100 (§5.4). */
export function presenceReport(held: Iterable<string>): { screen: true; held: string[] } {
  const hashes = [...new Set([...held].filter((h) => /^[0-9a-f]{64}$/.test(h)))].sort().slice(0, 100);
  return { screen: true, held: hashes };
}

export class DisplayMediaCache {
  /** url → its sha256 ('' when the configuration names none), for the files kept now. */
  private kept = new Map<string, string>();
  private syncing: Promise<void> | null = null;
  private again: readonly MediaEntry[] | null = null;

  constructor(private readonly deps: MediaCacheDeps) {}

  /** The configuration's files kept (fetching what is missing), the rest dropped. One at a time. */
  sync(entries: readonly MediaEntry[]): Promise<void> {
    if (this.syncing) {
      this.again = entries;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        await this.syncOnce(entries);
        while (this.again) {
          const next = this.again;
          this.again = null;
          await this.syncOnce(next);
        }
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  private async syncOnce(entries: readonly MediaEntry[]): Promise<void> {
    let cache: CacheLike | null = null;
    try {
      cache = await this.deps.open();
    } catch {
      cache = null;
    }
    if (!cache) return;
    const wanted = mediaToKeep(entries);
    const urls = new Set(wanted.map((e) => e.url));
    try {
      for (const key of await cache.keys()) {
        if (!urls.has(key.url)) await cache.delete(key.url);
      }
    } catch {
      /* a cache that cannot list: nothing dropped */
    }
    const kept = new Map<string, string>();
    for (const e of wanted) {
      const sha = typeof e.sha256 === 'string' ? e.sha256 : '';
      try {
        if (await cache.match(e.url)) {
          kept.set(e.url, sha);
          continue;
        }
        if (e.onServer === false) continue;
        const res = await this.deps.fetchFile(e.url);
        if (!res.ok) continue;
        if (sha && this.deps.digest) {
          const got = await this.deps.digest(await res.clone().arrayBuffer());
          if (got && got !== sha) {
            this.deps.log?.(`media ${e.url}: hash mismatch, not kept`);
            continue;
          }
        }
        await cache.put(e.url, res);
        kept.set(e.url, sha);
      } catch {
        this.deps.log?.(`media ${e.url}: not kept (network / storage)`);
      }
    }
    this.kept = kept;
  }

  /** The hashes of the files kept (for the heartbeat). */
  heldHashes(): string[] {
    return presenceReport(this.kept.values()).held;
  }

  isKept(url: string): boolean {
    return this.kept.has(url);
  }

  /** What the player loads: the kept copy (an object URL), else the URL itself. */
  async srcFor(url: string): Promise<string> {
    if (!this.kept.has(url) || !this.deps.createObjectURL) return url;
    try {
      const cache = await this.deps.open();
      const hit = cache ? await cache.match(url) : undefined;
      return hit ? this.deps.createObjectURL(await hit.blob()) : url;
    } catch {
      return url;
    }
  }

  release(src: string): void {
    if (src.startsWith('blob:')) this.deps.revokeObjectURL?.(src);
  }
}

/** sha256 as lowercase hex through SubtleCrypto (a secure context), else null. */
export async function subtleSha256(data: ArrayBuffer): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return null;
  const digest = new Uint8Array(await subtle.digest('SHA-256', data));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
