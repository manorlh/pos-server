/**
 * How a JSON-RPC request reaches a SynqPay terminal from the Windows kiosk (pos-server
 * docs/SPEC_SYNQPAY.md §1.1, §4.3) — as the Android till's SynqPayTransport.kt:
 *
 *  - LinkTransport: the link frames (link.ts) over ONE channel — a TCP socket (9000, TLS 9443) or
 *    the serial port (USB CDC-ACM = a COM port on Windows; the `serialport` package, loaded at
 *    run time). One channel carries every request: the terminal takes one client and drops the
 *    previous one, so a `cancel` on a second socket would cut the sale it is meant to stop.
 *  - HttpTransport: one POST per request to /synqpay (8000, HTTPS 8443), the key in `api-key`.
 *
 * Errors: SynqNotSentError — the request certainly never left (connect refused, TLS failed, no
 * serial port): nothing was charged. SynqAuthError — the terminal refused the key. Anything else
 * (a timeout, a dropped link) is "no answer": the caller asks by referenceId.
 */

import { X509Certificate } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { certFingerprint, tryParse, type PinStore } from '../pinpadHttp';
import { FrameDecoder, PAIRING_KEY, ackFrame, apiKeyBytes, keepAliveFrame, linkErrorName, LINK_ERROR, requestFrame, type Frame } from './link';
import { idOf } from './protocol';

export interface SynqTransport {
  readonly label: string;
  call(id: string, json: string, timeoutMs: number, unauthenticated?: boolean): Promise<string>;
  /** Send the CRC in the other byte order from now on (a probe after CRC_ERROR); false where there is none. */
  flipCrcOrder?(): boolean;
  close(): void;
}

export class SynqAuthError extends Error {}
export class SynqNotSentError extends Error {}
export class SynqTimeoutError extends Error {}
export class SynqLinkError extends Error {
  constructor(readonly code: number) {
    super(`SynqPay link error ${linkErrorName(code)}`);
  }
}

/** A byte link to the terminal (a socket, a serial port). */
export interface LinkChannel {
  write(bytes: Buffer): void;
  close(): void;
  onData(cb: (bytes: Buffer) => void): void;
  onClose(cb: (why: string) => void): void;
}

/** An error frame this soon after a request is that request's (error frames carry no id). */
export const ERROR_ATTRIBUTION_MS = 5_000;

interface Waiter {
  resolve(json: string): void;
  reject(e: Error): void;
}

class Link {
  readonly pending = new Map<string, Waiter>();
  private readonly decoder = new FrameDecoder();
  closed = false;
  lastSentId: string | null = null;
  lastSentAt = 0;
  lastAckAt = 0;

  constructor(
    private readonly channel: LinkChannel,
    private readonly hooks: { onEvent: (json: string) => void; onCrcOrder: (le: boolean) => void; log: (m: string) => void },
  ) {
    channel.onData((b) => {
      for (const f of this.decoder.feed(b)) this.handle(f);
    });
    channel.onClose((why) => this.close(why));
  }

  write(bytes: Buffer) {
    if (this.closed) throw new Error('the link to the terminal is closed');
    this.channel.write(bytes);
  }

  private handle(f: Frame) {
    switch (f.kind) {
      case 'response': {
        this.hooks.onCrcOrder(f.crcLittleEndian);
        const id = idOf(f.json);
        const w = id !== null ? this.pending.get(id) : undefined;
        if (w && id !== null) {
          this.pending.delete(id);
          w.resolve(f.json);
        } else this.hooks.log(`synqpay link: a reply nobody waits for (id ${id})`);
        return;
      }
      case 'event':
        this.hooks.onEvent(f.json);
        return;
      case 'keepalive':
        try {
          this.write(ackFrame());
        } catch {
          /* closing */
        }
        return;
      case 'ack':
        this.lastAckAt = Date.now();
        return;
      case 'error': {
        const id = this.lastSentId;
        const fresh = id !== null && Date.now() - this.lastSentAt <= ERROR_ATTRIBUTION_MS;
        const w = fresh && id !== null ? this.pending.get(id) : undefined;
        this.hooks.log(`synqpay link: error frame ${linkErrorName(f.code)}${w ? ` for ${id}` : ' (not attributed)'}`);
        if (w && id !== null) {
          this.pending.delete(id);
          w.reject(f.code === LINK_ERROR.NOT_AUTHENTICATED ? new SynqAuthError('מפתח ה-API נדחה במסוף') : new SynqLinkError(f.code));
        }
        return;
      }
      case 'garbage':
        this.hooks.log(`synqpay link: skipped ${f.bytes} bytes (${f.reason})`);
        return;
      default:
        return;
    }
  }

