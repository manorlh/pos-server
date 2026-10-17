/**
 * The technician's setup actions on Windows (P:/specs/windows-setup-parity.md) — the parts of pos-android's technician
 * screens that are more than a look: "כתובת שרת" (tested, then switched — the pairing kept on the same cloud), "חיפוש
 * מדפסות ברשת" (found → printed from here, or added to the shop with a manager's code), "כתובת המסופון" (a manager's
 * code: `PUT /sync/{m}/payment-terminal`), "קישור מסופון מחדש" (searched, picked: `PUT /sync/{m}/pinpad-host`, reason
 * `technician` — the machine token alone, as Android), "מגירת כסף" (the pin and the pulse, and a test opening) and
 * "שליחת לוגים לתמיכה". KioskService (main/service.ts) owns the state and hands this class what it reads and writes.
 *
 * A manager's code is checked by the cloud, never only here: the roster finds who typed it, then `POST
 * /elevation/sessions` (the person's till PIN, the scope `catalog:write`) gives the grant sent as `X-Elevation-Token`.
 */

import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { gzipSync } from 'node:zlib';
import bcrypt from 'bcryptjs';
import { displayName, findByPin, ofShop, type RosterUser } from '../../core/desktopExit';
import { scrubLogText } from '../../core/logScrub';
import { choose, match, subnetHosts, type PinpadCandidate, type PinpadIdentity } from '../../core/pinpadRelocation';
import { decideServerSwitch, logRangeMinutes, normalizeServerUrl, TECH_TEXT, type LogRange, type ServerProbe } from '../../core/technicianSetup';
import { apiBase, detailOf, type Api, type FetchFn } from '../sync/api';
import type { RollingLog } from '../deviceLog';
import { originOf, timedGet, type HttpCheck } from './technicianTools';

export interface TechnicianSetupDeps {
  api: Api;
  fetch: FetchFn;
  appVersion: string;
  machineId(): string | null;
  credentials(): { serverUrl: string; accessToken: string | null } | null;
  /** The same cloud at another address: the pairing kept, the API's base moved. */
  moveServer(serverUrl: string): void;
  /** "ניתוק המכשיר מהענן" (the technician's own action — its refusals included). */
  unpair(): Promise<{ ok: boolean; message?: string }>;
  outboxCount(): number;
  roster(): readonly RosterUser[];
  shopId(): string | null;
  /** After the cloud took a setting for this device: settings pulled again, the provider applied. */
  afterSettings(): Promise<void>;
  /** After a printer was added to the shop: the kitchen's printers pulled again. */
  afterPrinters(): Promise<void>;
  /** The pinpad on the network now (null: none). */
  pinpadHere(): { host: string; port: number; path: string } | null;
  /** The pinpad's expected terminal (the cloud's `expectedTerminalNumber`, else the one learned). */
  expectedTerminal(): string | null;
  sweep(hosts: string[], port: number): Promise<string[]>;
  localIpv4(): string | null;
  identify(host: string, port: number): Promise<PinpadIdentity | null>;
  savePinpadHost(host: string, port: number, id: PinpadIdentity, previous: string, reason: 'technician'): Promise<'ok' | 'offline' | 'refused'>;
  logs: RollingLog | null;
  log(m: string): void;
  now?: () => number;
}

export interface ServerTestView {
  url: string;
  health: HttpCheck;
  same: HttpCheck | null;
  sameCloud: boolean;
}

export interface FoundPinpad {
  host: string;
  port: number;
  terminal: string | null;
  merchant: string | null;
  serial: string | null;
  /** The device's own terminal ("✓ המסוף של המכשיר"), another, or unknown. */
  match: 'same' | 'other' | 'unknown';
}

const MAX_LOG_CONTENT = 3 * 1024 * 1024;

export class TechnicianSetup {
  /** The last "בדיקת חיבור" — "שמירה" goes on it only (Android: test first). */
  private lastProbe: ServerProbe | null = null;
  private lastFound: FoundPinpad[] = [];
  private readonly now: () => number;

  constructor(private readonly d: TechnicianSetupDeps) {
    this.now = d.now ?? Date.now;
  }

  /* ------------------------------------------------------------ "כתובת שרת" */

