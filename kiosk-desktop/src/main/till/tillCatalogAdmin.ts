/**
 * "ניהול קטלוג" on the Windows till (pos-android ui/catalogadmin/CatalogAdminScreen.kt, CatalogAdminViewModel.kt,
 * MachineCatalogViewModel.kt, data/repo/ProductLockQueue.kt; P:/specs/till-catalog-management.md). The rules and words are
 * core/till/catalogAdmin.ts (and core/till/tillPriceLevel.ts for "איפה לשנות?"); this module reads the till's stored
 * catalog, keeps the screen's filters, and writes to the cloud with the routes the Android till uses:
 *
 *  - `PUT /sync/{m}/products/{id}/availability` — "פעיל / לא פעיל", "אזל להיום": on this till AT ONCE (the stored row) and
 *    queued for the cloud when it does not answer (kv `catalogAdmin.pendingLocks`, tried again every 20 s and put back over a
 *    pull until delivered), as the Android lock queue;
 *  - `PUT /sync/{m}/products/{id}` (only what changed), `POST /sync/{m}/products`, `POST|DELETE …/{id}/image` (multipart,
 *    `keepBackground` / `enhance`), `POST|PUT /sync/{m}/categories[/{id}]`, `PUT …/categories/{id}/availability`,
 *    `PUT /sync/{m}/machine-catalog` — online only ("ניהול קטלוג דורש חיבור לענן…"); after each the catalog is pulled, not
 *    patched, so the till shows what the cloud decided;
 *  - "שינוי מחיר מהקופה" (area management, feature-detected): `GET …/{id}/price-options` (404 / an older cloud — the shop's
 *    price through the product patch, no question) and `PUT …/{id}/price` {price, level}; "תמיד באישור מורשה" — the cloud's
 *    401 — asks an authorised person's code and sends their grant (`POST /elevation/sessions`, `X-Elevation-Token`).
 *
 * Who: each write by its own permission (CATALOG_AVAILABILITY / PRICE / EDIT / CREATE; "קטלוג למסוף" CATALOG_WRITE), decided
 * before the tap. One the operator may do alone goes out in their name (`X-Pos-User-Id`); one that needs approval asks the
 * engine's manager-code dialog and goes out in the approver's name — and the screen keeps that approval ("מאושר על ידי …",
 * Android's grant) until it is given back, the screen closes or five minutes pass.
 *
 * Electron-free.
 */

import { findByPin, permissionState } from '../../core/desktopExit';
import {
  ACTION_CODE,
  ALL_KEY,
  CATALOG_ADMIN_TEXT as T,
  CATALOG_PERM,
  CATALOG_PERM_LABEL,
  DEFAULT_ENHANCE,
  DEFAULT_KEEP_BACKGROUND,
  PHOTO_MAX_BYTES,
  SALES_CHANNELS,
  STATE_FILTERS,
  STATE_LABEL,
  TAG_LABEL,
  actionsFor,
  adminCategoryOf,
  adminProductOf,
  applyFilter,
  availabilityBody,
  catalogDeniedText,
  catalogGate,
  catalogRows,
  catalogSettingsOf,
  channelLabel,
  createBody,
  defaultScopeFor,
  diffEdit,
  draftError,
  draftOf,
  emptyDraft,
  entryShown,
  filterChips,
  filterCounts,
  gateView,
  inScope,
  lockedBy,
  machineGroups,
  machineListToSend,
  machineModeOf,
  matchesState,
  otherChanged,
  parseCatalogView,
  patchOf,
  photoFormatOf,
  priceChanged,
  priceText,
  resolveCatalogView,
  resolveTicketMode,
  salesChannelOf,
  scopeEffect,
  scopeLabel,
  sharedRefusal,
  ticketModeLabel,
  usable,
  validFilter,
  type AdminCategory,
  type AdminProduct,
  type AvailabilityChange,
  type AvailabilityScope,
  type CatalogAction,
  type CatalogAdminState,
  type CatalogAdminView,
  type CatalogDeniedUi,
  type CatalogGate,
  type CatalogPageView,
  type CatalogRowView,
  type CatalogUserFacts,
  type MachineCatalogMode,
  type ProductDraft,
  type SalesChannel,
  type StateFilter,
} from '../../core/till/catalogAdmin';
import { deniedUiSettingsOf, legacyUi, profileOf, type ProfileUser } from '../../core/till/permissions';
import { displayName, loginCandidates, type RosterUser } from '../../core/till/staff';
import {
  PRICE_LEVEL_TEXT,
  decidePriceLevel,
  priceChoiceLabel,
  priceOptionsOf,
  priceRefusalMessage,
  type PriceDecision,
  type PriceLevel,
} from '../../core/till/tillPriceLevel';
import type { ApproverRef, TillContext, TillFeature } from './tillContext';

export type { CatalogAdminState };

export interface TillCatalogAdminDeps {
  /** A shift is open (or the till works without shifts): the screen opens for anyone allowed; else a manager's only. */
  shiftOpen?: () => boolean;
  /** The fetch the picture's multipart upload goes through (the API client speaks JSON only). */
  fetch?: typeof fetch;
  /** The till's own catalog changed on the disk (a lock set here): its sell screen is built again. */
  catalogChanged?: () => void;
}

const OPS = [
  'catalog.open',
  'catalog.close',
  'catalog.panel',
  'catalog.filter',
  'catalog.more',
  'catalog.page',
  'catalog.pageClose',
  'catalog.save',
  'catalog.add',
  'catalog.priceLevel',
  'catalog.priceCancel',
  'catalog.setAvailable',
  'catalog.moveCategory',
  'catalog.photo',
  'catalog.categoryAdd',
  'catalog.categoryRename',
  'catalog.categoryActive',
  'catalog.machineAuth',
  'catalog.machineSave',
  'catalog.release',
  'catalog.dismiss',
] as const;

const MUTATING = [
  'catalog.save',
  'catalog.add',
  'catalog.priceLevel',
  'catalog.setAvailable',
  'catalog.moveCategory',
  'catalog.photo',
  'catalog.categoryAdd',
  'catalog.categoryRename',
  'catalog.categoryActive',
  'catalog.machineSave',
] as const;

/** The rows the list shows at first, and each "עוד" adds. */
export const ROWS_PAGE = 120;
/** An approval held by the screen ("מאושר על ידי …"): given back after this. */
export const HELD_MS = 5 * 60_000;
/** The queued availability changes are tried again this often. */
export const LOCK_RETRY_MS = 20_000;

const KV_VIEW = 'catalogAdmin.view';
const KV_SHARED = 'catalogAdmin.sharedIds';
const KV_LOCKS = 'catalogAdmin.pendingLocks';

interface PendingLock {
  productId: string;
  scope: AvailabilityScope;
  change: AvailabilityChange;
  permanent: boolean | null;
  atIso: string;
  by: string | null;
}

type Outcome =
  | { kind: 'saved'; note?: string }
  | { kind: 'offline' }
  | { kind: 'shared' }
  | { kind: 'failed'; text: string }
  | { kind: 'elevation' }
  /** The cloud wants an authorised person's grant for this write: asked, then [retry] with it. */
  | { kind: 'grant'; retry: (token: string) => unknown };

interface Photo {
  remove?: boolean;
  bytes?: Uint8Array;
  keepBackground: boolean;
  enhance: boolean;
}

type Reply = Awaited<ReturnType<TillContext['svc']['api']['get']>>;

export class TillCatalogAdmin implements TillFeature {
  readonly key = 'catalogAdmin';
  readonly ops: readonly string[] = OPS;
  readonly mutating: readonly string[] = MUTATING;

