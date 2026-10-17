/**
 * "התראות" on the Windows till (core/till/tillAlerts.ts — pos-android data/repo/TillAlertCenter.kt, ui/alerts/TillAlertsUi.kt,
 * data/repo/KioskAlertsRuntime.kt `KioskTillAlertsRepository`): every couple of seconds what each source says becomes one
 * list, its notice is told when one is due (a toast and a sound — never a modal, never over a payment), and the list's
 * actions:
 *
 *  - the kiosks' alerts routed to this till (`GET /sync/{m}/kiosk/alerts`, every 10 s; an older cloud's 404 — none), "ראיתי"
 *    telling the cloud "הבנתי" for those it keeps (`POST …/kiosk/alerts/{id}/ack`), "בדרך" on a help request;
 *  - this till's kitchen bons that did not print (the device's kitchen queue), with "תור הדפסה";
 *  - the change a cash station owes a customer (TillCash's list), with "שולם ללקוח" (the engine's own `owed.pay`);
 *  - the printers this till prints for the others, when the engine can say one is down (a dep; none on Windows today).
 *
 * What was told and seen is kept on the disk (`till.alertsBook`), so a restart tells nothing old again.
 */

import type { CashOwedNotice } from '../../core/till/cashOwed';
import type { KitchenJob } from '../../core/kitchen/queue';
import { parameterOn } from '../sync/cloud';
import {
  ackOnSeen,
  alertStep,
  alertsView,
  bookToJson,
  fromCashOwed,
  fromKiosk,
  fromPrintServer,
  kitchenItems,
  markSeen,
  noticeText,
  parseBook,
  parseKioskTillAlerts,
  problemKey,
  soundOfAll,
  visibleTo,
  type KioskTillAlert,
  type TillActivity,
  type TillAlertBook,
  type TillAlertItem,
  type TillAlertSource,
  type TillAlertsState,
} from '../../core/till/tillAlerts';
import { displayName } from '../../core/till/staff';
import type { ApiReply } from '../sync/api';
import type { TillContext, TillFeature } from './tillContext';

type Reply = ApiReply<unknown>;

export const ALERTS_BOOK_KEY = 'till.alertsBook';
/** How often the sources are read: a notice held for a payment shows within this of its end (Android STEP_MS 1.5 s). */
export const ALERTS_STEP_MS = 1_500;
/** The kiosks' alerts from the cloud (Android FETCH_EVERY_MS). */
export const KIOSK_ALERTS_FETCH_MS = 10_000;

export interface KioskAlertsCloud {
  alerts(): Promise<Reply>;
  ack(id: string, posUserId: string | null, posUserName: string | null): Promise<Reply>;
}

/** What the engine hands the alerts (each optional: a source it does not give is simply not there). */
export interface TillAlertsDeps {
  /** The cash stations' change owed routed here (TillCash's `owed`: its items, and whether the cloud has answered). */
  owed?(): { items: readonly CashOwedNotice[]; loaded: boolean } | null;
  /** The kitchen tickets that need a person (default: the device's kitchen queue, `svc.kitchen.attention()`). */
  kitchenJobs?(): readonly KitchenJob[] | null;
  /** The printers this till prints for the others that do not answer; null: not known (Windows has no watch of them yet). */
  printServerDown?(): Array<{ id: string; name: string }> | null;
  /** What the till is busy with (default: a payment when `paying()`, else working). */
  activity?(): TillActivity;
  /** The kiosks this till controls (default: the cloud's kiosk/sync `controls`). */
  controlledKiosks?(): string[];
  cloud?: KioskAlertsCloud;
  /** Runs the steps by itself (default true; the tests step by hand). */
  timers?: boolean;
}

const OPS = ['alerts.refresh', 'alerts.seen', 'alerts.seenAll', 'alerts.onMyWay', 'alerts.pay'] as const;
const MUTATING = ['alerts.seen', 'alerts.seenAll', 'alerts.onMyWay', 'alerts.pay'] as const;

export class TillAlertsService implements TillFeature {
  readonly key = 'alerts';
  readonly ops = OPS;
  readonly mutating = MUTATING;

