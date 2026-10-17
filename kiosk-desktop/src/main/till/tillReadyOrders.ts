/**
 * "הזמנות להכנה" on the Windows till (core/till/readyOrders.ts — pos-android ui/readyorders/ReadyOrdersViewModel.kt and
 * ReadyOrderMenu.kt): the shop's orders in preparation, ready and just handed over, from the cloud
 * (`GET /sync/{m}/kds/ready-orders`, refreshed by the screen every few seconds while it is up — `ready.refresh`), and the
 * till's "מוכן" / "נמסר" / "החזר" on them (`POST /sync/{m}/kds/ready-actions`):
 *
 *  - a tap is sent at once with a new id and shown straight away; no answer: the row keeps it, says it was not sent and
 *    offers "נסו שוב" — the same id, so a tap that did reach the cloud is recorded once — or "ביטול הסימון"; a refusal drops
 *    the tap and says why, in Hebrew, once at the top;
 *  - an order's ⋮ elsewhere on the till (`ready.status` / `ready.menuAction` / `ready.menuRetry`): its id and state from
 *    `GET kds/orders/status`, only what that state allows.
 *
 * The cloud's calls are made outside the engine's queue (a slow line never holds the till); their answers are applied inside
 * it (`later`). Nothing here exists while nobody is signed in or the workflow does not offer it.
 */

import { randomUUID } from 'node:crypto';
import {
  READY_ACTIONS,
  READY_TEXT,
  actionBody,
  actionLabel,
  actionsFor,
  blocksList,
  doneText,
  menuActions,
  outcomeOf,
  parseReadyOrders,
  readyOrdersOffered,
  readyOrdersView,
  refusalCode,
  refusalMessage,
  skewMs,
  statusOf,
  withPending,
  type ReadyAction,
  type ReadyMessage,
  type ReadyOrdersList,
  type ReadyOrdersState,
  type ReadyPending,
} from '../../core/till/readyOrders';
import { displayName } from '../../core/till/staff';
import type { ApiReply } from '../sync/api';
import type { TillContext, TillFeature } from './tillContext';

type Reply = ApiReply<unknown>;

/** The cloud's three calls, apart so a test answers them. */
export interface ReadyOrdersCloud {
  list(): Promise<Reply>;
  action(body: Record<string, unknown>): Promise<Reply>;
  status(source: string, ref: string): Promise<Reply>;
}

export interface TillReadyOrdersDeps {
  cloud?: ReadyOrdersCloud;
  newId?: () => string;
}

const OPS = ['ready.refresh', 'ready.tap', 'ready.retry', 'ready.discard', 'ready.dismiss', 'ready.status', 'ready.menuAction', 'ready.menuRetry'] as const;
const MUTATING = ['ready.tap', 'ready.retry', 'ready.discard', 'ready.dismiss', 'ready.menuAction', 'ready.menuRetry'] as const;

const SOURCES = new Set(['table', 'quick', 'kiosk']);

export class TillReadyOrders implements TillFeature {
  readonly key = 'readyOrders';
  readonly ops = OPS;
  readonly mutating = MUTATING;

