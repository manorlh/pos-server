/**
 * Hardware through the Windows bridge ("גשר לדפדפן", R2M POS for Windows in bridge mode on the
 * same PC, http://127.0.0.1:47615): network / Windows / USB printers, the drawer, and byte
 * channels to a terminal — what a browser cannot reach by itself.
 *
 * Over the dashboard's signed bridge client (client/src/lib/kioskBridge.ts `BridgeClient`, HMAC
 * per call). For the till role every call carries the ENGINE's ticket (§9.5: Ed25519, 30 s, one
 * use, bound to the action and the bytes) — the page passes it through and cannot make one, so
 * code injected into the page cannot open the drawer.
 *
 * SKELETON (P5): the bridge has no `till` role yet (ROLE_CAPS: kiosk / kds / board) and no
 * `/channel/*` routes; today it refuses these calls and this reports "refused".
 */

import type { BridgeReply } from '@dash-lib/kioskBridge';
import { bytesToBase64, base64ToBytes } from '../../../shared/till/bytes';
import { HwError, type ByteChannel, type ChannelSpec, type HardwarePort, type ParsedTarget, type PrintJobInfo } from '../HardwarePort';

/** What this needs of the dashboard's BridgeClient (structurally the same). */
export interface BridgeRequester {
  request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs?: number): Promise<BridgeReply<T>>;
}

function fail(r: BridgeReply<unknown>, what: string): never {
  if (r.kind === 'offline') throw new HwError('offline', 'הגשר ל-Windows לא עונה');
  if (r.kind === 'refused') throw new HwError(r.status === 401 || r.status === 403 ? 'not_permitted' : 'refused', r.message ?? `הגשר סירב ל${what} (${r.status})`);
  throw new HwError('io', what);
}

class BridgeChannel implements ByteChannel {
  constructor(
    readonly id: string,
    private readonly client: BridgeRequester,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    const r = await this.client.request('POST', '/channel/write', { channelId: this.id, bytesB64: bytesToBase64(bytes) });
    if (r.kind !== 'ok') fail(r, 'כתיבה לערוץ');
  }

  async read(max: number, timeoutMs: number): Promise<Uint8Array> {
    const r = await this.client.request<{ bytesB64?: string }>('POST', '/channel/read', { channelId: this.id, max, timeoutMs }, timeoutMs + 5_000);
    if (r.kind !== 'ok') fail(r, 'קריאה מהערוץ');
    return base64ToBytes(r.body?.bytesB64 ?? '');
  }

  async close(): Promise<void> {
    await this.client.request('POST', '/channel/close', { channelId: this.id }).catch(() => undefined);
  }
}

export class BridgeHardwarePort implements HardwarePort {
  readonly name = 'bridge';

  constructor(private readonly client: BridgeRequester) {}

  supports(t: ParsedTarget): boolean {
    return t.scheme === 'tcp' || t.scheme === 'spooler' || t.scheme === 'usb' || t.scheme === 'bt';
  }

  supportsChannel(s: ChannelSpec): boolean {
    return s.kind === 'tcp' || s.kind === 'tls' || s.kind === 'https-request' || s.kind === 'serial';
  }

  async print(t: ParsedTarget, bytes: Uint8Array, job: PrintJobInfo): Promise<void> {
    if (!job.ticket) throw new HwError('not_permitted', 'הגשר דורש אישור מהמנוע (כרטיס מנוע)');
    const r =
      job.kind === 'drawer'
        ? await this.client.request('POST', '/drawer', { target: t.raw, engineTicket: job.ticket })
        : await this.client.request('POST', '/print', { target: t.raw, jobId: job.jobId, kind: job.kind, rawB64: bytesToBase64(bytes), engineTicket: job.ticket }, 30_000);
    if (r.kind !== 'ok') fail(r, job.kind === 'drawer' ? 'פתיחת המגירה' : 'ההדפסה');
  }

  async openChannel(s: ChannelSpec): Promise<ByteChannel> {
    if (!s.ticket) throw new HwError('not_permitted', 'הגשר דורש אישור מהמנוע (כרטיס מנוע)');
    const r = await this.client.request<{ channelId?: string }>('POST', '/channel/open', { kind: s.kind, address: s.address, tls: s.tls, serial: s.serial, engineTicket: s.ticket });
    if (r.kind !== 'ok') fail(r, 'פתיחת ערוץ');
    const id = r.body?.channelId;
    if (typeof id !== 'string' || !id) throw new HwError('io', 'הגשר לא החזיר ערוץ');
    return new BridgeChannel(id, this.client);
  }
}