  private open = false;
  private openedBy: string | null = null;
  private panel: CatalogAdminState['panel'] = 'products';
  private filter = { query: '', categoryId: null as string | null, channel: null as SalesChannel | null, state: 'any' as StateFilter, showOutOfScope: false };
  private limit = ROWS_PAGE;
  private busy = false;
  private note: CatalogAdminState['note'] = null;
  private held: { by: ApproverRef; codes: Set<string>; until: number; userId: string } | null = null;
  private page: { key: string; productId: string | null } | null = null;
  private pageSeq = 0;
  private ask: { decision: Extract<PriceDecision, { kind: 'ask' }>; go: (level: PriceLevel) => unknown } | null = null;
  /** "קטלוג למסוף" for a cashier: the manager who approved it, for this opening. */
  private machineApprover: ApproverRef | null = null;
  private viewRaw: unknown;
  private rows: { catalog: unknown; products: AdminProduct[]; categories: AdminCategory[] } | null = null;
  private lockTimer: ReturnType<typeof setInterval> | null = null;
  private memo: { key: string; catalog: unknown; out: { rows: CatalogRowView[]; total: number; scoped: number; scopedIds: Set<string>; offerOut: boolean; chips: CatalogAdminState['categoryChips'] } } | null = null;

  constructor(
    private readonly c: TillContext,
    private readonly d: TillCatalogAdminDeps = {},
  ) {
    this.viewRaw = this.c.svc.kv.getJson<unknown>(KV_VIEW);
    if (this.pendingLocks().length > 0) this.armLocks();
  }

  stop() {
    if (this.lockTimer) clearInterval(this.lockTimer);
    this.lockTimer = null;
  }

  /* ------------------------------------------------------------------------------------------------------ reads */

  private params(): Record<string, unknown> {
    return this.c.svc.cloud.parameters();
  }

  /** The stored catalog read once per version of it (the same object until the next pull or local lock). */
  private read(): { products: AdminProduct[]; categories: AdminCategory[] } {
    const catalog = this.c.svc.cloud.catalog();
    if (this.rows?.catalog === catalog) return this.rows;
    this.rows = {
      catalog,
      products: catalog.products.map((r) => adminProductOf(r)).filter((p): p is AdminProduct => p !== null),
      categories: catalog.categories.map((r) => adminCategoryOf(r)).filter((x): x is AdminCategory => x !== null),
    };
    return this.rows;
  }

  private products(): AdminProduct[] {
    return this.read().products;
  }

  private categoriesList(): AdminCategory[] {
    return this.read().categories;
  }

  private area(): { id: string; name: string } | null {
    const a = (this.c.svc.cloud.machine() as { area?: { id?: unknown; name?: unknown } | null } | null)?.area;
    const id = typeof a?.id === 'string' ? a.id.trim() : '';
    const name = typeof a?.name === 'string' ? a.name.trim() : '';
    return id && name ? { id, name } : null;
  }

  private view(): CatalogAdminView {
    return resolveCatalogView(this.viewRaw, this.c.svc.cloud.catalogMenus(), new Date(this.c.now()));
  }

  private shared(): Set<string> {
    const raw = this.c.svc.kv.getJson<unknown>(KV_SHARED);
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  }

  private rememberShared(id: string) {
    const s = this.shared();
    if (s.has(id)) return;
    s.add(id);
    this.c.svc.kv.setJson(KV_SHARED, [...s]);
    this.memo = null;
  }

  private userFacts(u: RosterUser): CatalogUserFacts {
    const fresh = (this.c.roster().find((x) => x.id === u.id) ?? u) as RosterUser & ProfileUser;
    const perms = fresh.permissions;
    return {
      role: fresh.role ?? null,
      fromCloud: !!perms && typeof perms === 'object' && Object.keys(perms).length > 0,
      tillRoleKey: typeof fresh.tillRoleKey === 'string' ? fresh.tillRoleKey.trim() || null : null,
      editState: permissionState(fresh, CATALOG_PERM.EDIT),
    };
  }

  /** "כשאין הרשאה" as the catalog reads it (DeniedActions.legacyUi). */
  private deniedUi(u: RosterUser): CatalogDeniedUi {
    const fresh = (this.c.roster().find((x) => x.id === u.id) ?? u) as RosterUser & ProfileUser;
    return legacyUi(profileOf(fresh), deniedUiSettingsOf(this.params()));
  }

  private shiftOpen(): boolean {
    return this.d.shiftOpen ? this.d.shiftOpen() : this.c.svc.ledger.currentShift() !== null;
  }

  private heldFor(code: string): ApproverRef | null {
    const h = this.held;
    const u = this.c.operator();
    if (!h || !u || h.userId !== u.id || this.c.now() > h.until) return null;
    return h.codes.has(code) ? h.by : null;
  }

  private gate(action: CatalogAction): CatalogGate {
    const u = this.c.operator();
    if (!u) return { kind: 'hidden' };
    const code = ACTION_CODE[action];
    return catalogGate(action, this.c.decide(code), this.deniedUi(u), catalogSettingsOf(this.params()), this.heldFor(code) !== null);
  }

  /** "ניהול קטלוג" in the menu for the operator now. */
  entryShown(): boolean {
    const u = this.c.operator();
    if (!u) return false;
    return entryShown(catalogSettingsOf(this.params()), this.shiftOpen(), this.userFacts(u), this.c.decide(CATALOG_PERM.VIEW), this.deniedUi(u));
  }

  /* ------------------------------------------------------------------------------------------------------- state */

  state(): CatalogAdminState | undefined {
    const u = this.c.operator();
    if (!u) {
      if (this.open) this.reset();
      return undefined;
    }
    if (this.open && this.openedBy !== u.id) this.reset();
    const shown = this.entryShown();
    if (!this.open) return closedState(shown);
    const products = this.products();
    const categories = this.categoriesList();
    const view = this.view();
    const area = this.area();
    const shared = this.shared();
    const list = this.listOf(products, categories, view, shared);
    const gAvail = this.gate('availability');
    const gPrice = this.gate('price');
    const gEdit = this.gate('edit');
    const gCreate = this.gate('create');
    const scope = defaultScopeFor(view, area !== null);
    const held = this.held && this.c.now() <= this.held.until && this.held.userId === u.id ? this.held.by.name : null;
    return {
      entryShown: shown,
      open: true,
      panel: this.panel,
      title: this.panel === 'categories' ? T.categories : this.panel === 'till' ? T.machineTab : T.title,
      scopeLine: T.scopeLine(scopeLabel(view, null), list.scoped),
      busy: this.busy,
      note: this.note,
      approvedBy: held,
      gates: { availability: gateView(gAvail), price: gateView(gPrice), edit: gateView(gEdit), create: gateView(gCreate) },
      canSelect: gAvail.kind !== 'hidden' || gEdit.kind !== 'hidden',
      filter: { ...this.filter },
      offerOutOfScope: list.offerOut,
      stateChips: STATE_FILTERS.map((s) => ({ key: s, label: STATE_LABEL[s], on: this.filter.state === s })),
      channelChips: [{ key: '', label: T.filterAnyChannel, on: this.filter.channel === null }, ...SALES_CHANNELS.map((ch) => ({ key: ch, label: channelLabel(ch), on: this.filter.channel === ch }))],
      categoryChips: list.chips,
      rows: list.rows,
      total: list.total,
      hasArea: area !== null,
      availabilityScope: scope,
      scopeOptions: (['machine', 'area', 'shop'] as AvailabilityScope[]).map((key) => ({
        key,
        label: key === 'machine' ? T.scopeMachine : key === 'area' ? T.scopeArea : T.scopeShop,
        affects: scopeEffect(key),
        enabled: key !== 'area' || area !== null,
      })),
      categories: categories.map((cat) => ({ id: cat.id, name: cat.name, inactive: !cat.isActive })),
      page: this.pageView(products, categories, view, shared, gAvail, gPrice, gEdit, gCreate, scope),
      priceAsk: this.ask
        ? {
            title: PRICE_LEVEL_TEXT.where,
            choices: this.ask.decision.choices.map((ch) => ({ level: ch.level, label: priceChoiceLabel(ch.level, this.ask!.decision.areaName), refusal: ch.refusal, enabled: ch.enabled })),
            preselected: this.ask.decision.preselected,
          }
        : null,
      machine: this.panel === 'till' ? this.machineView(products, categories, u) : null,
    };
  }

