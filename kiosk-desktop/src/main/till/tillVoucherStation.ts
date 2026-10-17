/**
 * "עמדת שובר" on the Windows till (core/till/voucherStation.ts — the Android VoucherStationScreen / VoucherFirstController's
 * station): while `voucherStation` is on (and the station was not left for the ordinary screen this session), the sell screen
 * IS the station. A voucher scanned or typed is looked up (`prepaid-vouchers/lookup`, read only — the shop's LAN host's copy
 * when the cloud does not answer and the batch works there), its terms and its picker are shown; the items picked go into
 * the till's own cart by the engine's `sell.add` (every gate and refusal the engine's), each unit to a voucher while one takes
 * it, else paid ("רכישה נוספת בתשלום", `voucherStationPaidItems`). The sale is then paid THROUGH the engine: `checkout.start`,
 * each voucher's `checkout.voucher` in the order scanned (the payment's own flow looks it up again, holds and books it), and
 * — the cashier's "סגור עסקה וממש שובר" — `checkout.cash` of ₪0. Nothing here writes a document, holds or redeems a voucher.
 */

import { lookupVoucher, type VoucherPost } from '@dash-lib/kioskVoucherClient';
import { voucherBenefitOf, voucherKindOf, voucherStackingOf, type VoucherInSale } from '@dash-lib/kioskVouchers';
import { refusalOf } from '../../core/cash/credit';
import { formatShekelSign } from '../../core/money';
import { VOUCHER_DEAD_TEXT, VOUCHER_BALANCE_TEXT, cleanScan, localStamp, prepaidVoucherCodeOf, voucherDeadOf, type StampFormat } from '../../core/till/voucherBalance';
import { VOUCHER_LAN, dtoOfSnapshot, hostLookupOf, hostTakes } from '../../core/till/voucherLan';
import {
  VOUCHER_STATION_TEXT as T,
  groupsFor,
  resolveVoucherAutoClose,
  resolveVoucherCatalogSwitch,
  resolveVoucherPayOptions,
  resolveVoucherStation,
  resolveVoucherStationHeader,
  resolveVoucherStationPaidItems,
  stationAddHint,
  stationAssignUnit,
  stationAutoAssign,
  stationBackPlan,
  stationBar,
  stationCap,
  stationCatalog,
  stationCloses,
  stationCoversText,
  stationEntitlement,
  stationEstimate,
  stationPaidButton,
  stationPickerBar,
  stationPrimary,
  stationPrune,
  stationRefusedText,
  stationRows,
  stationSaleBanner,
  stationSaleButtons,
  stationSaleStrip,
  stationToggle,
  stationToPay,
  stationUnits,
  stationUsageText,
  stationVoucherRemoval,
  stationVoucherTitle,
  stationWhyNot,
  unitCount,
  voucherConditionsLines,
  voucherConditionsOf,
  voucherDiscountCardText,
  voucherDiscountHeader,
  voucherDiscountProducts,
  voucherDiscountRoute,
  voucherDiscountUnitCap,
  voucherDiscountUses,
  voucherLimitNote,
  voucherStationHeaderText,
  voucherStationHome,
  voucherStationMenuRow,
  voucherStationPaidItems,
  voucherStationRefusal,
  voucherStationTitleOf,
  type StationItemView,
  type StationLine,
  type StationPart,
  type StationPickerView,
  type StationProduct,
  type StationVoucher,
  type VoucherStationPhase,
  type VoucherStationState,
} from '../../core/till/voucherStation';
import { VOUCHER_FEATURES, VOUCHER_TEST_TEXT, VOUCHER_TEXT, termsOf, unitsRemaining, voucherLogTail, voucherReasonText, voucherSaleCap, voucherTestMixRefusal, type VoucherGroupTerms } from '../../core/till/vouchers';
import { lanCall as defaultLanCall, type LanCall } from '../kitchen/kitchenNet';
import type { TillContext, TillFeature } from './tillContext';

/** The engine's sale as the station reads it: the cart, the payment's phase and what is due. Cheap, no I/O. */
export interface StationSale {
  /** The order's id (the engine's basketId): another one — the sale was written or cleared — starts the station afresh. */
  ref: string;
  lines: Array<{ lineId: string; productId: string; qty: number; refund?: boolean; name?: string }>;
  /** `idle` | `tender` | `card_waiting` | `card_unknown` | `done`. */
  phase: string;
  /** What is left to pay while the payment is open. */
  dueAgorot: number;
}

export interface VoucherStationDeps {
  /** The engine's cart and payment now (see the report: `sale: () => ({ ref: this.basketId, … })`). */
  sale(): StationSale;
  /** The payment's voucher flow under way (`engine.vouchers.lastScan`): the next voucher waits for it. */
  scanDone(): Promise<unknown> | null;
  /** A cash / card way to pay the rest at this till (the Windows till always takes cash — absent: true). */
  payOptions?(): boolean;
  /** The cloud's voucher calls (tests answer them). */
  post?: VoucherPost;
  /** The shop's LAN host (tests answer it). */
  lanCall?: LanCall;
  format?: StampFormat;
}

export const VOUCHER_STATION_OPS = [
  'voucherStation.leave',
  'voucherStation.return',
  'voucherStation.scan',
  'voucherStation.dismiss',
  'voucherStation.pick',
  'voucherStation.commit',
  'voucherStation.closePicker',
  'voucherStation.basket',
  'voucherStation.add',
  'voucherStation.toggle',
  'voucherStation.category',
  'voucherStation.back',
  'voucherStation.removeVoucher',
  'voucherStation.pay',
  'voucherStation.payOpen',
  'voucherStation.clear',
] as const;

export const VOUCHER_STATION_MUTATING = [
  'voucherStation.leave',
  'voucherStation.return',
  'voucherStation.commit',
  'voucherStation.basket',
  'voucherStation.add',
  'voucherStation.toggle',
  'voucherStation.back',
  'voucherStation.removeVoucher',
  'voucherStation.pay',
  'voucherStation.payOpen',
  'voucherStation.clear',
] as const;

/** The permission "יציאה למסך רגיל" asks a manager's code for (`voucherStationCatalogSwitch` manager). */
export const VOUCHER_STATION_LEAVE_PERMISSION = 'KIOSK_TILL_MODE';

/** The most rows the picker / the basket's catalog send (the screens are a Celeron's; a filter narrows the rest). */
const MAX_ITEMS = 120;

