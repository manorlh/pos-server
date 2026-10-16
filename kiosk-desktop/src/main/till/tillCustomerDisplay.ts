/**
 * "מסך לקוח" — the till's side (pos-android data/repo/CustomerDisplayRepository.kt, CustomerDisplayGate.kt,
 * ui/customerdisplay/CustomerDisplayFeed.kt; core/till/customerDisplay.ts): the cloud's settings (`GET /sync/{m}/customer-display`,
 * ETag, every `poll.configSec` while they matter), the screen's state from every state the engine shows (through the bus:
 * filtered, the thanks held), and whether the Windows shell should show it on a second screen
 * (main/shell/customerDisplayWindow.ts). The heartbeat says whether a screen shows it (`customerDisplayMedia.screen`).
 *
 * Electron-free.
 */

import { CustomerDisplayBus, IDLE_STATE, basketOf, displayConfigOf, screenOf, showsOnSecondScreen, type CdState, type DisplayConfig } from '../../core/till/customerDisplay';
import type { TillState } from '../../shared/till/protocol';
import type { TillContext } from './tillContext';

const CONFIG_KEY = 'till.customerDisplay';

export interface CustomerDisplayFrame {
  /** Show it on a second screen (a till, `enabled`). */
  wanted: boolean;
  config: DisplayConfig['config'];
  branding: DisplayConfig['branding'];
  state: CdState;
}

export class TillCustomerDisplay {
  private config: DisplayConfig | null;
  private etag: string | null = null;
  private pulledAt = 0;
  private readonly bus: CustomerDisplayBus;
  private readonly listeners = new Set<(f: CustomerDisplayFrame) => void>();
  private screenPresent = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly c: TillContext) {
    this.config = displayConfigOf(c.svc.kv.getJson(CONFIG_KEY));
    this.bus = new CustomerDisplayBus(() => this.emit(), () => this.c.now());
    this.applyConfig();
  }

  start() {
    this.c.svc.setHeartbeatPart('customerDisplayMedia', () => ({ screen: this.screenPresent && this.wanted(), held: [] }));
    const tick = () => void this.pull(false).catch(() => undefined);
    this.timer = setInterval(tick, 30_000);
    this.timer.unref?.();
    setTimeout(tick, 5_000).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.stop();
    this.c.svc.setHeartbeatPart('customerDisplayMedia', null);
  }

  wanted(): boolean {
    return this.c.svc.fiscal && !this.c.svc.isKiosk() && showsOnSecondScreen(this.config);
  }

  /** The shell has a second screen showing it (or not): the heartbeat says so. */
  setScreenPresent(present: boolean) {
    this.screenPresent = present;
  }

  private applyConfig() {
    this.bus.show = this.config?.config.show ?? this.bus.show;
    this.bus.thanksMs = (this.config?.config.thanksSec ?? 6) * 1000;
  }

  /** The settings (ETag): every `configSec`, or now. */
  async pull(force: boolean): Promise<void> {
    const m = this.c.svc.machineId;
    if (!m || !this.c.svc.paired) return;
    const every = (this.config?.configSec ?? 120) * 1000;
    if (!force && this.c.now() - this.pulledAt < every) return;
    this.pulledAt = this.c.now();
    const r = await this.c.svc.api.get<Record<string, unknown>>(`sync/${m}/customer-display`, { headers: this.etag ? { 'If-None-Match': this.etag } : {}, timeoutMs: 15_000 });
    if (r.kind !== 'ok' || r.status === 304) return;
    const next = displayConfigOf(r.body);
    if (!next) return;
    this.etag = r.headers.get('etag');
    this.c.svc.kv.setJson(CONFIG_KEY, r.body);
    const was = this.wanted();
    this.config = next;
    this.applyConfig();
    if (was !== this.wanted()) this.c.log(`customer display: ${this.wanted() ? 'on' : 'off'}`);
    this.emit();
  }

  /** Every state the engine shows: the screen's, through the bus (nothing for a till that shows none). */
  publish(state: TillState, customerNotice: string | null) {
    if (!this.wanted()) {
      if (this.bus.current.phase !== 'idle') this.bus.publish(IDLE_STATE);
      return;
    }
    const signedIn = !!state.session.cashier && !state.session.locked;
    this.bus.publish(signedIn ? screenOf(basketOf(state.sell), state.checkout, customerNotice) : IDLE_STATE);
  }

  frame(): CustomerDisplayFrame {
    const cfg = this.config;
    return {
      wanted: this.wanted(),
      config: cfg?.config ?? displayConfigOf({})!.config,
      branding: cfg?.branding ?? { shopName: this.c.svc.cloud.machine()?.shopName ?? '', logoUrl: '', primaryColor: null },
      state: this.bus.current,
    };
  }

  onChange(fn: (f: CustomerDisplayFrame) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const f = this.frame();
    for (const fn of this.listeners) {
      try {
        fn(f);
      } catch {
        /* a listener's own trouble */
      }
    }
  }
}
