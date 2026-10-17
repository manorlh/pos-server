/**
 * "עריכת מסך" on the Windows till (core/till/screenEdit.ts — pos-android ui/sell/ArrangeMode.kt, SellViewModel
 * `startArrange` / `moveArranged` / `moveArrangedCategory` / `finishArrange` / `setProductLocked`):
 *
 *  - `screenEdit.start` — a manager's, or with a manager's code (CATALOG_WRITE; a cashier is asked for one as Android's
 *    elevation sheet does): the sell screen's tiles are arranged, not sold;
 *  - `screenEdit.move` / `screenEdit.moveCategory` — the working order, laid over the catalog the engine sends
 *    (`overlay()` → core `arrangeCatalog`; `rev()` moves the catalog's version so the screens fetch it again);
 *  - `screenEdit.done` — nothing moved: out; else `PUT /sync/{m}/product-order` at the parameter's level ("לשאול בקופה" /
 *    a point of sale this till is not in: the till asks), the arranger in `X-Pos-User-Id` (the cloud checks their role
 *    again). Saved: the order stays laid over the catalog until the settings pull brings it back (kept in svc.kv until
 *    then, a restart included); offline / refused: Android's notice, and the edit mode stays open;
 *  - `screenEdit.lock` — ✕ (inactive) / + (active again) at this till, its point of sale or the shop
 *    (`PUT /sync/{m}/products/{id}/availability`), then a full catalog pull so the tile shows the cloud's word.
 *
 * Electron-free.
 */

import {
  SCREEN_EDIT_CODE,
  SCREEN_EDIT_TEXT,
  PARAM_PRODUCT_ORDER_SCOPE,
  doneScope,
  lockBody,
  lockNotice,
  moveAmongShown,
  moveCategory,
  orderBy,
  parseOrder,
  saveNotice,
  sameOrder,
  scopeChoices,
  screenEditEnabled,
  writeOutcome,
  type ArrangeOrder,
  type OrderScope,
  type ScreenEditState,
} from '../../core/till/screenEdit';
import { displayName } from '../../core/till/staff';
import type { ApproverRef, TillContext, TillFeature } from './tillContext';

export const SCREEN_EDIT_OPS = [
  'screenEdit.start',
  'screenEdit.cancel',
  'screenEdit.move',
  'screenEdit.moveCategory',
  'screenEdit.done',
  'screenEdit.lock',
] as const;

/** The saved order, laid over the catalog until the settings pull says the same (or anything newer). */
const SAVED_KEY = 'screenEdit.saved';
const MAX_IDS = 5000;

interface Saved {
  order: ArrangeOrder;
  /** The settings' `settingsUpdatedAt` when it was saved: any newer settings are the cloud's word. */
  settingsAt: string | null;
}

const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200;

export class TillScreenEdit implements TillFeature {
  readonly key = 'screenEdit';
  readonly ops = SCREEN_EDIT_OPS;
  readonly mutating = SCREEN_EDIT_OPS;

  private on = false;
  private saving = false;
  private lockBusy: string | null = null;
  /** Who arranges: the operator, or the manager whose code opened the edit mode (the cloud hears them). */
  private by: ApproverRef | null = null;
  private working: ArrangeOrder = { productIds: null, categoryIds: null };
  private saved: Saved | null;
  /** An older cloud answered 404 to the order's route: no row, never a dead button (this run). */
  private routeMissing = false;
  private revision = 0;

  constructor(private readonly c: TillContext) {
    this.saved = this.readSaved();
  }

  /* ------------------------------------------------------------ the engine's hooks */

  /** Moves whenever the order laid over the catalog changes: the engine adds it to the catalog's version. */
  rev(): number {
    return this.revision;
  }