/** The voucher on the picker: its lookup, and what is chosen (product|group → units), not in the sale yet. */
interface Picker {
  voucher: StationVoucher;
  dto: Record<string, unknown>;
  picks: Map<string, number>;
  /** The voucher was in the sale before the picker opened (its selection opened to add to it). */
  held: boolean;
}

type Lookup = { kind: 'ok'; code: string; dto: Record<string, unknown> } | { kind: 'refused'; text: string; detail: string | null };

export class TillVoucherStation implements TillFeature {
  readonly key = 'voucherStation';
  readonly ops: readonly string[] = VOUCHER_STATION_OPS;
  readonly mutating: readonly string[] = VOUCHER_STATION_MUTATING;

  /** "יציאה למסך רגיל": the ordinary screen for this session (VoucherStationSession.left). */
  private left = false;
  private phase: VoucherStationPhase = 'home';
  private vouchers: StationVoucher[] = [];
  private seen: Record<string, number> = {};
  private saleRef: string | null = null;
  private picker: Picker | null = null;
  private notice: VoucherStationState['notice'] = null;
  private refused: string | null = null;
  private hint: { text: string; covered: boolean } | null = null;
  private category: string | null = null;
  private busy = false;
  /** The voucher codes the payment still applies, in the order scanned. */
  private pending: string[] = [];
  private applying = false;
  /** "סגור עסקה וממש שובר" tapped: the payment closes at ₪0 once its vouchers are applied. */
  private closeAsked = false;
  private seq = 0;
  private stopped = false;
  /** The work under way (the tests wait for it; never sent to a screen). */
  last: Promise<unknown> | null = null;
  private readonly post: VoucherPost;
  private readonly lan: LanCall;
  private readonly format: StampFormat;

  constructor(
    private readonly c: TillContext,
    private readonly deps: VoucherStationDeps,
  ) {
    this.lan = deps.lanCall ?? defaultLanCall;
    this.format = deps.format ?? localStamp;
    this.post =
      deps.post ??
      (async (path, body, timeoutMs) => {
        const m = c.svc.machineId;
        if (!m) return { kind: 'offline' };
        const r = await c.svc.api.post<Record<string, unknown>>(`sync/${m}/${path}`, body, { timeoutMs });
        if (r.kind === 'ok') return { kind: 'ok', body: (r.body && typeof r.body === 'object' ? r.body : {}) as never };
        if (r.kind === 'refused') {
          const ref = refusalOf(r.body);
          const code = ref.code ?? (ref.message && /^[a-z_]+$/.test(ref.message) ? ref.message : null);
          return { kind: 'refused', status: r.status, body: { detail: code, message: code === ref.message ? null : ref.message }, detail: code };
        }
        return { kind: 'offline' };
      });
  }

  /* ------------------------------------------------------------ settings */

  private params(): Record<string, unknown> {
    return { ...this.c.svc.settingsMap(), ...this.c.svc.cloud.parameters() };
  }

  /** `voucherStation` on. */
  stationOn(): boolean {
    return resolveVoucherStation(this.params());
  }

  /** The station replaces the sell screen now. */
  active(): boolean {
    return this.stationOn() && !this.left;
  }

  private payOptions(): boolean {
    return this.deps.payOptions?.() ?? true;
  }

  private basketOn(): boolean {
    return this.stationOn() && resolveVoucherStationPaidItems(this.params()) && this.payOptions();
  }

  /* ------------------------------------------------------------ the sale */

  private products(): StationProduct[] {
    const cat = this.c.svc.tillCatalogData();
    return cat.products.map((p) => ({
      id: p.id,
      name: p.name,
      priceAgorot: p.priceAgorot,
      categoryId: p.categoryId,
      available: p.available && p.sale?.state !== 'blocked' && p.sale?.state !== 'sold_out',
      barcode: p.barcode ?? null,
      sku: p.sku,
    }));
  }

  /** The cart's lines, named and priced from the catalog (an estimate — the payment prices the sale). */
  private linesOf(sale: StationSale): StationLine[] {
    const cat = this.c.svc.tillCatalogData();
    const byId = new Map([...cat.products, ...cat.held].map((p) => [p.id, p] as const));
    return sale.lines.map((l) => {
      const p = byId.get(l.productId);
      return { lineId: l.lineId, productId: l.productId, name: l.name ?? p?.name ?? l.productId, qty: l.qty, unitAgorot: p?.priceAgorot ?? 0, refund: l.refund === true };
    });
  }

  /** The station's sale as the cart now is: a new order starts afresh; lines gone release their units; new units assigned. */
  private reconcile(): { sale: StationSale; lines: StationLine[]; last: ReturnType<typeof stationAutoAssign>['last'] } {
    const sale = this.deps.sale();
    if (this.saleRef !== sale.ref) {
      if (this.saleRef !== null) this.resetSale();
      this.saleRef = sale.ref;
    }
    const lines = this.linesOf(sale);
    const auto = stationAutoAssign(stationPrune(this.vouchers, lines), this.seen, lines);
    this.vouchers = auto.vouchers;
    this.seen = auto.seen;
    return { sale, lines, last: auto.last };
  }

  private resetSale() {
    this.vouchers = [];
    this.seen = {};
    this.picker = null;
    this.refused = null;
    this.hint = null;
    this.pending = [];
    this.closeAsked = false;
    if (this.phase !== 'checking') this.phase = 'home';
  }

  private goods(): StationVoucher[] {
    return this.vouchers.filter((v) => !v.discount);
  }

  private held(): VoucherInSale[] {
    return this.vouchers.map((v) => v.inSale);
  }

  /* ------------------------------------------------------------ the state */