  private listOf(products: AdminProduct[], categories: AdminCategory[], view: CatalogAdminView, shared: Set<string>) {
    const catalog = this.c.svc.cloud.catalog();
    const minute = Math.floor(this.c.now() / 60_000);
    const key = JSON.stringify([this.filter, this.limit, view, [...shared].length, minute, this.c.svc.cloud.catalogMenus() === null]);
    if (this.memo && this.memo.catalog === catalog && this.memo.key === key) return this.memo.out;
    const mode = machineModeOf(catalog.machineCatalog?.mode);
    const scoped = inScope(products, view, this.c.svc.cloud.catalogMenus(), mode);
    const filter = validFilter({ categoryId: this.filter.categoryId, channel: this.filter.channel, query: this.filter.query }, categories);
    const nowMs = this.c.now();
    const rows = catalogRows(applyFilter(filter, products), scoped, this.filter.showOutOfScope, shared, nowMs).filter((r) => matchesState(r, this.filter.state));
    const chipBase = this.filter.showOutOfScope ? products : products.filter((p) => scoped.has(p.id));
    const counts = filterCounts(filter, chipBase);
    const listedCount = products.filter((p) => p.shopListed && !p.isGeneral).length;
    const images = this.images();
    const out = {
      rows: rows.slice(0, this.limit).map(
        (r): CatalogRowView => ({
          id: r.product.id,
          name: r.product.name,
          price: priceText(r.product.price),
          imageUrl: images.get(r.product.id) ?? null,
          inScope: r.inScope,
          tags: r.tags.map((t) => ({ tag: t, label: TAG_LABEL[t] })),
          channel: r.product.salesChannel === 'all' ? null : channelLabel(r.product.salesChannel),
        }),
      ),
      total: rows.length,
      scoped: scoped.size,
      scopedIds: scoped,
      offerOut: scoped.size < listedCount || products.some((p) => !p.shopListed && !p.isGeneral),
      chips: [
        { key: ALL_KEY, label: `${T.filterAll} (${counts[ALL_KEY] ?? 0})`, on: filter.categoryId === null },
        ...filterChips(filter, categories, chipBase).map((cat) => ({ key: cat.id, label: `${cat.name} (${counts[cat.id] ?? 0})`, on: filter.categoryId === cat.id })),
      ],
    };
    this.memo = { key, catalog, out };
    return out;
  }

  /** The pictures the till keeps (its own media), by product: the sell screen's. */
  private images(): Map<string, string> {
    const out = new Map<string, string>();
    try {
      for (const p of this.c.svc.tillCatalogData().products as Array<{ id: string; imageUrl?: string | null }>) if (p.imageUrl) out.set(p.id, p.imageUrl);
    } catch {
      /* no catalog yet */
    }
    return out;
  }

  private pageView(
    products: AdminProduct[],
    categories: AdminCategory[],
    view: CatalogAdminView,
    shared: Set<string>,
    gAvail: CatalogGate,
    gPrice: CatalogGate,
    gEdit: CatalogGate,
    gCreate: CatalogGate,
    scope: AvailabilityScope,
  ): CatalogPageView | null {
    if (!this.page) return null;
    const settings = catalogSettingsOf(this.params());
    if (this.page.productId === null) {
      return {
        key: this.page.key,
        mode: 'new',
        productId: null,
        title: T.addProduct,
        draft: emptyDraft(categories[0]?.id ?? null),
        isAvailable: true,
        outOfScope: false,
        shared: false,
        imageUrl: null,
        cloudTicket: ticketModeLabel('off'),
        cloudPrintTicket: false,
        gates: { availability: gateView({ kind: 'hidden' }), price: gateView(gCreate), edit: gateView(gCreate), block: false },
        availabilityAffects: '',
        photoEnabled: settings.photoFromTill,
      };
    }
    const p = products.find((x) => x.id === this.page!.productId);
    if (!p) return null;
    const cat = categories.find((x) => x.id === p.categoryId);
    const mode = resolveTicketMode(p.ticketMode, cat?.ticketMode);
    const isShared = shared.has(p.id);
    // A shared product: only the price and the availability are this shop's to change.
    const edit: CatalogGate = isShared && gEdit.kind !== 'hidden' ? { kind: 'disabled', reason: T.affectsShared } : gEdit;
    const scoped = this.memo?.out.scopedIds ?? inScope(products, view, this.c.svc.cloud.catalogMenus(), machineModeOf(this.c.svc.cloud.catalog().machineCatalog?.mode));
    const blockShown = !(this.c.decide('ITEM_BLOCK') === 'denied' && this.deniedUi(this.c.signedIn()) === 'hide');
    return {
      key: this.page.key,
      mode: 'edit',
      productId: p.id,
      title: p.name,
      draft: draftOf(p, mode !== 'off'),
      isAvailable: p.isAvailable,
      outOfScope: !scoped.has(p.id),
      shared: isShared,
      imageUrl: this.images().get(p.id) ?? null,
      cloudTicket: ticketModeLabel(mode),
      cloudPrintTicket: mode !== 'off',
      gates: { availability: gateView(gAvail), price: gateView(gPrice), edit: gateView(edit), block: blockShown },
      availabilityAffects: `${scopeEffect(scope)} · ${T.affectsOfflineOk}`,
      photoEnabled: settings.photoFromTill,
    };
  }

  private machineView(products: AdminProduct[], categories: AdminCategory[], u: RosterUser): NonNullable<CatalogAdminState['machine']> {
    const authorized = this.c.decide(CATALOG_PERM.WRITE) === 'allowed' || (this.machineApprover !== null && this.held?.userId === u.id) || this.heldFor(CATALOG_PERM.WRITE) !== null;
    const mode = machineModeOf(this.c.svc.cloud.catalog().machineCatalog?.mode);
    if (!authorized) return { authorized: false, mode, selected: [], groups: [], total: 0 };
    const groups = machineGroups(products, categories, '');
    return {
      authorized: true,
      mode,
      selected: products.filter((p) => !p.isGeneral && p.inMachineCatalog).map((p) => p.id),
      groups: groups.map((g) => ({
        categoryId: g.categoryId,
        name: g.name ?? T.machineNoCategory,
        products: g.products.map((p) => ({ id: p.id, name: p.name, code: p.barcode ?? p.sku, locked: !p.isAvailable })),
      })),
      total: products.filter((p) => !p.isGeneral).length,
    };
  }

  /* --------------------------------------------------------------------------------------------------------- ops */

