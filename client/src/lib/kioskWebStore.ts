/**
 * The browser kiosk's own storage (`/k`, docs/SPEC_KIOSK.md §27): the machine's credentials, the
 * cloud's last word (the kiosk snapshot, the catalog, the settings), the pickup counter and the
 * orders still to deliver — so a reload, a short network drop or a closed tab never brings the
 * kiosk back unpaired or blank.
 *
 *  - IndexedDB first (bigger, kept for an installed app), localStorage as a mirror for the small
 *    keys (the credentials) and the fallback when IndexedDB is missing (Safari private mode, a
 *    blocked database), memory as the last resort (the kiosk then works until the tab closes);
 *  - every access in try/catch: a storage that throws (quota, privacy settings, an evicted
 *    database) is never the customer's problem;
 *  - JSON values only.
 *
 * Pure of React; no `@/` imports (the node tests compile it on its own).
 */

export interface KvStore {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  /** Every key with this prefix (the outbox). */
  keys(prefix: string): Promise<string[]>;
  /** Where the values really live (for the staff screen). */
  readonly kind: 'indexeddb' | 'localstorage' | 'memory';
}

/** The kiosk's keys. */
export const KV = {
  credentials: 'r2m.kiosk.credentials',
  machine: 'r2m.kiosk.machine',
  snapshot: 'r2m.kiosk.snapshot',
  snapshotAt: 'r2m.kiosk.snapshotAt',
  catalog: 'r2m.kiosk.catalog',
  /** "מבצעים": `GET /sync/{m}/promotions` as it came, with its ETag. */
  promotions: 'r2m.kiosk.promotions',
  /** The shop's stock levels (`GET /sync/{m}/stock`), by product id: what "אזל" counts by. */
  stock: 'r2m.kiosk.stock',
  settings: 'r2m.kiosk.settings',
  parameters: 'r2m.kiosk.parameters',
  pickup: 'r2m.kiosk.pickup',
  pickupFallback: 'r2m.kiosk.pickupFallback',
  deviceId: 'r2m.kiosk.deviceId',
  /** `r2m.kiosk.order.<localId>`: an open order not yet taken by the cloud (or its state). */
  orderPrefix: 'r2m.kiosk.order.',
  /** `r2m.kiosk.reverse.<redemptionId>`: a voucher redemption to give back once the cloud answers. */
  reversePrefix: 'r2m.kiosk.reverse.',
} as const;

/** Small keys also written to localStorage (a second copy if IndexedDB is ever lost). */
const MIRRORED: ReadonlySet<string> = new Set([KV.credentials, KV.deviceId, KV.pickup, KV.pickupFallback]);

export class MemoryStore implements KvStore {
  readonly kind = 'memory' as const;
  private readonly map = new Map<string, string>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(prefix: string): Promise<string[]> {
    return [...this.map.keys()].filter((k) => k.startsWith(prefix));
  }
}

/** The subset of the Storage API used here (tests pass a fake). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export class LocalStore implements KvStore {
  readonly kind = 'localstorage' as const;

  constructor(private readonly storage: StorageLike) {}

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = this.storage.getItem(key);
      return raw === null ? null : (JSON.parse(raw) as T);
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      this.storage.setItem(key, JSON.stringify(value));
    } catch {
      // Full or blocked: the value lives only as long as the page.
    }
  }

  async del(key: string): Promise<void> {
    try {
      this.storage.removeItem(key);
    } catch {
      /* nothing to do */
    }
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    try {
      for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
    } catch {
      /* a storage that cannot be listed */
    }
    return out;
  }
}

const DB_NAME = 'r2m-kiosk';
const STORE = 'kv';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB, with every key in MIRRORED (or the store's own list) also kept in localStorage; any failure falls back to the mirror. */
export class IdbStore implements KvStore {
  readonly kind = 'indexeddb' as const;

  private constructor(
    private readonly db: IDBDatabase,
    private readonly mirror: KvStore,
    private readonly mirrored: ReadonlySet<string> = MIRRORED,
  ) {}

  /** `dbName` / `mirrored`: another app on the same site (the browser KDS / board, lib/screenWebService.ts) keeps its own. */
  static async open(idb: IDBFactory, mirror: KvStore, dbName = DB_NAME, mirrored: ReadonlySet<string> = MIRRORED): Promise<IdbStore> {
    const open = idb.open(dbName, 1);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    const db = await req(open);
    return new IdbStore(db, mirror, mirrored);
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const v = await req(this.tx('readonly').get(key));
      if (v !== undefined && v !== null) return JSON.parse(String(v)) as T;
    } catch {
      /* fall through to the mirror */
    }
    // Lost from the database (or never written there): the mirror's copy, if any.
    return this.mirrored.has(key) ? this.mirror.get<T>(key) : null;
  }

  async set(key: string, value: unknown): Promise<void> {
    const json = JSON.stringify(value);
    if (this.mirrored.has(key)) await this.mirror.set(key, value);
    try {
      await req(this.tx('readwrite').put(json, key));
    } catch {
      if (!this.mirrored.has(key)) await this.mirror.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.mirror.del(key);
    try {
      await req(this.tx('readwrite').delete(key));
    } catch {
      /* nothing to do */
    }
  }

  async keys(prefix: string): Promise<string[]> {
    const out = new Set<string>();
    try {
      const all = (await req(this.tx('readonly').getAllKeys())) as IDBValidKey[];
      for (const k of all) if (typeof k === 'string' && k.startsWith(prefix)) out.add(k);
    } catch {
      /* the mirror's then */
    }
    for (const k of await this.mirror.keys(prefix)) out.add(k);
    return [...out];
  }
}

/** Another app's own database and mirrored keys (the browser KDS / board); the kiosk's by default. */
export interface StoreOptions {
  dbName?: string;
  mirrored?: Iterable<string>;
}

/** The best store this browser gives: IndexedDB (with a localStorage mirror), else localStorage, else memory. */
export async function openKioskStore(env: { indexedDB?: IDBFactory | null; localStorage?: StorageLike | null } = {}, opts: StoreOptions = {}): Promise<KvStore> {
  let local: KvStore | null = null;
  try {
    if (env.localStorage) {
      // Some browsers expose localStorage but throw on the first write (Safari private mode, old).
      env.localStorage.setItem('r2m.kiosk.probe', '1');
      env.localStorage.removeItem('r2m.kiosk.probe');
      local = new LocalStore(env.localStorage);
    }
  } catch {
    local = null;
  }
  const mirror = local ?? new MemoryStore();
  if (env.indexedDB) {
    try {
      return await withTimeout(IdbStore.open(env.indexedDB, mirror, opts.dbName ?? DB_NAME, opts.mirrored ? new Set(opts.mirrored) : MIRRORED), 3_000);
    } catch {
      /* blocked or absent */
    }
  }
  return mirror;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