  /** "בדיקת חיבור": `/health` at the address's origin, then — answered — whether the same cloud knows this device there. */
  async testServer(typed: string): Promise<{ ok: boolean; message?: string; server?: ServerTestView }> {
    const url = normalizeServerUrl(typed);
    if (!url) return { ok: false, message: TECH_TEXT.serverInvalid };
    const origin = originOf(url);
    const health = await timedGet(this.d.fetch, `${origin}/health`, null, 8_000, this.now);
    let same: HttpCheck | null = null;
    let sameCloud = false;
    const m = this.d.machineId();
    const token = this.d.credentials()?.accessToken ?? null;
    if (health.ok && m) {
      const base = apiBase(url);
      same = await timedGet(this.d.fetch, `${base}sync/${m}/kiosk/technician`, token, 8_000, this.now);
      const id = (same.body as { machine?: { id?: unknown } } | null)?.machine?.id;
      sameCloud = same.ok && typeof id === 'string' && id.toLowerCase() === m.toLowerCase();
      if (same.code === 404) {
        // A cloud from before the technician route: its parameters answer for this device too.
        same = await timedGet(this.d.fetch, `${base}sync/${m}/parameters`, token, 8_000, this.now);
        sameCloud = same.ok;
      }
    }
    this.lastProbe = { url, reachable: health.ok, sameCloud };
    return { ok: health.ok, server: { url, health: strip(health), same: same ? strip(same) : null, sameCloud } };
  }

  /** "שמירה": by Android's rule (core/technicianSetup.ts decideServerSwitch). `confirm`: "נתק ועבור לענן החדש" was pressed. */
  async saveServer(typed: string, confirm: boolean): Promise<{ ok: boolean; message: string; confirm?: string }> {
    const current = this.d.credentials()?.serverUrl ?? null;
    const decision = decideServerSwitch(current, typed, this.lastProbe, this.d.outboxCount(), confirm);
    const url = normalizeServerUrl(typed) ?? typed;
    switch (decision) {
      case 'invalid':
        return { ok: false, message: TECH_TEXT.serverInvalid };
      case 'unchanged':
        return { ok: false, message: TECH_TEXT.serverUnchanged };
      case 'not_tested':
        return { ok: false, message: TECH_TEXT.serverUntested };
      case 'unreachable':
        return { ok: false, message: TECH_TEXT.serverUnreachable };
      case 'refused_unsynced':
        return { ok: false, message: TECH_TEXT.serverUnsynced(this.d.outboxCount()) };
      case 'confirm_new_cloud':
        return { ok: false, message: TECH_TEXT.serverConfirmNewCloud, confirm: TECH_TEXT.serverConfirmUnpair };
      case 'switch_keep_pairing':
        this.d.moveServer(url);
        this.d.log(`technician: server address ${current ?? '-'} -> ${url} (same cloud, pairing kept)`);
        return { ok: true, message: TECH_TEXT.serverSwitched(url) };
      case 'switch_and_unpair': {
        const r = await this.d.unpair();
        if (!r.ok) return { ok: false, message: r.message ?? 'לא ניתן לנתק' };
        this.d.log(`technician: server address ${current ?? '-'} -> ${url} (another cloud, unpaired)`);
        // The pairing screen opens on the new address (shell/pairing reads the last one).
        this.lastServer = url;
        return { ok: true, message: TECH_TEXT.serverSwitchedUnpaired(url) };
      }
    }
  }

  /** The address the pairing screen offers after a switch to another cloud. */
  lastServer: string | null = null;

  /* ------------------------------------------------------------ a manager's grant */

