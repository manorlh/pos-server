/**
 * "חסומים כעת" and "חסום / אזל" on the Windows till (pos-android ui/blocks/ItemBlocksUi.kt, ItemBlockSheet.kt,
 * data/repo/ItemBlocksRepository.kt, data/remote/ItemBlocksApi.kt): the rules and words are core/till/itemBlocks.ts; this
 * module asks the cloud (`GET /sync/{m}/item-blocks`, `POST …`, `POST …/{id}/clear` — the operator, or the manager who
 * approved, in `X-Pos-User-Id`), builds the sheet's options for the operator, and pulls the catalog after every write so the
 * sale's "חסום" / "אזל" follows. Nothing is queued: offline the list comes from the stored catalog, read-only.
 *
 * Electron-free.
 */

import {
  ALL_CHANNELS,
  CHANNEL_LABEL,
  IB_TEXT,
  ITEM_BLOCK_CAPABILITY,
  access,
  activeFor,
  blockOf,
  blocksFromCatalog,
  categoryChain,
  cloudReachOf,
  effectiveLevel,
  inForceAt,
  isWide,
  mayBlock,
  offeredLevels,
  policyFromParameters,
  policyOf,
  reachFor,
  refusalText,
  releaseNeedsWide,
  releaseWhy,
  releaseWhyText,
  requestAccess,
  requestBody,
  requestRefusal,
  rowWords,
  untilText,
  type Access,
  type BlockReach,
  type BlockRequest,
  type BlockView,
  type Channel,
  type Level,
  type WideState,
  type BlockRowView,
  type BlockSheetView,
  type BlocksListView,
} from '../../core/till/itemBlocks';
import type { TillContext } from './tillContext';

export { ITEM_BLOCK_CAPABILITY, type BlockRowView, type BlockSheetView, type BlocksListView };

interface SheetContext {
  machineId: string | null;
  areaId: string | null;
  reach: BlockReach | null;
  hasEvents: boolean;
  live: boolean;
  blocks: BlockView[];
  at: number;
}

export class TillItemBlocks {
  /** The last sheet's facts, by item key: what a request is checked against. */
  private readonly contexts = new Map<string, SheetContext>();

  constructor(
    private readonly c: TillContext,
    private readonly o: { wide: () => WideState; deniedHidden: () => boolean },
  ) {}

  start() {
    this.c.svc.setCapabilities('till.itemBlocks', () => (this.c.svc.fiscal && !this.c.svc.isKiosk() ? [ITEM_BLOCK_CAPABILITY] : []));
  }

  stop() {
    this.c.svc.setCapabilities('till.itemBlocks', null);
  }

  private headers(userId: string | null): Record<string, string> {
    const id = userId ?? this.c.operator()?.id ?? null;
    return id ? { 'X-Pos-User-Id': id } : {};
  }

  private async fetch(query: string): Promise<{ live: true; body: Record<string, unknown> } | { live: false }> {
    const m = this.c.svc.machineId;
    if (!m) return { live: false };
    const r = await this.c.svc.api.get<Record<string, unknown>>(`sync/${m}/item-blocks${query}`, { headers: this.headers(null), timeoutMs: 15_000 });
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object') return { live: false };
    return { live: true, body: r.body };
  }

  private catalogProducts() {
    return this.c.svc.cloud.catalog().products as Array<{ id?: unknown; name?: unknown; blocks?: unknown; categoryId?: unknown }>;
  }

  private reachOf(body: Record<string, unknown> | null, areaId: string | null): BlockReach | null {
    const policy = (body && policyOf(body.itemBlocks)) ?? policyFromParameters(this.c.svc.cloud.parameters());
    return reachFor(policy, body ? cloudReachOf(body.allowed) : null, areaId !== null);
  }

  private rowView(b: BlockView, live: boolean, reach: BlockReach | null): BlockRowView {
    const wide = this.o.wide();
    const why = releaseWhy(b, live, reach, wide);
    return { id: b.id, kind: b.kind, words: rowWords(b, this.c.now()), releasable: why === null, wide: releaseNeedsWide(b, reach), why: releaseWhyText(why, b.releaseHint) };
  }