  apply(op: string, a: Record<string, unknown>): unknown {
    switch (op) {
      case 'catalog.open':
        return this.openScreen(optStr(a.productId));
      case 'catalog.close':
        this.c.signedIn();
        this.reset();
        return undefined;
      case 'catalog.panel': {
        this.mustBeOpen();
        const p = a.panel;
        if (p !== 'products' && p !== 'categories' && p !== 'till') return this.c.refuse('invalid_args');
        this.panel = p;
        return undefined;
      }
      case 'catalog.filter':
        return this.setFilter(a);
      case 'catalog.more':
        this.mustBeOpen();
        this.limit += ROWS_PAGE;
        return undefined;
      case 'catalog.page':
        return this.openPage(a.productId === null || a.productId === undefined ? null : optStr(a.productId) ?? this.c.refuse('invalid_args'));
      case 'catalog.pageClose':
        this.mustBeOpen();
        this.page = null;
        this.ask = null;
        return undefined;
      case 'catalog.save':
        return this.save(a);
      case 'catalog.add':
        return this.add(a);
      case 'catalog.priceLevel': {
        this.mustBeOpen();
        const level = a.level === 'area' || a.level === 'shop' ? a.level : null;
        const ask = this.ask;
        if (!ask || !level || !ask.decision.choices.some((ch) => ch.level === level && ch.enabled)) return this.c.refuse('invalid_args');
        this.ask = null;
        return ask.go(level);
      }
      case 'catalog.priceCancel':
        this.mustBeOpen();
        this.ask = null;
        return undefined;
      case 'catalog.setAvailable':
        return this.setAvailable(a);
      case 'catalog.moveCategory':
        return this.moveCategory(a);
      case 'catalog.photo':
        return this.photoOp(a);
      case 'catalog.categoryAdd':
        return this.categoryAdd(a);
      case 'catalog.categoryRename':
        return this.categoryRename(a);
      case 'catalog.categoryActive':
        return this.categoryActive(a);
      case 'catalog.machineAuth':
        return this.machineAuth();
      case 'catalog.machineSave':
        return this.machineSave(a);
      case 'catalog.release':
        this.c.signedIn();
        this.held = null;
        this.machineApprover = null;
        return undefined;
      case 'catalog.dismiss':
        this.note = null;
        return undefined;
      default:
        return this.c.refuse('invalid_args');
    }
  }

  private reset() {
    this.open = false;
    this.openedBy = null;
    this.panel = 'products';
    this.filter = { query: '', categoryId: null, channel: null, state: 'any', showOutOfScope: false };
    this.limit = ROWS_PAGE;
    this.note = null;
    this.held = null;
    this.page = null;
    this.ask = null;
    this.machineApprover = null;
    this.memo = null;
  }

  private mustBeOpen(): RosterUser {
    const u = this.c.signedIn();
    if (!this.open || this.openedBy !== u.id) return this.c.refuse('invalid_args');
    return u;
  }

  /** "ניהול קטלוג" (or "פתח בניהול קטלוג" from a tile): CATALOG_VIEW, as the menu's row asks it; then the cloud's view. */
  private openScreen(productId: string | null): unknown {
    const u = this.c.signedIn();
    const settings = catalogSettingsOf(this.params());
    if (!settings.enabled) return this.c.refuse('permission_denied', T.notAllowed);
    if (!this.shiftOpen() && !(settings.managerWithoutShift && entryShown(settings, false, this.userFacts(u), 'allowed', 'disable'))) return this.c.refuse('shift_not_open');
    if (productId !== null && !this.products().some((p) => p.id === productId)) return this.c.refuse('invalid_args');
    return this.c.gate(
      CATALOG_PERM.VIEW,
      () => {
        if (!this.open || this.openedBy !== u.id) this.reset();
        this.open = true;
        this.openedBy = u.id;
        if (productId !== null) {
          this.panel = 'products';
          this.page = { key: this.nextPageKey(), productId };
        }
        void this.c.later(() => this.refreshView());
        return undefined;
      },
      { title: T.title },
    );
  }

  /** The cloud's `catalogAdminView` (it travels beside the parameters, which the till's pull keeps apart): kept on the disk. */
  private async refreshView() {
    const m = this.c.svc.machineId;
    if (!m) return;
    const r = await this.c.svc.api.get<Record<string, unknown>>(`sync/${m}/parameters`, { timeoutMs: 15_000 });
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object') return;
    const v = parseCatalogView(r.body.catalogAdminView);
    if (v) this.c.svc.kv.setJson(KV_VIEW, r.body.catalogAdminView);
    else this.c.svc.kv.delete(KV_VIEW);
    this.viewRaw = v ? r.body.catalogAdminView : null;
    this.memo = null;
    this.c.changed();
  }

  private setFilter(a: Record<string, unknown>) {
    this.mustBeOpen();
    const f = { ...this.filter };
    if (a.query !== undefined) {
      if (typeof a.query !== 'string') return this.c.refuse('invalid_args');
      f.query = a.query.slice(0, 80);
    }
    if (a.categoryId !== undefined) {
      if (a.categoryId !== null && typeof a.categoryId !== 'string') return this.c.refuse('invalid_args');
      // Tapping the chosen chip again: back to all.
      f.categoryId = a.categoryId === null || a.categoryId === '' || a.categoryId === f.categoryId ? null : a.categoryId;
    }
    if (a.channel !== undefined) {
      if (a.channel !== null && a.channel !== '' && !SALES_CHANNELS.includes(a.channel as SalesChannel)) return this.c.refuse('invalid_args');
      f.channel = a.channel === null || a.channel === '' ? null : (a.channel as SalesChannel);
    }
    if (a.state !== undefined) {
      if (!STATE_FILTERS.includes(a.state as StateFilter)) return this.c.refuse('invalid_args');
      f.state = a.state as StateFilter;
    }
    if (a.showOutOfScope !== undefined) {
      if (typeof a.showOutOfScope !== 'boolean') return this.c.refuse('invalid_args');
      f.showOutOfScope = a.showOutOfScope;
    }
    this.filter = f;
    this.limit = ROWS_PAGE;
    return undefined;
  }

  private nextPageKey() {
    this.pageSeq += 1;
    return `pg${this.pageSeq}`;
  }

  private openPage(productId: string | null) {
    this.mustBeOpen();
    if (productId === null) {
      const g = this.gate('create');
      if (g.kind === 'hidden') return this.c.refuse('permission_denied', T.notAllowed);
      if (g.kind === 'disabled') return this.c.refuse('permission_denied', g.reason);
    } else if (!this.products().some((p) => p.id === productId)) return this.c.refuse('invalid_args');
    this.page = { key: this.nextPageKey(), productId };
    this.ask = null;
    return undefined;
  }

  /* ----------------------------------------------------------------------------------------------- authority */

  /**
   * The gates of [actions], decided now: one denied — refused here (the screen never offers it); those that need an
   * approval the screen does not hold — the manager's code, one after the other, each kept; then [run] with who signs.
   */
  private authorize(actions: CatalogAction[], run: (by: ApproverRef | null) => unknown, codes?: string[]): unknown {
    const u = this.c.signedIn();
    if (this.busy) return this.c.refuse('invalid_args', T.saving);
    const list = codes ?? actions.map((x) => ACTION_CODE[x]);
    if (!codes) {
      for (const action of actions) {
        const g = this.gate(action);
        if (!usable(g)) return this.c.refuse('permission_denied', g.kind === 'disabled' ? g.reason : catalogDeniedText(ACTION_CODE[action]));
      }
    }
    const missing = list.filter((code) => this.c.decide(code) !== 'allowed' && this.heldFor(code) === null);
    if (missing.length === 0) {
      const by = list.map((code) => this.heldFor(code)).find((x) => x !== null) ?? null;
      return run(by);
    }
    const code = missing[0];
    return this.c.gate(
      code,
      (by) => {
        if (by) this.hold(by, code, u);
        return this.authorize(actions, run, list);
      },
      { title: T.title, body: `${catalogLabel(code)} — ${T.needsApproval}` },
    );
  }

