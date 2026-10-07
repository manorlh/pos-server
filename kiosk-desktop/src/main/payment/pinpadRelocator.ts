/**
 * The Windows kiosk's pinpad that moved (core/pinpadRelocation.ts — the Android till's rule): the
 * configured address silent two minutes, no payment, the terminal known, the cloud reachable, not
 * again before the cooldown → look for the same terminal on the LAN and move to it.
 *
 * Windows reads its ARP table (`arp -a`), so a MAC remembered for the pinpad (from its own reply,
 * or from ARP while it answered) points at its new address first; the /24 sweep of its port is
 * the rest. Every candidate is asked who it is — read-only frames (getStatus, getInfo,
 * getRetailerInfo, getConfig), never a charge, a setup or a configuration — and only the same
 * terminal is taken. The new address is saved in the cloud first (`PUT /sync/{id}/pinpad-host`,
 * machine token), which the next settings pull brings back here.
 *
 * Everything that touches the network or the clock is a dependency, so the orchestration is
 * tested without either (test/pinpadRelocation.test.ts).
 */

import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import { privateIpv4, type PinpadAddress } from '../../core/nayax';
import {
  choose,
  decide,
  IDENTITY_FRAMES,
  identityOf,
  match,
  normMac,
  parseArp,
  subnetHosts,
  target,
  type PinpadCandidate,
  type PinpadIdentity,
} from '../../core/pinpadRelocation';
import { postFrame, tlsRefused, type RawReply } from './pinpadHttp';

export interface RelocatorDeps {
  now(): number;
  kvGet(key: string): string | null;
  kvSet(key: string, value: string | null): void;
  /** `arp -a`'s output ('' when it cannot be read). */
  readArp(): Promise<string>;
  localIpv4(): string | null;
  /** The hosts of [hosts] with [port] open (TCP connect only; bounded, short timeouts). */
  sweep(hosts: string[], port: number): Promise<string[]>;
  /** Who answers at host:port (read-only frames); null when no pinpad does. */
  identify(host: string, port: number): Promise<PinpadIdentity | null>;
  /** The new address to the cloud (and then here): 'ok', or why not. */
  save(host: string, port: number, found: PinpadIdentity, previousHost: string): Promise<'ok' | 'offline' | 'refused'>;
  log(msg: string): void;
}

export interface RelocatorFacts {
  configured: { host: string; port: number } | null;
  /** The monitor's word: answering now, silent, or not checked yet. */
  answering: boolean | null;
  lastOkAtMs: number | null;
  inPayment: () => boolean;
  online: boolean;
  /** The kiosk's expected terminal number (`expectedTerminalNumber`), if set. */
  expectedTerminal: string | null;
}

const K = {
  terminal: 'pinpad.relocate.terminal',
  serial: 'pinpad.relocate.serial',
  mac: 'pinpad.relocate.mac',
  arpMac: 'pinpad.relocate.arpMac',
  lastScan: 'pinpad.relocate.lastScanAt',
  fruitless: 'pinpad.relocate.fruitless',
  lastMove: 'pinpad.relocate.lastMove',
  lastLearn: 'pinpad.relocate.lastLearnAt',
} as const;

const LEARN_EVERY_MS = 6 * 3_600_000;

export class PinpadRelocator {
  private failingSince: number | null = null;
  private running = false;

  constructor(private readonly d: RelocatorDeps) {}

  remembered(): PinpadIdentity {
    return { terminal: this.d.kvGet(K.terminal), serial: this.d.kvGet(K.serial), mac: this.d.kvGet(K.mac), arpMac: this.d.kvGet(K.arpMac) };
  }