  private list: ReadyOrdersList | null = null;
  private loaded = false;
  private offline = false;
  private blocked: ReadyMessage | null = null;
  private notice: ReadyMessage | null = null;
  private skew = 0;
  private readonly pending = new Map<string, ReadyPending>();
  /** Each tap's body, by order id — sent again as is by "נסו שוב". */
  private readonly bodies = new Map<string, Record<string, unknown>>();
  /** Moves on with every confirmed tap: a poll that started before it is stale and dropped. */
  private generation = 0;
  private refreshing: Promise<void> | null = null;
  /** An order's ⋮ tap with no answer, by its ref — "נסו שוב" sends the same body. */
  private readonly unsent = new Map<string, { action: ReadyAction; body: Record<string, unknown> }>();
  private readonly cloud: ReadyOrdersCloud;
  private readonly newId: () => string;
  /** The last work under way (the tests wait for it). */
  lastWork: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly c: TillContext,
    deps: TillReadyOrdersDeps = {},
  ) {
    const svc = c.svc;
    const m = () => svc.machineId;
    const offline = (): Promise<Reply> => Promise.resolve({ kind: 'offline', reason: 'not paired' });
    this.cloud = deps.cloud ?? {
      list: () => (m() ? svc.api.get(`sync/${m()}/kds/ready-orders`, { timeoutMs: 8_000 }) : offline()),
      action: (body) => (m() ? svc.api.post(`sync/${m()}/kds/ready-actions`, body, { timeoutMs: 8_000 }) : offline()),
      status: (source, ref) => (m() ? svc.api.get(`sync/${m()}/kds/orders/status?source=${encodeURIComponent(source)}&refs=${encodeURIComponent(ref)}`, { timeoutMs: 8_000 }) : offline()),
    };
    this.newId = deps.newId ?? (() => randomUUID());
  }

  /** The workflow offers it now (the menu row's first condition). */
  offered(): boolean {
    return readyOrdersOffered(this.c.svc.cloud.parameters() as Record<string, unknown>);
  }

  state(): ReadyOrdersState | undefined {
    if (!this.c.operator() || !this.offered()) return undefined;
    return readyOrdersView({
      list: this.list,
      loaded: this.loaded,
      offline: this.offline,
      blocked: this.blocked,
      pending: this.pending,
      notice: this.notice,
      nowMs: this.c.now(),
      skewMs: this.skew,
    });
  }

  apply(op: string, a: Record<string, unknown>): unknown {
    this.c.signedIn();
    if (!this.offered()) return this.c.refuse('invalid_args');
    switch (op) {
      case 'ready.refresh':
        this.lastWork = this.refresh();
        return undefined;
      case 'ready.tap':
        return this.tap(this.idArg(a.orderId), this.actionArg(a.action));
      case 'ready.retry':
        return this.retry(this.idArg(a.orderId));
      case 'ready.discard':
        return this.discard(this.idArg(a.orderId));
      case 'ready.dismiss':
        this.notice = null;
        this.c.changed();
        return undefined;
      case 'ready.status':
        return this.status(this.sourceArg(a.source), this.idArg(a.ref));
      case 'ready.menuAction':
        return this.menuAction(this.sourceArg(a.source), this.idArg(a.ref), this.actionArg(a.action));
      case 'ready.menuRetry':
        return this.menuRetry(this.idArg(a.ref));
      default:
        return this.c.refuse('invalid_args');
    }
  }

  private idArg(v: unknown): string {
    if (typeof v !== 'string' || v.trim() === '' || v.length > 128) return this.c.refuse('invalid_args');
    return v.trim();
  }

  private actionArg(v: unknown): ReadyAction {
    if (typeof v !== 'string' || !(READY_ACTIONS as readonly string[]).includes(v)) return this.c.refuse('invalid_args');
    return v as ReadyAction;
  }

  private sourceArg(v: unknown): string {
    if (typeof v !== 'string' || !SOURCES.has(v)) return this.c.refuse('invalid_args');
    return v;
  }

  private actor(): string | null {
    const u = this.c.operator();
    return u ? displayName(u) : null;
  }

  /* ------------------------------------------------------------ the list */

  /** The list again (the screen polls it every few seconds; one call at a time). */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const started = this.generation;
    const run: Promise<void> = this.cloud
      .list()
      .catch((e: unknown): Reply => ({ kind: 'offline', reason: String(e) }))
      .then((r) =>
        this.c.later(() => {
          if (this.refreshing === run) this.refreshing = null;
          if (started !== this.generation) return;
          if (r.kind === 'ok') {
            this.list = parseReadyOrders(r.body);
            this.skew = skewMs(this.list.serverTime, this.c.now());
            this.loaded = true;
            this.offline = false;
            this.blocked = null;
          } else if (r.kind === 'refused') {
            const m = refusalMessage(r.status, refusalCode(r.body));
            this.loaded = true;
            this.offline = false;
            this.blocked = blocksList(m) ? m : null;
          } else {
            this.loaded = true;
            this.offline = true;
          }
          this.c.changed();
        }),
      );
    this.refreshing = run;
    return run;
  }

  /* ------------------------------------------------------------ a tap */

  /** A button of a row: sent at once, shown at once. One tap at a time per order. */
  private tap(orderId: string, action: ReadyAction): { pending: boolean } {
    if (this.pending.has(orderId)) return { pending: true };
    const order = this.list?.orders.find((o) => o.orderId === orderId);
    if (!order) return this.c.refuse('invalid_args', READY_TEXT.msg.order_not_found);
    if (!actionsFor(order.group).includes(action)) return this.c.refuse('invalid_args');
    const id = this.newId();
    this.bodies.set(orderId, actionBody(id, action, orderId, this.actor(), new Date(this.c.now()).toISOString()));
    const p: ReadyPending = { id, action, orderId, from: order.group, failed: false };
    this.pending.set(orderId, p);
    this.notice = null;
    this.c.changed();
    this.lastWork = this.send(p);
    return { pending: true };
  }

  /** "נסו שוב": the same body, the same id. */
  private retry(orderId: string): { pending: boolean } {
    const failed = this.pending.get(orderId);
    if (!failed?.failed) return { pending: false };
    const again = { ...failed, failed: false };
    this.pending.set(orderId, again);
    this.c.changed();
    this.lastWork = this.send(again);
    return { pending: true };
  }

  /** "ביטול הסימון": the unsent tap is dropped; the row shows the cloud's state again. */
  private discard(orderId: string): undefined {
    if (this.pending.get(orderId)?.failed !== true) return undefined;
    this.bodies.delete(orderId);
    this.pending.delete(orderId);
    this.c.changed();
    return undefined;
  }

  private send(p: ReadyPending): Promise<void> {
    const body = this.bodies.get(p.orderId);
    if (!body) return Promise.resolve();
    return this.cloud
      .action(body)
      .catch((e: unknown): Reply => ({ kind: 'offline', reason: String(e) }))
      .then((r) =>
        this.c.later((): boolean => {
          if (r.kind === 'ok') {
            const out = outcomeOf(r.body);
            this.confirmed(p, out.kind === 'rejected' ? out.message : null);
            return true;
          }
          if (r.kind === 'refused') {
            this.confirmed(p, refusalMessage(r.status, refusalCode(r.body)));
            return true;
          }
          // Still ours (not discarded meanwhile): kept, with "נסו שוב".
          if (this.pending.get(p.orderId)?.id === p.id) {
            this.pending.set(p.orderId, { ...p, failed: true });
            this.c.changed();
          }
          return false;
        }),
      )
      // Answered: the list again — outside the engine's queue (never awaited inside it).
      .then((answered) => (answered ? this.refresh() : undefined));
  }

  /**
   * The cloud answered: done ([refused] null) — folded into the list shown until the next poll — or refused, and the row
   * goes back to the cloud's state. A poll that started before this answer is dropped.
   */
  private confirmed(p: ReadyPending, refused: ReadyMessage | null): void {
    this.generation += 1;
    this.refreshing = null;
    this.bodies.delete(p.orderId);
    if (refused === null && this.list) this.list = { ...this.list, orders: withPending(this.list.orders, new Map([[p.orderId, p]])) };
    this.pending.delete(p.orderId);
    if (refused !== null) this.notice = refused;
    this.c.changed();
  }

  /* ------------------------------------------------------------ an order's ⋮ */

  /** The ⋮ items of the order [ref] of [source] ("table" / "quick" / "kiosk"): none when the kitchen does not have it. */
  private async status(source: string, ref: string): Promise<{ orderId: string | null; actions: Array<{ action: ReadyAction; label: string }> }> {
    const r = await this.cloud.status(source, ref).catch((e: unknown): Reply => ({ kind: 'offline', reason: String(e) }));
    const target = r.kind === 'ok' ? statusOf(r.body, ref) : null;
    return { orderId: target?.orderId ?? null, actions: menuActions(target).map((a) => ({ action: a, label: actionLabel(a) })) };
  }

  /**
   * A ⋮ item: the order's state read again, then the tap under a new id — done: said in a toast; refused: said why; no
   * answer: `{kind:'offline'}` and "נסו שוב" (`ready.menuRetry`) sends the same id.
   */
  private async menuAction(source: string, ref: string, action: ReadyAction): Promise<{ kind: 'done' | 'refused' | 'offline'; text: string }> {
    const r = await this.cloud.status(source, ref).catch((e: unknown): Reply => ({ kind: 'offline', reason: String(e) }));
    if (r.kind === 'offline') return { kind: 'offline', text: READY_TEXT.offlineBody };
    const target = r.kind === 'ok' ? statusOf(r.body, ref) : null;
    if (!target || !menuActions(target).includes(action)) return { kind: 'refused', text: READY_TEXT.msg.refused };
    const body = actionBody(this.newId(), action, target.orderId, this.actor(), new Date(this.c.now()).toISOString());
    return this.sendMenu(ref, action, body);
  }

  private async menuRetry(ref: string): Promise<{ kind: 'done' | 'refused' | 'offline'; text: string }> {
    const u = this.unsent.get(ref);
    if (!u) return { kind: 'refused', text: READY_TEXT.msg.refused };
    return this.sendMenu(ref, u.action, u.body);
  }

  private async sendMenu(ref: string, action: ReadyAction, body: Record<string, unknown>): Promise<{ kind: 'done' | 'refused' | 'offline'; text: string }> {
    const r = await this.cloud.action(body).catch((e: unknown): Reply => ({ kind: 'offline', reason: String(e) }));
    if (r.kind === 'offline') {
      this.unsent.set(ref, { action, body });
      return { kind: 'offline', text: READY_TEXT.offlineBody };
    }
    this.unsent.delete(ref);
    const message = r.kind === 'ok' ? (() => {
      const out = outcomeOf(r.body);
      return out.kind === 'rejected' ? out.message : null;
    })() : refusalMessage(r.status, refusalCode(r.body));
    if (message === null) {
      this.c.toast(doneText(action), 'ok');
      if (this.list) this.lastWork = this.refresh();
      return { kind: 'done', text: doneText(action) };
    }
    return { kind: 'refused', text: READY_TEXT.msg[message] };
  }
}