  private hold(by: ApproverRef, code: string, u: RosterUser) {
    const keep = this.held && this.held.userId === u.id && this.held.by.id === by.id && this.c.now() <= this.held.until ? this.held.codes : new Set<string>();
    keep.add(code);
    // The approver's own answer covers the screen's other writes too (Android's catalog grant): kept as well.
    const approver = this.c.roster().find((x) => x.id === by.id);
    if (approver) for (const other of Object.values(ACTION_CODE)) if (permissionState(approver, other) === 'allow') keep.add(other);
    this.held = { by, codes: keep, until: this.c.now() + HELD_MS, userId: u.id };
  }

  private headers(by: ApproverRef | null, token?: string | null): Record<string, string> {
    const id = by?.id ?? this.c.operator()?.id ?? null;
    const h: Record<string, string> = {};
    if (token) h['X-Elevation-Token'] = token;
    if (id) h['X-Pos-User-Id'] = id;
    return h;
  }

  /** One write at a time: busy, the work in `later`, then the outcome said. */
  private write(work: () => Promise<Outcome>, success: string, after?: (o: Outcome) => void): void {
    this.busy = true;
    this.note = null;
    this.c.changed();
    void this.c.later(async () => {
      let o: Outcome;
      try {
        o = await work();
      } catch (e) {
        this.c.log(`catalog admin: ${e instanceof Error ? e.message : String(e)}`);
        o = { kind: 'failed', text: T.notAllowed };
      }
      this.busy = false;
      this.say(o, success);
      after?.(o);
      if (o.kind === 'grant') this.priceGrant(o.retry);
      this.memo = null;
      this.c.changed();
    });
  }

  private say(o: Outcome, success: string) {
    if (o.kind === 'grant') this.note = null;
    else if (o.kind === 'saved') this.note = { text: o.note ?? success, tone: o.note ? 'info' : 'ok' };
    else if (o.kind === 'offline') this.note = { text: T.needsNetwork, tone: 'error' };
    else if (o.kind === 'shared') this.note = { text: T.sharedReadonly, tone: 'error' };
    else if (o.kind === 'elevation') this.note = { text: catalogDeniedText(CATALOG_PERM.WRITE), tone: 'error' };
    else this.note = { text: o.text, tone: 'error' };
  }

  /** A cloud answer as an outcome: pulled after a success (the server decides what a till may change). */
  private async outcomeOf(r: Reply, sharedId?: string): Promise<Outcome> {
    if (r.kind === 'offline') return { kind: 'offline' };
    if (r.kind === 'ok') {
      await this.pull(true);
      return { kind: 'saved' };
    }
    if (r.status === 401) {
      // The cloud disagrees with the till about this person: the approval held is given back.
      this.held = null;
      return { kind: 'elevation' };
    }
    if (sharedRefusal(r.status, r.body)) {
      if (sharedId) this.rememberShared(sharedId);
      return { kind: 'shared' };
    }
    return { kind: 'failed', text: priceRefusalMessage(r.body) ?? (r.status === 403 && typeof r.detail === 'string' && /[\u05D0-\u05EA]/.test(r.detail) ? r.detail : `HTTP ${r.status}`) };
  }

  private async pull(full: boolean) {
    await this.c.svc.sync.pullCatalog(full).catch(() => undefined);
    this.memo = null;
  }

  /* -------------------------------------------------------------------------------------------- the product page */

  private draftArg(raw: unknown): ProductDraft {
    const d = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    if (!d) return this.c.refuse('invalid_args');
    const s = (k: string, max: number) => (typeof d[k] === 'string' ? (d[k] as string).slice(0, max) : '');
    return {
      name: s('name', 200),
      price: s('price', 20),
      categoryId: s('categoryId', 80),
      sku: s('sku', 80),
      barcode: s('barcode', 80),
      description: s('description', 2000),
      stockQuantity: s('stockQuantity', 12).replace(/\D+/g, ''),
      isOpenPrice: d.isOpenPrice === true,
      isWeighed: d.isWeighed === true,
      unitLabel: s('unitLabel', 16),
      printTicket: d.printTicket === true,
      salesChannel: salesChannelOf(d.salesChannel),
    };
  }

  private photoArg(raw: unknown): Photo | null {
    if (raw === undefined || raw === null) return null;
    if (raw === 'remove') return { remove: true, keepBackground: true, enhance: false };
    if (typeof raw !== 'object' || Array.isArray(raw)) return this.c.refuse('invalid_args');
    const o = raw as Record<string, unknown>;
    if (o.remove === true) return { remove: true, keepBackground: true, enhance: false };
    if (typeof o.data !== 'string') return this.c.refuse('invalid_args');
    const bytes = new Uint8Array(Buffer.from(o.data.replace(/^data:[^,]*,/, ''), 'base64'));
    if (bytes.length === 0 || bytes.length > PHOTO_MAX_BYTES || !photoFormatOf(bytes)) return this.c.refuse('invalid_args', T.photoUnreadable);
    return {
      bytes,
      keepBackground: typeof o.keepBackground === 'boolean' ? o.keepBackground : DEFAULT_KEEP_BACKGROUND,
      enhance: typeof o.enhance === 'boolean' ? o.enhance : DEFAULT_ENHANCE,
    };
  }

  /**
   * "שמירה" of a product's page: only what changed (the cloud splits "this shop's price" from "the chain's master record" by
   * the fields that arrived). A changed price asks where it goes when the cloud has levels ("איפה לשנות?").
   */
  private save(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const id = optStr(a.productId);
    const p = id ? this.products().find((x) => x.id === id) : null;
    if (!p) return this.c.refuse('invalid_args');
    const draft = this.draftArg(a.draft);
    const err = draftError(draft);
    if (err) return this.c.refuse('invalid_args', err);
    const photo = this.photoArg(a.photo);
    const categories = this.categoriesList();
    const mode = resolveTicketMode(p.ticketMode, categories.find((x) => x.id === p.categoryId)?.ticketMode);
    const gEdit = this.gate('edit');
    const gPrice = this.gate('price');
    const shared = this.shared().has(p.id);
    const editOk = usable(gEdit) && !shared;
    const priceOk = usable(gPrice);
    // What the operator may not change is read as it is (CatalogAdminScreen.edit()).
    const edit = diffEdit(p, {
      name: editOk ? draft.name : p.name,
      price: priceOk ? draft.price : String(p.price),
      categoryId: editOk ? draft.categoryId : p.categoryId,
      description: editOk ? draft.description : (p.description ?? ''),
      barcode: editOk ? draft.barcode : (p.barcode ?? ''),
      isOpenPrice: editOk ? draft.isOpenPrice : p.isOpenPrice,
      isWeighed: editOk ? draft.isWeighed : p.isWeighed,
      unitLabel: editOk ? draft.unitLabel : (p.unitLabel ?? ''),
      stock: editOk ? draft.stockQuantity : '',
    });
    const ticketWas = mode !== 'off';
    const ticketMode = !editOk || draft.printTicket === ticketWas ? null : draft.printTicket ? 'per_unit' : 'off';
    const salesChannel = editOk && draft.salesChannel !== p.salesChannel ? draft.salesChannel : null;
    const photoChange = editOk && catalogSettingsOf(this.params()).photoFromTill ? photo : null;
    const other = otherChanged(edit) || ticketMode !== null || salesChannel !== null || photoChange !== null;
    const actions = actionsFor(priceChanged(edit), other);
    if (actions.length === 0) {
      this.page = null;
      this.note = { text: T.saved, tone: 'ok' };
      return undefined;
    }
    const send = (priceLevel: PriceLevel | null, token: string | null) =>
      this.authorize(actions, (by) => this.write(() => this.saveWork(p, edit, ticketMode, salesChannel, photoChange, priceLevel, by, token), T.saved, (o) => this.afterPage(o)));
    if (!priceChanged(edit)) return send(null, null);
    // "שינוי מחיר מהקופה": where the price goes, as the cloud allows (core/till/tillPriceLevel.ts).
    return this.authorize(actions, () => {
      this.busy = true;
      this.c.changed();
      void this.c.later(async () => {
        const { decision, approvalRequired } = await this.priceDecision(p.id);
        this.busy = false;
        if (decision === null) this.note = { text: T.needsNetwork, tone: 'error' };
        else if (decision.kind === 'legacy') send(null, null);
        else if (decision.kind === 'off') this.note = { text: PRICE_LEVEL_TEXT.off, tone: 'error' };
        else {
          const go = (level: PriceLevel) => (approvalRequired ? this.priceGrant((token) => send(level, token)) : send(level, null));
          if (decision.kind === 'use') go(decision.level);
          else this.ask = { decision, go };
        }
        this.c.changed();
      });
      return undefined;
    });
  }