  close(why: string) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      /* already */
    }
    const e = new Error(`the link to the terminal closed: ${why}`);
    for (const w of this.pending.values()) w.reject(e);
    this.pending.clear();
    this.hooks.log(`synqpay link: closed (${why})`);
  }
}

export class LinkTransport implements SynqTransport {
  private link: Link | null = null;
  private opening: Promise<Link> | null = null;
  private crcLittleEndian = false;

  constructor(
    readonly label: string,
    /** Read per request, so a key changed in the cloud applies to the next one. */
    private readonly apiKey: () => string | null,
    private readonly open: () => Promise<LinkChannel>,
    private readonly opts: { keepAliveMs?: number; onEvent?: (json: string) => void; log?: (m: string) => void } = {},
  ) {}

  flipCrcOrder(): boolean {
    this.crcLittleEndian = !this.crcLittleEndian;
    return true;
  }

  private log(m: string) {
    this.opts.log?.(m);
  }

  private async getLink(): Promise<Link> {
    if (this.link && !this.link.closed) return this.link;
    if (!this.opening) {
      this.opening = (async () => {
        let channel: LinkChannel;
        try {
          channel = await this.open();
        } catch (e) {
          if (e instanceof SynqNotSentError) throw e;
          throw new SynqNotSentError(`אין חיבור למסוף (${this.label}): ${e instanceof Error ? e.message : String(e)}`);
        }
        const l = new Link(channel, {
          onEvent: (json) => this.opts.onEvent?.(json),
          onCrcOrder: (le) => {
            if (le !== this.crcLittleEndian) {
              this.crcLittleEndian = le;
              this.log(`synqpay link: following the terminal's CRC byte order (${le ? 'little' : 'big'}-endian)`);
            }
          },
          log: (m) => this.log(m),
        });
        this.link = l;
        return l;
      })().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  async call(id: string, json: string, timeoutMs: number, unauthenticated = false): Promise<string> {
    const key = unauthenticated ? PAIRING_KEY : apiKeyBytes(this.apiKey());
    if (!key) throw new SynqAuthError('מפתח ה-API אינו 8 תווים הקסדצימליים — לא ניתן לשלוח אותו בחיבור TCP / USB');
    const l = await this.getLink();
    const keepAliveMs = this.opts.keepAliveMs ?? 15_000;
    return new Promise<string>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        clearInterval(keepAlive);
      };
      const timer = setTimeout(() => {
        l.pending.delete(id);
        done();
        // Alone on a link that went quiet: drop it, so the next call starts on a clean one.
        if (l.pending.size === 0) l.close(`no reply to ${id} in ${timeoutMs} ms`);
        reject(new SynqTimeoutError(`no reply from the terminal within ${timeoutMs} ms`));
      }, timeoutMs);
      const keepAlive = setInterval(() => {
        const sentAt = Date.now();
        try {
          l.write(keepAliveFrame());
        } catch {
          return;
        }
        setTimeout(() => {
          if (l.lastAckAt < sentAt && l.pending.has(id)) this.log(`synqpay link: no ACK to a KeepAlive (waiting on ${id})`);
        }, keepAliveMs / 2).unref?.();
      }, keepAliveMs);
      l.pending.set(id, {
        resolve: (s) => {
          done();
          resolve(s);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      // Named before it leaves: an error frame can come back before write returns.
      l.lastSentId = id;
      l.lastSentAt = Date.now();
      try {
        l.write(requestFrame(key, json, this.crcLittleEndian));
      } catch (e) {
        l.pending.delete(id);
        done();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close() {
    this.link?.close('closed by the kiosk');
    this.link = null;
  }
}

/* ------------------------------------------------------------------ TLS trust */

/** "Synqpay Root CA" (Codeblocks Ltd.), as https://docs.synqpay.com/api/transport/certificate/ publishes it. */
export const SYNQPAY_ROOT_SHA256 = '61:AA:67:E7:0D:4B:C5:4A:25:31:E1:E4:40:16:87:C0:B1:D9:61:0D:EC:16:E2:49:AF:F3:F4:12:3A:D1:1D:5C';

/** The DER chain the server sent, leaf first (Node's issuerCertificate links). */
export function peerChain(socket: tls.TLSSocket): Buffer[] {
  const out: Buffer[] = [];
  let c = socket.getPeerCertificate(true) as tls.DetailedPeerCertificate | null;
  const seen = new Set<string>();
  while (c && c.raw && !seen.has(c.fingerprint256)) {
    seen.add(c.fingerprint256);
    out.push(c.raw);
    c = c.issuerCertificate && c.issuerCertificate !== c ? c.issuerCertificate : null;
  }
  return out;
}

/** The chain ends in SynqPay's root, every certificate signed by the next. */
export function chainsToSynqPayRoot(chain: Buffer[]): boolean {
  const at = chain.findIndex((der) => certFingerprint(der) === SYNQPAY_ROOT_SHA256);
  if (at < 0) return false;
  try {
    const certs = chain.slice(0, at + 1).map((der) => new X509Certificate(der));
    for (let i = 0; i < at; i++) if (!certs[i].verify(certs[i + 1].publicKey)) return false;
    return certs[at].verify(certs[at].publicKey);
  } catch {
    return false;
  }
}

/** Accept the root-signed chain (and pin it), or trust the first certificate seen at [pinKey]. */
export function trustTerminal(chain: Buffer[], pins: PinStore, pinKey: string): void {
  if (!chain.length) throw new Error('the terminal sent no certificate');
  const seen = certFingerprint(chain[0]);
  if (chainsToSynqPayRoot(chain)) {
    pins.set(pinKey, seen);
    return;
  }
  const pinned = pins.get(pinKey);
  if (!pinned) {
    pins.set(pinKey, seen);
    return;
  }
  if (pinned !== seen) throw new Error(`תעודת המסוף השתנתה (${seen}) — נדרש איפוס הצמדה בהגדרות`);
}

function secureConnect(host: string, port: number, pins: PinStore, pinKey: string, timeoutMs: number): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: 'TLSv1.2' });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    s.once('secureConnect', () => {
      clearTimeout(timer);
      try {
        trustTerminal(peerChain(s), pins, pinKey);
        resolve(s);
      } catch (e) {
        s.destroy();
        reject(e);
      }
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function plainConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    s.once('connect', () => {
      clearTimeout(timer);
      s.setNoDelay(true);
      s.setKeepAlive(true);
      resolve(s);
    });
    s.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** A socket as a link channel. */
export function socketChannel(s: net.Socket): LinkChannel {
  return {
    write: (b) => {
      s.write(b);
    },
    close: () => s.destroy(),
    onData: (cb) => {
      s.on('data', cb);
    },
    onClose: (cb) => {
      s.once('close', () => cb('socket closed'));
      s.on('error', (e) => cb(e.message));
    },
  };
}

/** TCP (or TLS) to the terminal's link port. */
export async function tcpChannel(host: string, port: number, trust: { pins: PinStore; pinKey: string } | null, connectTimeoutMs = 5_000): Promise<LinkChannel> {
  const s = trust ? await secureConnect(host, port, trust.pins, trust.pinKey, connectTimeoutMs) : await plainConnect(host, port, connectTimeoutMs);
  return socketChannel(s);
}

/* -------------------------------------------------------------------- serial */

/** What `SerialPort.list()` gives (the parts we read). */
export interface SerialPortInfo {
  path: string;
  vendorId?: string;
  productId?: string;
  manufacturer?: string;
  pnpId?: string;
}

/**
 * The COM port to open: the one named ("COM3"), the USB device named ("0B00:0080"), else the
 * only USB serial port attached. Several and none named: none (the technician must name it).
 */
export function pickSerialPort(ports: SerialPortInfo[], wanted: string | null): SerialPortInfo | null {
  const w = (wanted ?? '').trim().toUpperCase();
  if (/^COM\d{1,3}$/.test(w)) return ports.find((p) => p.path.toUpperCase() === w) ?? null;
  const usb = ports.filter((p) => p.vendorId || /USB/i.test(p.pnpId ?? ''));
  const m = /^([0-9A-F]{4}):([0-9A-F]{4})$/.exec(w);
  if (m) return usb.find((p) => (p.vendorId ?? '').toUpperCase() === m[1] && (p.productId ?? '').toUpperCase() === m[2]) ?? null;
  return usb.length === 1 ? usb[0] : null;
}

interface SerialPortLike {
  open(cb: (err: Error | null) => void): void;
  write(b: Buffer): unknown;
  close(cb?: (err: Error | null) => void): void;
  set?(o: { dtr?: boolean; rts?: boolean }, cb?: (err: Error | null) => void): void;
  on(evt: 'data', cb: (b: Buffer) => void): unknown;
  on(evt: 'close' | 'error', cb: (e?: Error) => void): unknown;
}

interface SerialPortModule {
  SerialPort: {
    new (o: { path: string; baudRate: number; dataBits: 8; parity: 'none'; stopBits: 1; rtscts: boolean; autoOpen: boolean }): SerialPortLike;
    list(): Promise<SerialPortInfo[]>;
  };
}

/** The `serialport` package, if the kiosk has it (not a dependency of this module: SPEC §4.3). */
export async function loadSerialport(): Promise<SerialPortModule | null> {
  const name = 'serialport';
  try {
    return (await import(/* @vite-ignore */ name)) as SerialPortModule;
  } catch {
    return null;
  }
}

/** SynqPay's serial link (115200 8N1, no flow control) on a COM port. */
export async function serialChannel(wanted: string | null, load: () => Promise<SerialPortModule | null> = loadSerialport): Promise<LinkChannel> {
  const mod = await load();
  if (!mod) throw new SynqNotSentError('חבילת serialport אינה מותקנת בקיוסק — חיבור USB סריאלי אינו זמין');
  const port = pickSerialPort(await mod.SerialPort.list(), wanted);
  if (!port) throw new SynqNotSentError(wanted ? `מסוף ה-USB ${wanted} לא נמצא` : 'לא נמצא מסוף USB סריאלי יחיד — יש להגדיר את היציאה (COMn)');
  const sp = new mod.SerialPort({ path: port.path, baudRate: 115_200, dataBits: 8, parity: 'none', stopBits: 1, rtscts: false, autoOpen: false });
  await new Promise<void>((resolve, reject) => sp.open((err) => (err ? reject(new SynqNotSentError(`לא ניתן לפתוח את ${port.path}: ${err.message}`)) : resolve())));
  sp.set?.({ dtr: true, rts: true });
  return {
    write: (b) => {
      sp.write(b);
    },
    close: () => sp.close(),
    onData: (cb) => {
      sp.on('data', cb);
    },
    onClose: (cb) => {
      sp.on('close', () => cb('serial port closed'));
      sp.on('error', (e) => cb(e?.message ?? 'serial error'));
    },
  };
}

/* ---------------------------------------------------------------------- HTTP */

/** The bytes of one SynqPay HTTP request: POST /synqpay, the key in `api-key` (none for pairing). */
export function httpRequest(host: string, port: number, apiKey: string | null, json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  const head =
    'POST /synqpay HTTP/1.1\r\n' +
    `Host: ${host}:${port}\r\n` +
    (apiKey !== null ? `api-key: ${apiKey}\r\n` : '') +
    'Content-Type: application/json; charset=utf-8\r\n' +
    'Accept: application/json\r\n' +
    'Connection: close\r\n' +
    `Content-Length: ${body.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, 'latin1'), body]);
}

export class HttpTransport implements SynqTransport {
  readonly label: string;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly apiKey: () => string | null,
    private readonly trust: { pins: PinStore; pinKey: string } | null,
    private readonly connectTimeoutMs = 5_000,
  ) {
    this.label = `${host}:${port} (HTTP${trust ? 'S' : ''})`;
  }

  async call(_id: string, json: string, timeoutMs: number, unauthenticated = false): Promise<string> {
    let socket: net.Socket;
    try {
      socket = this.trust
        ? await secureConnect(this.host, this.port, this.trust.pins, this.trust.pinKey, Math.min(this.connectTimeoutMs, timeoutMs))
        : await plainConnect(this.host, this.port, Math.min(this.connectTimeoutMs, timeoutMs));
    } catch (e) {
      // Nothing was written: the terminal cannot have taken this request.
      throw new SynqNotSentError(`אין חיבור למסוף (${this.label}): ${e instanceof Error ? e.message : String(e)}`);
    }
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (e: Error | null, body?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (e) reject(e);
        else resolve(body!);
      };
      const timer = setTimeout(() => finish(new SynqTimeoutError(`no reply from ${this.label} within ${timeoutMs} ms`)), timeoutMs);
      const settle = (ended: boolean) => {
        const r = tryParse(Buffer.concat(chunks), ended);
        if (!r) {
          if (ended) finish(new Error('the terminal closed the connection without a reply'));
          return;
        }
        if (r.status === 200) finish(null, r.body);
        else if (r.status === 401) finish(new SynqAuthError('מפתח ה-API נדחה במסוף (HTTP 401)'));
        else finish(new Error(`the terminal answered HTTP ${r.status}`));
      };
      socket.on('data', (d: Buffer) => {
        chunks.push(d);
        settle(false);
      });
      socket.on('end', () => settle(true));
      socket.on('close', () => settle(true));
      socket.on('error', (e) => finish(e));
      socket.write(httpRequest(this.host, this.port, unauthenticated ? null : this.apiKey(), json));
    });
  }

  close() {
    /* one connection per request */
  }
}
