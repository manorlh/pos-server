/**
 * The cloud's last word, kept on the kiosk (SQLite `kv`), so the kiosk starts as a kiosk with no
 * network at all: the pairing credentials, machines/me, settings (+ business info), till
 * parameters, the catalog (+ menu), the kiosk snapshot (`kiosk/sync`), the heartbeat's facts
 * (zMode, lastTillZNumber…) and the shop's POS users (PINs as bcrypt hashes, their shop and effective
 * permissions — for the admin and "יציאה לשולחן העבודה", checked offline).
 */

import type { Kv } from '../db/schema';

export interface Credentials {
  serverUrl: string;
  accessToken: string;
  machineId: string;
  machineCode: string | null;
  tenantId: string | null;
  shopId: string | null;
  mqttClientId: string | null;
  realtimeChannel: string | null;
  pairedAt: string;
}

export interface MachineMe {
  machineId: string;
  machineCode?: string | null;
  machineName?: string | null;
  posNumber?: string | null;
  documentPrefix?: string | null;
  shopName?: string | null;
  companyName?: string | null;
  shopNumber?: number | null;
  companyNumber?: number | null;
  tenantId?: string | null;
  shopId?: string | null;
  pairingStatus?: string | null;
  /** till | kiosk | kds | order_status_board (core/roles.ts reads it leniently). */
  deviceRole?: string | null;
  /** false for a screen (KDS, order status board): never a till, never a document. */
  fiscal?: boolean | null;
  platform?: string | null;
  hasBuiltinTerminal?: boolean | null;
  [key: string]: unknown;
}

export interface SettingsSnapshot {
  settings: Record<string, unknown>;
  businessInfo: Record<string, unknown> | null;
  settingsUpdatedAt: string | null;
  serverTime: string | null;
}

export interface CatalogSnapshot {
  products: Array<Record<string, unknown>>;
  categories: Array<Record<string, unknown>>;
  menu: Record<string, unknown> | null;
  machineCatalog: { mode?: string } | null;
  /**
   * "תפריטים": the `catalogMenus` block as the pull carried it (client lib/kioskMenus.ts) — whole when sent, kept when a delta
   * carries none; null: none (a snapshot written before this field reads as none).
   */
  catalogMenus?: Record<string, unknown> | null;
  serverTime: string | null;
}

export interface HeartbeatFacts {
  zMode: 'till' | 'cloud';
  lastTillZNumber: number | null;
  tillZEpoch: number;
  independentTill: boolean;
  lastOkAt: number | null;
  serverTime: string | null;
}

export interface PosUser {
  id: string;
  username: string;
  firstName: string | null;
  lastName: string | null;
  pinHash: string;
  role: string;
  isActive: boolean;
  /** The user's shop (the roster is this machine's shop's; core/desktopExit.ts checks it). */
  shopId?: string | null;
  /**
   * "תפקידים והרשאות": the user's effective permissions as the cloud resolved them (code → allow |
   * approval | deny) — absent from an older server (the legacy `role` answers then).
   */
  permissions?: Record<string, string> | null;
  tillRoleKey?: string | null;
  tillRoleName?: string | null;
}

/** The roster's shape kept here; a copy from before it (no shop, no permissions) is pulled again in full. */
const POS_USERS_SHAPE = '2';

/** A secret store (Electron safeStorage) for the machine token; plain in Node tools. */
export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
}

export const PLAIN_BOX: SecretBox = { seal: (s) => s, open: (s) => s };

const K = {
  creds: 'cloud.credentials',
  me: 'cloud.machineMe',
  settings: 'cloud.settings',
  params: 'cloud.parameters',
  paramsEtag: 'cloud.parametersEtag',
  catalog: 'cloud.catalog',
  kiosk: 'cloud.kioskSnapshot',
  kioskSyncAt: 'cloud.kioskSyncAt',
  beat: 'cloud.heartbeat',
  users: 'cloud.posUsers',
  usersAt: 'cloud.posUsersAt',
  usersShape: 'cloud.posUsersShape',
  promotions: 'cloud.promotions',
  promotionsEtag: 'cloud.promotionsEtag',
  stock: 'cloud.stockLevels',
} as const;

