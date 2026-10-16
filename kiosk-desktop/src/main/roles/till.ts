/**
 * Role module "קופה" (till) of R2M POS for Windows — S0-6, the skeleton
 * (P:/specs/web-till-spec-v2.md §4.2, §5.2, §8.2, §13.2).
 *
 * The till is just another ROLE of the same app and the same installer (the owner's rule): install
 * R2M POS for Windows, type the pairing code, and the role comes from the dashboard. No second
 * app, no Java to install, no settings screen. Java and the engine ride inside the installer and
 * update with it through the existing updater (main/update/updater.ts) — the user never sees them.
 *
 * What this does:
 *  - picks the screens: the newest VERIFIED app bundle (every file against its manifest, and its
 *    Ed25519 signature once a release key is pinned), else the one built into the installer;
 *  - serves it at `r2m://app/` (only listed files, a strict CSP header);
 *  - is the page's door to the engine (`window.r2mApp`, preload/app.ts): the till protocol's
 *    envelopes in, the engine's events out. The engine is the MOCK today; in P2 it is the bundled
 *    JVM engine over stdio (engineCommand below). Hardware (`hw.*`) never passes through the page;
 *  - tells the updater when the till is at rest (never mid-sale) and runs the watchdog.
 *
 * The engine behind the screens is the kiosk core's own (main/till/engine.ts — the 10.10.2026 "basic till"); the mock
 * (shared/till/mockEngine.ts) is the web demo's. Electron-free: tillElectron.ts holds the window and protocol glue.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppHostInfo } from '../../shared/till/appBridge';
import { ELECTRON_SHELL_API } from '../../shared/till/appBridge';
import { MockTillEngine } from '../../shared/till/mockEngine';
import { TILL_PROTOCOL, type DeviceRoleName, type EngineCall, type EngineEndpoint, type EngineEvent, type EngineReply, type HelloReply, type HwRequest } from '../../shared/till/protocol';
import { NO_CAPS } from '../../renderer/host/caps';
import type { DeviceInfo, HostCaps } from '../../renderer/host/TillHost';
import { resolveAppPath, verifyAppBundleDir, type AppBundleManifest } from './appBundle';

/** The protocols the engine on this PC speaks (the mock: 1). */
export const ENGINE_PROTOCOLS: readonly number[] = [TILL_PROTOCOL];
/** The watchdog: no "ready" from the page by then → the bundle is bad on this PC (§8.2). */
export const READY_TIMEOUT_MS = 25_000;

/** The strict CSP of the till's screens (§9.3): our files only, the engine only through IPC. */
export const APP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export interface ChosenBundle {
  dir: string;
  manifest: AppBundleManifest;
  source: 'downloaded' | 'built-in';
}

export interface TillRoleOptions {
  /** %APPDATA%\R2M Kiosk — the till's own folder is `till/` inside it, never the kiosk's data. */
  userData: string;
  /** The bundle inside the installer (resources/app-bundle), or dist/app-bundle in development. */
  builtInBundleDir: string;
  appVersion: string;
  device(): DeviceInfo;
  caps(): HostCaps;
  /** The pinned release key (decision 11); null until it exists. */
  publicKey?: Uint8Array | null;
  /** The engine; default the mock (P2: the JVM over stdio). */
  engine?: EngineEndpoint;
  log(m: string): void;
}

/** What the shell knows of the till for the updater (core/updatePolicy.ts Activity). */
export interface TillActivity {
  busy: boolean;
  idle: boolean;
  lastActivityAt: number | null;
}

export class TillRole {
  readonly dir: string;
  private chosen: ChosenBundle | null = null;
  private readonly engine: EngineEndpoint;
  private ready = false;
  private atRest = { idle: false, busy: false, at: null as number | null };
  private role: DeviceRoleName = 'till';

  constructor(private readonly o: TillRoleOptions) {
    this.dir = path.join(o.userData, 'till');
    this.engine = o.engine ?? new MockTillEngine({ terminal: false, printerTarget: null, drawerTarget: null });
  }

  /* ------------------------------------------------------------- the bundle */

  private badFile(): string {
    return path.join(this.dir, 'bad-bundles.json');
  }

