/**
 * `HardwarePort` — how a host carries out the engine's `hw.*` requests (§3.4): it moves bytes,
 * never decides. The engine chose what to print, where, and whether the drawer opens (with its
 * permission checks and drawer log); the port sends the bytes to the target and says how it went.
 *
 * Targets (the engine's words): `tcp://ip:9100`, `spooler://<queue>`, `usb://<vid>:<pid>` (hex),
 * `bt://<mac>`, `ble://<id>`, `builtin` (the APK), `relay://<printerId>` (the cloud to the shop's
 * print server), `lan` (the print server on the LAN), `demo://<name>` (the demo's virtual printer).
 *
 * In the shells this runs in native code; in a plain browser it is host/browser — WebUSB, Web
 * Serial, the cloud relay, the Windows bridge.
 */

import { base64ToBytes, bytesToBase64 } from '../../shared/till/bytes';
import type { HwErrorCode, HwRequest, HwResult } from '../../shared/till/protocol';
import { DRAWER_KICK } from './escpos';

export type TargetScheme = 'tcp' | 'spooler' | 'usb' | 'bt' | 'ble' | 'builtin' | 'relay' | 'lan' | 'demo';

export interface ParsedTarget {
  scheme: TargetScheme;
  raw: string;
  host?: string;
  port?: number;
  queue?: string;
  vendorId?: number;
  productId?: number;
  address?: string;
  printerId?: string;
  name?: string;
}

/** The engine's target string → its parts; null when it is not one we know. */
export function parseTarget(raw: unknown): ParsedTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 300) return null;
  if (raw === 'builtin') return { scheme: 'builtin', raw };
  if (raw === 'lan') return { scheme: 'lan', raw };
  const m = /^([a-z]+):\/\/(.+)$/.exec(raw);
  if (!m) return null;
  const [, scheme, rest] = m;
  switch (scheme) {
    case 'tcp': {
      const hp = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(rest);
      if (!hp) return null;
      const port = Number(hp[2]);
      return port > 0 && port < 65536 ? { scheme: 'tcp', raw, host: hp[1], port } : null;
    }
    case 'spooler':
      return /^[^\\/:*?"<>|]{1,200}$/.test(rest) ? { scheme: 'spooler', raw, queue: decodeURIComponent(rest) } : null;
    case 'usb': {
      const ids = /^([0-9a-fA-F]{4}):([0-9a-fA-F]{4})$/.exec(rest);
      return ids ? { scheme: 'usb', raw, vendorId: parseInt(ids[1], 16), productId: parseInt(ids[2], 16) } : null;
    }
    case 'bt':
      return /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(rest) ? { scheme: 'bt', raw, address: rest.toUpperCase() } : null;
    case 'ble':
      return /^[A-Za-z0-9._:-]{1,100}$/.test(rest) ? { scheme: 'ble', raw, address: rest } : null;
    case 'relay':
      return /^[0-9a-fA-F-]{8,64}$/.test(rest) ? { scheme: 'relay', raw, printerId: rest.toLowerCase() } : null;
    case 'demo':
      return /^[a-z0-9-]{1,40}$/.test(rest) ? { scheme: 'demo', raw, name: rest } : null;
  }
  return null;
}

