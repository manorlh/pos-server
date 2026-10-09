/**
 * The Nayax C4 on the kiosk's own USB ("nayax_usb", P:\specs\spi\PLAN.md, the Android till's
 * TcSerialEmvDevice.kt): the same TweezerComm frames as on the LAN (core/nayax.ts) —
 * `doTransaction`, `ackTransaction`, `abortTransaction`, `getTransactionByVuid`, `doPeriodic` —
 * framed for the serial line (core/tcSerialFraming.ts) on the C4's CDC-ACM port, which Windows
 * shows as a COM port (the `serialport` package, loaded at run time as SynqPay's serial link is:
 * synqpay/transport.ts serialChannel).
 *
 * Everything above the line is NayaxTweezerProvider's (nayaxProvider.ts), unchanged: the vuid on
 * disk before the frame, the acknowledgement, the lookups after a lost answer, the recovery.
 *
 * As SPI's own serial transport does ("waiting for RPC ID", a map of pending responses): one link,
 * each reply handed to the request with its JSON-RPC id. Our frames all say `"id":"1"`, so each
 * request goes out under an id of its own — an abort sent while the sale waits is its own request,
 * and its answer is never taken for the sale's. The reply is returned as the terminal wrote it.
 *
 * Choices that matter for money, as on the LAN:
 *  - **No retries.** A frame is written once; a lost reply is `ok: false` and the caller settles
 *    it by the vuid, never by sending the sale again.
 *  - **Today's timeouts** (core/nayax.ts TIMEOUTS).
 *  - A reply nobody waits for (a late one) is dropped, and said.
 *
 * One USB terminal per kiosk (the owner, 08.10.2026): this is the kiosk's own terminal; the cloud
 * refuses a second one on USB (pos-server `usb_terminal_second`).
 */

import type { CallFn, CallResult } from '../../core/cardRecovery';
import { frame, statusFrame } from '../../core/nayax';
import { SPI, type TcSerialDecoder, type TcSerialFraming, type TcSerialRead } from '../../core/tcSerialFraming';
import { NayaxTweezerProvider } from './nayaxProvider';
import type { ProviderContext, ProviderFactory } from './provider';
import { serialChannel, type LinkChannel } from './synqpay/transport';

/** [json] with its JSON-RPC id set to [id]; null when it is not a JSON object. */
export function withId(json: string, id: string): string | null {
  try {
    const o: unknown = JSON.parse(json);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return JSON.stringify({ ...(o as Record<string, unknown>), id });
  } catch {
    return null;
  }
}

/** The JSON-RPC id of a reply; null when it has none or is not JSON. */
export function idOf(json: string): string | null {
  try {
    const o: unknown = JSON.parse(json);
    if (!o || typeof o !== 'object') return null;
    const id = (o as Record<string, unknown>).id;
    return id === undefined || id === null ? null : String(id);
  } catch {
    return null;
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Waiter {
  resolve(body: string): void;
  fail(why: string): void;
}

/** One open link: the channel, its decoder and the requests waiting on it. */
class OpenLink {
  readonly pending = new Map<string, Waiter>();
  private readonly decoder: TcSerialDecoder;
  closed = false;

  constructor(
    private readonly channel: LinkChannel,
    framing: TcSerialFraming,
    private readonly log: (m: string) => void,
  ) {
    this.decoder = framing.decoder();
    channel.onData((b) => {
      for (const r of this.decoder.feed(b)) this.handle(r);
    });
    channel.onClose((why) => this.close(why));
  }

  write(bytes: Buffer) {
    if (this.closed) throw new Error('the USB link to the terminal is closed');
    this.channel.write(bytes);
  }

  private handle(r: TcSerialRead) {
    if (r.kind === 'garbage') {
      this.log(`${r.bytes} byte(s) skipped (${r.why})`);
      return;
    }
    const id = idOf(r.text);
    const w = id !== null ? this.pending.get(id) : undefined;
    if (w && id !== null) {
      this.pending.delete(id);
      w.resolve(r.text);
    } else this.log(`a reply nobody waits for (id ${id}, ${r.text.length} chars)`);
  }

  close(why: string) {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      /* already */
    }
    for (const w of this.pending.values()) w.fail(`the USB link closed: ${why}`);
    this.pending.clear();
    this.log(`link closed (${why})`);
  }
}

/**
 * TweezerComm frames on the C4's serial line: [call] is a CallFn (core/cardRecovery.ts) — one
 * frame out, its own reply back, or `ok: false` (never a retry).
 */
export class TcSerialLink {
  private link: OpenLink | null = null;
  private opening: Promise<OpenLink> | null = null;
  private seq = 0;
  /** The last reply as it came off the line — "בדיקת מסופון USB" shows it. */
  lastRaw: string | null = null;

  constructor(
    readonly label: string,
    private readonly open: () => Promise<LinkChannel>,
    readonly framing: TcSerialFraming = SPI,
    private readonly log: (m: string) => void = () => {},
  ) {}

  private async getLink(): Promise<OpenLink> {
    if (this.link && !this.link.closed) return this.link;
    if (!this.opening) {
      this.opening = (async () => {
        const l = new OpenLink(await this.open(), this.framing, this.log);
        this.link = l;
        this.log(`link opened (${this.label}, ${this.framing.describe()})`);
        return l;
      })().finally(() => {
        this.opening = null;
      });
    }
    return this.opening;
  }

  call: CallFn = async (json, timeoutMs) => {
    const id = `u${++this.seq}`;
    const outgoing = withId(json, id);
    if (outgoing === null) return { ok: false, error: 'not a JSON-RPC frame' };
    let l: OpenLink;
    try {
      l = await this.getLink();
    } catch (e) {
      return { ok: false, error: `אין חיבור למסוף (${this.label}): ${message(e)}` };
    }
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        l.pending.delete(id);
        // Alone on a link that went quiet: dropped, so the next call starts on a clean one.
        if (l.pending.size === 0) l.close(`no reply to ${id} in ${timeoutMs} ms`);
        resolve({ ok: false, error: `timeout after ${timeoutMs} ms` });
      }, Math.max(1, timeoutMs));
      l.pending.set(id, {
        resolve: (body) => {
          clearTimeout(timer);
          this.lastRaw = body;
          resolve({ ok: true, body });
        },
        fail: (why) => {
          clearTimeout(timer);
          resolve({ ok: false, error: why });
        },
      });
      try {
        l.write(this.framing.frame(outgoing));
      } catch (e) {
        l.pending.delete(id);
        clearTimeout(timer);
        l.close(`write failed: ${message(e)}`);
        resolve({ ok: false, error: message(e) });
      }
    });
  };

  close(): void {
    this.link?.close('closed by the kiosk');
    this.link = null;
  }
}