  private badList(): string[] {
    try {
      const v = JSON.parse(readFileSync(this.badFile(), 'utf8')) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** A bundle that failed here (the watchdog): never chosen again on this shell version. */
  markBad(dir: string) {
    const key = `${this.o.appVersion}|${dir}`;
    const list = this.badList();
    if (list.includes(key)) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.badFile(), JSON.stringify([...list, key].slice(-20)));
    this.o.log(`till: bundle marked bad ${dir}`);
  }

  /** The downloaded bundle the updater made active (`till/bundles/active.json` {dir}), if any. */
  private activeDownloaded(): string | null {
    try {
      const a = JSON.parse(readFileSync(path.join(this.dir, 'bundles', 'active.json'), 'utf8')) as { dir?: unknown };
      if (typeof a.dir !== 'string') return null;
      const dir = path.resolve(this.dir, 'bundles', a.dir);
      return dir.startsWith(path.join(this.dir, 'bundles') + path.sep) ? dir : null;
    } catch {
      return null;
    }
  }

  /** Picks and VERIFIES the screens: the downloaded one, then the installer's; null if none holds. */
  chooseBundle(): ChosenBundle | null {
    const bad = new Set(this.badList());
    const candidates: Array<[string, ChosenBundle['source']]> = [];
    const active = this.activeDownloaded();
    if (active) candidates.push([active, 'downloaded']);
    candidates.push([this.o.builtInBundleDir, 'built-in']);
    for (const [dir, source] of candidates) {
      if (bad.has(`${this.o.appVersion}|${dir}`) || !existsSync(dir)) continue;
      const r = verifyAppBundleDir(dir, { protocols: ENGINE_PROTOCOLS, role: 'till', publicKey: this.o.publicKey ?? null });
      if (r.ok) {
        this.chosen = { dir, manifest: r.manifest, source };
        return this.chosen;
      }
      this.o.log(`till: ${source} bundle refused (${r.problems.slice(0, 5).join(', ')})`);
    }
    this.chosen = null;
    return null;
  }

  get bundle(): ChosenBundle | null {
    return this.chosen;
  }

  /** `r2m://app/<path>` → a file of the chosen, verified bundle (null: 404). */
  serve(urlPath: string): { file: string; headers: Record<string, string> } | null {
    if (!this.chosen) return null;
    const file = resolveAppPath(this.chosen.dir, this.chosen.manifest, urlPath);
    if (!file) return null;
    return { file, headers: { 'Content-Security-Policy': APP_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' } };
  }

  /* ------------------------------------------------------- the page's door */

  info(): AppHostInfo {
    const m = this.chosen?.manifest;
    return {
      role: this.role,
      shellApi: ELECTRON_SHELL_API,
      shellVersion: this.o.appVersion,
      caps: this.o.caps(),
      device: this.o.device(),
      bundle: m ? { version: m.version, versionCode: m.versionCode, protocol: m.protocol } : null,
      demo: this.o.engine === undefined,
    };
  }

  hello(since?: number): Promise<HelloReply> {
    return Promise.resolve(this.engine.hello(since));
  }

  /** An envelope from the page. Malformed → refused here, before the engine sees it. */
  call(c: unknown): Promise<EngineReply> {
    const env = c as Partial<EngineCall> | null;
    if (!env || typeof env !== 'object' || typeof env.id !== 'number' || typeof env.op !== 'string') {
      return Promise.resolve({ id: typeof env?.id === 'number' ? env.id : -1, ok: false, error: { code: 'invalid_args', message: 'בקשה לא תקינה' } });
    }
    // The page never answers hardware: `hw.result` comes from the main process only.
    if (env.op === 'hw.result') return Promise.resolve({ id: env.id, ok: false, error: { code: 'permission_denied', message: 'אין הרשאה לפעולה הזו' } });
    return this.engine.call({ id: env.id, op: env.op, args: env.args, clientOpId: typeof env.clientOpId === 'string' ? env.clientOpId : undefined });
  }

  /** The engine's events: `state` / `toast` to the page; `hw` to the main process's hardware. */
  onEngineEvent(toPage: (e: EngineEvent) => void, toHardware: (req: HwRequest) => void): () => void {
    return this.engine.on((e) => {
      if (e.ev === 'hw') toHardware(e.data as HwRequest);
      else toPage(e);
    });
  }

  /** The main process's answer to an `hw.*` request (P2: printer/transports.ts, payment/*). */
  hwResult(r: { requestId: string; ok: boolean; code?: string; message?: string }) {
    void this.engine.call({ id: -1, op: 'hw.result', args: r }).catch(() => undefined);
  }

  reportReady() {
    this.ready = true;
  }

  get isReady(): boolean {
    return this.ready;
  }

  reportIdle(idle: boolean, busy: boolean, now = Date.now()) {
    this.atRest = { idle: idle === true, busy: busy === true, at: now };
    void this.engine.call({ id: -1, op: 'host.idle', args: { idle: this.atRest.idle, busy: this.atRest.busy } }).catch(() => undefined);
  }

  /** For the updater: busy until the page says otherwise (no update before the till drew). */
  activity(): TillActivity {
    if (!this.ready) return { busy: true, idle: false, lastActivityAt: null };
    return { busy: this.atRest.busy, idle: this.atRest.idle && !this.atRest.busy, lastActivityAt: this.atRest.at };
  }

  /** A new load starts the watchdog over. */
  loading() {
    this.ready = false;
  }
}

/** The demo's honest capabilities: the mock engine reaches no hardware; a USB scanner types. */
export const PREVIEW_CAPS: HostCaps = { ...NO_CAPS, scan: { hid: true, camera: false } };

/**
 * The installed Windows till's capabilities (the kiosk core's own): the engine runs here (works without the internet), the
 * receipt goes to the Windows queue / the network printer / the USB printer, the drawer opens through it, and the card
 * terminal is the one the cloud configured for this machine (Nayax LAN / USB, SynqPay).
 */
export function windowsTillCaps(svc: { pay: { describe(): { kind: string | null } } }): HostCaps {
  const kind = svc.pay.describe().kind;
  return {
    localEngine: true,
    print: { tcp: true, spooler: true, usb: true, btSpp: false, ble: false, airprint: false, relay: false, lanHost: false, system: false },
    drawer: { viaPrinter: true, devicePort: false },
    channels: { tcpTls: true, https: true, serial: true, usbCdc: true },
    terminals: { nayaxLan: kind === 'nayax_lan', nayaxUsb: kind === 'nayax_usb', synqpayLan: kind === 'synqpay', synqpaySerial: kind === 'synqpay', zcredit: kind === 'zcredit', agamento: false },
    scan: { hid: true, camera: false },
    customerDisplay: false,
    secureStore: true,
    backgroundSync: true,
  };
}

/**
 * The lite profile's hint from the PC itself (§13.4): Windows 7 / 8 / 8.1 (NT 6.x), or 4 GB of
 * memory or less. (No AVX2 is the third sign — the CPU's flags come with the P2 engine probe.)
 */
export function liteHintOf(i: { release: string; totalMemBytes: number }): boolean {
  const major = Number(i.release.split('.')[0]);
  if (Number.isFinite(major) && major > 0 && major < 10) return true;
  return i.totalMemBytes > 0 && i.totalMemBytes <= 4.5 * 1024 ** 3;
}

/* ----------------------------------------------------------- the engine (P2) */

export interface EngineCommandInput {
  /** process.resourcesPath of the installed app: resources/engine/{bin,lib}, resources/engine/till-engine.jar */
  resourcesPath: string;
  /** %APPDATA%\R2M Kiosk\till — the engine's data and its class archive. */
  tillDir: string;
  machineId: string;
  /** The lite profile (§13.4: Windows 7/8.1, ≤ 4 GB, no AVX2): the smallest JVM. */
  lite: boolean;
  /** Java 19+ can make its class archive by itself; Liberica 17 (Windows 7) cannot. */
  javaFeature: number;
}

/**
 * The bundled engine's command line (P2; S0-7 measured these flags): `javaw.exe` from the jlink
 * image inside the installer — nothing installed on the PC, nothing to configure. The class
 * archive (AppCDS) sits in the till's data folder and is made on the first start.
 */
export function engineCommand(i: EngineCommandInput): { exe: string; args: string[] } {
  const engineDir = path.join(i.resourcesPath, 'engine');
  const jsa = path.join(i.tillDir, 'engine.jsa');
  const cds = i.javaFeature >= 19 ? ['-XX:+AutoCreateSharedArchive', `-XX:SharedArchiveFile=${jsa}`] : existsSync(jsa) ? [`-XX:SharedArchiveFile=${jsa}`] : [`-XX:ArchiveClassesAtExit=${jsa}`];
  const heap = i.lite ? ['-Xmx192m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-XX:ReservedCodeCacheSize=48m', '-Xss512k'] : ['-Xmx256m', '-XX:+UseSerialGC'];
  return {
    exe: path.join(engineDir, 'bin', 'javaw.exe'),
    args: [...heap, ...cds, '-Dfile.encoding=UTF-8', `-Dr2m.data=${path.join(i.tillDir, 'machines', i.machineId)}`, '-jar', path.join(engineDir, 'till-engine.jar'), '--stdio'],
  };
}
