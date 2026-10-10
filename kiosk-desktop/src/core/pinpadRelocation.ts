/**
 * "מה קורה כאשר כתובת המסופון משתנה? אולי תחפש אותו לפי המק שלו" — the pinpad that moved (a DHCP
 * change), found again by who it is. The same rule as the Android till's
 * (pos-android domain/PinpadRelocation.kt, pinned there by PinpadRelocationTest), here with what
 * Windows adds: the ARP table is readable (`arp -a`), so a MAC remembered for the pinpad points
 * straight at its new address before any sweep — still only a hint, checked by the pinpad's own
 * identity read.
 *
 * Who it is: the terminal number (`getRetailerInfo` — the id's first 7 digits — else `getConfig`
 * (device) `tmsRetailer`), its serial (`getInfo`), the business, and a MAC when the pinpad's own
 * reply names one (none of Agamento's known replies does; every one is looked in). The terminal
 * number must always match; a serial or a self-reported MAC that differs is another device;
 * an ARP MAC only breaks a tie. Only read-only frames are ever sent.
 */

import { frame } from './nayax';

export interface PinpadIdentity {
  terminal: string | null;
  serial?: string | null;
  merchant?: string | null;
  fingerprint?: string | null;
  /** The MAC the pinpad itself reported (a key). */
  mac?: string | null;
  /** The MAC the ARP table gave for its address (a hint). */
  arpMac?: string | null;
}

export interface PinpadCandidate {
  host: string;
  port: number;
  identity: PinpadIdentity;
}

export type PinpadMatch = 'same' | 'different_terminal' | 'different_device' | 'unknown';

export const UNREACHABLE_MS = 2 * 60_000;
export const COOLDOWN_MS = 10 * 60_000;
export const MAX_COOLDOWN_MS = 60 * 60_000;

/** The identity reads — the same frames as the Android till's search and card lock. Reads only. */
export const IDENTITY_FRAMES = {
  status: frame('getStatus', {}),
  info: frame('getInfo', {}, 'device'),
  retailer: frame('getRetailerInfo', {}),
  config: frame('getConfig', {}, 'device'),
} as const;

export const MAC_KEYS = ['macAddress', 'mac', 'macAddr', 'wifiMac', 'wlanMac', 'ethMac', 'ethernetMac', 'lanMac', 'deviceMac'];

export function normTerminal(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t) return null;
  return t.replace(/^0+/, '') || '0';
}

/** "AA-BB-CC-DD-EE-01" / "aabb.ccdd.ee01" → "aa:bb:cc:dd:ee:01"; null for junk, all-zeros, broadcast or multicast. */
export function normMac(v: string | null | undefined): string | null {
  const text = (v ?? '').trim();
  if (!text) return null;
  const hex = text.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12 || text.replace(/[^0-9a-z]/gi, '').length !== 12) return null;
  if (hex === '000000000000' || hex === 'ffffffffffff') return null;
  // A multicast address (the low bit of the first octet) is never a device's.
  if (parseInt(hex.slice(0, 2), 16) & 1) return null;
  return hex.match(/.{2}/g)!.join(':');
}

const norm = (v: string | null | undefined) => {
  const t = (v ?? '').trim().toLowerCase().replace(/-/g, ':');
  return t || null;
};

/** The terminal looked for: read off the pinpad while it answered, else the one set for this kiosk; both and different: none. */
export function target(remembered: string | null | undefined, expected: string | null | undefined): string | null {
  const r = normTerminal(remembered);
  const e = normTerminal(expected);
  if (r && e && r !== e) return null;
  return r ?? e;
}

export function match(want: PinpadIdentity, found: PinpadIdentity): PinpadMatch {
  const a = normTerminal(want.terminal);
  const b = normTerminal(found.terminal);
  if (!a || !b) return 'unknown';
  if (a !== b) return 'different_terminal';
  for (const [x, y] of [
    [norm(want.serial), norm(found.serial)],
    [norm(want.fingerprint), norm(found.fingerprint)],
    [normMac(want.mac), normMac(found.mac)],
  ]) {
    if (x && y && x !== y) return 'different_device';
  }
  return 'same';
}

export function cooldownMs(fruitless: number): number {
  let ms = COOLDOWN_MS;
  for (let i = 0; i < Math.min(Math.max(fruitless, 0), 8); i++) ms = Math.min(ms * 2, MAX_COOLDOWN_MS);
  return ms;
}

export interface RelocationFacts {
  nowMs: number;
  networkPinpad: boolean;
  failingSinceMs: number | null;
  inPayment: boolean;
  terminal: string | null;
  online: boolean;
  lastScanAtMs: number | null;
  fruitlessScans: number;
}

export type RelocationDecision = { scan: true } | { scan: false; why: 'not_network_pinpad' | 'answering' | 'not_long_enough' | 'payment' | 'no_identity' | 'offline' | 'cooldown' };