export class CloudStore {
  private cache = new Map<string, unknown>();

  constructor(
    private readonly kv: Kv,
    private readonly box: SecretBox = PLAIN_BOX,
  ) {}

  private read<T>(key: string): T | null {
    if (this.cache.has(key)) return this.cache.get(key) as T | null;
    const v = this.kv.getJson<T>(key);
    this.cache.set(key, v);
    return v;
  }

  private write(key: string, value: unknown) {
    this.kv.setJson(key, value);
    this.cache.set(key, value);
  }

  credentials(): Credentials | null {
    const sealed = this.read<Credentials & { sealed?: boolean }>(K.creds);
    if (!sealed) return null;
    if (!sealed.sealed) return sealed;
    try {
      return { ...sealed, accessToken: this.box.open(sealed.accessToken) };
    } catch {
      return null;
    }
  }

  setCredentials(c: Credentials) {
    this.write(K.creds, { ...c, accessToken: this.box.seal(c.accessToken), sealed: this.box !== PLAIN_BOX });
  }

  /** Unpaired: credentials and the cloud's copies go; documents, shifts, Zs and counters stay. */
  forget() {
    for (const key of Object.values(K)) {
      this.kv.delete(key);
      this.cache.delete(key);
    }
  }

  machine(): MachineMe | null {
    return this.read<MachineMe>(K.me);
  }

  setMachine(m: MachineMe) {
    this.write(K.me, m);
  }

  settings(): SettingsSnapshot {
    return this.read<SettingsSnapshot>(K.settings) ?? { settings: {}, businessInfo: null, settingsUpdatedAt: null, serverTime: null };
  }

  setSettings(s: SettingsSnapshot) {
    this.write(K.settings, s);
  }

  parameters(): Record<string, unknown> {
    return this.read<Record<string, unknown>>(K.params) ?? {};
  }

  parametersEtag(): string | null {
    return this.kv.get(K.paramsEtag);
  }

  setParameters(p: Record<string, unknown>, etag: string | null) {
    this.write(K.params, p);
    if (etag) this.kv.set(K.paramsEtag, etag);
  }

  catalog(): CatalogSnapshot {
    return this.read<CatalogSnapshot>(K.catalog) ?? { products: [], categories: [], menu: null, machineCatalog: null, catalogMenus: null, serverTime: null };
  }

  /** A full pull replaces; a delta upserts by id (the menu only when sent). */
  applyCatalog(body: Record<string, unknown>) {
    const full = body.syncType === 'full';
    const prev = this.catalog();
    const products = asRows(body.products);
    const categories = asRows(body.categories);
    let nextProducts = products;
    let nextCategories = categories;
    if (!full) {
      nextProducts = upsert(prev.products, products);
      nextCategories = upsert(prev.categories, categories);
    } else if (products.length === 0 && prev.products.length > 0) {
      // A full pull with zero products is never taken as "everything delisted" (as the till).
      nextProducts = prev.products;
    }
    const menu = body.menu && typeof body.menu === 'object' ? (body.menu as Record<string, unknown>) : full ? null : prev.menu;
    // "תפריטים": whole when sent (a full pull always sends it, even empty, so the kiosk clears); a delta that carries none keeps it.
    const catalogMenus = body.catalogMenus && typeof body.catalogMenus === 'object' && !Array.isArray(body.catalogMenus) ? (body.catalogMenus as Record<string, unknown>) : (prev.catalogMenus ?? null);
    this.write(K.catalog, {
      products: nextProducts,
      categories: nextCategories,
      catalogMenus,
      menu: menu ?? prev.menu,
      machineCatalog: (body.machineCatalog as CatalogSnapshot['machineCatalog']) ?? prev.machineCatalog,
      serverTime: typeof body.serverTime === 'string' ? body.serverTime : prev.serverTime,
    } satisfies CatalogSnapshot);
  }

  /** The promotions as `GET /sync/{m}/promotions` sent them (read by lib/kioskMoney.ts promotionsOf). */
  promotions(): Array<Record<string, unknown>> {
    return this.read<Array<Record<string, unknown>>>(K.promotions) ?? [];
  }

