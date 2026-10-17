/**
 * "צימוד מהענן" (P:/specs/foreign-records-upload.md §6.1): an unpaired device registers a pending pairing request
 * (`POST /pairing/device/register`), shows the "קוד מכשיר" the answer gives (6 characters, rotated every 10 minutes) and
 * polls `GET /pairing/device/{nonce}/status` with its own secret nonce until a dashboard user claims the code for a
 * machine — then the credentials (the pairing/validate shape) are this device's.
 *
 * Feature-detected: a server whose register answer has no `deviceCode` (or no register at all) leaves the screen to the
 * code entry as today (`unsupported`).
 */

import type { Credentials } from './cloud';
import type { Api } from './api';
import { credentialsFrom } from './syncEngine';

export type CloudPairingPhase = 'idle' | 'starting' | 'waiting' | 'unsupported' | 'error' | 'paired';

export interface CloudPairingView {
  phase: CloudPairingPhase;
  serverUrl: string | null;
  /** "ABC2DE" — shown as "ABC-2DE" with its QR. */
  code: string | null;
  codeExpiresAt: string | null;
  error: string | null;
}

export interface CloudPairingDeps {
  api: Api;
  deviceInfo(): Record<string, unknown>;
  machineName(): string | null;
  /** The credentials a claim delivered: the device takes them (KioskService.adopt). */
  adopt(c: Credentials): Promise<void>;
  changed(): void;
  log(m: string): void;
  now?: () => number;
  /** Between polls (tests: 0). */
  pollMs?: number;
}

export const POLL_MS = 3_000;
/** A code is replaced a little before the cloud lets it go. */
const ROTATE_BEFORE_MS = 15_000;
const DEFAULT_CODE_TTL_MS = 10 * 60_000;

export class CloudPairing {
  private v: CloudPairingView = { phase: 'idle', serverUrl: null, code: null, codeExpiresAt: null, error: null };
  private nonce: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private generation = 0;
  private readonly now: () => number;

  constructor(private readonly d: CloudPairingDeps) {
    this.now = d.now ?? Date.now;
  }

  view(): CloudPairingView {
    return { ...this.v };
  }

  private set(p: Partial<CloudPairingView>) {
    this.v = { ...this.v, ...p };
    this.d.changed();
  }

  /** Register (again) on this server and poll. */
  async start(serverUrl: string): Promise<CloudPairingView> {
    this.stop();
    const gen = ++this.generation;
    this.set({ phase: 'starting', serverUrl, code: null, codeExpiresAt: null, error: null });
    this.d.api.setBase(serverUrl);
    await this.register(gen);
    return this.view();
  }

  stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nonce = null;
    if (this.v.phase !== 'paired') this.v = { ...this.v, phase: 'idle', code: null, codeExpiresAt: null };
  }

  private async register(gen: number): Promise<void> {
    const r = await this.d.api.post<Record<string, unknown>>('pairing/device/register', { deviceInfo: this.d.deviceInfo(), machineName: this.d.machineName() }, { auth: false, timeoutMs: 20_000 });
    if (gen !== this.generation) return;
    if (r.kind === 'offline') return this.set({ phase: 'error', error: `אין חיבור לשרת (${r.reason})` });
    if (r.kind === 'refused') {
      if (r.status === 404 || r.status === 405) return this.set({ phase: 'unsupported', error: null });
      return this.set({ phase: 'error', error: r.status === 429 ? 'יותר מדי ניסיונות — נסו שוב בעוד דקה' : `שגיאת שרת ${r.status}` });
    }
    const b = r.body ?? {};
    if (typeof b.deviceNonce !== 'string' || typeof b.deviceCode !== 'string' || !b.deviceCode) {
      // An older server: the request is there, but no code a person can type — the code entry as today.
      return this.set({ phase: 'unsupported', error: null });
    }
    this.nonce = b.deviceNonce;
    const expires = typeof b.codeExpiresAt === 'string' ? b.codeExpiresAt : new Date(this.now() + DEFAULT_CODE_TTL_MS).toISOString();
    this.set({ phase: 'waiting', code: b.deviceCode, codeExpiresAt: expires, error: null });
    this.schedule(gen);
  }

  private schedule(gen: number) {
    if (gen !== this.generation) return;
    this.timer = setTimeout(() => void this.poll(gen), this.d.pollMs ?? POLL_MS);
    this.timer.unref?.();
  }

  /** One poll (exposed for tests). */
  async poll(gen = this.generation): Promise<void> {
    if (gen !== this.generation || !this.nonce) return;
    const expires = this.v.codeExpiresAt ? Date.parse(this.v.codeExpiresAt) : NaN;
    if (Number.isFinite(expires) && this.now() >= expires - ROTATE_BEFORE_MS) return this.register(gen);
    const r = await this.d.api.get<Record<string, unknown>>(`pairing/device/${encodeURIComponent(this.nonce)}/status`, { auth: false, timeoutMs: 15_000 });
    if (gen !== this.generation) return;
    if (r.kind === 'refused' && r.status === 410) return this.register(gen);
    if (r.kind === 'ok') {
      const creds = credentialsFrom(r.body ?? {}, this.v.serverUrl ?? '');
      if (creds) {
        this.generation++;
        this.nonce = null;
        this.d.log(`cloud pairing: claimed as machine ${creds.machineId}`);
        try {
          await this.d.adopt(creds);
          this.set({ phase: 'paired', code: null, codeExpiresAt: null, error: null });
        } catch (e) {
          this.set({ phase: 'error', error: `הצימוד התקבל אך נכשל: ${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }
    }
    this.schedule(gen);
  }
}