  state(): VoucherStationState | undefined {
    if (!this.c.operator()) return undefined;
    const params = this.params();
    const station = resolveVoucherStation(params);
    const menu = voucherStationMenuRow({ station, left: this.left, catalogSwitch: resolveVoucherCatalogSwitch(params) });
    if (!station) return undefined;
    const active = !this.left;
    const { sale, lines } = this.reconcile();
    // A sale written through the payment (or cancelled there): the station is at home again once the payment is closed.
    if (sale.phase === 'tender' && this.pending.length > 0 && !this.applying) queueMicrotask(() => this.kick());
    const pay = resolveVoucherPayOptions(params);
    const home = voucherStationHome(pay);
    const inSale = this.vouchers.length > 0;
    const another = !inSale || voucherStationRefusal(this.held()) === null;
    const units = this.goods().reduce((s, a) => s + stationUnits(a), 0);
    const open = lines.filter((l) => !l.refund);
    const test = this.vouchers.some((v) => v.testMode) || this.picker?.voucher.testMode === true;
    return {
      active,
      menu,
      phase: this.phase,
      header: voucherStationHeaderText(resolveVoucherStationHeader(params), false, voucherStationTitleOf(params.voucherStationTitle)),
      home: {
        scan: home.scan && another,
        manual: home.manual && another,
        nothing: home.nothing ? T.payOff : null,
        scanText: home.scan && another ? (inSale ? T.scanAnotherBig : T.scan) : null,
        hint: T.hintHead,
        strip: stationSaleStrip(
          this.vouchers.map((v) => stationVoucherTitle(v.serial)),
          units,
        ),
        vouchers: this.vouchers.map((v) => ({ voucherId: v.voucherId, title: stationVoucherTitle(v.serial), covers: stationCoversText(v, lines) })),
        finish: inSale,
        openOrder: open.length > 0 && !inSale ? T.openOrder(open.map((l) => `${l.name} ×${l.qty}`).join(', ')) : null,
        basket: inSale && this.basketOn() && !test,
      },
      notice: this.notice,
      picker: this.phase === 'picker' && this.picker ? this.pickerView(this.picker, lines) : null,
      basket: this.phase === 'basket' ? this.basketView(lines, pay) : null,
      testBar: test ? VOUCHER_TEST_TEXT.bar : null,
      busy: this.busy || this.applying,
    };
  }

  private pickKeyOf(productId: string, groupKey: string) {
    return `${productId}|${groupKey}`;
  }

  /** The picker's voucher with its picks as parts on pseudo lines ("pick:<product>"): the station's own rules decide. */
  private withPicks(p: Picker): { voucher: StationVoucher; productOf: Record<string, string> } {
    const parts: StationPart[] = [...p.voucher.parts];
    const productOf: Record<string, string> = {};
    for (const [key, qty] of p.picks) {
      if (qty <= 0) continue;
      const [productId, groupKey] = key.split('|');
      parts.push({ lineId: `pick:${productId}`, groupKey, qty });
      productOf[`pick:${productId}`] = productId;
    }
    return { voucher: { ...p.voucher, parts }, productOf };
  }

  private selected(p: Picker): number {
    return [...p.picks.values()].reduce((s, q) => s + q, 0);
  }

  private pickerView(p: Picker, lines: StationLine[]): StationPickerView {
    const { voucher, productOf } = this.withPicks(p);
    for (const l of lines) productOf[l.lineId] = l.productId;
    const products = this.products();
    const dto = p.dto;
    const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const discount = voucher.discount;
    let shown = 0;
    let more = 0;
    const item = (pr: StationProduct, g: VoucherGroupTerms): StationItemView => {
      const count = p.picks.get(this.pickKeyOf(pr.id, g.key)) ?? 0;
      const why = !pr.available ? T.notSellable : this.whyText(stationWhyNot(voucher, pr.id, g, productOf), voucher, g);
      return { productId: pr.id, groupKey: g.key, name: pr.name, price: formatShekelSign(pr.priceAgorot), tag: null, tagText: null, count, why, available: pr.available };
    };
    const groups = voucher.terms.groups.map((g) => {
      const takenNow = voucher.parts.filter((x) => x.groupKey === g.key).reduce((a, x) => a + x.qty, 0);
      const list = products.filter((pr) => groupsFor({ ...voucher, terms: { ...voucher.terms, groups: [g] } }, pr.id).length > 0);
      const items: StationItemView[] = [];
      for (const pr of list) {
        if (shown >= MAX_ITEMS) {
          more += 1;
          continue;
        }
        shown += 1;
        items.push(item(pr, g));
      }
      return { key: g.key, counter: T.groupCounter(g.name, takenNow, g.maxUnits), full: takenNow >= g.remaining, items };
    });
    const sel = this.selected(p);
    const units = stationUnits(voucher);
    const refusal = sel > 0 ? stationEstimate(voucher, [...lines, ...[...p.picks.keys()].map((k) => this.pseudoLine(k, products))]).refusal : null;
    const paid = stationPaidButton(voucherStationPaidItems(resolveVoucherStationPaidItems(this.params()), this.payOptions(), voucher.testMode || this.vouchers.some((v) => v.testMode)));
    // The bar: the sale's other vouchers' units and this selection; what is to pay of the cart (the picks are all the voucher's).
    const others = this.goods().filter((v) => v.voucherId !== voucher.voucherId);
    const barUnits = others.reduce((a, v) => a + stationUnits(v), 0) + units;
    const toPay = this.toPayOf(lines, [...others, voucher]);
    const bar = stationPickerBar(barUnits, toPay, resolveVoucherAutoClose(this.params()));
    const ent = discount ? null : stationEntitlement(voucher);
    const quotaLeft = stationCap(voucher) - units;
    const conditions = discount ? [] : voucherConditionsLines(voucherConditionsOf(dto, voucher.terms), true, (x) => (x ? this.format(x) : null));
    const names = discount ? voucherDiscountProducts(discount.benefit, products).map((x) => x.name) : [];
    return {
      voucherId: voucher.voucherId,
      title: T.serial(voucher.serial),
      typeName: voucher.typeName,
      event: s(dto.eventName) ?? s(dto.batchName),
      production: s(dto.productionName) ? T.production(s(dto.productionName)!) : null,
      validUntil: this.format(s(dto.validUntil)) ? T.validUntil(this.format(s(dto.validUntil))!) : null,
      testBar: voucher.testMode ? VOUCHER_TEST_TEXT.bar : null,
      conditions,
      discount: discount ? { header: voucherDiscountHeader(discount.benefit, discount.uses, sel), card: voucherDiscountCardText(discount.benefit, discount.uses, names) } : null,
      groups,
      limitNote: voucherLimitNote(stationCap(voucher), unitsRemaining(voucher.terms), typeof dto.maxUnitsPerSale === 'number' ? dto.maxUnitsPerSale : null, units),
      selected: sel,
      refusal,
      entitlement: quotaLeft > 0 ? (ent?.tillText ?? null) : null,
      canAdd: sel > 0 && !refusal,
      paidButton: paid,
      scanAnother: resolveVoucherPayOptions(this.params()).scan,
      bar: bar ? { text: bar.text, button: bar.button, green: stationCloses(bar.primary) } : null,
      more,
    };
  }