  promotionsEtag(): string | null {
    return this.kv.get(K.promotionsEtag);
  }

  setPromotions(list: Array<Record<string, unknown>>, etag: string | null) {
    this.write(K.promotions, list);
    if (etag) this.kv.set(K.promotionsEtag, etag);
  }

  /** This shop's stock levels (`GET /sync/{m}/stock`), by product id: what "אזל" counts by (lib/kioskSoldOut.ts). */
  stockLevels(): Record<string, number> {
    return this.read<Record<string, number>>(K.stock) ?? {};
  }

  /** Levels as pulled; a product the pull does not name keeps its last level (the Android till's upsert). */
  mergeStockLevels(levels: Record<string, number>): boolean {
    const prev = this.stockLevels();
    const next = { ...prev, ...levels };
    const changed = Object.keys(levels).some((id) => prev[id] !== levels[id]);
    if (changed) this.write(K.stock, next);
    return changed;
  }

  kioskSnapshot(): Record<string, unknown> | null {
    return this.read<Record<string, unknown>>(K.kiosk);
  }

  setKioskSnapshot(s: Record<string, unknown>) {
    this.write(K.kiosk, s);
    this.kv.setNumber(K.kioskSyncAt, Date.now());
  }

  kioskSyncAt(): number | null {
    return this.kv.getNumber(K.kioskSyncAt);
  }

  heartbeat(): HeartbeatFacts {
    return this.read<HeartbeatFacts>(K.beat) ?? { zMode: 'cloud', lastTillZNumber: null, tillZEpoch: 0, independentTill: false, lastOkAt: null, serverTime: null };
  }

  setHeartbeat(h: HeartbeatFacts) {
    this.write(K.beat, h);
  }

  posUsers(): PosUser[] {
    return this.read<PosUser[]>(K.users) ?? [];
  }

  /** The delta's start — none (a full pull) while the copy kept is of an older shape. */
  posUsersAt(): string | null {
    if (this.kv.get(K.usersShape) !== POS_USERS_SHAPE) return null;
    return this.kv.get(K.usersAt);
  }

  applyPosUsers(body: Record<string, unknown>) {
    const rows = asRows(body.users).map(
      (u): PosUser => ({
        id: String(u.id),
        username: String(u.username ?? ''),
        firstName: (u.firstName as string) ?? null,
        lastName: (u.lastName as string) ?? null,
        pinHash: String(u.pinHash ?? ''),
        role: String(u.role ?? ''),
        isActive: u.isActive !== false,
        shopId: typeof u.shopId === 'string' ? u.shopId : null,
        permissions: permissionsOf(u.permissions),
        tillRoleKey: typeof u.tillRoleKey === 'string' ? u.tillRoleKey : null,
        tillRoleName: typeof u.tillRoleName === 'string' ? u.tillRoleName : null,
      }),
    );
    const full = body.syncType === 'full';
    const next = full ? rows : upsert(this.posUsers() as unknown as Array<Record<string, unknown>>, rows as unknown as Array<Record<string, unknown>>) as unknown as PosUser[];
    this.write(K.users, next);
    if (typeof body.serverTime === 'string') this.kv.set(K.usersAt, body.serverTime);
    if (full) this.kv.set(K.usersShape, POS_USERS_SHAPE);
  }
}

/** `{code: state}` with the states the cloud uses; anything else dropped (null when nothing is left). */
function permissionsOf(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [code, state] of Object.entries(v as Record<string, unknown>)) {
    if (state === 'allow' || state === 'approval' || state === 'deny') out[code] = state;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function asRows(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string') : [];
}

function upsert(prev: Array<Record<string, unknown>>, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  if (rows.length === 0) return prev;
  const byId = new Map(prev.map((r) => [String(r.id), r]));
  for (const r of rows) byId.set(String(r.id), r);
  return [...byId.values()];
}

/** Lenient boolean parameters (true / 1 / yes / on / כן), as the till's parameterOn. */
export function parameterOn(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return ['true', '1', 'yes', 'on', 'כן'].includes(v.trim().toLowerCase());
  return false;
}