  /** One look (the kiosk's 30-second tick). Returns what it did, for the log; null when nothing was due. */
  async tick(f: RelocatorFacts): Promise<string | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.step(f);
    } finally {
      this.running = false;
    }
  }

  private async step(f: RelocatorFacts): Promise<string | null> {
    const now = this.d.now();
    const here = f.configured;
    if (f.answering === true) {
      this.failingSince = null;
      if (here) await this.learn(here, f);
    } else if (f.answering === false && this.failingSince === null) {
      this.failingSince = f.lastOkAtMs !== null && f.lastOkAtMs <= now ? f.lastOkAtMs : now;
    }
    const terminal = target(this.d.kvGet(K.terminal), f.expectedTerminal);
    const decision = decide({
      nowMs: now,
      networkPinpad: here !== null,
      failingSinceMs: this.failingSince,
      inPayment: f.inPayment(),
      terminal,
      online: f.online,
      lastScanAtMs: Number(this.d.kvGet(K.lastScan)) || null,
      fruitlessScans: Number(this.d.kvGet(K.fruitless)) || 0,
    });
    if (!decision.scan || !here || !terminal) return null;
    this.d.kvSet(K.lastScan, String(now));
    return this.relocate(here, terminal, f);
  }

  /** While it answers: its ARP MAC kept, and once in a while who it is (serial, a self-reported MAC). */
  private async learn(here: { host: string; port: number }, f: RelocatorFacts) {
    const arp = parseArp(await this.d.readArp().catch(() => '')).get(here.host);
    if (arp) this.d.kvSet(K.arpMac, arp);
    const known = this.remembered();
    const last = Number(this.d.kvGet(K.lastLearn)) || 0;
    if ((known.serial && known.mac && known.terminal) || (last > 0 && this.d.now() - last < LEARN_EVERY_MS) || f.inPayment()) return;
    this.d.kvSet(K.lastLearn, String(this.d.now()));
    const id = await this.d.identify(here.host, here.port).catch(() => null);
    if (!id) return;
    // Learned, never overwritten by itself: a stranger at the address must not teach its terminal.
    const want = target(known.terminal, f.expectedTerminal);
    if (id.terminal && (!want || match({ terminal: want }, id) === 'same')) this.d.kvSet(K.terminal, id.terminal);
    if (id.serial && match({ terminal: want ?? id.terminal }, id) === 'same') this.d.kvSet(K.serial, id.serial);
    if (id.mac) this.d.kvSet(K.mac, normMac(id.mac));
  }

  private async relocate(here: { host: string; port: number }, terminal: string, f: RelocatorFacts): Promise<string> {
    const known = this.remembered();
    const want: PinpadIdentity = { terminal, serial: known.serial, mac: known.mac, arpMac: known.arpMac };
    const currentLabel = `${here.host}:${here.port}`;
    this.d.log(`pinpad: ${currentLabel} silent — looking for terminal ${terminal} on the LAN`);
    // 1. "לפי המאק": the ARP table's entry with the remembered MAC, asked first.
    const arp = parseArp(await this.d.readArp().catch(() => ''));
    const macs = [normMac(known.mac), normMac(known.arpMac)].filter((m): m is string => !!m);
    const byMac = [...arp.entries()].filter(([ip, mac]) => ip !== here.host && macs.includes(mac)).map(([ip]) => ip);
    const candidates: PinpadCandidate[] = [];
    for (const host of byMac) {
      const id = await this.d.identify(host, here.port).catch(() => null);
      if (id) candidates.push({ host, port: here.port, identity: { ...id, arpMac: arp.get(host) ?? null } });
    }
    let choice = choose(want, currentLabel, candidates);
    // 2. Else the sweep of the kiosk's own /24 on the pinpad's port.
    if (choice.kind !== 'switch' && choice.kind !== 'still_there') {
      const open = await this.d.sweep(subnetHosts(this.d.localIpv4()), here.port).catch(() => [] as string[]);
      const arpAfter = parseArp(await this.d.readArp().catch(() => ''));
      for (const host of open) {
        if (byMac.includes(host)) continue;
        const id = await this.d.identify(host, here.port).catch(() => null);
        if (id) candidates.push({ host, port: here.port, identity: { ...id, arpMac: arpAfter.get(host) ?? null } });
      }
      choice = choose(want, currentLabel, candidates);
    }
    if (choice.kind === 'still_there') {
      this.failingSince = null;
      return this.note('the configured address answered the search');
    }
    if (choice.kind !== 'switch') {
      this.fruitless();
      return this.note(choice.kind === 'ambiguous' ? `terminal ${terminal} answers at ${choice.labels.join(', ')} — not guessed between` : `terminal ${terminal} not found (${choice.others} other pinpad(s), never taken)`);
    }
    if (f.inPayment()) return this.note(`found at ${choice.to.host}; a payment started — not moved now`);
    const saved = await this.d.save(choice.to.host, choice.to.port, choice.to.identity, currentLabel).catch(() => 'offline' as const);
    if (saved !== 'ok') {
      this.fruitless();
      return this.note(`found at ${choice.to.host}:${choice.to.port}, not saved (${saved})`);
    }
    this.d.kvSet(K.fruitless, '0');
    if (choice.to.identity.serial) this.d.kvSet(K.serial, choice.to.identity.serial);
    if (choice.to.identity.mac) this.d.kvSet(K.mac, normMac(choice.to.identity.mac));
    if (choice.to.identity.arpMac) this.d.kvSet(K.arpMac, choice.to.identity.arpMac);
    this.d.kvSet(K.lastMove, JSON.stringify({ from: currentLabel, to: `${choice.to.host}:${choice.to.port}`, terminal, at: this.d.now() }));
    this.failingSince = null;
    return this.note(`moved ${currentLabel} -> ${choice.to.host}:${choice.to.port} (terminal ${terminal})`);
  }

  private fruitless() {
    this.d.kvSet(K.fruitless, String((Number(this.d.kvGet(K.fruitless)) || 0) + 1));
  }

  private note(msg: string): string {
    this.d.log(`pinpad relocation: ${msg}`);
    return msg;
  }

  /** The last move ({from, to, terminal, at}), for the technician screen; null: none. */
  lastMove(): { from: string; to: string; terminal: string; at: number } | null {
    try {
      return JSON.parse(this.d.kvGet(K.lastMove) ?? 'null');
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------- the real network */


const IDENTIFY_TIMEOUT_MS = 4_000;
const SWEEP_CONNECT_MS = 400;
const SWEEP_PARALLEL = 48;

/** `arp -a` (Windows), '' when it cannot be run. */
export function readArpTable(): Promise<string> {
  return new Promise((resolve) => {
    execFile('arp', ['-a'], { timeout: 5_000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')));
  });
}

/** The kiosk's own private IPv4 address on the LAN; null off it. */
export function localPrivateIpv4(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && privateIpv4(a.address)) return a.address;
    }
  }
  return null;
}

/** TCP connect only, nothing sent; [SWEEP_PARALLEL] at once, [SWEEP_CONNECT_MS] each. */
export async function sweepPort(hosts: string[], port: number): Promise<string[]> {
  const open: string[] = [];
  let next = 0;
  const one = (host: string) =>
    new Promise<void>((resolve) => {
      const s = net.connect({ host, port });
      const done = (ok: boolean) => {
        if (ok) open.push(host);
        s.destroy();
        resolve();
      };
      s.setTimeout(SWEEP_CONNECT_MS, () => done(false));
      s.once('connect', () => done(true));
      s.once('error', () => done(false));
    });
  await Promise.all(
    Array.from({ length: Math.min(SWEEP_PARALLEL, hosts.length) }, async () => {
      while (next < hosts.length) await one(hosts[next++]);
    }),
  );
  return open;
}

const isRpc = (body: string): boolean => {
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    return !!o && typeof o === 'object' && ('result' in o || 'error' in o);
  } catch {
    return false;
  }
};