  private pseudoLine(key: string, products: StationProduct[]): StationLine {
    const [productId] = key.split('|');
    const p = products.find((x) => x.id === productId);
    return { lineId: `pick:${productId}`, productId, name: p?.name ?? productId, qty: 0, unitAgorot: p?.priceAgorot ?? 0, refund: false };
  }

  private whyText(why: ReturnType<typeof stationWhyNot>, a: StationVoucher, g: VoucherGroupTerms): string | null {
    if (why === null) return null;
    if (why === 'total') {
      const units = stationUnits(a);
      return voucherLimitNote(stationCap(a), unitsRemaining(a.terms), null, units);
    }
    if (why === 'group') {
      const n = a.parts.filter((p) => p.groupKey === g.key).reduce((s, p) => s + p.qty, 0);
      return n === 1 ? T.groupPickedOne : T.groupPicked(n);
    }
    return T.groupPickedOne;
  }

  /** What is left to pay of [lines] with [vouchers] as placed (an estimate — the payment prices it). */
  private toPayOf(lines: StationLine[], vouchers: StationVoucher[]): number {
    const total = lines.filter((l) => !l.refund).reduce((s, l) => s + Math.round(l.unitAgorot * l.qty), 0);
    return stationToPay(
      total,
      vouchers.map((v) => stationEstimate(v, lines).effectAgorot),
    );
  }

  private basketView(lines: StationLine[], pay: { scan: boolean; manual: boolean }): NonNullable<VoucherStationState['basket']> {
    const goods = this.goods();
    const toPay = this.toPayOf(lines, goods);
    const total = lines.filter((l) => !l.refund).reduce((s, l) => s + Math.round(l.unitAgorot * l.qty), 0);
    const bar = stationBar(goods, toPay);
    const refusals = goods.map((v) => stationEstimate(v, lines).refusal);
    const covering = goods.reduce((s, v) => s + stationUnits(v), 0);
    const primary = stationPrimary(
      lines.filter((l) => !l.refund).length,
      covering + this.vouchers.filter((v) => v.discount).length,
      refusals,
      toPay,
      resolveVoucherAutoClose(this.params()),
    );
    const buttons = stationSaleButtons(primary, pay.scan, pay.manual, voucherStationRefusal(this.held()) === null);
    const cat = this.c.svc.tillCatalogData();
    const all = this.products().filter((p) => this.category === null || p.categoryId === this.category);
    const tagged = stationCatalog(all, goods, lines);
    const items: StationItemView[] = tagged.slice(0, MAX_ITEMS).map(({ product: p, tag }) => ({
      productId: p.id,
      groupKey: null,
      name: p.name,
      price: formatShekelSign(p.priceAgorot),
      tag,
      tagText: tag === 'paid' ? T.tagPaidPrice(formatShekelSign(p.priceAgorot)) : T.tagVoucher,
      count: lines.filter((l) => l.productId === p.id && !l.refund).reduce((s, l) => s + l.qty, 0),
      why: p.available ? null : T.notSellable,
      available: p.available,
    }));
    return {
      banner: stationSaleBanner(goods, bar),
      bar,
      categories: [{ id: null, name: T.all, on: this.category === null }, ...cat.categories.map((x) => ({ id: x.id, name: x.name, on: this.category === x.id }))],
      items,
      more: Math.max(0, tagged.length - MAX_ITEMS),
      rows: stationRows(lines, goods).map((r) => ({
        ...r,
        amount: formatShekelSign(r.amountAgorot),
        tagText: r.covered ? T.tagVoucher : T.tagPaid,
        // A paid row moves to the voucher only when one takes it now.
        mayMove: r.covered || stationAssignUnit(goods, lines.find((l) => l.lineId === r.lineId)!, lines).outcome === 'covered',
      })),
      hint: this.hint,
      refused: this.refused,
      totals: { order: formatShekelSign(total), vouchers: formatShekelSign(Math.max(0, total - toPay)), toPay: formatShekelSign(toPay) },
      primary: { text: buttons.text, enabled: buttons.enabled && !this.busy, green: buttons.green },
      scanAnother: buttons.scanAnother,
      typeCode: buttons.typeCode,
      vouchers: goods.map((v) => ({ voucherId: v.voucherId, title: stationVoucherTitle(v.serial), usage: stationUsageText(v) })),
    };
  }

  /* ------------------------------------------------------------ the ops */

  apply(op: string, a: Record<string, unknown>): unknown {
    switch (op) {
      case 'voucherStation.leave':
        return this.leave();
      case 'voucherStation.return':
        this.c.signedIn();
        if (!this.stationOn()) return this.c.refuse('invalid_args');
        this.left = false;
        return undefined;
      case 'voucherStation.scan':
        return this.scan(a.code, a.typed);
      case 'voucherStation.dismiss':
        this.c.signedIn();
        this.notice = null;
        if (this.phase === 'refused') this.phase = 'home';
        return undefined;
      case 'voucherStation.pick':
        return this.pick(a.productId, a.groupKey, a.delta);
      case 'voucherStation.commit':
        return this.commit(this.phase === 'basket' ? 'basket' : 'home');
      case 'voucherStation.closePicker':
        this.c.signedIn();
        this.picker = null;
        this.phase = 'home';
        return undefined;
      case 'voucherStation.basket':
        return this.openBasket();
      case 'voucherStation.add':
        return this.add(a.productId);
      case 'voucherStation.toggle':
        return this.toggle(a.lineId, a.toVoucher);
      case 'voucherStation.category': {
        this.c.signedIn();
        const id = a.categoryId === null || a.categoryId === undefined ? null : a.categoryId;
        if (id !== null && (typeof id !== 'string' || !this.c.svc.tillCatalogData().categories.some((x) => x.id === id))) return this.c.refuse('invalid_args');
        this.category = id as string | null;
        return undefined;
      }
      case 'voucherStation.back':
        return this.backToScan();
      case 'voucherStation.removeVoucher':
        return this.removeVoucher(a.voucherId);
      case 'voucherStation.pay':
        return this.pay();
      case 'voucherStation.payOpen':
        return this.payOpen();
      case 'voucherStation.clear':
        return this.clear();
    }
    return this.c.refuse('unknown_op');
  }

  stop(): void {
    this.stopped = true;
    this.seq += 1;
  }

  private onStation(): void {
    this.c.signedIn();
    if (!this.active()) this.c.refuse('invalid_args');
    if (this.c.paying()) this.c.refuse('checkout_busy');
  }