  /**
   * A manager's code for a cloud write: who typed it (the roster, bcrypt — offline too), then the cloud's own check of the
   * same PIN for [scope]. Its token, or why not (Hebrew).
   */
  async managerGrant(code: string, scope: string): Promise<{ ok: true; token: string; name: string } | { ok: false; message: string }> {
    const users = this.d.roster().filter((u) => u.isActive && !!u.pinHash && ofShop(u, this.d.shopId()));
    if (users.length === 0) return { ok: false, message: 'אין עובדים בקופה עדיין — סנכרנו קודם' };
    const u = await findByPin(users, code.trim(), (p, h) => bcrypt.compare(p, h));
    if (!u) return { ok: false, message: 'קוד שגוי' };
    const r = await this.d.api.post<{ token?: string; userName?: string }>('elevation/sessions', { posUserId: u.id, pin: code.trim(), scopes: [scope] }, { timeoutMs: 15_000 });
    if (r.kind === 'offline') return { ok: false, message: 'אין חיבור לענן — לא נשמר' };
    if (r.kind === 'refused') {
      const why = detailOf(r.body);
      return { ok: false, message: why === 'not_permitted_here' ? `ל${displayName(u)} אין הרשאה לשנות הגדרות` : why === 'pin_locked' || r.status === 429 ? 'יותר מדי ניסיונות — נסו שוב מאוחר יותר' : `הענן סירב (${why ?? r.status})` };
    }
    const token = r.body?.token;
    if (typeof token !== 'string' || !token) return { ok: false, message: 'הענן לא החזיר אישור' };
    return { ok: true, token, name: r.body?.userName ?? displayName(u) };
  }

  /* ------------------------------------------------------------ "כתובת המסופון" */

  /** "שמירה" of the pinpad's address (or "חיבור USB"): a manager's code, the cloud's own route, then the settings again. */
  async setPinpad(input: { connection: 'lan'; host: string; port: number | null } | { connection: 'usb' }, code: string): Promise<{ ok: boolean; message: string }> {
    const m = this.d.machineId();
    if (!m) return { ok: false, message: 'המכשיר לא משויך' };
    if (input.connection === 'lan' && !/^\d{1,3}(\.\d{1,3}){3}$/.test(input.host.trim()) && !/^[a-z0-9.-]+$/i.test(input.host.trim())) return { ok: false, message: 'כתובת לא תקינה' };
    if (input.connection === 'lan' && input.port !== null && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) return { ok: false, message: 'פורט לא תקין' };
    const grant = await this.managerGrant(code, 'catalog:write');
    if (!grant.ok) return grant;
    const body = input.connection === 'usb' ? { host: '', connection: 'usb' } : { host: input.host.trim(), port: input.port ?? undefined, connection: 'lan' };
    const r = await this.d.api.put(`sync/${m}/payment-terminal`, body, { headers: { 'X-Elevation-Token': grant.token }, timeoutMs: 20_000 });
    if (r.kind === 'offline') return { ok: false, message: 'אין חיבור לענן — לא נשמר' };
    if (r.kind === 'refused') return { ok: false, message: `הענן סירב: ${detailOf(r.body) ?? r.status}` };
    this.d.log(`technician: payment terminal set ${input.connection === 'usb' ? 'usb' : `${input.host}:${input.port ?? 'default'}`} by ${grant.name}`);
    await this.d.afterSettings();
    return { ok: true, message: input.connection === 'usb' ? 'נשמר · המסופון ב-USB' : `נשמר · המסופון ${input.host}${input.port ? `:${input.port}` : ''}` };
  }

  /* ------------------------------------------------------------ "קישור מסופון מחדש" */

  /** "חיפוש מסופון ברשת": the /24 on the pinpad's port, each that answers asked who it is (reads only). */
  async searchPinpads(): Promise<{ ok: boolean; message?: string; found?: FoundPinpad[] }> {
    const here = this.d.pinpadHere();
    if (!here) return { ok: false, message: 'המכשיר לא מוגדר לסליקה במסופון ברשת' };
    const ip = this.d.localIpv4();
    if (!ip) return { ok: false, message: 'המחשב לא מחובר לרשת מקומית' };
    const open = await this.d.sweep(subnetHosts(ip), here.port);
    const want = this.d.expectedTerminal();
    const found: FoundPinpad[] = [];
    for (const host of open) {
      const id = await this.d.identify(host, here.port).catch(() => null);
      if (!id) continue;
      const m = want ? match({ terminal: want }, id) : 'unknown';
      found.push({ host, port: here.port, terminal: id.terminal ?? null, merchant: id.merchant ?? null, serial: id.serial ?? null, match: m === 'same' ? 'same' : m === 'unknown' ? 'unknown' : 'other' });
    }
    this.lastFound = found;
    return { ok: true, found, message: found.length === 0 ? TECH_TEXT.relinkNone : undefined };
  }