  /** The order the engine's `catalogSnapshot` lays over the catalog (core `arrangeCatalog`); null — the catalog's own. */
  overlay(): ArrangeOrder | null {
    if (this.on && (this.working.productIds || this.working.categoryIds)) return this.working;
    const s = this.saved;
    if (!s) return null;
    const settings = this.c.svc.cloud.settings();
    if ((settings.settingsUpdatedAt ?? null) !== s.settingsAt || settingsHold(settings.settings ?? {}, s.order)) {
      // The settings moved since, or hold it already: the cloud's word (the saved order with them, or a newer one).
      this.saved = null;
      this.c.svc.kv.delete(SAVED_KEY);
      return null;
    }
    return s.order;
  }

  /* ----------------------------------------------------------------------- state */

  state(): ScreenEditState | undefined {
    const user = this.c.operator();
    if (!user) {
      // Signed out (or locked) mid-arrangement: the arrangement goes with them, unsaved — as Android's Back.
      if (this.on) this.reset();
      return undefined;
    }
    return {
      available: this.available(),
      on: this.on,
      saving: this.saving,
      dirty: this.dirty(),
      lockBusy: this.lockBusy,
    };
  }

  private available(): boolean {
    return (
      !!this.c.svc.machineId &&
      !this.routeMissing &&
      screenEditEnabled(this.c.svc.cloud.parameters()) &&
      !this.c.hiddenCodes().includes(SCREEN_EDIT_CODE)
    );
  }

  private dirty(): boolean {
    return this.working.productIds !== null || this.working.categoryIds !== null;
  }

  /* ------------------------------------------------------------------------- ops */

  apply(op: string, args: Record<string, unknown>): unknown {
    switch (op) {
      case 'screenEdit.start':
        return this.start();
      case 'screenEdit.cancel':
        this.c.signedIn();
        this.reset();
        return undefined;
      case 'screenEdit.move': {
        const shown = args.shown;
        if (!isId(args.fromId) || !isId(args.toId) || !Array.isArray(shown) || shown.length > MAX_IDS || !shown.every(isId)) return this.c.refuse('invalid_args');
        return this.move(args.fromId, args.toId, shown as string[]);
      }
      case 'screenEdit.moveCategory':
        if (!isId(args.fromId) || !isId(args.toId)) return this.c.refuse('invalid_args');
        return this.moveCat(args.fromId, args.toId);
      case 'screenEdit.done':
        return this.done();
      case 'screenEdit.lock':
        if (!isId(args.productId) || typeof args.locked !== 'boolean') return this.c.refuse('invalid_args');
        return this.lock(args.productId, args.locked);
      default:
        return this.c.refuse('invalid_args');
    }
  }

  /** "עריכת מסך" from the menu: a manager's at once; anyone else — a manager's code (Android ArrangeUi.request). */
  private start(): unknown {
    const user = this.c.signedIn();
    if (!this.available()) return this.c.refuse('invalid_args');
    if (this.on) return undefined;
    return this.c.gate(
      SCREEN_EDIT_CODE,
      (approver) => {
        this.on = true;
        this.saving = false;
        this.working = { productIds: null, categoryIds: null };
        this.by = approver ?? { id: user.id, name: displayName(user) };
        this.bump();
        return undefined;
      },
      { askOnDeny: true, title: SCREEN_EDIT_TEXT.title, body: SCREEN_EDIT_TEXT.reason },
    );
  }

  private arranging() {
    this.c.signedIn();
    if (!this.on || this.saving) this.c.refuse('invalid_args');
  }

  /** The whole product order now (the catalog as built — already in the settings' order — with the working one over it). */
  private fullProducts(): string[] {
    const ids = this.c.svc.tillCatalogData().products.map((p) => p.id);
    const over = this.working.productIds ?? this.saved?.order.productIds ?? null;
    return over ? orderBy(ids, over, (x) => x) : ids;
  }

  private fullCategories(): string[] {
    const ids = this.c.svc.tillCatalogData().categories.map((c) => c.id);
    const over = this.working.categoryIds ?? this.saved?.order.categoryIds ?? null;
    return over ? orderBy(ids, over, (x) => x) : ids;
  }