  /** "יציאה למסך רגיל": off — not offered; free — at once; manager — a manager's code (KIOSK_TILL_MODE) unless the user holds it. */
  private leave(): unknown {
    this.c.signedIn();
    if (!this.stationOn()) return this.c.refuse('invalid_args');
    const sw = resolveVoucherCatalogSwitch(this.params());
    if (sw === 'off') return this.c.refuse('invalid_args');
    if (sw === 'free') {
      this.left = true;
      return undefined;
    }
    return this.c.gate(
      VOUCHER_STATION_LEAVE_PERMISSION,
      () => {
        this.left = true;
        this.c.changed();
      },
      { askOnDeny: true, title: T.leave, body: T.leaveAsk },
    );
  }

  /* ------------------------------------------------------------ a scan */

  /** A voucher scanned or typed at the station: refused at once when it cannot be one, else looked up in the background. */
  private scan(raw: unknown, typed: unknown): unknown {
    this.onStation();
    if (typeof raw !== 'string' || raw.length > 120 || (typed !== undefined && typeof typed !== 'boolean')) return this.c.refuse('invalid_args');
    const text = cleanScan(raw);
    const code = prepaidVoucherCodeOf(text, typed !== false);
    const { lines } = this.reconcile();
    if (!code) {
      // In the basket a product's barcode is a product (the till's own scan): barcode, then SKU.
      if (this.phase === 'basket') {
        const p = this.products().find((x) => (x.barcode && x.barcode === text) || (x.sku && x.sku === text));
        if (p) return this.add(p.id);
      }
      return this.say(typed === false ? VOUCHER_BALANCE_TEXT.notAVoucher : VOUCHER_BALANCE_TEXT.invalidCode, null);
    }
    if (this.phase === 'checking') return this.c.refuse('checkout_busy', T.busy);
    // The voucher on the picker again: said; another one keeps this selection (into the sale) first.
    if (this.phase === 'picker' && this.picker) {
      if (this.picker.voucher.code === code) return this.say(T.alreadyScanned, null);
      if (this.selected(this.picker) > 0) {
        const { voucher } = this.withPicks(this.picker);
        const why = stationEstimate(voucher, [...lines, ...[...this.picker.picks.keys()].map((k) => this.pseudoLine(k, this.products()))]).refusal;
        if (why) return this.say(why, null, 'picker');
      }
    }
    // Held in the sale already: its selection opens to add to it.
    const heldOne = this.vouchers.find((v) => v.code === code);
    if (heldOne) {
      if (this.phase === 'picker' && this.picker && this.selected(this.picker) > 0) return this.commitThen(() => this.openPicker(heldOne, null, true));
      return this.openPicker(heldOne, null, true);
    }
    const others = [...this.held(), ...(this.phase === 'picker' && this.picker && !this.picker.held && this.selected(this.picker) > 0 ? [this.picker.voucher.inSale] : [])];
    const before = voucherStationRefusal(others);
    if (before) return this.say(this.phase === 'basket' ? stationRefusedText(before) : before, null);
    const carry = this.phase === 'picker' && this.picker && this.selected(this.picker) > 0;
    const back: VoucherStationPhase = this.phase === 'basket' ? 'basket' : 'home';
    const run = async () => {
      if (carry) await this.commitNow();
      this.lookupNow(code, back);
    };
    return run();
  }

  /** Into the lookup: "בודק…", the answer in the background. */
  private lookupNow(code: string, back: VoucherStationPhase) {
    this.seq += 1;
    const mine = this.seq;
    this.phase = 'checking';
    this.notice = null;
    this.refused = null;
    this.picker = null;
    this.c.log(`voucher station: scan ${voucherLogTail(code)}`);
    this.last = this.lookup(code)
      .catch((e: unknown): Lookup => {
        this.c.log(`voucher station ${voucherLogTail(code)}: ${String(e)}`);
        return { kind: 'refused', text: VOUCHER_BALANCE_TEXT.reasonOther, detail: null };
      })
      .then((r) =>
        this.c.later(() => {
          if (mine !== this.seq || this.stopped) return;
          this.answer(r, back);
          this.c.changed();
        }),
      );
    return { started: true };
  }

  private async lookup(code: string): Promise<Lookup> {
    const r = await lookupVoucher(this.post, code, { features: [...VOUCHER_FEATURES] });
    if (r.kind === 'ok') return { kind: 'ok', code, dto: r.dto };
    if (r.kind === 'refused') {
      const reason = r.reason;
      if (reason !== 'prepaid_voucher_assigned_offline') {
        const dead = voucherDeadOf(reason);
        return { kind: 'refused', text: dead ? VOUCHER_DEAD_TEXT[dead] : voucherReasonText(reason, (r as { message?: string }).message ?? null), detail: null };
      }
    }
    // No cloud (or a batch assigned to the shop's main till): the LAN host's copy of its terms; the payment redeems it there.
    const host = await this.hostLookup(code);
    if (host) return host;
    return { kind: 'refused', text: r.kind === 'refused' ? voucherReasonText(r.reason) : VOUCHER_TEXT.offline, detail: null };
  }

  private async hostLookup(code: string): Promise<Lookup | null> {
    const config = this.c.svc.kitchen.config();
    const h = config.printHost;
    if (!h || h.isSelf || !h.lanAddress || !config.printSecret) return null;
    const m = this.c.svc.machineId;
    try {
      const r = await this.lan({ address: h.lanAddress, port: h.port }, config.printSecret, 'POST', VOUCHER_LAN.LOOKUP, { code }, { caller: m ? { id: m, name: this.c.svc.cloud.machine()?.machineName ?? null } : null, connectMs: 1_200, readMs: 5_000 });
      const looked = r.status === 200 ? hostLookupOf(r.body) : null;
      if (!looked || !looked.ok || !hostTakes(looked)) return null;
      if (looked.refusal) return { kind: 'refused', text: looked.refusalText ?? voucherReasonText(looked.refusal), detail: null };
      return { kind: 'ok', code, dto: { ...dtoOfSnapshot(looked), redeemable: true, kind: 'items' } };
    } catch {
      return null;
    }
  }

