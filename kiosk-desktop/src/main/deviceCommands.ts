/**
 * "שליטה מרחוק" for a box with no screen of its own — the cash host (P:/specs/cash-paylink.md §11.15ד): the
 * dashboard's generic device commands, pulled from the cloud (`GET /sync/{m}/device-commands`, every minute and at
 * start) and answered once (`POST …/device-commands/{id}/ack`):
 *
 *  - `restart_app` — only at rest (no open cash transaction at any station): answered `done`, then the app
 *    restarts; busy → `refused` `payment_in_progress`;
 *  - `upload_logs` {minutes 15–1440, default 120} — any time: the app's rolling log of that window, scrubbed
 *    (core/logScrub.ts), gzip + base64, `POST /sync/{m}/device-logs` (reason `remote`, `command_id`), then
 *    `done` with {log_id} (P:/specs/device-logs-api.md §1–§2); a failed upload → `failed`;
 *  - anything else → `refused` `not_supported`.
 *
 * A command answered here is remembered (by id) so a slow cloud never gets it twice.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import type { Api } from './sync/api';
import { scrubLogText } from '../core/logScrub';
import type { RollingLog } from './deviceLog';

export interface DeviceCommandsDeps {
  api: Api;
  machineId(): string | null;
  log(m: string): void;
  logs: RollingLog | null;
  appVersion: string;
  /** Why a restart must wait now (a refusal reason), or null. */
  busy(): string | null;
  restart(): void;
  now?: () => number;
}

interface Command {
  id: string;
  action: string;
  status: string;
  params?: Record<string, unknown> | null;
}

/** The capability the dashboard looks for before offering "בקש לוגים" (device-logs-api.md §2). */
export const DEVICE_LOGS_CAPABILITY = 'device_logs_v1';
const POLL_MS = 60_000;
const MAX_CONTENT = 3 * 1024 * 1024;

export class DeviceCommands {
  private timer: NodeJS.Timeout | null = null;
  private readonly done = new Set<string>();
  private running = false;
  private readonly now: () => number;

  constructor(private readonly d: DeviceCommandsDeps) {
    this.now = d.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    const m = this.d.machineId();
    if (!m || this.running) return;
    this.running = true;
    try {
      const r = await this.d.api.get<{ commands?: Command[] }>(`sync/${m}/device-commands`, { timeoutMs: 15_000 });
      if (r.kind !== 'ok') return;
      for (const c of r.body?.commands ?? []) {
        if (!c || typeof c.id !== 'string' || this.done.has(c.id)) continue;
        if (c.status !== 'pending' && c.status !== 'delivered') continue;
        await this.handle(m, c);
      }
    } catch (e) {
      this.d.log(`device commands: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
    }
  }

  private async ack(m: string, id: string, status: 'done' | 'refused' | 'failed', detail: string | null, result?: Record<string, unknown>): Promise<boolean> {
    const r = await this.d.api.post(`sync/${m}/device-commands/${encodeURIComponent(id)}/ack`, { status, detail, ...(result ? { result } : {}) }, { timeoutMs: 15_000 });
    // An answer the cloud no longer wants (expired, cancelled): done with it too.
    if (r.kind === 'ok' || (r.kind === 'refused' && r.status < 500)) {
      this.done.add(id);
      return true;
    }
    return false;
  }

  private async handle(m: string, c: Command): Promise<void> {
    if (c.action === 'restart_app') {
      const busy = this.d.busy();
      if (busy) {
        await this.ack(m, c.id, 'refused', busy);
        return;
      }
      if (await this.ack(m, c.id, 'done', null)) {
        this.d.log('device command: restart_app — restarting');
        setTimeout(() => this.d.restart(), 500);
      }
      return;
    }
    if (c.action === 'upload_logs') {
      const raw = Number(c.params?.minutes);
      const minutes = Number.isFinite(raw) ? Math.min(1440, Math.max(15, Math.round(raw))) : 120;
      const r = await this.uploadLogs(m, minutes, c.id);
      if (r.ok) await this.ack(m, c.id, 'done', null, { log_id: r.id });
      else await this.ack(m, c.id, 'failed', r.error.slice(0, 300));
      return;
    }
    await this.ack(m, c.id, 'refused', 'not_supported');
  }

  /** The window's lines, scrubbed, gzip + base64, up to the device-logs endpoint. */
  async uploadLogs(m: string, minutes: number, commandId: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
    const to = this.now();
    const from = to - minutes * 60_000;
    const header = [
      `# R2M POS Windows ${this.d.appVersion} · machine ${m}`,
      `# ${os.type()} ${os.release()} ${os.arch()} · ${os.hostname()} · up ${Math.round(os.uptime() / 60)} min · free ${Math.round(os.freemem() / 1048576)} MB`,
      `# window ${new Date(from).toISOString()} – ${new Date(to).toISOString()}`,
    ];
    const lines = this.d.logs ? this.d.logs.collect(from, to) : [];
    let text = scrubLogText([...header, ...lines].join('\n'));
    let content = gzipSync(Buffer.from(text, 'utf8')).toString('base64');
    // Too big for one upload: the newest lines that fit.
    for (let keep = lines.length; content.length > MAX_CONTENT && keep > 10; keep = Math.floor(keep / 2)) {
      text = scrubLogText([...header, '# (cut: the newest lines)', ...lines.slice(-keep)].join('\n'));
      content = gzipSync(Buffer.from(text, 'utf8')).toString('base64');
    }
    const r = await this.d.api.post<{ id?: string }>(
      `sync/${m}/device-logs`,
      {
        upload_id: randomUUID(),
        reason: 'remote',
        command_id: commandId,
        note: null,
        app_version: this.d.appVersion,
        device_model: `${os.type()} ${os.arch()}`.slice(0, 100),
        os: `${os.type()} ${os.release()}`.slice(0, 100),
        from_ms: from,
        to_ms: to,
        line_count: lines.length,
        content_encoding: 'gzip+base64',
        content,
      },
      { timeoutMs: 60_000 },
    );
    if (r.kind === 'ok' && typeof r.body?.id === 'string') return { ok: true, id: r.body.id };
    return { ok: false, error: r.kind === 'offline' ? r.reason : `HTTP ${r.status}` };
  }
}
