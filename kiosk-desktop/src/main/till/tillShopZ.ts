/**
 * "סגירת Z סניפי" from the Windows till as the shop's master (core/till/shopZRun.ts; pos-android ui/reports/ShopZScreen.kt
 * `ShopZViewModel`): the cloud's run, driven with the till's own token —
 *
 *  - `GET sync/{m}/shop-z` (`?scope=area` when the operator picked the point of sale): the tills, the shop's rule, a run under
 *    way; refreshed every 10 s while the screen is open, for 5 minutes after the last touch — each read keeps the shop's tills
 *    on the cloud's fast beat, so the close reaches them in seconds;
 *  - `POST sync/{m}/shop-z` `{confirmOpenTills, posUserName, scope?}`: close every till and start the Z (a 409 asks the typed
 *    "סגור", or names the tills the shop's rule wants closed first, or the open tables, or "Z על 0");
 *  - the master's own shift is closed HERE, at once, from the run's answer (its item's `id` is the close request): no heartbeat
 *    round trip to this same till; asked again on each poll while a payment holds it;
 *  - `GET sync/{m}/shop-z/runs/{id}` every 2 s while the run waits — each poll is the cloud verifying again;
 *    `POST …/proceed` after the typed "סגור": build without the tills not confirmed;
 *  - the Z built: its summary printed here once (`GET sync/{m}/z-reports/{id}/print-document?part=summary`), then "print each
 *    till's detail apart?" — each its own strip (`?till=<machineId>`), in till-number order, a cancel between them.
 *
 * The Z is numbered by the cloud only (strictly in sequence). In local mode (the shop's Z numbered by its main till on the LAN,
 * pos-server SPEC_INDEPENDENT_TILL §8) the Windows till does not produce it: the screen says so and offers no start (the cloud
 * refuses its own run there as well, 409 `shop_z_producer_local`).
 *
 * No permission of the role (Android DeniedMenu: "סגירת Z סניפי" is the cloud's). Electron-free; the timers can be turned off
 * (tests call `pollOnce` / `idleTick`).
 */

import { HELD_TEXT, allowCloseWithHeldSales, heldSalesGate } from '../../core/till/heldSales';
import {
  SHOP_Z_LIVE,
  SHOP_Z_TEXT,
  cloudPrintDocumentOf,
  cloudZOps,
  emptyShopZState,
  localMasterOf,
  ownPendingItem,
  paramsShowShopZ,
  printInSequence,
  printSequenceMessage,
  runOf,
  runStartOnTillClock,
  shopZMenuShown,
  shopZShopOffered,
  shopZStartScope,
  shopZStatusPath,
  startRefusal,
  statusOf,
  describeRefusal,
  tillLabel,
  tillsInOrder,
  withoutFailedPaymentSections,
  type CloudPrintDocument,
  type CloudZTill,
  type ShopZRun,
  type ShopZState,
} from '../../core/till/shopZRun';
import type { ZDoc } from '../../core/printDocs';
import { displayName } from '../../core/till/staff';
import { HeldStore } from './heldStore';
import type { TillContext, TillFeature } from './tillContext';

export const SHOP_Z_OPS = [
  'shopZ.open',
  'shopZ.refresh',
  'shopZ.leave',
  'shopZ.scope',
  'shopZ.start',
  'shopZ.proceed',
  'shopZ.dismiss',
  'shopZ.printSummary',
  'shopZ.details',
  'shopZ.printDetails',
  'shopZ.cancelDetails',
] as const;

export const SHOP_Z_MUTATING = ['shopZ.start', 'shopZ.proceed', 'shopZ.printSummary', 'shopZ.printDetails'] as const;

/** The master polls a run this often while it waits. */
export const RUN_POLL_MS = 2_000;
/** The tills' states are refreshed this often while the screen is open… */
export const IDLE_REFRESH_MS = 10_000;
/** …for this long after the last touch. */
export const IDLE_REFRESH_FOR_MS = 5 * 60_000;
/** After this till closed its own shift: looked again this soon, rather than at the next tick. */
const OWN_CLOSE_LOOK_MS = 800;

/** What closing this till's own shift for its item did. */
export type OwnCloseOutcome = 'closed' | 'already' | 'none' | 'pending';