  /** The lookup's answer on the station: red why, the voucher's picker, or the basket. */
  private answer(r: Lookup, back: VoucherStationPhase) {
    if (r.kind !== 'ok') return this.sayNow(r.text, r.detail, back);
    const dto = r.dto;
    if (dto.redeemable === false) {
      const reason = typeof dto.reason === 'string' ? dto.reason : null;
      const message = typeof dto.message === 'string' && dto.message.trim() ? dto.message.trim() : null;
      const dead = voucherDeadOf(reason, typeof dto.status === 'string' ? dto.status : null);
      return this.sayNow(dead ? VOUCHER_DEAD_TEXT[dead] : voucherReasonText(reason, message), dead ? message : null, back);
    }
    const voucherId = String(dto.voucherId ?? dto.id ?? '');
    const kind = voucherKindOf(dto.kind);
    const inSale: VoucherInSale = { voucherId, batchId: String(dto.batchId ?? ''), kind, stacking: voucherStackingOf(dto.stacking), maxPerSale: typeof dto.maxVouchersPerSale === 'number' ? dto.maxVouchersPerSale : null };
    // The same voucher under another code (typed, a reprint): its selection.
    const same = this.vouchers.find((v) => v.voucherId === voucherId);
    if (same) return this.openPicker(same, dto, true);
    const stack = voucherStationRefusal(this.held(), inSale);
    if (stack) return this.sayNow(back === 'basket' ? stationRefusedText(stack) : stack, null, back);
    const testMode = dto.testMode === true;
    if (voucherTestMixRefusal(this.vouchers.map((v) => ({ voucherId: v.voucherId, testMode: v.testMode })), { voucherId, testMode })) return this.sayNow(T.testMixed, null, back);
    const terms = termsOf(dto);
    const perSale = typeof dto.maxUnitsPerSale === 'number' ? dto.maxUnitsPerSale : null;
    const left = Math.max(0, Math.floor(unitsRemaining(terms)));
    const voucher: StationVoucher = {
      voucherId,
      code: r.code,
      serial: typeof dto.serial === 'number' ? dto.serial : 0,
      typeName: typeof dto.typeName === 'string' ? dto.typeName : null,
      kind,
      terms,
      inSale,
      cap: voucherSaleCap(left, perSale),
      left,
      parts: [],
      testMode,
      discount: null,
    };
    const { lines } = this.reconcile();
    const orderHasItems = lines.some((l) => !l.refund);
    const route = voucherDiscountRoute(kind, orderHasItems, this.basketOn());
    if (route === 'goods') {
      if (terms.groups.length === 0) return this.sayNow(T.nothing, null, back);
      return this.openPicker(voucher, dto, false);
    }
    const benefit = voucherBenefitOf(dto.benefit, dto.kind);
    if (!benefit) return this.sayNow(T.noBenefit, null, back);
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const uses = voucherDiscountUses(n(dto.maxUsesPerSale), n(dto.usesAvailable), n(dto.usesToday));
    if (uses <= 0) return this.sayNow(T.noUses, null, back);
    const discountVoucher: StationVoucher = { ...voucher, discount: { benefit, uses }, cap: 0 };
    switch (route) {
      case 'till_discount':
        // The order has items: the discount goes on it the till's own way, at the payment.
        this.vouchers = [...this.vouchers, discountVoucher];
        this.phase = back;
        return undefined;
      case 'item_discount_picker': {
        const cap = voucherDiscountUnitCap(benefit, uses);
        const items = voucherDiscountProducts(benefit, this.products());
        if (items.length === 0) return this.sayNow(T.noBenefit, null, back);
        const group: VoucherGroupTerms = {
          key: 'discount',
          name: T.discountGroup,
          minUnits: 1,
          maxUnits: cap,
          remaining: cap,
          productIds: new Set(items.map((p) => p.id.toLowerCase())),
          excludedIds: new Set(),
          allowRepeat: true,
          item: false,
        };
        const dterms = { ...terms, groups: [group], maxUnits: cap, unitsLeft: cap, splitAllowed: true, listItems: true };
        return this.openPicker({ ...discountVoucher, terms: dterms, cap, left: cap }, dto, false);
      }
      case 'order_discount_basket':
        this.phase = 'basket';
        this.refused = T.orderDiscountBasket;
        return undefined;
      default:
        return this.sayNow(T.orderDiscount, null, back);
    }
  }

  private openPicker(voucher: StationVoucher, dto: Record<string, unknown> | null, held: boolean) {
    const previous = this.picker?.voucher.voucherId === voucher.voucherId ? this.picker.dto : null;
    this.picker = { voucher, dto: dto ?? previous ?? this.dtoOf(voucher), picks: new Map(), held };
    this.phase = 'picker';
    this.notice = null;
    return undefined;
  }

  /** The lookup a held voucher was opened with (kept on it for its conditions). */
  private dtos = new Map<string, Record<string, unknown>>();
  private dtoOf(v: StationVoucher): Record<string, unknown> {
    return this.dtos.get(v.voucherId) ?? {};
  }

  /** A refusal in red: the station stays where it was (the basket — on its banner). */
  private say(text: string, detail: string | null, stay?: VoucherStationPhase): undefined {
    if (this.phase === 'basket' || stay === 'basket') {
      this.refused = text;
      return undefined;
    }
    if (stay === 'picker' || this.phase === 'picker') {
      this.notice = { text, detail, tone: 'red' };
      return undefined;
    }
    return this.sayNow(text, detail, 'home');
  }

  private sayNow(text: string, detail: string | null, back: VoucherStationPhase): undefined {
    if (back === 'basket') {
      this.phase = 'basket';
      this.refused = text;
      return undefined;
    }
    this.phase = 'refused';
    this.notice = { text, detail, tone: 'red' };
    return undefined;
  }

  /* ------------------------------------------------------------ the picker */

  private pick(productId: unknown, groupKey: unknown, delta: unknown): undefined {
    this.onStation();
    const p = this.picker;
    if (this.phase !== 'picker' || !p) return this.c.refuse('invalid_args');
    if (typeof productId !== 'string' || typeof groupKey !== 'string' || (delta !== 1 && delta !== -1)) return this.c.refuse('invalid_args');
    const g = p.voucher.terms.groups.find((x) => x.key === groupKey);
    const product = this.products().find((x) => x.id === productId);
    if (!g || !product || groupsFor({ ...p.voucher, terms: { ...p.voucher.terms, groups: [g] } }, productId).length === 0) return this.c.refuse('invalid_args');
    const key = this.pickKeyOf(productId, groupKey);
    const now = p.picks.get(key) ?? 0;
    this.notice = null;
    if (delta === -1) {
      if (now <= 1) p.picks.delete(key);
      else p.picks.set(key, now - 1);
      return undefined;
    }
    if (!product.available) return this.c.refuse('sell_refused', T.notSellable);
    const { voucher, productOf } = this.withPicks(p);
    const why = this.whyText(stationWhyNot(voucher, productId, g, productOf), voucher, g);
    if (why) return this.c.refuse('invalid_args', why);
    p.picks.set(key, now + 1);
    return undefined;
  }

