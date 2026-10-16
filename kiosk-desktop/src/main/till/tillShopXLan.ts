/**
 * "דוח X סניפי" over the LAN — this till's part in the main till's report (core/till/shopXLan.ts; pos-android
 * LanShopCloseClient.pollOnce / answerShopX): every 3 s the shop-close board on the shop's print host is asked
 * (`GET /shop-close/pending`, the shop's print secret, connect 1.2 s / read 4 s) — only while the cloud's shop-Z history
 * lists this till as a participant closing through the cloud (re-read every 10 minutes); a live round's ask is answered once,
 * up to three times (`POST /shop-x/v1/part`, a 2xx or a 409 ends it), with this till's figures since its last Z.
 *
 * Electron-free; the LAN call and the clock are injectable.
 */

import { ownShopXSection, pendingPath, SHOP_X_PART_PATH, shopXAskOf, shopXPart, answersShopXOverLan, type TillFigures } from '../../core/till/shopXLan';
import { lanCall as defaultLanCall, type LanCall } from '../kitchen/kitchenNet';
import type { TillContext } from './tillContext';

const POLL_MS = 3_000;
const HISTORY_EVERY_MS = 10 * 60_000;

export class TillShopXLan {
  private timer: NodeJS.Timeout | null = null;
  private historyAt = 0;
  private listed = false;
  private readonly answered = new Set<string>();
  private polling = false;
  private readonly lan: LanCall;

  constructor(
    private readonly c: TillContext,
    private readonly o: {
      /** The open shift's interim figures (the engine's X), or null. */
      openShiftTill(): { id: string; businessDate: string | null; till: TillFigures } | null;
      lanCall?: LanCall;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {
    this.lan = o.lanCall ?? defaultLanCall;
  }

  start() {
    this.timer = setInterval(() => void this.pollOnce().catch(() => undefined), POLL_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The shop's print host on the LAN (never this device), with the shop's secret. */
  private target(): { address: string; port: number; secret: string } | null {
    const svc = this.c.svc;
    const config = svc.kitchen.config();
    const h = config.printHost;
    if (!h || h.isSelf || h.offLan || !h.lanAddress || !config.printSecret || !svc.kitchen.lanReachable()) return null;
    return { address: h.lanAddress, port: h.port, secret: config.printSecret };
  }

  private caller() {
    const svc = this.c.svc;
    const m = svc.machineId;
    const me = svc.cloud.machine();
    return m ? { id: m, name: me?.machineName ?? (me?.posNumber ? `#${me.posNumber}` : null) } : null;
  }

  /** Whether the cloud lists this till in a local shop Z, closing through the cloud (re-read every 10 minutes). */
  private async listedNow(): Promise<boolean> {
    const svc = this.c.svc;
    const m = svc.machineId;
    if (!m) return false;
    if (this.c.now() - this.historyAt < HISTORY_EVERY_MS) return this.listed;
    this.historyAt = this.c.now();
    const r = await svc.api.get(`sync/${m}/shop-z/history?days=1`, { timeoutMs: 15_000 });
    if (r.kind === 'ok') this.listed = answersShopXOverLan(r.body, m);
    return this.listed;
  }

  /** One look at the board; an ask answered. */
  async pollOnce(): Promise<void> {
    const svc = this.c.svc;
    if (this.polling || !svc.paired || !svc.fiscal || svc.isKiosk()) return;
    const beat = svc.cloud.heartbeat();
    if (beat.independentTill || beat.zMode === 'till') return;
    const t = this.target();
    const m = svc.machineId;
    if (!t || !m) return;
    this.polling = true;
    try {
      if (!(await this.listedNow())) return;
      const me = svc.cloud.machine();
      const reply = await this.lan(t, t.secret, 'GET', pendingPath(m, me?.posNumber ?? null, me?.machineName ?? null), null, { caller: this.caller(), connectMs: 1_200, readMs: 4_000 }).catch(() => null);
      if (!reply || reply.status !== 200) return;
      const ask = shopXAskOf(reply.body);
      if (ask && !this.answered.has(ask)) {
        this.answered.add(ask);
        while (this.answered.size > 20) this.answered.delete(this.answered.values().next().value as string);
        await this.answer(t, ask, m);
      }
    } finally {
      this.polling = false;
    }
  }

  /** This till's part: the closed shifts no Z took, and the open shift's interim figures. Never stored. */
  ownPart(): Record<string, unknown> {
    const svc = this.c.svc;
    const me = svc.cloud.machine();
    const closed = svc.ledger
      .unreportedShifts()
      .filter((s) => s.z_number === null)
      .map((s) => {
        let till: TillFigures = {};
        try {
          till = ((JSON.parse(s.close_payload ?? 'null') as { till?: TillFigures } | null)?.till ?? {}) as TillFigures;
        } catch {
          till = {};
        }
        return { id: s.id, businessDate: s.business_date, till };
      });
    const open = this.o.openShiftTill();
    return ownShopXSection({ machineId: svc.machineId!, posNumber: me?.posNumber ?? null, machineName: me?.machineName ?? null }, open ? [...closed, open] : closed);
  }

  private async answer(t: { address: string; port: number; secret: string }, requestId: string, machineId: string): Promise<void> {
    let section: Record<string, unknown> | null = null;
    let error: string | null = null;
    try {
      section = this.ownPart();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const body = shopXPart(requestId, machineId, section, error ?? (section ? null : 'unreadable'));
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < 3; i++) {
      const r = await this.lan(t, t.secret, 'POST', SHOP_X_PART_PATH, body, { caller: this.caller(), connectMs: 1_500, readMs: 6_000 }).catch(() => null);
      if (r && ((r.status >= 200 && r.status < 300) || r.status === 409)) {
        this.c.log(`shop X: this till's part to the main till (${r.status})`);
        return;
      }
      if (i < 2) await sleep(1_000);
    }
    this.c.log('shop X: the main till did not take this till\'s part');
  }
}