  /** "קשר את המסופון הזה": one the search found — saved in the cloud (reason `technician`), then used. */
  async linkPinpad(host: string, port: number): Promise<{ ok: boolean; message: string }> {
    const here = this.d.pinpadHere();
    const f = this.lastFound.find((x) => x.host === host && x.port === port);
    if (!here || !f) return { ok: false, message: 'חפשו קודם את המסופון ברשת' };
    const want = this.d.expectedTerminal();
    // Never a stranger: with the device's terminal known, only that terminal (the cloud refuses another too).
    if (want) {
      const c: PinpadCandidate = { host, port, identity: { terminal: f.terminal, serial: f.serial } };
      const pick = choose({ terminal: want }, `${here.host}:${here.port}`, [c]);
      if (pick.kind !== 'switch' && pick.kind !== 'still_there') return { ok: false, message: TECH_TEXT.relinkOther(f.terminal ?? '—') };
    }
    const r = await this.d.savePinpadHost(host, port, { terminal: f.terminal, serial: f.serial }, `${here.host}:${here.port}`, 'technician');
    if (r === 'offline') return { ok: false, message: 'אין חיבור לענן — הכתובת לא נשמרה' };
    if (r === 'refused') return { ok: false, message: 'הענן סירב לכתובת' };
    return { ok: true, message: `נשמר · המכשיר סולק עכשיו במסופון ${f.terminal ?? host}` };
  }

  /* ------------------------------------------------------------ "שליחת לוגים לתמיכה" */

  /** The app's log of the range, scrubbed, gzip + base64, to `POST /sync/{m}/device-logs` (reason `manual`, the note). */
  async sendLogs(range: LogRange, note: string | null): Promise<{ ok: boolean; message: string }> {
    const m = this.d.machineId();
    if (!m) return { ok: false, message: 'המכשיר לא משויך' };
    const to = this.now();
    const minutes = logRangeMinutes(range, new Date(to));
    const from = to - minutes * 60_000;
    const header = [
      `# R2M POS Windows ${this.d.appVersion} · machine ${m} · sent by the technician`,
      `# ${os.type()} ${os.release()} ${os.arch()} · ${os.hostname()} · up ${Math.round(os.uptime() / 60)} min`,
      `# window ${new Date(from).toISOString()} – ${new Date(to).toISOString()}`,
    ];
    const lines = this.d.logs ? this.d.logs.collect(from, to) : [];
    let content = gzipSync(Buffer.from(scrubLogText([...header, ...lines].join('\n')), 'utf8')).toString('base64');
    for (let keep = lines.length; content.length > MAX_LOG_CONTENT && keep > 10; keep = Math.floor(keep / 2)) {
      content = gzipSync(Buffer.from(scrubLogText([...header, '# (cut: the newest lines)', ...lines.slice(-keep)].join('\n')), 'utf8')).toString('base64');
    }
    const r = await this.d.api.post<{ id?: string }>(
      `sync/${m}/device-logs`,
      {
        upload_id: randomUUID(),
        reason: 'manual',
        command_id: null,
        note: note?.trim() ? note.trim().slice(0, 500) : null,
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
    if (r.kind === 'ok') return { ok: true, message: `הלוגים נשלחו לתמיכה (${lines.length} שורות)` };
    return { ok: false, message: r.kind === 'offline' ? 'אין חיבור לענן — הלוגים לא נשלחו' : `השליחה נכשלה (HTTP ${r.status})` };
  }

  /** "יומן אפליקציה": the last lines of the app's log (the last hour), scrubbed. */
  appLog(lines = 20): string[] {
    const to = this.now();
    const all = this.d.logs ? this.d.logs.collect(to - 60 * 60_000, to) : [];
    return scrubLogText(all.slice(-lines).join('\n')).split('\n').filter(Boolean);
  }
}

/** A check as the screen shows it (no body). */
function strip(c: HttpCheck): HttpCheck {
  return { url: c.url, ok: c.ok, code: c.code, ms: c.ms, error: c.error };
}