  /** price-options: null with no connection; an older server (404) or any other refusal — legacy. */
  private async priceDecision(productId: string): Promise<{ decision: PriceDecision | null; approvalRequired: boolean }> {
    const m = this.c.svc.machineId;
    if (!m) return { decision: null, approvalRequired: false };
    const r = await this.c.svc.api.get(`sync/${m}/products/${encodeURIComponent(productId)}/price-options`, { timeoutMs: 15_000 });
    if (r.kind === 'offline') return { decision: null, approvalRequired: false };
    const options = r.kind === 'ok' ? priceOptionsOf(r.body) : null;
    return { decision: decidePriceLevel(options), approvalRequired: options?.approvalRequired === true };
  }

  /**
   * "תמיד באישור מורשה" (`tillPriceChangeApproval`): an authorised person's code — one of the shop's whose own answer for
   * CATALOG_PRICE is "allow" — and the cloud's grant for `catalog:price`, sent as `X-Elevation-Token`.
   */
  private priceGrant(then: (token: string) => unknown): unknown {
    let token: string | null = null;
    return this.c.ask({
      kind: 'manager_approval',
      title: T.title,
      body: `${catalogLabel(CATALOG_PERM.PRICE)} — ${T.needsApproval}`,
      fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
      actions: [
        { id: 'approve', label: 'אישור', primary: true },
        { id: 'cancel', label: T.cancel },
      ],
      code: null,
      verify: async (pin) => {
        const users = loginCandidates(this.c.roster(), this.c.shopId()).filter((x) => permissionState(x, CATALOG_PERM.PRICE) === 'allow');
        const u = await findByPin(users, pin.trim(), this.c.compare);
        if (!u) return { ok: false, message: 'קוד מנהל שגוי' };
        const r = await this.c.svc.api.post<{ token?: string }>('elevation/sessions', { posUserId: u.id, pin: pin.trim(), scopes: ['catalog:price'] }, { timeoutMs: 15_000 });
        if (r.kind === 'offline') return { ok: false, message: T.needsNetwork };
        if (r.kind === 'refused' || typeof r.body?.token !== 'string' || !r.body.token) return { ok: false, message: catalogDeniedText(CATALOG_PERM.PRICE) };
        token = r.body.token;
        return { ok: true, by: { id: u.id, name: displayName(u) } };
      },
      resume: () => (token ? then(token) : undefined),
    });
  }

  private async saveWork(
    p: AdminProduct,
    edit: ReturnType<typeof diffEdit>,
    ticketMode: string | null,
    salesChannel: SalesChannel | null,
    photo: Photo | null,
    priceLevel: PriceLevel | null,
    by: ApproverRef | null,
    token: string | null,
  ): Promise<Outcome> {
    const m = this.c.svc.machineId;
    if (!m) return { kind: 'offline' };
    const id = encodeURIComponent(p.id);
    let rest = edit;
    if (priceLevel !== null && edit.price !== undefined) {
      // The price first, at its level, on the same authority; the rest after it.
      const r = await this.c.svc.api.put(`sync/${m}/products/${id}/price`, { price: edit.price, level: priceLevel }, { headers: this.headers(by, token), timeoutMs: 20_000 });
      if (r.kind !== 'ok') {
        // "שינוי מחיר דורש אישור מורשה" (the cloud's 401 — a grant held may have run out too): the authorised person's
        // code, and the very same save again with their grant.
        if (r.kind === 'refused' && r.status === 401 && !token) {
          return { kind: 'grant', retry: (t) => this.write(() => this.saveWork(p, edit, ticketMode, salesChannel, photo, priceLevel, by, t), T.saved, (o) => this.afterPage(o)) };
        }
        return this.outcomeOf(r, p.id);
      }
      rest = { ...edit, price: undefined };
    }
    const patch = patchOf(rest, { ticketMode, salesChannel });
    if (Object.keys(patch).length > 0) {
      const r = await this.c.svc.api.put(`sync/${m}/products/${id}`, patch, { headers: this.headers(by, token), timeoutMs: 20_000 });
      if (r.kind !== 'ok') return this.outcomeOf(r, p.id);
    }
    if (photo) {
      const note = await this.sendPhoto(p.id, photo, by);
      await this.pull(true);
      if (note) return Object.keys(patch).length > 0 || priceLevel !== null ? { kind: 'saved', note } : { kind: 'failed', text: note };
      return { kind: 'saved' };
    }
    await this.pull(true);
    return { kind: 'saved' };
  }

  private afterPage(o: Outcome) {
    if (o.kind === 'saved') {
      this.page = null;
      this.ask = null;
    }
  }

  /** "+ מוצר חדש": the product, then its picture (the product exists from there on: a refused picture is said, never retried). */
  private add(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const draft = this.draftArg(a.draft);
    const err = draftError(draft);
    if (err) return this.c.refuse('invalid_args', err);
    if (!this.categoriesList().some((x) => x.id === draft.categoryId)) return this.c.refuse('invalid_args', T.categoryRequired);
    const photo = catalogSettingsOf(this.params()).photoFromTill ? this.photoArg(a.photo) : null;
    return this.authorize(['create'], (by) =>
      this.write(
        async () => {
          const m = this.c.svc.machineId;
          if (!m) return { kind: 'offline' };
          const r = await this.c.svc.api.post<{ id?: unknown }>(`sync/${m}/products`, createBody(draft), { headers: this.headers(by), timeoutMs: 20_000 });
          if (r.kind !== 'ok') return this.outcomeOf(r);
          const created = typeof r.body?.id === 'string' ? r.body.id : null;
          const note = photo && !photo.remove && created ? await this.sendPhoto(created, photo, by) : null;
          await this.pull(true);
          return note ? { kind: 'saved', note } : { kind: 'saved' };
        },
        T.saved,
        (o) => this.afterPage(o),
      ),
    );
  }

  /** The picture alone ("הוספת תמונה" / "הסר תמונה" saved by itself). */
  private photoOp(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const id = optStr(a.productId);
    if (!id || !this.products().some((p) => p.id === id)) return this.c.refuse('invalid_args');
    if (!catalogSettingsOf(this.params()).photoFromTill) return this.c.refuse('permission_denied', T.notAllowed);
    if (this.shared().has(id)) return this.c.refuse('permission_denied', T.photoShared);
    const photo = this.photoArg(a.remove === true ? 'remove' : a);
    if (!photo) return this.c.refuse('invalid_args');
    return this.authorize(['edit'], (by) =>
      this.write(async () => {
        const note = await this.sendPhoto(id, photo, by);
        await this.pull(true);
        return note ? { kind: 'failed', text: note } : { kind: 'saved', note: T.photoSaved };
      }, T.photoSaved),
    );
  }