  /** The tile `fromId` dropped on `toId`'s place among the tiles on screen (`shown`, in their order). */
  private move(fromId: string, toId: string, shown: string[]): unknown {
    this.arranging();
    const next = moveAmongShown(this.fullProducts(), shown, fromId, toId);
    if (!next) return undefined;
    this.working = { ...this.working, productIds: next };
    this.bump();
    return undefined;
  }

  private moveCat(fromId: string, toId: string): unknown {
    this.arranging();
    const next = moveCategory(this.fullCategories(), fromId, toId);
    if (!next) return undefined;
    this.working = { ...this.working, categoryIds: next };
    this.bump();
    return undefined;
  }

  /** "סיום" / "שמור": nothing moved — out; else saved where the parameter says, or where the till is told. */
  private done(): unknown {
    this.arranging();
    if (!this.dirty()) {
      this.reset();
      return undefined;
    }
    const scope = doneScope(this.c.svc.cloud.parameters()[PARAM_PRODUCT_ORDER_SCOPE], this.hasArea());
    if (scope !== 'ask') return this.save(scope);
    const choices = scopeChoices(this.hasArea()).reverse();
    return this.c.ask({
      kind: 'confirm',
      title: SCREEN_EDIT_TEXT.saveTitle,
      body: SCREEN_EDIT_TEXT.saveBody,
      fields: [],
      actions: [
        ...choices.map((c) => ({ id: c.scope, label: SCREEN_EDIT_TEXT.saveFor(c.label), primary: c.scope === 'shop' })),
        { id: 'cancel', label: SCREEN_EDIT_TEXT.cancel },
      ],
      code: null,
      onAction: (action) => {
        if (!choices.some((c) => c.scope === action) || !this.on || this.saving) return undefined;
        return this.save(action as OrderScope);
      },
    });
  }

  private save(scope: OrderScope): unknown {
    const m = this.c.svc.machineId;
    if (!m) return this.c.refuse('invalid_args');
    const order: ArrangeOrder = { ...this.working };
    const body: Record<string, unknown> = { scope };
    if (order.productIds) body.productIds = order.productIds;
    if (order.categoryIds) body.categoryIds = order.categoryIds;
    this.saving = true;
    this.c.changed();
    void this.c.later(async () => {
      const r = await this.c.svc.api.put(`sync/${m}/product-order`, body, { headers: this.headers(), timeoutMs: 20_000 });
      const outcome = writeOutcome(r);
      this.saving = false;
      if (outcome === 'ok') {
        // Shown at once (the order laid over the catalog); the settings pull brings the same back.
        this.saved = { order, settingsAt: this.c.svc.cloud.settings().settingsUpdatedAt ?? null };
        this.c.svc.kv.setJson(SAVED_KEY, this.saved);
        this.on = false;
        this.working = { productIds: null, categoryIds: null };
        this.by = null;
        this.bump();
        await this.c.svc.sync.pullSettings().catch(() => undefined);
        this.c.changed();
        return;
      }
      if (outcome === 'missing') {
        // An older cloud: no "סידור פריטים" there — the row goes, and the arrangement with it.
        this.routeMissing = true;
        this.reset();
      }
      this.notice(SCREEN_EDIT_TEXT.title, saveNotice(outcome) ?? SCREEN_EDIT_TEXT.offline);
      this.c.changed();
    });
    return undefined;
  }