/** "בדיקת מסופון USB": what the C4 said to two read-only questions, and the framing in use. */
export interface C4UsbCheck {
  answered: boolean;
  framing: string;
  /** Each method sent and what came back, raw (or why nothing did). */
  replies: Array<{ method: string; raw: string }>;
}

export class NayaxUsbProvider extends NayaxTweezerProvider {
  readonly kind = 'nayax_usb' as const;
  readonly link: TcSerialLink;

  protected call: CallFn = (frame, timeoutMs) => this.link.call(frame, timeoutMs);

  constructor(
    /** "VVVV:PPPP" (the cloud's nayaxUsbDevice) or "COMn"; null: the only USB serial port. */
    readonly usbDevice: string | null,
    ctx: ProviderContext,
    opts: { open?: () => Promise<LinkChannel>; framing?: TcSerialFraming; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    super(ctx, opts.sleep);
    this.link = new TcSerialLink(
      usbDevice ? `USB ${usbDevice}` : 'USB',
      opts.open ?? (() => serialChannel(usbDevice)),
      opts.framing ?? SPI,
      (m) => ctx.log(`c4 usb: ${m}`),
    );
  }

  describe() {
    return { kind: this.kind, address: this.link.label };
  }

  /**
   * "בדיקת מסופון USB": `getStatus`, then `getRetailerInfo`, with the raw replies and the framing,
   * so the framing can be verified on a real C4 without a sale. Read-only: never a charge, never a
   * config write.
   */
  async diagnose(timeoutMs = 8_000): Promise<C4UsbCheck> {
    const status = await this.call(statusFrame(), timeoutMs);
    const replies = [{ method: 'getStatus', raw: status.ok ? status.body : `✗ ${status.error}` }];
    if (status.ok) {
      const info = await this.call(frame('getRetailerInfo', {}), timeoutMs);
      replies.push({ method: 'getRetailerInfo', raw: info.ok ? info.body : `✗ ${info.error}` });
    }
    return { answered: status.ok, framing: this.link.framing.describe(), replies };
  }

  /** Replaced by another terminal (payService.setProvider): the COM port is let go — one opener at a time. */
  dispose(): void {
    this.link.close();
  }
}

/** The kiosk's C4 on USB from the cloud settings (paymentIntegration "nayax_usb", nayaxUsbDevice). */
export const nayaxUsbFactory: ProviderFactory = (settings, ctx) => {
  const integration = String(settings.paymentIntegration ?? '').toLowerCase().replace(/-/g, '_');
  if (integration !== 'nayax_usb') return null;
  const raw = settings.nayaxUsbDevice;
  const device = typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : null;
  return new NayaxUsbProvider(device, ctx);
};