/** A byte channel to a terminal (TweezerComm frames to a C4, SynqPay, …) — opened for the engine. */
export interface ByteChannel {
  readonly id: string;
  write(bytes: Uint8Array): Promise<void>;
  /** Up to `max` bytes; fewer (or none) when `timeoutMs` passes first. */
  read(max: number, timeoutMs: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface ChannelSpec {
  kind: 'tcp' | 'tls' | 'https-request' | 'serial';
  address: string;
  tls?: { pinSha256?: string };
  serial?: { baudRate: number };
  ticket?: string;
}

export interface PrintJobInfo {
  jobId: string;
  kind: string;
  /** The engine's ticket for a bridge (§9.5); passed through, never made here. */
  ticket?: string;
}

export interface HardwarePort {
  /** A short name for logs and the technician view. */
  readonly name: string;
  supports(target: ParsedTarget): boolean;
  print(target: ParsedTarget, bytes: Uint8Array, job: PrintJobInfo): Promise<void>;
  supportsChannel?(spec: ChannelSpec): boolean;
  openChannel?(spec: ChannelSpec): Promise<ByteChannel>;
  systemPrint?(input: { png?: Uint8Array; pdf?: Uint8Array }): Promise<void>;
}

export class HwError extends Error {
  constructor(
    readonly code: HwErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HwError';
  }
}

/** The first port that takes the target wins (WebUSB, then the bridge, then the relay…). */
export function composePorts(ports: HardwarePort[]): HardwarePort {
  const pick = (t: ParsedTarget) => ports.find((p) => p.supports(t));
  const pickChannel = (s: ChannelSpec) => ports.find((p) => p.openChannel && (p.supportsChannel?.(s) ?? false));
  return {
    name: ports.map((p) => p.name).join('+') || 'none',
    supports: (t) => !!pick(t),
    print: (t, bytes, job) => {
      const p = pick(t);
      if (!p) return Promise.reject(new HwError('unsupported', `אין דרך להגיע ל-${t.raw} מהמכשיר הזה`));
      return p.print(t, bytes, job);
    },
    supportsChannel: (s) => !!pickChannel(s),
    openChannel: (s) => {
      const p = pickChannel(s);
      if (!p || !p.openChannel) return Promise.reject(new HwError('unsupported', 'ערוץ מהסוג הזה אינו זמין במכשיר הזה'));
      return p.openChannel(s);
    },
    systemPrint: (input) => {
      const p = ports.find((x) => x.systemPrint);
      if (!p || !p.systemPrint) return Promise.reject(new HwError('unsupported', 'אין הדפסת מערכת'));
      return p.systemPrint(input);
    },
  };
}

function failure(requestId: string, e: unknown): HwResult {
  if (e instanceof HwError) return { requestId, ok: false, code: e.code, message: e.message };
  return { requestId, ok: false, code: 'io', message: e instanceof Error ? e.message : String(e) };
}

/**
 * Carries out one `hw.*` request on `port` and answers it (`hw.result`). `channels` are the open
 * byte channels of this host (by id). Never throws: a failure is an answer.
 */
export async function executeHw(port: HardwarePort, req: HwRequest, channels: Map<string, ByteChannel>): Promise<HwResult> {
  const { requestId } = req;
  try {
    switch (req.type) {
      case 'hw.print': {
        const t = parseTarget(req.target);
        if (!t) return { requestId, ok: false, code: 'unsupported', message: `יעד לא מוכר: ${req.target}` };
        await port.print(t, base64ToBytes(req.bytesB64), { jobId: req.jobId, kind: req.kind, ticket: req.ticket });
        return { requestId, ok: true };
      }
      case 'hw.drawer': {
        // The drawer opens through its printer: the kick on pin 2 (ESC p 0 25 250).
        const t = parseTarget(req.target);
        if (!t) return { requestId, ok: false, code: 'unsupported', message: `יעד לא מוכר: ${req.target}` };
        await port.print(t, DRAWER_KICK, { jobId: `drawer-${requestId}`, kind: 'drawer', ticket: req.ticket });
        return { requestId, ok: true };
      }
      case 'hw.channel.open': {
        if (!port.openChannel) return { requestId, ok: false, code: 'unsupported', message: 'אין ערוצים במכשיר הזה' };
        const ch = await port.openChannel({ kind: req.kind, address: req.address, tls: req.tls, serial: req.serial, ticket: req.ticket });
        channels.set(ch.id, ch);
        return { requestId, ok: true, channelId: ch.id };
      }
      case 'hw.channel.write': {
        const ch = channels.get(req.channelId);
        if (!ch) return { requestId, ok: false, code: 'unknown_channel', message: 'הערוץ סגור' };
        await ch.write(base64ToBytes(req.bytesB64));
        return { requestId, ok: true, channelId: ch.id };
      }
      case 'hw.channel.read': {
        const ch = channels.get(req.channelId);
        if (!ch) return { requestId, ok: false, code: 'unknown_channel', message: 'הערוץ סגור' };
        const bytes = await ch.read(Math.max(1, Math.min(65_536, req.max ?? 4096)), Math.max(0, Math.min(180_000, req.timeoutMs ?? 5_000)));
        return { requestId, ok: true, channelId: ch.id, bytesB64: bytesToBase64(bytes) };
      }
      case 'hw.channel.close': {
        const ch = channels.get(req.channelId);
        channels.delete(req.channelId);
        if (ch) await ch.close();
        return { requestId, ok: true, channelId: req.channelId };
      }
      case 'hw.systemPrint': {
        if (!port.systemPrint) return { requestId, ok: false, code: 'unsupported', message: 'אין הדפסת מערכת' };
        await port.systemPrint({ png: req.pngB64 ? base64ToBytes(req.pngB64) : undefined, pdf: req.pdfB64 ? base64ToBytes(req.pdfB64) : undefined });
        return { requestId, ok: true };
      }
    }
    return { requestId, ok: false, code: 'unsupported', message: 'בקשה לא מוכרת' };
  } catch (e) {
    return failure(requestId, e);
  }
}

/** The demo's virtual printer: keeps the jobs (the demo shows them), always "printed". */
export class DemoPrinterPort implements HardwarePort {
  readonly name = 'demo';
  readonly jobs: Array<{ target: string; kind: string; bytes: number; at: number }> = [];

  supports(t: ParsedTarget): boolean {
    return t.scheme === 'demo';
  }

  async print(t: ParsedTarget, bytes: Uint8Array, job: PrintJobInfo): Promise<void> {
    this.jobs.unshift({ target: t.raw, kind: job.kind, bytes: bytes.length, at: Date.now() });
    if (this.jobs.length > 20) this.jobs.pop();
  }
}