  /** ✕ / +: where — this till, its point of sale, the shop (Android ArrangeDialogs' sheets). */
  private lock(productId: string, locked: boolean): unknown {
    this.arranging();
    if (this.lockBusy) return this.c.refuse('invalid_args');
    const product = this.c.svc.tillCatalogData().products.find((p) => p.id === productId);
    if (!product) return this.c.refuse('invalid_args');
    const choices = scopeChoices(this.hasArea());
    return this.c.ask({
      kind: 'confirm',
      title: locked ? SCREEN_EDIT_TEXT.removeTitle(product.name) : SCREEN_EDIT_TEXT.restoreTitle(product.name),
      body: locked ? SCREEN_EDIT_TEXT.removeBody : '',
      fields: [],
      actions: [
        ...choices.map((c) => ({
          id: c.scope,
          label: locked ? SCREEN_EDIT_TEXT.removeIn(c.label) : SCREEN_EDIT_TEXT.restoreIn(c.label),
          primary: !locked && c.scope === 'machine',
        })),
        { id: 'cancel', label: SCREEN_EDIT_TEXT.cancel },
      ],
      code: null,
      onAction: (action) => {
        if (!choices.some((c) => c.scope === action) || this.lockBusy) return undefined;
        return this.sendLock(productId, product.name, action as OrderScope, locked);
      },
    });
  }

  private sendLock(productId: string, name: string, scope: OrderScope, locked: boolean): unknown {
    const m = this.c.svc.machineId;
    if (!m) return this.c.refuse('invalid_args');
    this.lockBusy = productId;
    this.c.changed();
    void this.c.later(async () => {
      const r = await this.c.svc.api.put(`sync/${m}/products/${encodeURIComponent(productId)}/availability`, lockBody(scope, locked), {
        headers: this.headers(),
        timeoutMs: 20_000,
      });
      const outcome = writeOutcome(r);
      // Sent or refused, the cloud has answered: pull, so the tile shows its word.
      if (outcome !== 'offline') await this.c.svc.sync.pullCatalog(true).catch(() => undefined);
      this.lockBusy = null;
      this.notice(SCREEN_EDIT_TEXT.lockTitle, lockNotice(outcome, name, locked));
      this.c.changed();
    });
    return undefined;
  }

  /* --------------------------------------------------------------------- helpers */

  private headers(): Record<string, string> {
    const id = this.by?.id ?? this.c.operator()?.id ?? null;
    return id ? { 'X-Pos-User-Id': id } : {};
  }

  private hasArea(): boolean {
    const area = (this.c.svc.cloud.machine() as { area?: unknown } | null)?.area;
    return !!area && typeof area === 'object' && typeof (area as { id?: unknown }).id === 'string' && !!(area as { id: string }).id;
  }

  /** Android's notice ("הבנתי"); a question already on screen keeps its place — then a toast. */
  private notice(title: string, body: string) {
    if (this.c.dialogOpen?.()) {
      this.c.toast(body, 'info');
      return;
    }
    this.c.ask({
      kind: 'confirm',
      title,
      body,
      fields: [],
      actions: [{ id: 'ok', label: SCREEN_EDIT_TEXT.ok, primary: true }],
      code: null,
      onAction: () => undefined,
    });
  }

  private reset() {
    const had = this.on || this.dirty();
    this.on = false;
    this.saving = false;
    this.working = { productIds: null, categoryIds: null };
    this.by = null;
    if (had) this.bump();
  }

  private bump() {
    this.revision += 1;
    this.c.changed();
  }

  private readSaved(): Saved | null {
    try {
      const s = this.c.svc.kv.getJson<Saved>(SAVED_KEY);
      if (!s || typeof s !== 'object' || !s.order) return null;
      const productIds = s.order.productIds === null ? null : parseOrder(s.order.productIds);
      const categoryIds = s.order.categoryIds === null ? null : parseOrder(s.order.categoryIds);
      if (!productIds && !categoryIds) return null;
      return { order: { productIds, categoryIds }, settingsAt: typeof s.settingsAt === 'string' ? s.settingsAt : null };
    } catch {
      return null;
    }
  }
}

/** The saved order is the settings' own already: nothing to lay over the catalog. */
export function settingsHold(settings: Record<string, unknown>, order: ArrangeOrder): boolean {
  return (
    (order.productIds === null || sameOrder(parseOrder(settings.productOrder), order.productIds)) &&
    (order.categoryIds === null || sameOrder(parseOrder(settings.categoryOrder), order.categoryIds))
  );
}