  /** "חסומים כעת": the blocks in force that reach this device; offline — from the stored catalog, read-only. */
  async list(): Promise<BlocksListView> {
    this.c.signedIn();
    const now = this.c.now();
    const got = await this.fetch('');
    const policy = got.live ? (policyOf(got.body.itemBlocks) ?? policyFromParameters(this.c.svc.cloud.parameters())) : policyFromParameters(this.c.svc.cloud.parameters());
    if (!got.live) {
      return { live: false, banner: IB_TEXT.offline, rows: blocksFromCatalog(this.catalogProducts(), now).map((b) => this.rowView(b, false, null)), mayBlock: false };
    }
    const ctx = (got.body.context ?? {}) as Record<string, unknown>;
    const reach = this.reachOf(got.body, typeof ctx.areaId === 'string' ? ctx.areaId : null);
    const blocks = (Array.isArray(got.body.blocks) ? got.body.blocks : []).map(blockOf).filter((b): b is BlockView => !!b && inForceAt(b, now));
    return { live: true, banner: null, rows: blocks.map((b) => this.rowView(b, true, reach)), mayBlock: mayBlock(policy) };
  }

  /** "חסום / אזל · <פריט>": the item's blocks in force and the form's options for this operator. */
  async sheet(productId: string | null, categoryId: string | null): Promise<BlockSheetView> {
    this.c.signedIn();
    if (!!productId === !!categoryId) return this.c.refuse('invalid_args');
    const now = this.c.now();
    const data = this.c.svc.tillCatalogData();
    const product = productId ? (data.products.find((p) => p.id === productId) ?? null) : null;
    if (productId && !product) return this.c.refuse('invalid_args');
    const catId = categoryId ?? product?.categoryId ?? null;
    const raws = this.c.svc.cloud.catalog().categories;
    const nodes = raws.map((r) => ({ id: String(r.id ?? ''), parentId: typeof r.parentId === 'string' ? r.parentId : null, name: String(r.name ?? '') }));
    const catName = catId ? (nodes.find((n) => n.id === catId)?.name ?? null) : null;
    const got = await this.fetch(productId ? `?productId=${encodeURIComponent(productId)}` : `?categoryId=${encodeURIComponent(categoryId!)}`);
    const body = got.live ? got.body : null;
    const ctx = (body?.context ?? {}) as Record<string, unknown>;
    const areaId = typeof ctx.areaId === 'string' && ctx.areaId ? ctx.areaId : null;
    const machineId = (typeof ctx.machineId === 'string' && ctx.machineId) || this.c.svc.machineId;
    const policy = (body && policyOf(body.itemBlocks)) ?? policyFromParameters(this.c.svc.cloud.parameters());
    const reach = this.reachOf(body, areaId);
    const blocks = got.live ? (Array.isArray(body!.blocks) ? body!.blocks : []).map(blockOf).filter((b): b is BlockView => !!b) : blocksFromCatalog(this.catalogProducts(), now);
    const chain = categoryChain(catId, nodes);
    const active = activeFor(blocks, productId ? [productId] : [], categoryId ? chain : chain, now).filter((b) => (categoryId ? b.itemType === 'category' : true));
    const events = Array.isArray(body?.events) ? (body!.events as Array<Record<string, unknown>>).map((e) => ({ id: String(e.id ?? ''), name: String(e.name ?? '') })).filter((e) => e.id) : [];
    const wide = this.o.wide();
    const hidden = this.o.deniedHidden();
    const show = (a: Access) => !(a === 'locked_permission' && hidden);
    const channels = ALL_CHANNELS.map((v) => {
      const a = reach ? access(v, reach.channels, reach.localChannels, wide) : 'open';
      return { v, label: `${CHANNEL_LABEL[v]}${a === 'approval' ? IB_TEXT.withApproval : ''}`, access: a };
    }).filter((o) => show(o.access));
    const levels = offeredLevels(areaId !== null, events.length > 0)
      .map((v) => {
        const a = reach ? access(v, reach.levels, reach.localLevels, wide) : 'open';
        const label = v === 'shop' ? IB_TEXT.levelShop(typeof ctx.shopName === 'string' ? ctx.shopName : null) : v === 'area' ? IB_TEXT.levelArea(typeof ctx.areaName === 'string' ? ctx.areaName : null) : v === 'machine' ? IB_TEXT.levelMachine : IB_TEXT.levelEvent;
        return { v, label, access: a };
      })
      .filter((o) => show(o.access));
    const devices = (Array.isArray(body?.areaDevices) ? (body!.areaDevices as Array<Record<string, unknown>>) : []).map((d) => {
      const id = String(d.id ?? '');
      const here = id === machineId;
      const a = here || !reach ? 'open' : access('area', reach.levels, reach.localLevels, wide);
      return { id, label: `${String(d.name ?? '')} · ${d.isKiosk === true ? 'קיוסק' : 'קופה'}${here ? ' · המכשיר הזה' : a === 'approval' ? IB_TEXT.withApproval : ''}`, access: a as Access };
    });
    const notes: string[] = [];
    if ([...channels, ...levels].some((o) => o.access === 'locked_till')) notes.push(IB_TEXT.onlyManaging);
    if ([...channels, ...levels].some((o) => o.access === 'locked_permission')) notes.push(IB_TEXT.noWide);
    const free = (o: { access: Access }) => o.access !== 'locked_till' && o.access !== 'locked_permission';
    const defChannels = (reach?.defaultChannels ?? ALL_CHANNELS).filter((cv) => channels.some((o) => o.v === cv && free(o)));
    const defLevel = (() => {
      const pick = (v: Level | null | undefined) => (v && levels.some((o) => o.v === v && free(o)) ? v : null);
      return pick(reach?.defaultLevel) ?? pick(areaId ? 'area' : 'machine') ?? levels.filter(free).sort((a, b) => (a.v === 'machine' ? 0 : a.v === 'area' ? 1 : 2) - (b.v === 'machine' ? 0 : b.v === 'area' ? 1 : 2))[0]?.v ?? null;
    })();
    const key = productId ? `p:${productId}` : `c:${categoryId}`;
    this.contexts.set(key, { machineId, areaId, reach, hasEvents: events.length > 0, live: got.live, blocks: active, at: now });
    const name = product?.name ?? catName ?? IB_TEXT.theItem;
    const rows = active.map((b) => this.rowView(b, got.live, reach));
    return {
      title: IB_TEXT.sheetTitle(name),
      productId,
      categoryId,
      live: got.live,
      banner: got.live ? null : IB_TEXT.sheetOffline,
      rows,
      releaseAll: rows.filter((r) => r.releasable).length,
      mayBlock: mayBlock(policy) && got.live,
      what:
        product && catId
          ? [
              { v: 'product', label: product.name || IB_TEXT.theItem, id: product.id },
              { v: 'category', label: catName ? IB_TEXT.department(catName) : IB_TEXT.wholeDepartment, id: catId },
            ]
          : [],
      channels,
      levels,
      devices,
      events,
      defaults: { channels: defChannels.length > 0 ? defChannels : channels.filter(free).slice(0, 1).map((o) => o.v), level: defLevel, kind: 'sold_out' },
      notes,
      machineId,
    };
  }