export interface TillShopZOptions {
  /**
   * This till's own shift closed for its item of the run (Android CloseShiftCoordinator.handleCloudRequest(byThisTill =
   * true)): unattended, the close carrying `requestId` as its `closeRequestId` (the cloud ties it to the run's item), the
   * outbox flushed at once. The engine's own close (drawer and vouchers on the X) belongs here; without it, the ledger's
   * unattended close.
   */
  closeOwnShift?(input: { requestId: string; closeShiftId: string | null; closer: { id: string; name: string } }): Promise<OwnCloseOutcome> | OwnCloseOutcome;
  /** The engine's held-sales gate (refuses `held_sales`); without it the same rule over the held sales kept in the kv. */
  heldGate?(keepHeld: boolean): void;
  /** A page on the report printer; without it the receipt printer's queue. Returns the job id. */
  print?(doc: ZDoc, refId: string, title: string): string | null;
  /** false: no timers (tests drive `pollOnce` / `idleTick`). */
  timers?: boolean;
}

export class TillShopZ implements TillFeature {
  readonly key = 'shopZ';
  readonly ops = SHOP_Z_OPS;
  readonly mutating = SHOP_Z_MUTATING;

  private s: ShopZState = emptyShopZState();
  private opened = false;
  private screenOpen = false;
  private lastTouchAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollingRun: string | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private detailsCancelRequested = false;
  /** Close requests of this till already acted on here, so a poll does not repeat one. */
  private readonly selfClosed = new Set<string>();
  private inFlight = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private readonly c: TillContext,
    private readonly o: TillShopZOptions = {},
  ) {}

  /* ------------------------------------------------------------------ facts for the menu */

  /** The ☰ row "סגירת Z סניפי" (core shopZMenuShown): `hidden` are the till's `hiddenMenuItems`. */
  menuShown(hidden: readonly string[]): boolean {
    const beat = this.c.svc.cloud.heartbeat();
    return shopZMenuShown({ zMode: beat.zMode, independent: beat.independentTill === true, params: this.c.svc.cloud.parameters(), hidden });
  }

  /* ------------------------------------------------------------------ TillFeature */

  state(): ShopZState | undefined {
    if (!this.opened || !this.c.operator()) return undefined;
    return this.s;
  }

  apply(op: string, a: Record<string, unknown>): unknown {
    this.c.signedIn();
    this.touch();
    switch (op) {
      case 'shopZ.open':
        return this.open();
      case 'shopZ.refresh':
        return this.refresh();
      case 'shopZ.leave':
        return this.leave();
      case 'shopZ.scope':
        if (typeof a.area !== 'boolean') return this.c.refuse('invalid_args');
        return this.chooseScope(a.area);
      case 'shopZ.start':
        if ((a.confirm !== undefined && typeof a.confirm !== 'boolean') || (a.keepHeld !== undefined && typeof a.keepHeld !== 'boolean')) return this.c.refuse('invalid_args');
        return this.start(a.confirm === true, a.keepHeld === true);
      case 'shopZ.proceed':
        return this.proceed();
      case 'shopZ.dismiss':
        this.set({ needsConfirm: null, blockedBy: null });
        return { ok: true };
      case 'shopZ.printSummary':
        return this.printSummaryOp();
      case 'shopZ.details':
        if (a.answer !== 'all' && a.answer !== 'choose' && a.answer !== 'no') return this.c.refuse('invalid_args');
        return this.answerDetails(a.answer);
      case 'shopZ.printDetails': {
        const ids = a.machineIds;
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200 || !ids.every((x) => typeof x === 'string' && x.length > 0)) return this.c.refuse('invalid_args');
        const tills = this.s.zTills.filter((t) => (ids as string[]).includes(t.machineId));
        if (tills.length === 0) return this.c.refuse('invalid_args');
        void this.track(this.printDetails(tills));
        return { ok: true };
      }
      case 'shopZ.cancelDetails':
        this.detailsCancelRequested = true;
        this.set({ cancelling: true });
        return { ok: true };
      default:
        return this.c.refuse('unknown_op');
    }
  }

  stop() {
    this.stopped = true;
    this.stopPolling();
    this.stopIdle();
  }

  /** Every piece of work started so far, settled (tests). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight]);
  }

  /* ------------------------------------------------------------------ the screen */

  private set(patch: Partial<ShopZState>) {
    this.s = { ...this.s, ...patch };
    this.c.changed();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    const done = () => this.inFlight.delete(p);
    p.then(done, done);
    return p;
  }

  private touch() {
    this.lastTouchAt = this.c.now();
    if (this.screenOpen && !this.idleTimer) this.startIdle();
  }

  private machine(): string | null {
    return this.c.svc.machineId ?? null;
  }

  private operatorName(): string | null {
    const u = this.c.operator();
    return u ? displayName(u) : null;
  }

  private offline() {
    this.set({ loading: false, busy: false, error: SHOP_Z_TEXT.offline });
  }

  private open() {
    const beat = this.c.svc.cloud.heartbeat();
    // Never on a till that makes its own Z, nor an independent one (the menu shows it there neither).
    if (beat.independentTill === true || (beat.zMode ?? '').trim().toLowerCase() === 'till' || !paramsShowShopZ(this.c.svc.cloud.parameters())) {
      return this.c.refuse('permission_denied', SHOP_Z_TEXT.notMaster);
    }
    if (!this.opened) {
      this.opened = true;
      this.s = emptyShopZState();
    }
    this.screenOpen = true;
    this.touch();
    this.c.changed();
    void this.track(this.checkLocal());
    void this.track(this.load(false));
    return { ok: true };
  }

  private refresh() {
    void this.track(this.load(false));
    return { ok: true };
  }

  /** The screen went away: the tills stop refreshing (the shop's tills drop back to their beat). A run is still watched. */
  private leave() {
    this.screenOpen = false;
    this.stopIdle();
    return { ok: true };
  }

  /** "כל הסניף" / "<נקודה>": asked again for the scope picked — not while a run is under way. */
  private chooseScope(area: boolean) {
    if (this.s.wantArea === area || (this.s.run && SHOP_Z_LIVE.has(this.s.run.status)) || this.s.busy) return { ok: false };
    this.set({ wantArea: area, loading: true, error: null, needsConfirm: null, blockedBy: null });
    void this.track(this.load(false));
    return { ok: true };
  }

  /** Local mode, with this till the main till: no start here (the cloud's history says so; unreadable — not local). */
  private async checkLocal(): Promise<void> {
    const m = this.machine();
    if (!m) return;
    const r = await this.c.svc.api.get(`sync/${m}/shop-z/history?days=1`, { timeoutMs: 15_000 }).catch(() => null);
    if (r && r.kind === 'ok') {
      const local = localMasterOf(r.body, m);
      if (local !== this.s.localMode) this.set({ localMode: local });
    }
  }

  async load(quiet: boolean): Promise<void> {
    const m = this.machine();
    if (!m) {
      if (!quiet) this.offline();
      return;
    }
    const wantArea = this.s.wantArea;
    const r = await this.c.svc.api.get(shopZStatusPath(m, wantArea), { timeoutMs: 20_000 }).catch(() => null);
    if (!r || r.kind === 'offline') {
      if (!quiet) this.offline();
      return;
    }
    if (r.kind === 'refused') {
      if (!quiet) this.set({ loading: false, error: SHOP_Z_TEXT.cloudError(r.status) });
      return;
    }
    const body = statusOf(r.body);
    const receivedAt = this.c.now();
    const prev = this.s;
    this.set({
      loading: false,
      status: body,
      error: quiet ? prev.error : null,
      // Read off a status asked with no scope only: an "area" asked for says nothing of the shop's.
      shopOffered: wantArea ? prev.shopOffered : shopZShopOffered(body),
      // Asked afresh with nothing under way: a finished run is behind us.
      run: !body?.run && !quiet && !(prev.run && SHOP_Z_LIVE.has(prev.run.status)) ? null : prev.run,
    });
    if (body?.run) this.onRun(body.run, receivedAt);
  }

  /* ------------------------------------------------------------------ the run */

  private heldGate(keepHeld: boolean) {
    if (this.o.heldGate) return this.o.heldGate(keepHeld);
    const held = new HeldStore(this.c.svc.kv, () => this.c.now());
    const n = held.count();
    const gate = heldSalesGate(n, allowCloseWithHeldSales(this.c.svc.cloud.parameters()));
    if (gate === 'proceed' || (gate === 'warn_with_keep_option' && keepHeld)) return;
    this.c.refuse('held_sales', HELD_TEXT.closeTitle(n), { count: n, keepAllowed: gate === 'warn_with_keep_option', body: HELD_TEXT.closeBody, sales: held.summaries() });
  }

  /** "סגור את כל הקופות והפק Z סניפי"; `confirm` after the typed "סגור" for the tills left out. */
  private start(confirm: boolean, keepHeld: boolean) {
    if (!this.opened) return this.c.refuse('invalid_args');
    if (this.s.busy) return { ok: false };
    if (this.s.localMode) {
      this.set({ error: SHOP_Z_TEXT.localBody });
      return { ok: false };
    }
    // "מכירות מושהות" on this till, whose own shift the run closes: paid or cancelled first (or kept where allowed).
    this.heldGate(keepHeld);
    const m = this.machine();
    if (!m) {
      this.offline();
      return { ok: false };
    }
    this.set({ busy: true, error: null, needsConfirm: null, blockedBy: null, message: null });
    const scope = shopZStartScope(this.s.status);
    const body: Record<string, unknown> = { confirmOpenTills: confirm, posUserName: this.operatorName() };
    if (scope) body.scope = scope;
    void this.track(
      (async () => {
        const r = await this.c.svc.api.post(`sync/${m}/shop-z`, body, { timeoutMs: 30_000 }).catch(() => null);
        if (!r || r.kind === 'offline') return this.offline();
        if (r.kind === 'ok') {
          this.set({ busy: false });
          const run = runOf(r.body);
          if (run) this.onRun(run, this.c.now());
          return;
        }
        const refusal = startRefusal(r.body, r.status);
        if (refusal.kind === 'needs_confirm') this.set({ busy: false, needsConfirm: refusal.tills });
        else if (refusal.kind === 'blocked') this.set({ busy: false, blockedBy: refusal.tills });
        else this.set({ busy: false, error: refusal.text });
      })(),
    );
    return { ok: true };
  }

  /** Build now without the tills the cloud is still waiting for — the operator typed "סגור". */
  private proceed() {
    const run = this.s.run;
    if (!run) return { ok: false };
    const m = this.machine();
    if (!m) {
      this.offline();
      return { ok: false };
    }
    this.set({ busy: true, error: null });
    void this.track(
      (async () => {
        const r = await this.c.svc.api
          .post(`sync/${m}/shop-z/runs/${encodeURIComponent(run.id)}/proceed`, { posUserName: this.operatorName() }, { timeoutMs: 30_000 })
          .catch(() => null);
        if (!r || r.kind === 'offline') return this.offline();
        if (r.kind === 'ok') {
          this.set({ busy: false });
          const next = runOf(r.body);
          if (next) this.onRun(next, this.c.now());
          return;
        }
        this.set({ busy: false, error: describeRefusal(r.body, r.status) });
      })(),
    );
    return { ok: true };
  }

  private onRun(run: ShopZRun, receivedAtMs: number) {
    const prev = this.s;
    this.set({
      run,
      // Fixed once per run, so the seconds do not jitter with each poll's latency.
      runStartedAtMs: prev.run?.id === run.id && prev.runStartedAtMs !== null ? prev.runStartedAtMs : runStartOnTillClock(run, receivedAtMs),
    });
    if (SHOP_Z_LIVE.has(run.status)) {
      this.closeOwnShift(run);
      if (this.pollingRun !== run.id) this.startPolling(run.id);
    } else if (this.pollingRun === run.id) this.stopPolling();
    if (run.status === 'completed' && run.zReportId && this.s.printedZId !== run.zReportId) {
      this.set({ printedZId: run.zReportId });
      void this.track(this.printSummary(run.zReportId, true));
    }
  }

  /** This till's own shift, closed here and now for its item — the same close a command from the cloud makes. */
  private closeOwnShift(run: ShopZRun) {
    const item = ownPendingItem(run, this.machine());
    if (!item || !item.id || this.selfClosed.has(item.id)) return;
    const requestId = item.id;
    this.selfClosed.add(requestId);
    const user = this.c.operator();
    const closer = user ? { id: user.id, name: displayName(user) } : { id: '', name: SHOP_Z_TEXT.title };
    void this.track(
      this.c.later(async () => {
        let outcome: OwnCloseOutcome;
        try {
          outcome = this.o.closeOwnShift ? await this.o.closeOwnShift({ requestId, closeShiftId: item.closeShiftId, closer }) : this.ledgerClose(requestId, closer);
        } catch (e) {
          this.c.log(`shop Z: this till's own close for ${requestId} failed: ${String(e)}`);
          outcome = 'pending';
        }
        // A payment still holds it: asked again on the next poll.
        if (outcome === 'pending') this.selfClosed.delete(requestId);
        else this.c.log(`shop Z: this till's own shift for ${requestId}: ${outcome}`);
        this.c.changed();
        if (outcome === 'closed' && this.o.timers !== false && !this.stopped) {
          const t = setTimeout(() => void this.track(this.pollOnce(run.id)), OWN_CLOSE_LOOK_MS);
          t.unref?.();
        }
      }),
    );
  }

  /** The ledger's unattended close named after the request (no engine hook). */
  private ledgerClose(requestId: string, closer: { id: string; name: string }): OwnCloseOutcome {
    const svc = this.c.svc;
    if (svc.ledger.shiftByCloseRequest(requestId)) return 'already';
    if (this.c.paying()) return 'pending';
    const r = svc.ledger.closeShift({ closedByName: closer.name, closedByUserId: closer.id || null, unattended: true, closeRequestId: requestId, vatRate: svc.vatRate(), now: new Date(this.c.now()) });
    if (r.kind === 'pending') return 'pending';
    if (r.kind === 'none') return 'none';
    void svc.sync.flush().catch(() => undefined);
    return 'closed';
  }

  /** One look at the run under way. */
  async pollOnce(runId: string): Promise<ShopZRun | null> {
    const m = this.machine();
    if (!m || this.stopped) return null;
    const r = await this.c.svc.api.get(`sync/${m}/shop-z/runs/${encodeURIComponent(runId)}`, { timeoutMs: 15_000 }).catch(() => null);
    if (!r || r.kind !== 'ok') return null;
    const run = runOf(r.body);
    if (run) this.onRun(run, this.c.now());
    return run;
  }

  private startPolling(runId: string) {
    this.stopPolling();
    this.pollingRun = runId;
    if (this.o.timers === false || this.stopped) return;
    let busy = false;
    this.pollTimer = setInterval(() => {
      if (busy) return;
      busy = true;
      void this.track(this.pollOnce(runId)).finally(() => {
        busy = false;
      });
    }, RUN_POLL_MS);
    this.pollTimer.unref?.();
  }

  private stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.pollingRun = null;
  }

  /** While no run is under way: the tills' states, live, for a few minutes after the last touch. */
  async idleTick(): Promise<void> {
    if (this.c.now() - this.lastTouchAt >= IDLE_REFRESH_FOR_MS || !this.screenOpen) {
      this.stopIdle();
      return;
    }
    const run = this.s.run;
    if (run?.status === 'completed') {
      this.stopIdle();
      return;
    }
    if (!run || !SHOP_Z_LIVE.has(run.status)) await this.load(true);
  }

  private startIdle() {
    this.stopIdle();
    if (this.o.timers === false || this.stopped) return;
    this.idleTimer = setInterval(() => void this.track(this.idleTick()), IDLE_REFRESH_MS);
    this.idleTimer.unref?.();
  }

  private stopIdle() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /* ------------------------------------------------------------------ printing */

  private printSummaryOp() {
    const id = this.s.run?.zReportId ?? this.s.printedZId;
    if (!id) return this.c.refuse('invalid_args');
    void this.track(this.printSummary(id, false));
    return { ok: true };
  }

  /** The cloud's document (`part=summary`, or one till's); the failure's words otherwise. */
  private async fetchDoc(zId: string, q: string): Promise<{ doc: CloudPrintDocument } | { error: string }> {
    const m = this.machine();
    if (!m) return { error: SHOP_Z_TEXT.printFailed(SHOP_Z_TEXT.offline) };
    const r = await this.c.svc.api.get(`sync/${m}/z-reports/${encodeURIComponent(zId)}/print-document?${q}`, { timeoutMs: 30_000 }).catch(() => null);
    if (!r || r.kind === 'offline') return { error: SHOP_Z_TEXT.printFailed(SHOP_Z_TEXT.offline) };
    if (r.kind === 'refused') return { error: SHOP_Z_TEXT.printFailed(`HTTP ${r.status}`) };
    const doc = cloudPrintDocumentOf(r.body);
    return doc ? { doc } : { error: SHOP_Z_TEXT.printFailed(SHOP_Z_TEXT.cloudError(200)) };
  }

  /** On paper (the failed payments' sections off unless the parameter puts them there); null, or the failure's words. */
  private printDoc(doc: CloudPrintDocument, refId: string): string | null {
    const paper = withoutFailedPaymentSections(doc, this.c.svc.cloud.parameters());
    const logo = this.c.svc.settingsMap().brandReceiptLogoUrl;
    const z: ZDoc = { kind: 'z', logoUrl: typeof logo === 'string' && logo ? logo : null, ops: cloudZOps(paper) };
    const title = [paper.title, paper.number !== null ? `#${paper.number}` : null].filter(Boolean).join(' ') || SHOP_Z_TEXT.title;
    try {
      const id = this.o.print ? this.o.print(z, refId, title) : this.c.svc.printQueue.enqueue('z', refId, z);
      return id ? null : SHOP_Z_TEXT.printFailed(SHOP_Z_TEXT.cloudError(0));
    } catch (e) {
      return SHOP_Z_TEXT.printFailed(e instanceof Error ? e.message : String(e));
    }
  }

  /** The summary — the shop's totals and one line per till — then the question about the details. */
  async printSummary(zReportId: string, askAfter: boolean): Promise<void> {
    if (this.s.progress !== null) return;
    this.set({ progress: SHOP_Z_TEXT.printingSummary, progressDetail: null, message: null });
    // Fetched apart from the print: a printer out of paper still leaves the tills known.
    const got = await this.fetchDoc(zReportId, 'part=summary');
    const error = 'error' in got ? got.error : this.printDoc(got.doc, `shopz:${zReportId}:summary:${this.c.now()}`);
    const tills = 'doc' in got ? tillsInOrder(got.doc.tills) : [];
    this.set({
      progress: null,
      zTills: tills.length ? tills : this.s.zTills,
      askDetails: askAfter && error === null && tills.length > 0,
      message: error,
    });
  }

  private answerDetails(answer: 'all' | 'choose' | 'no') {
    const tills = this.s.zTills;
    if (answer === 'no') {
      this.set({ askDetails: false, choosing: false });
      return { ok: true };
    }
    this.set({ askDetails: false, choosing: answer === 'choose' && tills.length > 0 });
    if (answer === 'all' && tills.length) void this.track(this.printDetails(tills));
    return { ok: true };
  }

  /** Each till's own Z detail, one after another in till-number order, each its own strip. */
  async printDetails(tills: CloudZTill[]): Promise<void> {
    const zId = this.s.printedZId ?? this.s.run?.zReportId ?? null;
    if (!zId || this.s.progress !== null || tills.length === 0) return;
    this.detailsCancelRequested = false;
    this.set({ choosing: false, cancelling: false, message: null });
    const outcome = await printInSequence(
      tillsInOrder(tills),
      () => this.detailsCancelRequested,
      (i, total, till) => this.set({ progress: SHOP_Z_TEXT.detailProgress(i, total), progressDetail: tillLabel(till) }),
      async (till) => {
        const got = await this.fetchDoc(zId, `till=${encodeURIComponent(till.machineId)}`);
        return 'error' in got ? got.error : this.printDoc(got.doc, `shopz:${zId}:till:${till.machineId}:${this.c.now()}`);
      },
    );
    this.set({ progress: null, progressDetail: null, cancelling: false, message: printSequenceMessage(outcome) });
  }
}