  /** "הוסף למימוש": the selection into the cart (the engine's `sell.add`), each unit the voucher's; then home. */
  private commit(after: 'home' | 'basket'): unknown {
    this.onStation();
    const p = this.picker;
    if (this.phase !== 'picker' || !p) return this.c.refuse('invalid_args');
    if (this.selected(p) === 0) return this.c.refuse('invalid_args');
    const run = async () => {
      const ok = await this.commitNow();
      if (ok) this.phase = after;
    };
    return run();
  }

  private async commitThen(next: () => unknown): Promise<unknown> {
    const ok = await this.commitNow();
    return ok ? next() : undefined;
  }

  /**
   * The picker's selection into the sale: refused as placed (a package not complete…) — said, the picker stays; else each
   * pick by `sell.add` (its gates the engine's), its new units the voucher's. A pick the engine asked about first (a sold-out
   * item's manager) joins the sale when answered and goes to a voucher by the basket's rule.
   */
  private async commitNow(): Promise<boolean> {
    const p = this.picker;
    if (!p) return true;
    const { lines } = this.reconcile();
    const products = this.products();
    const { voucher } = this.withPicks(p);
    const why = stationEstimate(voucher, [...lines, ...[...p.picks.keys()].map((k) => this.pseudoLine(k, products))]).refusal;
    if (why && this.selected(p) > 0) {
      this.notice = { text: why, detail: null, tone: 'red' };
      return false;
    }
    if (!this.vouchers.some((v) => v.voucherId === p.voucher.voucherId)) {
      this.vouchers = [...this.vouchers, p.voucher];
      this.dtos.set(p.voucher.voucherId, p.dto);
    }
    this.busy = true;
    try {
      for (const [key, qty] of [...p.picks]) {
        if (qty <= 0) continue;
        const [productId, groupKey] = key.split('|');
        const before = this.reconcile().lines;
        try {
          await this.c.run('sell.add', { productId, qty });
        } catch (e) {
          this.notice = { text: this.refusalText(e), detail: null, tone: 'red' };
          p.picks.delete(key);
          continue;
        }
        p.picks.delete(key);
        const sale = this.deps.sale();
        const after = this.linesOf(sale);
        const grown = after.find((l) => l.productId === productId && !l.refund && unitCount(l) > (before.find((b) => b.lineId === l.lineId)?.qty ?? 0));
        if (!grown) continue;
        const added = Math.min(qty, unitCount(grown) - Math.floor(before.find((b) => b.lineId === grown.lineId)?.qty ?? 0));
        this.vouchers = this.vouchers.map((v) => {
          if (v.voucherId !== p.voucher.voucherId) return v;
          const parts = [...v.parts];
          const at = parts.findIndex((x) => x.lineId === grown.lineId && x.groupKey === groupKey);
          if (at >= 0) parts[at] = { ...parts[at], qty: parts[at].qty + added };
          else parts.push({ lineId: grown.lineId, groupKey, qty: added });
          return { ...v, parts };
        });
        this.seen = { ...this.seen, [grown.lineId]: unitCount(grown) };
      }
    } finally {
      this.busy = false;
    }
    this.picker = null;
    if (this.phase === 'picker') this.phase = 'home';
    return true;
  }

  private refusalText(e: unknown): string {
    const err = (e as { error?: { message?: string } } | null)?.error;
    return err?.message || VOUCHER_BALANCE_TEXT.reasonOther;
  }

  /* ------------------------------------------------------------ the basket */

  /** "הוסף פריט בתשלום": the selection kept, the basket opens — or why not. */
  private openBasket(): unknown {
    this.onStation();
    const test = this.vouchers.some((v) => v.testMode) || this.picker?.voucher.testMode === true;
    const state = voucherStationPaidItems(resolveVoucherStationPaidItems(this.params()), this.payOptions(), test);
    const button = stationPaidButton(state);
    if (!button.enabled) return this.c.refuse('invalid_args', button.why ?? undefined);
    this.refused = null;
    this.hint = null;
    if (this.phase === 'picker' && this.picker) {
      if (this.selected(this.picker) === 0) {
        if (!this.vouchers.some((v) => v.voucherId === this.picker!.voucher.voucherId)) {
          this.vouchers = [...this.vouchers, this.picker.voucher];
          this.dtos.set(this.picker.voucher.voucherId, this.picker.dto);
        }
        this.picker = null;
        this.phase = 'basket';
        return undefined;
      }
      return this.commit('basket');
    }
    this.phase = 'basket';
    return undefined;
  }

  /** A tap on the basket's catalog: the item by the till's own add, then to a voucher while one takes it, else paid. */
  private async add(productId: unknown): Promise<unknown> {
    this.onStation();
    if (this.phase !== 'basket' || typeof productId !== 'string') return this.c.refuse('invalid_args');
    const p = this.products().find((x) => x.id === productId);
    if (!p) return this.c.refuse('invalid_args');
    this.refused = null;
    const r = await this.c.run('sell.add', { productId, qty: 1 });
    const { last } = this.reconcile();
    if (last) {
      const hint = stationAddHint(last.outcome, p.priceAgorot, last.group);
      const v = last.voucherId ? this.vouchers.find((x) => x.voucherId === last.voucherId) : null;
      this.hint = hint ? { text: hint, covered: false } : v ? { text: T.addedTo(stationVoucherTitle(v.serial)), covered: true } : null;
    }
    return r;
  }

  /** A tap on a basket row: "בשובר" ↔ "בתשלום", as the rules allow — refused with why. */
  private toggle(lineId: unknown, toVoucher: unknown): undefined {
    this.onStation();
    if (this.phase !== 'basket' || typeof lineId !== 'string' || typeof toVoucher !== 'boolean') return this.c.refuse('invalid_args');
    const { lines } = this.reconcile();
    const line = lines.find((l) => l.lineId === lineId);
    if (!line) return this.c.refuse('invalid_args');
    const goods = this.goods();
    const r = stationToggle(goods, lineId, toVoucher, lines);
    if (toVoucher && r.outcome !== 'covered') return this.c.refuse('invalid_args', stationAddHint(r.outcome, line.unitAgorot, r.group ?? null) ?? undefined);
    const byId = new Map(r.vouchers.map((v) => [v.voucherId, v] as const));
    this.vouchers = this.vouchers.map((v) => byId.get(v.voucherId) ?? v);
    this.hint = null;
    return undefined;
  }