export function decide(f: RelocationFacts): RelocationDecision {
  if (!f.networkPinpad) return { scan: false, why: 'not_network_pinpad' };
  if (f.failingSinceMs === null) return { scan: false, why: 'answering' };
  if (f.nowMs - f.failingSinceMs < UNREACHABLE_MS) return { scan: false, why: 'not_long_enough' };
  if (f.inPayment) return { scan: false, why: 'payment' };
  if (!normTerminal(f.terminal)) return { scan: false, why: 'no_identity' };
  if (!f.online) return { scan: false, why: 'offline' };
  if (f.lastScanAtMs !== null && f.nowMs - f.lastScanAtMs < cooldownMs(f.fruitlessScans)) return { scan: false, why: 'cooldown' };
  return { scan: true };
}

export type RelocationChoice =
  | { kind: 'switch'; to: PinpadCandidate }
  | { kind: 'still_there' }
  | { kind: 'not_found'; others: number }
  | { kind: 'ambiguous'; labels: string[] };

const label = (c: { host: string; port: number }) => `${c.host}:${c.port}`;

export function choose(want: PinpadIdentity, currentLabel: string | null, found: PinpadCandidate[]): RelocationChoice {
  const same = found.filter((c) => match(want, c.identity) === 'same');
  if (same.some((c) => label(c) === currentLabel)) return { kind: 'still_there' };
  if (same.length === 0) return { kind: 'not_found', others: found.length };
  if (same.length === 1) return { kind: 'switch', to: same[0] };
  const own = normMac(want.mac);
  const byOwn = own ? same.filter((c) => normMac(c.identity.mac) === own) : [];
  if (byOwn.length === 1) return { kind: 'switch', to: byOwn[0] };
  const hint = normMac(want.mac ?? want.arpMac);
  const byArp = hint ? same.filter((c) => normMac(c.identity.arpMac ?? c.identity.mac) === hint) : [];
  if (byArp.length === 1) return { kind: 'switch', to: byArp[0] };
  return { kind: 'ambiguous', labels: same.map(label) };
}

/* ------------------------------------------------------------ the replies */

function resultOf(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { result?: unknown };
    return o && typeof o === 'object' ? (o.result ?? null) : null;
  } catch {
    return null;
  }
}

/** A value by key (case-insensitive) anywhere two levels deep in a reply's result. */
export function fieldOf(raw: string | null | undefined, keys: string[]): string | null {
  const scan = (o: unknown, depth: number): string | null => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const rec = o as Record<string, unknown>;
    for (const key of keys) {
      const hit = Object.keys(rec).find((k) => k.toLowerCase() === key.toLowerCase());
      if (hit === undefined) continue;
      const v = rec[hit];
      if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 60);
      if (typeof v === 'number') return String(v);
    }
    if (depth > 0) {
      for (const v of Object.values(rec)) {
        const inner = Array.isArray(v) ? v.map((x) => scan(x, depth - 1)).find((x) => x) ?? null : scan(v, depth - 1);
        if (inner) return inner;
      }
    }
    return null;
  };
  return scan(resultOf(raw), 2);
}

/** Who the pinpad said it is, from its replies to IDENTITY_FRAMES (any of them may be missing). */
export function identityOf(replies: { status?: string | null; info?: string | null; retailer?: string | null; config?: string | null }): PinpadIdentity {
  const retailer = resultOf(replies.retailer) as Record<string, unknown> | null;
  const id = retailer && typeof retailer === 'object' ? String(retailer.id ?? '').trim() : '';
  const fromRetailer = /^\d+$/.test(id) ? (id.length === 10 ? id.slice(0, 7) : id) : null;
  const config = resultOf(replies.config) as Record<string, unknown> | null;
  const tms = config && typeof config === 'object' && typeof config.tmsRetailer === 'string' && config.tmsRetailer.trim() ? config.tmsRetailer.trim() : null;
  const all = [replies.info, replies.status, replies.retailer, replies.config];
  const mac = all.map((r) => normMac(fieldOf(r, MAC_KEYS))).find((m) => m) ?? null;
  return {
    terminal: fromRetailer ?? tms ?? fieldOf(replies.info, ['terminalId', 'terminalNumber']),
    merchant: retailer && typeof retailer === 'object' && typeof retailer.name === 'string' ? retailer.name.trim() || null : null,
    serial: fieldOf(replies.info, ['serialNumber', 'serial', 'deviceSerial', 'sn', 'serialNo']),
    mac,
  };
}

/* ---------------------------------------------------------------- the LAN */

/**
 * Windows' `arp -a` ("Internet Address   Physical Address   Type"), Linux's `ip neigh` / `arp -an`
 * lines too: IPv4 → MAC, devices only (no broadcast, no multicast, no incomplete entries).
 */
export function parseArp(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line)?.[1];
    const macRaw = /([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i.exec(line)?.[1];
    if (!ip || !macRaw) continue;
    // The "Interface: 192.168.0.235 --- 0x7" header names no MAC; skip its own address otherwise.
    const mac = normMac(macRaw);
    if (mac && !out.has(ip)) out.set(ip, mac);
  }
  return out;
}

/** The /24 around [localIp], without itself, the network and the broadcast address. */
export function subnetHosts(localIp: string | null): string[] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(localIp ?? '');
  if (!m) return [];
  const base = `${m[1]}.${m[2]}.${m[3]}.`;
  const out: string[] = [];
  for (let i = 1; i < 255; i++) if (`${base}${i}` !== localIp) out.push(`${base}${i}`);
  return out;
}
