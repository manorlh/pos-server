/**
 * Printing through the cloud (`relay://<printerId>`): the job goes to `POST /sync/{m}/print-jobs`
 * and the cloud hands it to the shop's print server (a till on the LAN), which prints it on the
 * printer the engine named. The job id is the engine's, so a retried upload is the same job.
 *
 * SKELETON: today's endpoint takes a kitchen `ticket` (structured), not ready bytes. Sending the
 * engine's ESC/POS bytes (`rawEscPosB64`) is the P1 server change (§3.5: the engine draws, the
 * host moves bytes); until then the cloud answers 422 and this reports it as "refused".
 * The token is the browser till's short access token (§9.2) — never the machine token.
 */

import { bytesToBase64 } from '../../../shared/till/bytes';
import { HwError, type HardwarePort, type ParsedTarget, type PrintJobInfo } from '../HardwarePort';

export type HttpFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface RelayOptions {
  /** The API's base, e.g. https://api…/api/v1 */
  apiBase: string;
  machineId: string;
  token(): Promise<string | null>;
  http: HttpFn;
  timeoutMs?: number;
}

export interface RelayJobBody {
  id: string;
  printerId: string;
  kind: string;
  rawEscPosB64: string;
}

export function relayJobBody(t: ParsedTarget, bytes: Uint8Array, job: PrintJobInfo): RelayJobBody {
  if (t.scheme !== 'relay' || !t.printerId) throw new HwError('unsupported', 'יעד relay לא תקין');
  return { id: job.jobId, printerId: t.printerId, kind: job.kind, rawEscPosB64: bytesToBase64(bytes) };
}

export class RelayPrintPort implements HardwarePort {
  readonly name = 'relay';

  constructor(private readonly o: RelayOptions) {}

  supports(t: ParsedTarget): boolean {
    return t.scheme === 'relay';
  }

  async print(t: ParsedTarget, bytes: Uint8Array, job: PrintJobInfo): Promise<void> {
    const body = relayJobBody(t, bytes, job);
    const token = await this.o.token();
    if (!token) throw new HwError('refused', 'אין חיבור מאושר לענן');
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 15_000) : null;
    let res: { ok: boolean; status: number; text(): Promise<string> };
    try {
      res = await this.o.http(`${this.o.apiBase.replace(/\/+$/, '')}/sync/${encodeURIComponent(this.o.machineId)}/print-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      throw new HwError('offline', `הענן לא זמין: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 409: the same job id is already there — the retry of an upload that did arrive.
    if (res.ok || res.status === 409) return;
    let message = `הענן סירב (${res.status})`;
    try {
      const b = JSON.parse(await res.text()) as { detail?: unknown; message?: unknown };
      const m = typeof b.message === 'string' ? b.message : typeof b.detail === 'string' ? b.detail : null;
      if (m) message = m;
    } catch {
      /* not JSON */
    }
    throw new HwError(res.status >= 500 ? 'offline' : 'refused', message);
  }
}