  /** "חזרה לסריקה": the paid items go (asked first), the vouchers' stay. */
  private backToScan(): unknown {
    this.onStation();
    if (this.phase !== 'basket') {
      this.phase = 'home';
      return undefined;
    }
    const { lines } = this.reconcile();
    const plan = stationBackPlan(lines, this.goods());
    if (!plan.asks) {
      this.phase = 'home';
      this.refused = null;
      this.hint = null;
      return undefined;
    }
    return this.c.ask({
      kind: 'confirm',
      title: T.backTitle,
      body: plan.text ?? '',
      fields: [],
      actions: [
        { id: 'approve', label: T.backYes, primary: true },
        { id: 'cancel', label: T.stay },
      ],
      resume: () => this.cut(plan.cuts, () => {
        this.phase = 'home';
        this.refused = null;
        this.hint = null;
      }),
    });
  }

  /** The lines cut as [cuts] says (a line → its quantity after; 0 — off), by the engine's own ops. */
  private async cut(cuts: Record<string, number>, then: () => void) {
    for (const [lineId, qty] of Object.entries(cuts)) {
      try {
        if (qty <= 0) await this.c.run('sell.remove', { lineId });
        else await this.c.run('sell.setQty', { lineId, qty });
      } catch (e) {
        this.c.toast(this.refusalText(e), 'error');
      }
    }
    this.reconcile();
    then();
    this.c.changed();
  }

  /** "הסר שובר": nothing was consumed — its items stay paid, or go with it (asked when it covers something). */
  private removeVoucher(voucherId: unknown): unknown {
    this.onStation();
    if (typeof voucherId !== 'string') return this.c.refuse('invalid_args');
    const { lines } = this.reconcile();
    const r = stationVoucherRemoval(lines, this.vouchers, voucherId);
    if (!r) return this.c.refuse('invalid_args');
    const drop = () => {
      this.vouchers = this.vouchers.filter((v) => v.voucherId !== voucherId);
      this.dtos.delete(voucherId);
    };
    return this.c.ask({
      kind: 'confirm',
      title: r.title,
      body: r.text,
      fields: [],
      actions: r.hasItems
        ? [
            { id: 'keep', label: T.removeKeepPaid, primary: true },
            { id: 'drop', label: T.removeDrop },
            { id: 'cancel', label: T.cancel },
          ]
        : [
            { id: 'keep', label: T.removeVoucher, primary: true },
            { id: 'cancel', label: T.cancel },
          ],
      onAction: (action) => {
        if (action === 'keep') {
          drop();
          this.c.changed();
          return undefined;
        }
        if (action === 'drop') return this.cut(r.cuts, drop);
        return undefined;
      },
    });
  }

  /* ------------------------------------------------------------ the payment */

  /**
   * The primary button ("לתשלום ₪X" / "סגור — הכל בשובר" / "סגור עסקה וממש שובר", "סיום וסגירת העסקה"): the picker's
   * selection into the sale first, then the payment through the engine — `checkout.start`, each voucher's `checkout.voucher`
   * in the order scanned, and the cashier's close at ₪0 when `voucherAutoClose` is off. Refused with why when there is
   * nothing to pay or a voucher cannot be redeemed as placed.
   */
  private async pay(): Promise<unknown> {
    this.onStation();
    if (this.phase === 'picker' && this.picker && this.selected(this.picker) > 0) {
      const ok = await this.commitNow();
      if (!ok) return undefined;
    } else if (this.phase === 'picker') {
      this.picker = null;
    }
    const { lines } = this.reconcile();
    const goods = this.goods();
    const toPay = this.toPayOf(lines, goods);
    const primary = stationPrimary(
      lines.filter((l) => !l.refund).length,
      goods.reduce((s, v) => s + stationUnits(v), 0) + this.vouchers.filter((v) => v.discount).length,
      goods.map((v) => stationEstimate(v, lines).refusal),
      toPay,
      resolveVoucherAutoClose(this.params()),
    );
    if (primary.kind === 'empty') return this.c.refuse('cart_empty');
    if (primary.kind === 'blocked') return this.c.refuse('invalid_args', primary.why);
    this.closeAsked = primary.kind === 'close_manual';
    // A voucher that covers nothing (all its items taken off) is not sent: nothing of it would be redeemed.
    this.pending = this.vouchers.filter((v) => v.discount || stationUnits(v) > 0).map((v) => v.code);
    this.phase = 'home';
    const r = await this.c.run('checkout.start');
    // The order's details first, or the cart changed under it: the vouchers go when the payment opens (state() kicks).
    if (this.deps.sale().phase === 'tender') queueMicrotask(() => this.kick());
    return r;
  }

  /** The vouchers into the open payment, one after another (each waits for the payment's flow of the one before). */
  private kick() {
    if (this.applying || this.pending.length === 0 || this.stopped) return;
    this.applying = true;
    this.last = (async () => {
      try {
        while (this.pending.length > 0 && !this.stopped) {
          if (this.deps.sale().phase !== 'tender') break;
          const code = this.pending.shift()!;
          await this.c.later(async () => {
            try {
              await this.c.run('checkout.voucher', { code });
            } catch (e) {
              this.c.toast(this.refusalText(e), 'error');
            }
          });
          await (this.deps.scanDone() ?? Promise.resolve());
        }
        if (this.closeAsked && this.pending.length === 0) {
          this.closeAsked = false;
          await this.c.later(async () => {
            const s = this.deps.sale();
            if (s.phase !== 'tender' || s.dueAgorot > 0) return;
            try {
              await this.c.run('checkout.cash', { amountAgorot: 0 });
            } catch (e) {
              this.c.toast(this.refusalText(e), 'error');
            }
          });
        }
      } finally {
        this.applying = false;
        if (!this.stopped) this.c.changed();
      }
    })();
  }

  /** "המשך לתשלום": an order left open here with no voucher — the till's payment. */
  private payOpen(): unknown {
    this.onStation();
    return this.c.run('checkout.start');
  }

  /** "ביטול ההזמנה": the order given up (nothing of a voucher was consumed — they were pending). */
  private async clear(): Promise<unknown> {
    this.onStation();
    await this.c.run('sell.clear');
    this.resetSale();
    this.phase = 'home';
    this.notice = null;
    return undefined;
  }
}