  /**
   * A request checked against its sheet (the operator's reach, the access): what it is and whether it reaches beyond the
   * till (ITEM_BLOCK_WIDE). A locked option is refused here — the cloud would refuse it too.
   */
  plan(raw: Record<string, unknown>): { request: BlockRequest; wide: boolean; name: string | null } {
    const r: BlockRequest = {
      productId: typeof raw.productId === 'string' ? raw.productId : null,
      categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : null,
      kind: raw.kind === 'blocked' ? 'blocked' : 'sold_out',
      channels: Array.isArray(raw.channels) ? (raw.channels.filter((c) => ALL_CHANNELS.includes(c as Channel)) as Channel[]) : [],
      level: (['shop', 'area', 'machine', 'event'].includes(String(raw.level)) ? raw.level : 'area') as Level,
      levelId: typeof raw.levelId === 'string' && raw.levelId ? raw.levelId : null,
      kioskDisplay: raw.kioskDisplay === 'hide' || raw.kioskDisplay === 'grey' ? raw.kioskDisplay : null,
      note: typeof raw.note === 'string' ? raw.note : null,
      duration: durationOf(raw.duration),
    };
    const why = requestRefusal(r);
    if (why) return this.c.refuse('invalid_args', why === 'invalid' ? undefined : why);
    const ctx = this.contexts.get(r.productId ? `p:${r.productId}` : `c:${r.categoryId}`);
    if (!ctx || !ctx.live) return this.c.refuse('invalid_args', IB_TEXT.sheetOffline);
    const level = effectiveLevel(r.level, r.levelId ?? null, ctx.machineId);
    const a = requestAccess(ctx.reach, r.channels, level, this.o.wide());
    if (a === 'locked_till') return this.c.refuse('permission_denied', IB_TEXT.scopeNotAllowed);
    if (a === 'locked_permission') return this.c.refuse('permission_denied', IB_TEXT.noWide);
    return { request: r, wide: isWide(ctx.reach, r.channels, level), name: null };
  }