  /** The picture to the cloud: null when it is there, else what to say. */
  private async sendPhoto(productId: string, photo: Photo, by: ApproverRef | null): Promise<string | null> {
    const m = this.c.svc.machineId;
    if (!m) return T.photoOffline;
    const path = `sync/${m}/products/${encodeURIComponent(productId)}/image`;
    if (photo.remove) {
      const r = await this.c.svc.api.request('DELETE', path, { headers: this.headers(by), timeoutMs: 20_000 });
      if (r.kind === 'ok') return null;
      if (r.kind === 'offline') return T.photoOffline;
      if (sharedRefusal(r.status, r.body)) {
        this.rememberShared(productId);
        return T.photoShared;
      }
      return T.photoFailed(r.status);
    }
    const bytes = photo.bytes!;
    const fmt = photoFormatOf(bytes)!;
    const creds = this.c.svc.cloud.credentials();
    const url = `${this.c.svc.api.url(path)}?keepBackground=${photo.keepBackground}&enhance=${photo.enhance}`;
    const form = new FormData();
    form.append('file', new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: fmt.mime }), fmt.uploadName);
    const headers: Record<string, string> = { Accept: 'application/json', ...this.headers(by) };
    if (creds?.accessToken) headers.Authorization = `Bearer ${creds.accessToken}`;
    let res: Response;
    try {
      res = await (this.d.fetch ?? fetch)(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60_000) });
    } catch {
      return T.photoOffline;
    }
    if (res.ok) return null;
    if (res.status === 502 || res.status === 503 || res.status === 504) return T.photoOffline;
    const body = await res.text().catch(() => '');
    if (sharedRefusal(res.status, body)) {
      this.rememberShared(productId);
      return T.photoShared;
    }
    return T.photoFailed(res.status);
  }

  /* ------------------------------------------------------------------------------------------------ availability */

  /**
   * "הפוך ללא פעיל / לפעיל / החזר לברירת המחדל" and "אזל להיום" for one product or several, at a level: on this till at
   * once, then to the cloud — queued when it does not answer.
   */
  private setAvailable(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const ids = strList(a.productIds) ?? this.c.refuse('invalid_args');
    const change = a.change;
    if (change !== 'off' && change !== 'on' && change !== 'inherit' && change !== 'sold_out_today') return this.c.refuse('invalid_args');
    const scope = a.scope === 'machine' || a.scope === 'area' || a.scope === 'shop' ? a.scope : null;
    if (!scope || (scope === 'area' && !this.area())) return this.c.refuse('invalid_args', T.scopeNoArea);
    const products = this.products();
    const targets = ids.map((id) => products.find((p) => p.id === id)).filter((p): p is AdminProduct => !!p);
    if (targets.length === 0 || targets.length !== ids.length) return this.c.refuse('invalid_args');
    const permanent = change === 'off' && typeof a.permanent === 'boolean' ? a.permanent : null;
    return this.authorize(['availability'], (by) =>
      this.write(async () => {
        const at = new Date(this.c.now()).toISOString();
        const locks: PendingLock[] = targets.map((p) => ({ productId: p.id, scope, change, permanent, atIso: at, by: by?.id ?? this.c.operator()?.id ?? null }));
        // Queued before it is applied: a pull landing in between puts it back.
        this.queueLocks(locks);
        this.applyLocally(locks);
        const outcomes = [];
        for (const l of locks) outcomes.push(await this.deliver(l));
        if (outcomes.some((o) => o !== 'queued')) await this.pull(false);
        this.reapply();
        if (outcomes.some((o) => o === 'refused')) return { kind: 'failed', text: T.availabilityRefused };
        if (outcomes.some((o) => o === 'queued')) {
          this.armLocks();
          return { kind: 'saved', note: T.availabilityQueued };
        }
        return { kind: 'saved' };
      }, T.activeSaved),
    );
  }

  private pendingLocks(): PendingLock[] {
    const raw = this.c.svc.kv.getJson<unknown>(KV_LOCKS);
    return Array.isArray(raw) ? (raw.filter((x) => x && typeof x === 'object' && typeof (x as PendingLock).productId === 'string') as PendingLock[]) : [];
  }

  private queueLocks(locks: PendingLock[]) {
    // One row per product: a second change replaces the first.
    const ids = new Set(locks.map((l) => l.productId));
    this.c.svc.kv.setJson(KV_LOCKS, [...this.pendingLocks().filter((l) => !ids.has(l.productId)), ...locks]);
  }

  private dropLock(l: PendingLock) {
    this.c.svc.kv.setJson(
      KV_LOCKS,
      this.pendingLocks().filter((x) => !(x.productId === l.productId && x.atIso === l.atIso && x.change === l.change && x.scope === l.scope)),
    );
  }

  /** The stored rows as the locks say: off / sold out — not sold here; on / inherit — sold. */
  private applyLocally(locks: readonly PendingLock[]) {
    const rows = this.c.svc.cloud.catalog().products;
    const changed: Array<Record<string, unknown>> = [];
    for (const l of locks) {
      const row = rows.find((r) => String(r.id) === l.productId);
      if (!row) continue;
      const available = !lockedBy(l.change);
      const was = adminProductOf(row)?.isAvailable;
      if (was === available) continue;
      const next: Record<string, unknown> = { ...row, isAvailable: available };
      if (typeof row.lockAvailable === 'boolean') next.lockAvailable = available;
      changed.push(next);
    }
    if (changed.length === 0) return;
    this.c.svc.cloud.applyCatalog({ syncType: 'delta', products: changed });
    this.memo = null;
    (this.d.catalogChanged ?? (() => void this.c.svc.syncMedia().catch(() => undefined)))();
  }

  /** Every queued lock back over a pull that still carries the cloud's old state. */
  private reapply() {
    const pending = this.pendingLocks();
    if (pending.length > 0) this.applyLocally(pending);
  }

  private async deliver(l: PendingLock): Promise<'sent' | 'queued' | 'refused'> {
    const m = this.c.svc.machineId;
    if (!m) return 'queued';
    const r = await this.c.svc.api.put(`sync/${m}/products/${encodeURIComponent(l.productId)}/availability`, availabilityBody(l.change, l.scope, l.permanent, l.atIso), {
      headers: l.by ? { 'X-Pos-User-Id': l.by } : {},
      timeoutMs: 15_000,
    });
    const out = r.kind === 'ok' ? 'sent' : r.kind === 'offline' || r.status >= 500 || r.status === 408 || r.status === 429 ? 'queued' : 'refused';
    if (out === 'refused') this.c.log(`catalog admin: availability ${l.productId} refused by the cloud: HTTP ${r.kind === 'refused' ? r.status : '?'}`);
    if (out !== 'queued') this.dropLock(l);
    return out;
  }

  private armLocks() {
    if (this.lockTimer) return;
    this.lockTimer = setInterval(() => void this.c.later(() => this.retryLocks()), LOCK_RETRY_MS);
    (this.lockTimer as { unref?: () => void }).unref?.();
  }

  /** The queue tried again: whatever reached the cloud, the catalog pulled; what waits, put back over the rows. */
  async retryLocks(): Promise<void> {
    const pending = this.pendingLocks();
    if (pending.length === 0) {
      if (this.lockTimer) clearInterval(this.lockTimer);
      this.lockTimer = null;
      return;
    }
    let settled = false;
    for (const l of pending) {
      const o = await this.deliver(l);
      if (o === 'queued') break;
      settled = true;
    }
    if (settled) await this.pull(false);
    this.reapply();
    this.c.changed();
  }

  /* ---------------------------------------------------------------------------------------------- bulk, categories */

  /** "שינוי מחלקה" for several products: one edit each, online, counted. */
  private moveCategory(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const ids = strList(a.productIds) ?? this.c.refuse('invalid_args');
    const categoryId = optStr(a.categoryId);
    if (!categoryId || !this.categoriesList().some((x) => x.id === categoryId)) return this.c.refuse('invalid_args');
    const products = this.products();
    const targets = ids.map((id) => products.find((p) => p.id === id)).filter((p): p is AdminProduct => !!p);
    if (targets.length === 0) return this.c.refuse('invalid_args');
    return this.authorize(['edit'], (by) =>
      this.write(async () => {
        const m = this.c.svc.machineId;
        if (!m) return { kind: 'offline' };
        let failed = 0;
        let shared = 0;
        for (const p of targets) {
          if (p.categoryId === categoryId) continue;
          const r = await this.c.svc.api.put(`sync/${m}/products/${encodeURIComponent(p.id)}`, { categoryId }, { headers: this.headers(by), timeoutMs: 20_000 });
          if (r.kind === 'offline') return { kind: 'offline' };
          if (r.kind === 'ok') continue;
          if (r.status === 401) {
            this.held = null;
            return { kind: 'elevation' };
          }
          if (sharedRefusal(r.status, r.body)) {
            shared += 1;
            this.rememberShared(p.id);
          } else failed += 1;
        }
        await this.pull(true);
        return failed + shared === 0 ? { kind: 'saved' } : { kind: 'saved', note: T.bulkPartial(targets.length - failed - shared, failed + shared) };
      }, T.saved),
    );
  }

  private categoryAdd(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 120) : '';
    if (!name) return this.c.refuse('invalid_args', T.nameRequired);
    return this.authorize(['create'], (by) =>
      this.write(async () => {
        const m = this.c.svc.machineId;
        if (!m) return { kind: 'offline' };
        return this.outcomeOf(await this.c.svc.api.post(`sync/${m}/categories`, { name, isActive: true, sortOrder: 0 }, { headers: this.headers(by), timeoutMs: 20_000 }));
      }, T.saved),
    );
  }

  private categoryRename(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const id = optStr(a.categoryId);
    const name = typeof a.name === 'string' ? a.name.trim().slice(0, 120) : '';
    if (!id || !this.categoriesList().some((x) => x.id === id)) return this.c.refuse('invalid_args');
    if (!name) return this.c.refuse('invalid_args', T.nameRequired);
    return this.authorize(['edit'], (by) =>
      this.write(async () => {
        const m = this.c.svc.machineId;
        if (!m) return { kind: 'offline' };
        return this.outcomeOf(await this.c.svc.api.put(`sync/${m}/categories/${encodeURIComponent(id)}`, { name }, { headers: this.headers(by), timeoutMs: 20_000 }));
      }, T.saved),
    );
  }

  /** "פעיל / לא פעיל" of a category at a level: online (the Android till's direct call). */
  private categoryActive(a: Record<string, unknown>): unknown {
    this.mustBeOpen();
    const id = optStr(a.categoryId);
    if (!id || !this.categoriesList().some((x) => x.id === id)) return this.c.refuse('invalid_args');
    const scope = a.scope === 'machine' || a.scope === 'area' || a.scope === 'shop' ? a.scope : null;
    if (!scope || (scope === 'area' && !this.area())) return this.c.refuse('invalid_args', T.scopeNoArea);
    const active = a.active === true ? true : a.active === false ? false : a.active === null ? null : undefined;
    if (active === undefined) return this.c.refuse('invalid_args');
    const body: Record<string, unknown> = { scope, active };
    if (active === false && typeof a.permanent === 'boolean') body.permanent = a.permanent;
    return this.authorize(['availability'], (by) =>
      this.write(async () => {
        const m = this.c.svc.machineId;
        if (!m) return { kind: 'offline' };
        return this.outcomeOf(await this.c.svc.api.put(`sync/${m}/categories/${encodeURIComponent(id)}/availability`, body, { headers: this.headers(by), timeoutMs: 20_000 }));
      }, T.activeSaved),
    );
  }

  /* --------------------------------------------------------------------------------------------- "קטלוג למסוף" */

  /** "אישור מנהל" on "קטלוג למסוף": a manager's code for CATALOG_WRITE (a cashier sees nothing of the list before it). */
  private machineAuth(): unknown {
    const u = this.mustBeOpen();
    return this.c.gate(
      CATALOG_PERM.WRITE,
      (by) => {
        if (by) {
          this.machineApprover = by;
          this.hold(by, CATALOG_PERM.WRITE, u);
        }
        return undefined;
      },
      { askOnDeny: true, title: T.machineTab, body: T.machineManagerOnly },
    );
  }

  private machineSave(a: Record<string, unknown>): unknown {
    const u = this.mustBeOpen();
    const mode: MachineCatalogMode | null = a.mode === 'all' || a.mode === 'selected' ? a.mode : null;
    const ids = strList(a.productIds);
    if (!mode || !ids) return this.c.refuse('invalid_args');
    const by = this.c.decide(CATALOG_PERM.WRITE) === 'allowed' ? null : (this.heldFor(CATALOG_PERM.WRITE) ?? (this.held?.userId === u.id ? this.machineApprover : null));
    if (this.c.decide(CATALOG_PERM.WRITE) !== 'allowed' && !by) return this.c.refuse('permission_denied', T.machineManagerOnly);
    if (this.busy) return this.c.refuse('invalid_args', T.saving);
    const products = this.products();
    const list = machineListToSend(new Set(ids), products);
    this.busy = true;
    this.note = null;
    this.c.changed();
    void this.c.later(async () => {
      const m = this.c.svc.machineId;
      const r = m ? await this.c.svc.api.put(`sync/${m}/machine-catalog`, { mode, productIds: list }, { headers: this.headers(by), timeoutMs: 20_000 }) : ({ kind: 'offline', reason: 'unpaired' } as const);
      this.busy = false;
      if (r.kind === 'ok') {
        await this.pull(false);
        this.note = { text: T.machineSaved, tone: 'ok' };
      } else if (r.kind === 'offline') this.note = { text: T.machineOffline, tone: 'error' };
      else if (r.status === 401) {
        this.held = null;
        this.machineApprover = null;
        this.note = { text: T.machineManagerOnly, tone: 'error' };
      } else if (r.status === 404) {
        // The shop stopped selling something that was ticked: everything pulled, so the list is the shop's real one.
        await this.pull(true);
        this.note = { text: T.machineRefused, tone: 'error' };
      } else this.note = { text: `HTTP ${r.status}`, tone: 'error' };
      this.memo = null;
      this.c.changed();
    });
    return undefined;
  }
}

/* ------------------------------------------------------------------------------------------------------- helpers */

function closedState(shown: boolean): CatalogAdminState {
  const g = { offered: false, usable: false, approval: false, reason: null };
  return {
    entryShown: shown,
    open: false,
    panel: 'products',
    title: T.title,
    scopeLine: '',
    busy: false,
    note: null,
    approvedBy: null,
    gates: { availability: g, price: g, edit: g, create: g },
    canSelect: false,
    filter: { query: '', categoryId: null, channel: null, state: 'any', showOutOfScope: false },
    offerOutOfScope: false,
    stateChips: [],
    channelChips: [],
    categoryChips: [],
    rows: [],
    total: 0,
    hasArea: false,
    availabilityScope: 'shop',
    scopeOptions: [],
    categories: [],
    page: null,
    priceAsk: null,
    machine: null,
  };
}

function optStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function strList(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > 5000 || !v.every((x) => typeof x === 'string' && x)) return null;
  return [...new Set(v as string[])];
}

function catalogLabel(code: string): string {
  return CATALOG_PERM_LABEL[code] ?? code;
}