/**
 * Who answers at host:port: the identity frames (reads only), HTTPS first with nothing pinned (a
 * question is not trust), plain HTTP only when the pinpad does not speak TLS and the address is
 * private. Null: no TweezerComm pinpad there.
 */
export async function identifyPinpad(
  host: string,
  port: number,
  path = '/SPICy',
  post: (a: PinpadAddress, body: string, timeoutMs: number, pins: null) => Promise<RawReply> = postFrame,
): Promise<PinpadIdentity | null> {
  for (const tls of [true, false]) {
    if (!tls && !privateIpv4(host)) return null;
    const addr: PinpadAddress = { host, port, path, tls };
    let status: string;
    try {
      const r = await post(addr, IDENTITY_FRAMES.status, IDENTIFY_TIMEOUT_MS, null);
      if (r.status < 200 || r.status >= 300) return null;
      status = r.body;
    } catch (e) {
      if (tls && tlsRefused(e)) continue;
      return null;
    }
    if (!isRpc(status)) return null;
    const ask = async (frame: string) => {
      try {
        const r = await post(addr, frame, IDENTIFY_TIMEOUT_MS, null);
        return r.status >= 200 && r.status < 300 ? r.body : null;
      } catch {
        return null;
      }
    };
    return identityOf({ status, info: await ask(IDENTITY_FRAMES.info), retailer: await ask(IDENTITY_FRAMES.retailer), config: await ask(IDENTITY_FRAMES.config) });
  }
  return null;
}