  private book: TillAlertBook;
  private items: TillAlertItem[] = [];
  private activityNow: TillActivity = 'idle';
  private kiosk: KioskTillAlert[] = [];
  private kioskLoaded = false;
  private kioskById = new Map<string, KioskTillAlert>();
  private lastFetchAt: number | null = null;
  private fetching: Promise<void> | null = null;
  private beep: TillAlertsState['beep'] = null;
  private beepSeq = 0;
  private signature = '';
  private timers: NodeJS.Timeout[] = [];
  private readonly cloud: KioskAlertsCloud;
  /** The last work under way (the tests wait for it). */
  lastWork: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly c: TillContext,
    private readonly d: TillAlertsDeps = {},
  ) {
    const svc = c.svc;
    const m = () => svc.machineId;
    const offline = (): Promise<Reply> => Promise.resolve({ kind: 'offline', reason: 'not paired' });
    this.cloud = d.cloud ?? {
      alerts: () => (m() ? svc.api.get(`sync/${m()}/kiosk/alerts`, { timeoutMs: 10_000 }) : offline()),
      ack: (id, posUserId, posUserName) => (m() ? svc.api.post(`sync/${m()}/kiosk/alerts/${encodeURIComponent(id)}/ack`, { posUserId, posUserName }, { timeoutMs: 10_000 }) : offline()),
    };
    this.book = parseBook(svc.kv.get(ALERTS_BOOK_KEY));
  }

  /** The engine starts it once the till is up (the step every 1.5 s, the kiosks' alerts every 10 s). */
  start(): void {
    if (this.d.timers === false || this.timers.length > 0) return;
    const tick = () => void this.c.later(() => this.step()).catch(() => undefined);
    this.timers.push(setInterval(tick, ALERTS_STEP_MS), setTimeout(tick, 1_000));
    for (const t of this.timers) t.unref?.();
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /* ------------------------------------------------------------ the state */

  /** The role the kiosks' alerts read: "managers" are those whose role lets them control a kiosk alone. */
  private role(): string | null {
    const u = this.c.operator();
    if (!u) return null;
    return this.c.decide('KIOSK_CONTROL') === 'allowed' ? 'shop_manager' : 'cashier';
  }

  private visible(): TillAlertItem[] {
    const role = this.role();
    return this.items.filter((i) => visibleTo(i, role));
  }

  private controlled(): Set<string> {
    if (this.d.controlledKiosks) return new Set(this.d.controlledKiosks());
    const controls = this.c.svc.cloud.kioskSnapshot()?.controls;
    if (!Array.isArray(controls)) return new Set();
    return new Set(
      controls
        .map((k) => (k && typeof k === 'object' ? (k as Record<string, unknown>).machineId : null))
        .filter((x): x is string => typeof x === 'string'),
    );
  }

  state(): TillAlertsState | undefined {
    if (!this.c.operator()) return undefined;
    return alertsView({ book: this.book, visible: this.visible(), activity: this.activityNow, nowMs: this.c.now(), kiosks: this.kioskById, controlled: this.controlled(), beep: this.beep });
  }

  /* ------------------------------------------------------------ the sources */

  private isTill(): boolean {
    const svc = this.c.svc;
    return svc.paired && svc.fiscal && !svc.isKiosk();
  }

  /** The kiosks' alerts again, when due (or now): outside the engine's queue; the answer applied inside it. */
  fetchKioskAlerts(force = false): Promise<void> {
    const now = this.c.now();
    if (this.fetching) return this.fetching;
    if (!force && this.lastFetchAt !== null && now - this.lastFetchAt < KIOSK_ALERTS_FETCH_MS) return Promise.resolve();
    if (!this.isTill()) return Promise.resolve();
    this.lastFetchAt = now;
    const run: Promise<void> = this.cloud
      .alerts()
      .catch((e: unknown): Reply => ({ kind: 'offline', reason: String(e) }))
      .then((r) =>
        this.c.later(() => {
          if (this.fetching === run) this.fetching = null;
          if (r.kind === 'ok') {
            this.setKiosk(parseKioskTillAlerts(r.body));
            this.kioskLoaded = true;
          } else if (r.kind === 'refused' && r.status === 404) {
            // An older cloud without kiosk alerts.
            this.setKiosk([]);
            this.kioskLoaded = true;
          }
          // Offline: the last known stays.
          this.step();
        }),
      );
    this.fetching = run;
    return run;
  }

  private setKiosk(list: KioskTillAlert[]) {
    this.kiosk = list;
    this.kioskById = new Map(list.map((a) => [a.id, a]));
  }

  /** What every source says now, and which of them have answered since the till started. */
  private gather(): { items: TillAlertItem[]; reported: Set<TillAlertSource> } {
    const items: TillAlertItem[] = [];
    const reported = new Set<TillAlertSource>();
    items.push(...this.kiosk.map(fromKiosk));
    if (this.kioskLoaded) reported.add('kiosk');
    try {
      const down = this.d.printServerDown?.() ?? null;
      if (down) {
        items.push(...down.map(fromPrintServer));
        reported.add('print_server');
      }
    } catch {
      /* a source's own trouble */
    }
    try {
      const jobs = this.d.kitchenJobs ? this.d.kitchenJobs() : this.c.svc.kitchen.attention();
      if (jobs) {
        items.push(...kitchenItems(jobs));
        reported.add('kitchen');
      }
    } catch {
      /* a source's own trouble */
    }
    try {
      const owed = this.d.owed?.() ?? null;
      if (owed) {
        items.push(...owed.items.map((n) => fromCashOwed(n)));
        if (owed.loaded) reported.add('cash');
      }
    } catch {
      /* a source's own trouble */
    }
    return { items, reported };
  }

  private activity(): TillActivity {
    if (this.d.activity) return this.d.activity();
    return this.c.paying() ? 'payment' : 'working';
  }

  /** One step (TillAlertCenter.update): the book kept, the notice told. Call inside the engine's queue. */
  step(): TillAlertItem[] {
    void this.fetchKioskAlerts();
    const { items, reported } = this.gather();
    this.items = items;
    this.activityNow = this.activity();
    const s = alertStep(this.book, items, reported, this.c.now(), this.activityNow, this.role());
    this.keep(s.book);
    if (s.notify.length > 0) {
      this.c.toast(noticeText(s.notify), s.notify.some((i) => i.severity === 'urgent') ? 'error' : 'info');
      const sound = soundOfAll(s.notify);
      const batteryOff = (sound === 'battery' || sound === 'battery_critical') && !this.batterySoundOn();
      if (sound !== 'none' && !batteryOff) this.beep = { seq: ++this.beepSeq, sound };
    }
    const sig = `${this.activityNow}|${bookToJson(this.book)}|${items.map((i) => `${problemKey(i)}:${i.text}:${i.ping}`).join(',')}|${this.beepSeq}|${this.kiosk.map((a) => a.acknowledgedBy ?? '').join(',')}`;
    if (sig !== this.signature || s.notify.length > 0) {
      this.signature = sig;
      this.c.changed();
    }
    return s.notify;
  }

  /** `lowBatterySound` (on by default): a device's low battery sounds its alarm. */
  private batterySoundOn(): boolean {
    const v = (this.c.svc.cloud.parameters() as Record<string, unknown>).lowBatterySound;
    return v === undefined || v === null ? true : parameterOn(v);
  }

  private keep(book: TillAlertBook) {
    const before = bookToJson(this.book);
    const after = bookToJson(book);
    this.book = book;
    if (before !== after) {
      try {
        this.c.svc.kv.set(ALERTS_BOOK_KEY, after);
      } catch {
        /* kept in memory */
      }
    }
  }

  /* ------------------------------------------------------------ the ops */

  apply(op: string, a: Record<string, unknown>): unknown {
    this.c.signedIn();
    switch (op) {
      case 'alerts.refresh':
        this.lastWork = this.fetchKioskAlerts(true);
        this.step();
        return undefined;
      case 'alerts.seen':
        return this.seen(this.keysArg(a.keys));
      case 'alerts.seenAll':
        return this.seen(this.visible().map(problemKey));
      case 'alerts.onMyWay':
        return this.onMyWay(this.keyArg(a.key));
      case 'alerts.pay':
        return this.pay(this.keyArg(a.key));
      default:
        return this.c.refuse('invalid_args');
    }
  }

  private keyArg(v: unknown): string {
    if (typeof v !== 'string' || v === '' || v.length > 512) return this.c.refuse('invalid_args');
    return v;
  }

  private keysArg(v: unknown): string[] {
    if (!Array.isArray(v) || v.length === 0 || v.length > 200) return this.c.refuse('invalid_args');
    return v.map((k) => this.keyArg(k));
  }

  private find(key: string): TillAlertItem {
    const i = this.visible().find((x) => problemKey(x) === key);
    return i ?? this.c.refuse('invalid_args');
  }

  private who(): { id: string | null; name: string | null } {
    const u = this.c.operator();
    return { id: u?.id ?? null, name: u ? displayName(u) : null };
  }

  /** "ראיתי" on these: kept on the till, and the cloud hears "הבנתי" for the kiosks' that it keeps. */
  private seen(keys: string[]): { seen: number } {
    const set = new Set(keys);
    const items = this.visible().filter((i) => set.has(problemKey(i)));
    this.keep(markSeen(this.book, items, this.c.now()));
    const due = items
      .map((i) => (i.source === 'kiosk' ? this.kioskById.get(i.id) : undefined))
      .filter((k): k is KioskTillAlert => !!k && ackOnSeen(k));
    if (due.length > 0) {
      const who = this.who();
      this.lastWork = Promise.all(due.map((k) => this.cloud.ack(k.id, who.id, who.name).catch(() => undefined))).then(() => this.fetchKioskAlerts(true));
    }
    this.c.changed();
    return { seen: items.length };
  }

  /** "בדרך" on a help request: the kiosk tells its customer "הצוות בדרך". */
  private onMyWay(key: string): undefined {
    const item = this.find(key);
    const k = item.source === 'kiosk' ? this.kioskById.get(item.id) : undefined;
    if (!k || k.kind !== 'help') return this.c.refuse('invalid_args');
    this.keep(markSeen(this.book, [item], this.c.now()));
    this.setKiosk(this.kiosk.filter((x) => x.id !== k.id));
    this.items = this.items.filter((x) => problemKey(x) !== key);
    const who = this.who();
    this.lastWork = this.cloud
      .ack(k.id, who.id, who.name)
      .catch(() => undefined)
      .then(() => this.fetchKioskAlerts(true));
    this.c.changed();
    return undefined;
  }

  /** "שולם ללקוח": the engine's own `owed.pay` (the drawer's rules, a manager's code, the cloud first, then the cash out). */
  private pay(key: string): Promise<unknown> {
    const item = this.find(key);
    if (item.source !== 'cash') return this.c.refuse('invalid_args');
    return this.c.run('owed.pay', { id: item.id });
  }
}