  /** The block to the cloud under [approverId]: its answer in words; the catalog pulled so the sale follows. */
  async send(r: BlockRequest, approverId: string | null): Promise<{ ok: boolean; message: string; needsWide?: boolean }> {
    const m = this.c.svc.machineId;
    if (!m) return { ok: false, message: IB_TEXT.sheetOffline };
    const reply = await this.c.svc.api.post<Record<string, unknown>>(`sync/${m}/item-blocks`, requestBody(r), { headers: this.headers(approverId), timeoutMs: 15_000 });
    if (reply.kind === 'offline') return { ok: false, message: IB_TEXT.sheetOffline };
    if (reply.kind === 'refused') {
      const t = refusalText(reply.status, reply.body);
      return { ok: false, message: t.text, needsWide: t.needsWide };
    }
    const until = (reply.body?.until as string | null | undefined) ?? null;
    this.afterWrite();
    const u = untilText(until, this.c.now());
    return { ok: true, message: r.kind === 'blocked' ? IB_TEXT.blockedUntil(u) : IB_TEXT.soldOutUntil(u) };
  }

  /** "שחרר" / "שחרר הכל": each block cleared under [approverId]; how many, or the first refusal. */
  async release(ids: readonly string[], approverId: string | null): Promise<{ ok: boolean; message: string; released: number }> {
    const m = this.c.svc.machineId;
    if (!m) return { ok: false, message: IB_TEXT.sheetOffline, released: 0 };
    let released = 0;
    let error: string | null = null;
    for (const id of ids) {
      const r = await this.c.svc.api.post(`sync/${m}/item-blocks/${encodeURIComponent(id)}/clear`, {}, { headers: this.headers(approverId), timeoutMs: 15_000 });
      if (r.kind === 'ok') released++;
      else if (!error) error = r.kind === 'offline' ? IB_TEXT.sheetOffline : refusalText(r.status, r.body).text;
    }
    if (released > 0) this.afterWrite();
    if (error) return { ok: released > 0, message: error, released };
    return { ok: true, message: released === 1 && ids.length === 1 ? IB_TEXT.released : IB_TEXT.releasedCount(released), released };
  }

  /** Whether releasing [ids] needs ITEM_BLOCK_WIDE (any of them, by its sheet's or list's facts). */
  releaseNeedsWide(ids: readonly string[]): boolean {
    for (const ctx of this.contexts.values()) for (const b of ctx.blocks) if (ids.includes(b.id) && releaseNeedsWide(b, ctx.reach)) return true;
    return false;
  }

  /** A write went through: the catalog now, so the sale's "חסום" / "אזל" follows at once. */
  private afterWrite() {
    void this.c.svc.sync.pullCatalog(false).catch(() => undefined);
  }
}

function durationOf(raw: unknown): BlockRequest['duration'] {
  const d = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (d.mode === 'minutes' && typeof d.minutes === 'number') return { mode: 'minutes', minutes: Math.trunc(d.minutes) };
  if (d.mode === 'time' && typeof d.at === 'string') return { mode: 'time', at: d.at };
  if (d.mode === 'none') return { mode: 'none' };
  return { mode: 'end_of_day' };
}
