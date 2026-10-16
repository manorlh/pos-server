/**
 * Vouchers at the Windows till's payment — the Android till's (pos-android ui/checkout/CheckoutViewModel.kt applyVoucher /
 * autoApplyVoucher / finishTest, ui/sell/PrepaidRedeemSheet.kt, data/repo/ProductionVoucherService.kt, PrepaidVoucherRepository.kt):
 *
 *  - a voucher scanned (or typed) is looked up telling the cloud what this till can do (`features`, core/till/vouchers.ts);
 *  - "שובר הנחה" (order / item discount): the shared discount rules, held in the cloud for this sale (`reserve`) — a discount on
 *    the document (lib/kioskVoucherClient.ts, the kiosks' one copy);
 *  - a plain list of goods: `/redeem` — booked by its accounting (a "שוברי הפקה" leg, a deduction, ₪0 lines);
 *  - a production voucher of groups ("פריט אחד מכל קבוצה"), or a list that is not plain: matched to the sale by the shared rules
 *    (lib/voucherGroups.ts), the cashier asked only when a unit fits several groups or which item fills a group is a choice, then
 *    held by the cloud (reserve → confirm), its answer booked; a forced reduction asks a manager (VOUCHER_DISCOUNT_OVERRIDE);
 *  - "מימוש אוטומטי בסריקת שובר" (`voucherAutoApply`, on): applied at once when nothing needs a person — else a question;
 *  - "מצב בדיקה": a batch being checked — the sale is a simulation; "סיום בדיקה" ends it, nothing written or charged;
 *  - the sale written: every voucher confirmed with its document (the document names them too); abandoned: given back.
 *
 * The cloud calls run in the background (the op answers at once, `busy` on screen); each change of the payment goes through
 * the engine's queue (`later`), checked against the payment it started on.
 */

import { randomUUID } from 'node:crypto';
import { confirmDiscount, lookupVoucher, redeemLookedUp, releaseDiscount, stackingBeforeScan, type VoucherPost } from '@dash-lib/kioskVoucherClient';
import { stackingRefusal, stackingText, voucherKindOf, voucherStackingOf, type AppliedDiscountVoucher, type VoucherInSale } from '@dash-lib/kioskVouchers';
import { voucherCodeOf, type WebOrderLine } from '@dash-lib/kioskWebOrders';
import { GROUP_AMBIGUOUS } from '@dash-lib/voucherGroups';
import { refusalOf } from '../../core/cash/credit';
import { displayName } from '../../core/desktopExit';
import { unitAgorot, type SaleLine } from '../../core/sale';
import {
  APPROVAL_INVALID,
  APPROVAL_NEEDED,
  ITEM_GROUP_PREFIX,
  REDEEM_NEEDS_RESERVE,
  VOUCHER_FEATURES,
  VOUCHER_IN_USE,
  VOUCHER_TEST_TEXT,
  VOUCHER_TEXT,
  accountingOf,
  choiceOf,
  countsAsPayment,
  coveredUnitCounts,
  coverPriced,
  isDiscountVoucher,
  isHeld,
  isStaffTestVoucher,
  isTestVoucherId,
  productionVoucherEffect,
  resolveVoucherAutoApply,
  termsOf,
  unitsRemaining,
  voucherAppliedWhat,
  voucherAutoDecision,
  voucherCloseMessages,
  voucherCodeKey,
  voucherEntitlementOf,
  voucherLeftOf,
  voucherLogTail,
  voucherReasonText,
  voucherRescanText,
  voucherSaleCap,
  voucherScanState,
  voucherTestEndLines,
  voucherTestMixRefusal,
  voucherUnitsOf,
  withPick,
  type AppliedProduction,
  type AppliedUnit,
  type DocPrepaidRedemption,
  type TillVoucherUnit,
  type VoucherScanState,
  type VoucherTerms,
} from '../../core/till/vouchers';
import type { DocDraft } from '../fiscal/ledger';
import type { ApproverRef, TillContext } from './tillContext';

/** The cloud's answer to a voucher call: its body, or its refusal (code, Hebrew, extra fields), or none. */
type Reply = { kind: 'ok'; body: Record<string, unknown> } | { kind: 'refused'; status: number; code: string | null; message: string | null; extra: Record<string, unknown> } | { kind: 'offline' };

/** The cloud's voucher calls (`prepaid-vouchers/…` under `sync/{machine}/`), apart so a test answers them. */
export interface VoucherCloud {
  post(path: string, body: unknown, timeoutMs: number): Promise<Reply>;
  /** A `/redeem` redemption given back: kept and retried until the cloud answers (main/kiosk/payAtTill.ts). */
  reverse(redemptionId: string): Promise<void>;
}

/** The open payment as the vouchers see it (the engine's): its lines as priced now, its vouchers' records, its sale ref. */
export interface VoucherPayment {
  /** Identifies this payment: a voucher answer that comes back to another is given back. */
  token: string;
  lines: SaleLine[];
  prepaid: DocPrepaidRedemption[];
  saleRef: string;
}

/** What the engine hands the vouchers. */
export interface VoucherHost {
  /** The payment open for vouchers now, or why not (Hebrew). */
  payment(): VoucherPayment | { refused: string };
  /** The sale priced again with the vouchers as they stand (the engine's frozen payment); a refusal's words if it could not. */
  reprice(): string | null;
  /** A voucher was applied: the engine closes the sale by itself when nothing is left (`voucherAutoClose`). */
  afterApply(): void;
  /** May the signed-in user do [code] alone (no manager's code)? */
  mayAlone(code: string): boolean;
  /** A parameter of the till (`voucherAutoApply`, `voucherAutoClose`). */
  setting(key: string): unknown;
}

/** What the screens show of the payment's vouchers (`TillState.checkout.vouchers`). */
export interface VouchersState {
  items: Array<{ id: string; kind: 'production' | 'discount'; label: string; what: string; amountAgorot: number; test: boolean }>;
  /** "מצב בדיקה": the orange bar's words; null — a real sale. */
  testBar: string | null;
  /** "נותר לתשלום: … — בבדיקה לא נגבה דבר". */
  testDue: string | null;
  /** "הלקוח זכאי לעוד פריט מהשובר: …" — the orange alert. */
  entitlement: string | null;
  /** A voucher is being checked with the cloud. */
  busy: boolean;
  /** The last voucher's green line ("השובר הוחל: …") or its red refusal. */
  applied: string | null;
  error: string | null;
  autoApply: boolean;
}

export const VOUCHER_TEST_PERMISSION = 'VOUCHER_TEST_REDEEM';
export const VOUCHER_OVERRIDE_PERMISSION = 'VOUCHER_DISCOUNT_OVERRIDE';
const PARTIAL_NOT_ALLOWED = 'prepaid_voucher_partial_not_allowed';

type Outcome = { kind: 'applied'; text: string } | { kind: 'refused'; text: string } | { kind: 'cancelled' };

/** One question the flow asks: the answer's action (and approver), or null when dismissed. */
type Answer = { action: string; approver: ApproverRef | null } | null;

export class TillVouchers {
  production: AppliedProduction[] = [];
  discounts: AppliedDiscountVoucher[] = [];
  /** The codes scanned into this sale (normalised), by what they became. */
  private codes = new Map<string, { voucherId: string; id: string }>();
  private busy = false;
  private applied: string | null = null;
  private error: string | null = null;
  /** "סגירה עכשיו — …" was confirmed for this payment. */
  closeConfirmed = false;
  /** The flow under way (the tests wait for it; never sent to a screen). */
  lastScan: Promise<Outcome> | null = null;
  /** Holds sent with no answer, per sale and code: on "in use" the same request is sent again and given back. */
  private unanswered = new Map<string, Record<string, unknown>>();
  readonly cloud: VoucherCloud;

  constructor(
    private readonly c: TillContext,
    private readonly host: VoucherHost,
    cloud?: VoucherCloud,
  ) {
    const svc = c.svc;
    this.cloud = cloud ?? {
      post: async (path, body, timeoutMs) => {
        const m = svc.machineId;
        if (!m) return { kind: 'offline' };
        const r = await svc.api.post<Record<string, unknown>>(`sync/${m}/${path}`, body, { timeoutMs });
        if (r.kind === 'ok') return { kind: 'ok', body: (r.body && typeof r.body === 'object' ? r.body : {}) as Record<string, unknown> };
        if (r.kind === 'refused') {
          const ref = refusalOf(r.body);
          // A plain `{"detail": "code"}` is the code itself.
          const code = ref.code ?? (ref.message && /^[a-z_]+$/.test(ref.message) ? ref.message : null);
          return { kind: 'refused', status: r.status, code, message: code === ref.message ? null : ref.message, extra: ref.extra };
        }
        return { kind: 'offline' };
      },
      reverse: (id) => svc.payAtTill.reverse(id),
    };
  }

  /* ------------------------------------------------------------ the state */

  /** A test voucher is on this sale: it is a simulation. */
  simulation(): boolean {
    return this.production.some((a) => a.testMode) || this.discounts.some((d) => isTestVoucherId(d.reservationId));
  }

  any(): boolean {
    return this.production.length + this.discounts.length > 0;
  }

  autoApply(): boolean {
    return resolveVoucherAutoApply({ voucherAutoApply: this.host.setting('voucherAutoApply') });
  }

  state(lines: readonly SaleLine[], dueAgorot: number, outcomes: ReadonlyArray<{ voucher: { reservationId: string }; amountAgorot: number }>): VouchersState {
    const taken = new Map(outcomes.map((o) => [o.voucher.reservationId, o.amountAgorot] as const));
    const alerts = this.production.map((a) => a.entitlement?.tillText ?? null).filter((t): t is string => !!t);
    return {
      items: [
        ...this.production.map((a) => ({
          id: a.reservationId ?? a.redemptionId,
          kind: 'production' as const,
          label: VOUCHER_TEXT.chip(a.serial) + (a.typeName ? ` · ${a.typeName}` : ''),
          what: voucherAppliedWhat(a, lines),
          amountAgorot: productionVoucherEffect(a),
          test: a.testMode,
        })),
        ...this.discounts.map((d) => ({
          id: d.reservationId,
          kind: 'discount' as const,
          label: VOUCHER_TEXT.chip(d.serial) + (d.batchName ? ` · ${d.batchName}` : ''),
          what: d.benefit.text ?? '',
          amountAgorot: taken.get(d.reservationId) ?? 0,
          test: isTestVoucherId(d.reservationId),
        })),
      ],
      testBar: this.simulation() ? VOUCHER_TEST_TEXT.bar : null,
      testDue: this.simulation() ? (dueAgorot > 0 ? VOUCHER_TEST_TEXT.due(`₪${(dueAgorot / 100).toFixed(2)}`) : VOUCHER_TEST_TEXT.nothingDue) : null,
      entitlement: alerts.length > 0 ? alerts.join('\n') : null,
      busy: this.busy,
      applied: this.applied,
      error: this.error,
      autoApply: this.autoApply(),
    };
  }

  /** "סגירה עכשיו — מה שלא מומש מהשובר יאבד (…)": the one confirmation before a close that gives something up; null — none. */
  closeConfirm(now: Date): string | null {
    if (this.closeConfirmed || this.simulation()) return null;
    const left = this.production.map((a) => voucherLeftOf(a)).filter((v): v is NonNullable<typeof v> => !!v);
    return voucherCloseMessages(left, now)?.confirm ?? null;
  }

  /** The vouchers in this sale as the stacking rules see them (discount ones and production ones), with their test flag. */
  private inSale(): Array<VoucherInSale & { testMode: boolean }> {
    return [
      ...this.discounts.map((d) => ({ voucherId: d.voucherId, batchId: d.batchId, kind: d.benefit.kind, stacking: d.stacking, testMode: isTestVoucherId(d.reservationId) })),
      ...this.production.map((a) => ({ ...a.inSale, testMode: a.testMode })),
    ];
  }

  /* ------------------------------------------------------------- the scan */

  /** A voucher scanned (or typed) on the payment: started now, finished when its questions are answered. */
  scan(raw: unknown): { started: true } {
    this.c.signedIn();
    if (typeof raw !== 'string' || raw.length > 120) return this.c.refuse('invalid_args');
    const code = voucherCodeOf(raw);
    if (!code) return this.c.refuse('invalid_args', VOUCHER_TEXT.notFound);
    const pay = this.host.payment();
    if ('refused' in pay) return this.c.refuse('invalid_args', pay.refused);
    if (this.busy) return this.c.refuse('checkout_busy', 'בודק שובר — רגע');
    // Scanned again: said, never sent to the cloud a second time.
    const again = this.codes.get(voucherCodeKey(code) ?? '');
    if (again) return this.c.refuse('invalid_args', this.rescanText(again.id, pay.lines));
    // "שובר אחד בעסקה / כמה שוברים בעסקה": refused before the voucher is even looked up.
    const early = stackingBeforeScan(this.inSale());
    if (early) return this.c.refuse('invalid_args', stackingText(early.code, early.limit) ?? voucherReasonText(early.code));
    this.busy = true;
    this.error = null;
    this.applied = null;
    this.c.log(`voucher: scan ${voucherLogTail(code)} (till payment)`);
    const run = this.flow(code, pay)
      .catch((e: unknown): Outcome => {
        this.c.log(`voucher ${voucherLogTail(code)}: ${String(e)}`);
        return { kind: 'refused', text: voucherReasonText(null) };
      })
      .then((out) =>
        this.c.later(() => {
          this.busy = false;
          if (out.kind === 'refused') {
            this.error = out.text;
            this.c.toast(out.text, 'error');
          } else if (out.kind === 'applied') {
            this.applied = out.text;
            this.c.toast(out.text, 'ok');
          }
          this.c.changed();
          return out;
        }),
      );
    this.lastScan = run;
    this.c.changed();
    return { started: true };
  }

  private rescanText(id: string, lines: readonly SaleLine[]): string {
    const a = this.production.find((x) => (x.reservationId ?? x.redemptionId) === id);
    if (a) return voucherRescanText({ serial: a.serial, covers: voucherAppliedWhat(a, lines) || null, amountAgorot: productionVoucherEffect(a) });
    const d = this.discounts.find((x) => x.reservationId === id);
    if (d) return voucherRescanText({ serial: d.serial, covers: null, amountAgorot: null });
    return VOUCHER_TEXT.alreadyScanned;
  }

  private operator(): { id: string; name: string } {
    const u = this.c.operator();
    return { id: u?.id ?? '', name: u ? displayName(u) : '' };
  }

  private async flow(code: string, pay: VoucherPayment): Promise<Outcome> {
    const looked = await lookupVoucher(this.post, code, { features: [...VOUCHER_FEATURES] });
    if (looked.kind === 'offline') return { kind: 'refused', text: VOUCHER_TEXT.offline };
    if (looked.kind === 'refused') return { kind: 'refused', text: voucherReasonText(looked.reason, looked.message) };
    const dto = looked.dto;
    const voucherId = String(dto.voucherId ?? dto.id ?? '');
    if (dto.redeemable === false) return { kind: 'refused', text: voucherReasonText(typeof dto.reason === 'string' ? dto.reason : null, typeof dto.message === 'string' ? dto.message : null) };
    // The same voucher under another code (typed, a reprint): this sale holds it already.
    const held = [...this.codes.values()].find((v) => v.voucherId === voucherId);
    if (held) return { kind: 'refused', text: this.rescanText(held.id, pay.lines) };
    // "מצב בדיקה": never with a real voucher in one sale (either way round).
    const testMode = dto.testMode === true;
    if (voucherTestMixRefusal(this.inSale(), { voucherId, testMode })) return { kind: 'refused', text: VOUCHER_TEST_TEXT.mixed };
    // A staff test voucher ("שובר בדיקה"): a manager's code first unless the user may alone (VOUCHER_TEST_REDEEM).
    if (isStaffTestVoucher(dto) && !this.host.mayAlone(VOUCHER_TEST_PERMISSION)) {
      const ok = await this.approval(VOUCHER_TEST_PERMISSION, VOUCHER_TEXT.testVoucherBody);
      if (!ok) return { kind: 'cancelled' };
    }
    if (isDiscountVoucher(dto)) return this.discount(code, dto, pay);
    // "מצב בדיקה" (a sheet of its own on Android): said first, the orange bar on.
    if (testMode) {
      const go = await this.ask({ kind: 'confirm', title: VOUCHER_TEST_TEXT.confirmTitle, body: VOUCHER_TEST_TEXT.bar, fields: [], actions: [{ id: 'approve', label: VOUCHER_TEST_TEXT.confirmGo, primary: true }, { id: 'cancel', label: 'ביטול' }] });
      if (!go) return { kind: 'cancelled' };
    }
    if (!isHeld(dto)) {
      const r = await this.redeemPlain(code, dto, pay);
      // Not a plain batch after all (the cloud's word): held instead, at once.
      if (r !== REDEEM_NEEDS_RESERVE) return r;
    }
    return this.reserveGoods(code, dto, pay);
  }

  /** The shared voucher flow's calls (lib/kioskVoucherClient.ts) through this till's cloud: a refusal's code as its detail. */
  private readonly post: VoucherPost = async (path, body, timeoutMs) => {
    const r = await this.cloud.post(path, body, timeoutMs);
    if (r.kind === 'ok') return { kind: 'ok', body: r.body as never };
    if (r.kind === 'refused') return { kind: 'refused', status: r.status, body: { detail: r.code, message: r.message }, detail: r.code };
    return { kind: 'offline' };
  };

  /* ------------------------------------------------------ discount vouchers */

  private async discount(code: string, dto: Record<string, unknown>, pay: VoucherPayment): Promise<Outcome> {
    const r = await redeemLookedUp(
      this.post,
      {
        code,
        lines: pay.lines.filter((l) => typeof l.creditAgorot !== 'number').map(webLineOf),
        earlier: [],
        discounts: this.discounts,
        clientRequestId: randomUUID(),
        saleRef: pay.saleRef,
        operator: this.operator(),
        newId: () => randomUUID(),
        extras: { testModeAware: true },
      },
      dto,
    );
    if (r.kind === 'offline') return { kind: 'refused', text: VOUCHER_TEXT.offline };
    if (r.kind === 'refused') return { kind: 'refused', text: r.message ?? voucherReasonText(r.reason) };
    if (r.kind !== 'discount') return { kind: 'refused', text: voucherReasonText(null) };
    const v = r.voucher;
    return this.c.later(() => {
      if (!this.samePayment(pay)) {
        void releaseDiscount(this.post, v);
        return { kind: 'cancelled' as const };
      }
      this.discounts.push(v);
      this.codes.set(voucherCodeKey(code)!, { voucherId: v.voucherId, id: v.reservationId });
      const refused = this.host.reprice();
      if (refused) {
        this.discounts = this.discounts.filter((x) => x !== v);
        this.codes.delete(voucherCodeKey(code)!);
        void releaseDiscount(this.post, v);
        this.host.reprice();
        return { kind: 'refused' as const, text: refused };
      }
      this.host.afterApply();
      return { kind: 'applied' as const, text: VOUCHER_TEXT.applied(v.benefit.text ?? VOUCHER_TEXT.chip(v.serial)) };
    });
  }

  /* --------------------------------------------------------- goods (plain) */

  /** A plain list voucher: its items the sale holds, redeemed now (`/redeem`), booked by its accounting. */
  private async redeemPlain(code: string, dto: Record<string, unknown>, pay: VoucherPayment): Promise<Outcome | typeof REDEEM_NEEDS_RESERVE> {
    const includeExtras = dto.includeExtras === true;
    const units = this.freeUnits(pay, includeExtras);
    const items = (Array.isArray(dto.items) ? (dto.items as Array<Record<string, unknown>>) : []).filter((it) => typeof it.productId === 'string' && it.usable !== false);
    const take = new Map<string, number>();
    const used = new Set<string>();
    for (const it of items) {
      const ids = [String(it.productId).toLowerCase(), typeof it.tillProductId === 'string' ? it.tillProductId.toLowerCase() : null].filter((x): x is string => !!x);
      const left = Math.max(0, Math.floor(Number(it.remaining) || 0));
      const mine = units.filter((u) => ids.includes(u.productId) && !used.has(u.id)).slice(0, left);
      for (const u of mine) used.add(u.id);
      if (mine.length > 0) take.set(String(it.productId), mine.length);
    }
    if (take.size === 0) return { kind: 'refused', text: VOUCHER_TEXT.nothingInBasket };
    const split = dto.splitAllowed === true;
    let forfeitRest = false;
    // A one-time voucher of which the sale holds only part: what is not taken now is given up — the cashier says so.
    if (!split && !items.every((it) => (take.get(String(it.productId)) ?? 0) >= Math.floor(Number(it.remaining) || 0))) {
      const go = await this.ask({ kind: 'confirm', title: VOUCHER_TEXT.forfeitTitle, body: VOUCHER_TEXT.forfeitConfirm, fields: [], actions: [{ id: 'approve', label: 'מימוש', primary: true }, { id: 'cancel', label: 'ביטול' }] });
      if (!go) return { kind: 'cancelled' };
      forfeitRest = true;
    }
    if (!this.autoApply() && !forfeitRest) {
      const go = await this.confirmRedeem(units.filter((u) => used.has(u.id)));
      if (!go) return { kind: 'cancelled' };
    }
    const op = this.operator();
    const r = await this.cloud.post(
      'prepaid-vouchers/redeem',
      {
        code,
        items: [...take.entries()].map(([productId, quantity]) => ({ productId, quantity })),
        clientRequestId: randomUUID(),
        forfeitRest,
        posUserId: op.id || undefined,
        posUserName: op.name || undefined,
        saleRef: pay.saleRef,
        features: [...VOUCHER_FEATURES],
        testModeAware: true,
      },
      15_000,
    );
    if (r.kind === 'offline') return { kind: 'refused', text: VOUCHER_TEXT.noAnswer };
    if (r.kind === 'refused') {
      if (r.code === REDEEM_NEEDS_RESERVE) return REDEEM_NEEDS_RESERVE;
      return { kind: 'refused', text: voucherReasonText(r.code, r.message) };
    }
    const res = r.body;
    const redemptionId = typeof res.redemptionId === 'string' ? res.redemptionId : null;
    if (!redemptionId) return { kind: 'refused', text: voucherReasonText(null) };
    const v = (res.voucher && typeof res.voucher === 'object' ? res.voucher : dto) as Record<string, unknown>;
    const accounting = accountingOf(v.redemptionAccounting ?? dto.redemptionAccounting, v.countsAsPayment ?? dto.countsAsPayment);
    // Its redeemed goods matched to the sale's units, by product, in basket order.
    const redeemed = (Array.isArray(res.redeemed) ? (res.redeemed as Array<Record<string, unknown>>) : []).filter((x) => typeof x.productId === 'string');
    const covered: TillVoucherUnit[] = [];
    for (const x of redeemed) {
      const ids = [String(x.productId).toLowerCase(), typeof x.tillProductId === 'string' ? x.tillProductId.toLowerCase() : null].filter((y): y is string => !!y);
      let left = Math.max(0, Math.floor(Number(x.quantity) || 0));
      for (const u of units) {
        if (left <= 0) break;
        if (covered.includes(u) || !ids.includes(u.productId)) continue;
        covered.push(u);
        left -= 1;
      }
    }
    const test = res.testMode === true || dto.testMode === true || isTestVoucherId(redemptionId);
    if (covered.length === 0) {
      if (!test) void this.cloud.reverse(redemptionId);
      return { kind: 'refused', text: VOUCHER_TEXT.nothingInBasket };
    }
    const priced = coverPriced(accounting, covered, () => ({ key: null, name: null }));
    const applied: AppliedProduction = {
      source: 'redeem',
      reservationId: null,
      redemptionId,
      code,
      voucherId: String(v.voucherId ?? v.id ?? dto.voucherId ?? dto.id ?? ''),
      batchId: String(v.batchId ?? dto.batchId ?? ''),
      serial: Number(v.serial ?? dto.serial) || 0,
      typeName: str(v.typeName) ?? str(dto.typeName),
      batchName: str(v.eventName) ?? str(v.batchName) ?? str(dto.eventName) ?? str(dto.batchName),
      productionName: str(v.productionName) ?? str(dto.productionName),
      accounting,
      pricing: 'cover',
      tillValue: null,
      includeExtras,
      amountAgorot: priced.reduce((s, u) => s + u.covered, 0),
      topUpAgorot: 0,
      note: null,
      units: priced,
      inSale: { voucherId: String(v.voucherId ?? v.id ?? dto.voucherId ?? dto.id ?? ''), batchId: String(v.batchId ?? dto.batchId ?? ''), kind: 'items', stacking: voucherStackingOf(v.stacking ?? dto.stacking), maxPerSale: num(v.maxVouchersPerSale ?? dto.maxVouchersPerSale) },
      testMode: test,
      approval: null,
      entitlement: null,
    };
    return this.book(applied, pay, () => {
      if (!test) void this.cloud.reverse(redemptionId);
    });
  }

  /** The units of the sale a voucher may still cover (the sale's production vouchers took theirs). */
  private freeUnits(pay: VoucherPayment, includeExtras: boolean): TillVoucherUnit[] {
    return voucherUnitsOfPayment(pay, includeExtras);
  }

  /* ----------------------------------------------------- goods (held) */

  private async reserveGoods(code: string, dto: Record<string, unknown>, pay: VoucherPayment): Promise<Outcome> {
    const terms = termsOf(dto);
    const units = this.freeUnits(pay, terms.includeExtras);
    if (units.length === 0) return { kind: 'refused', text: VOUCHER_TEXT.nothingInBasket };
    const voucherId = String(dto.voucherId ?? dto.id ?? '');
    const incoming: VoucherInSale = { voucherId, batchId: String(dto.batchId ?? ''), kind: voucherKindOf(dto.kind), stacking: voucherStackingOf(dto.stacking), maxPerSale: num(dto.maxVouchersPerSale) };
    const stack = stackingRefusal(this.inSale(), incoming);
    if (stack) return { kind: 'refused', text: stackingText(stack.code, stack.limit, incoming.kind) ?? voucherReasonText(stack.code) };
    // What it may take in this sale: what it has left, within its per-sale limit less what it already took here.
    const remaining = num(dto.remaining) ?? unitsRemaining(terms);
    const takenHere = this.production.filter((a) => a.voucherId === voucherId).reduce((s, a) => s + a.units.length, 0);
    const cap = voucherSaleCap(Math.max(0, Math.floor(remaining)), num(dto.maxUnitsPerSale), takenHere);
    let st = voucherScanState(terms, units, cap);
    const decision = voucherAutoDecision(this.autoApply(), st, { testMode: dto.testMode === true });
    // The questions a person answers (the sheet's, on Android): which group a unit fits, which item fills a full group.
    for (const amb of st.ambiguous) {
      const u = st.units.find((x) => x.id === amb.ref)!;
      const pick = await this.ask({
        kind: 'confirm',
        title: VOUCHER_TEXT.groupTitle,
        body: VOUCHER_TEXT.groupBody(u.name),
        fields: [],
        actions: [...amb.groupKeys.map((k) => ({ id: `g:${k}`, label: terms.groups.find((g) => g.key === k)?.name ?? k })), { id: 'skip', label: 'לא בשובר' }, { id: 'cancel', label: 'ביטול' }],
        choice: true,
      });
      if (!pick) return { kind: 'cancelled' };
      if (pick.action.startsWith('g:')) {
        const key = pick.action.slice(2);
        const room = terms.groups.find((g) => g.key === key)?.remaining ?? 0;
        if (Object.values(st.assigned).filter((k) => k === key).length < room) st = withPick(st, u.id, key);
      }
    }
    for (let guard = 0; guard < 10; guard++) {
      const choice = choiceOf(st);
      if (!choice) break;
      const pick = await this.ask({
        kind: 'confirm',
        title: VOUCHER_TEXT.choiceTitle,
        body: VOUCHER_TEXT.choiceBody(choice.groupName),
        fields: [],
        actions: [...choice.candidates.map((u) => ({ id: `u:${u.id}`, label: u.name })), { id: 'cancel', label: 'ביטול' }],
        choice: true,
      });
      if (!pick) return { kind: 'cancelled' };
      const unitId = pick.action.slice(2);
      // The picked item in the group in place of what filled it (one unit per pick).
      const replace = st.assigned[unitId] === choice.groupKey ? [] : choice.placed.slice(0, 1);
      const next = withPick(st, unitId, choice.groupKey, replace);
      // Nothing changed (the pick was already there): the choice is made.
      if (JSON.stringify(next.assigned) === JSON.stringify(st.assigned)) {
        st = { ...st, unassigned: st.unassigned.filter((x) => !choice.candidates.some((c) => c.id === x.ref)) };
        break;
      }
      st = { ...next, unassigned: next.unassigned.filter((x) => !choice.candidates.some((c) => c.id === x.ref)) };
    }
    if (Object.keys(st.assigned).length === 0) return { kind: 'refused', text: st.refusal?.text ?? VOUCHER_TEXT.nothingInBasket };
    if (st.refusal) return { kind: 'refused', text: st.refusal.text };
    // "מימוש אוטומטי" off: the cashier presses "מימוש" (the sheet).
    if (decision.kind === 'sheet' && decision.why === 'off') {
      const go = await this.confirmRedeem(st.units.filter((u) => u.id in st.assigned));
      if (!go) return { kind: 'cancelled' };
    }
    return this.hold(code, dto, terms, st, pay, null, false);
  }

  /** The hold (reserve → confirm): the placed units and their groups; the cloud prices it — its answer is booked. */
  private async hold(code: string, dto: Record<string, unknown>, terms: VoucherTerms, st: VoucherScanState, pay: VoucherPayment, approval: AppliedProduction['approval'], forfeitRest: boolean): Promise<Outcome> {
    const mine = st.units.filter((u) => u.id in st.assigned);
    const op = this.operator();
    const voucherId = String(dto.voucherId ?? dto.id ?? '');
    const body: Record<string, unknown> = {
      code,
      clientRequestId: randomUUID(),
      saleRef: pay.saleRef,
      units: mine.map((u) => ({
        ref: u.id,
        productId: u.productId,
        productName: u.name,
        // A list voucher's items are never sent as group keys: the cloud matches its items itself.
        ...(st.assigned[u.id].startsWith(ITEM_GROUP_PREFIX) ? {} : { groupKey: st.assigned[u.id] }),
        quantity: 1,
        listPriceAgorot: u.price,
        listValueAgorot: u.listValue,
        categoryIds: u.categoryId ? [u.categoryId] : [],
        noDiscount: !u.discountable,
      })),
      otherVouchers: this.inSale()
        .filter((v) => v.voucherId !== voucherId)
        .map((v) => ({ voucherId: v.voucherId, batchId: v.batchId, kind: v.kind, stacking: v.stacking, maxVouchersPerSale: v.maxPerSale ?? null })),
      ...(approval ? { approval } : {}),
      ...(forfeitRest ? { forfeitRest: true } : {}),
      posUserId: op.id || undefined,
      posUserName: op.name || undefined,
      features: [...VOUCHER_FEATURES],
      testModeAware: true,
    };
    const key = `${pay.saleRef}|${voucherCodeKey(code)}`;
    let r = await this.cloud.post('prepaid-vouchers/reserve', body, 15_000);
    // "השובר פתוח כרגע בעסקה אחרת" — but the other one is this very sale's hold whose answer never came: found by its own
    // request id, given back, then held again (UnansweredHolds).
    if (r.kind === 'refused' && r.code === VOUCHER_IN_USE && this.unanswered.has(key)) {
      const earlier = this.unanswered.get(key)!;
      const again = await this.cloud.post('prepaid-vouchers/reserve', earlier, 15_000);
      const id = again.kind === 'ok' && typeof again.body.reservationId === 'string' ? again.body.reservationId : null;
      if (id && (await this.release(id))) {
        this.unanswered.delete(key);
        r = await this.cloud.post('prepaid-vouchers/reserve', body, 15_000);
      }
    }
    if (r.kind === 'offline') {
      this.unanswered.set(key, body);
      return { kind: 'refused', text: VOUCHER_TEXT.noAnswer };
    }
    this.unanswered.delete(key);
    if (r.kind === 'refused') {
      // A forced reduction: a manager's code (VOUCHER_DISCOUNT_OVERRIDE), then held again with it.
      if ((r.code === APPROVAL_NEEDED || r.code === APPROVAL_INVALID || r.extra.needsApproval === true) && !approval) {
        const by = this.host.mayAlone(VOUCHER_OVERRIDE_PERMISSION) ? { approver: { id: op.id, name: op.name } } : await this.approval(VOUCHER_OVERRIDE_PERMISSION, r.message ?? VOUCHER_TEXT.overrideBody);
        if (!by) return { kind: 'cancelled' };
        return this.hold(code, dto, terms, st, pay, { posUserId: by.approver.id, posUserName: by.approver.name, method: 'pin' }, forfeitRest);
      }
      // A unit several groups take (the cloud's own match): the cashier says which.
      if (r.code === GROUP_AMBIGUOUS && Array.isArray(r.extra.units)) {
        let next = st;
        for (const x of r.extra.units as Array<Record<string, unknown>>) {
          const ref = String(x.ref ?? '');
          const keys = Array.isArray(x.groupKeys) ? x.groupKeys.map(String) : [];
          const names = Array.isArray(x.groupNames) ? x.groupNames.map((n) => (typeof n === 'string' ? n : '')) : [];
          const u = next.units.find((y) => y.id === ref);
          if (!u || keys.length === 0) continue;
          const pick = await this.ask({ kind: 'confirm', title: VOUCHER_TEXT.groupTitle, body: VOUCHER_TEXT.groupBody(u.name), fields: [], actions: [...keys.map((k, i) => ({ id: `g:${k}`, label: names[i] || k })), { id: 'cancel', label: 'ביטול' }], choice: true });
          if (!pick) return { kind: 'cancelled' };
          next = withPick(next, ref, pick.action.slice(2), [ref]);
        }
        return this.hold(code, dto, terms, next, pay, approval, forfeitRest);
      }
      // A one-time list voucher taken in part: the rest is given up — said first.
      if (r.code === PARTIAL_NOT_ALLOWED && !forfeitRest) {
        const go = await this.ask({ kind: 'confirm', title: VOUCHER_TEXT.forfeitTitle, body: VOUCHER_TEXT.forfeitConfirm, fields: [], actions: [{ id: 'approve', label: 'מימוש', primary: true }, { id: 'cancel', label: 'ביטול' }] });
        if (!go) return { kind: 'cancelled' };
        return this.hold(code, dto, terms, st, pay, approval, true);
      }
      return { kind: 'refused', text: voucherReasonText(r.code, r.message) };
    }
    const reply = r.body;
    const reservationId = typeof reply.reservationId === 'string' ? reply.reservationId : null;
    if (!reservationId) return { kind: 'refused', text: VOUCHER_TEXT.noAnswer };
    // The cloud's pricing is the one booked: its mode, its values, its shares.
    const accounting = reply.redemptionAccounting != null || reply.countsAsPayment != null ? accountingOf(reply.redemptionAccounting, reply.countsAsPayment) : terms.accounting;
    const byRef = new Map(mine.map((u) => [u.id, u] as const));
    const groupName = (k: string | null) => (k ? (terms.groups.find((g) => g.key === k)?.name ?? null) : null);
    const priced: AppliedUnit[] = (Array.isArray(reply.units) ? (reply.units as Array<Record<string, unknown>>) : []).flatMap((x) => {
      const u = byRef.get(String(x.ref ?? ''));
      if (!u) return [];
      const key = typeof x.groupKey === 'string' ? x.groupKey : (st.assigned[u.id] ?? null);
      const zero = !countsAsPayment(accounting);
      return [
        {
          unitId: u.id,
          lineKey: u.lineKey,
          groupKey: key && !key.startsWith(ITEM_GROUP_PREFIX) ? key : null,
          groupName: typeof x.groupName === 'string' ? x.groupName : groupName(key),
          productId: u.productId,
          name: u.name,
          price: u.price,
          // Zero: the units are ₪0 lines (the contract's §4.3); else the voucher's price of each (fixed: its share; cover: its own).
          salePrice: zero ? 0 : Math.max(0, num(x.valueAgorot) ?? u.price),
          covered: zero ? 0 : Math.max(0, num(x.coveredAgorot) ?? 0),
          listValue: num(x.listValueAgorot) && num(x.listValueAgorot)! > 0 ? num(x.listValueAgorot)! : u.listValue,
          forced: x.forced === true,
          reduction: Math.max(0, num(x.reductionAgorot) ?? 0),
        },
      ];
    });
    const test = reply.testMode === true || dto.testMode === true || isTestVoucherId(reservationId);
    const taken = new Map<string, number>();
    for (const k of Object.values(st.assigned)) taken.set(k, (taken.get(k) ?? 0) + 1);
    const applied: AppliedProduction = {
      source: 'reserve',
      reservationId,
      redemptionId: String(body.clientRequestId),
      code,
      voucherId,
      batchId: String(dto.batchId ?? ''),
      serial: num(reply.serial) ?? (Number(dto.serial) || 0),
      typeName: str(reply.typeName) ?? terms.typeName,
      batchName: str(dto.eventName) ?? str(dto.batchName),
      productionName: str(reply.productionName) ?? str(dto.productionName),
      accounting,
      pricing: reply.pricing === 'fixed' ? 'fixed' : reply.pricing === 'cover' ? 'cover' : terms.pricing,
      tillValue: terms.tillValue,
      includeExtras: terms.includeExtras,
      amountAgorot: countsAsPayment(accounting) ? Math.max(0, num(reply.coveredAgorot) ?? priced.reduce((s, u) => s + u.covered, 0)) : 0,
      topUpAgorot: Math.max(0, num(reply.topUpAgorot) ?? 0),
      note: str(reply.note),
      units: priced,
      inSale: { voucherId, batchId: String(dto.batchId ?? ''), kind: 'items', stacking: voucherStackingOf(dto.stacking), maxPerSale: num(dto.maxVouchersPerSale) },
      testMode: test,
      approval,
      entitlement: voucherEntitlementOf(terms, taken, st.cap - Object.keys(st.assigned).length),
      validUntil: str(dto.validUntil),
      usesToday: num(dto.usesToday),
      maxUsesPerDay: num(dto.maxUsesPerDay),
    };
    if (priced.length === 0) {
      void this.release(reservationId);
      return { kind: 'refused', text: VOUCHER_TEXT.nothingInBasket };
    }
    return this.book(applied, pay, () => void this.release(reservationId));
  }

  /** [a] on the sale (through the engine's queue): repriced; given back when the payment moved on or could not take it. */
  private book(a: AppliedProduction, pay: VoucherPayment, giveBack: () => void): Promise<Outcome> {
    return this.c.later(() => {
      if (!this.samePayment(pay)) {
        giveBack();
        return { kind: 'cancelled' as const };
      }
      this.production.push(a);
      const id = a.reservationId ?? a.redemptionId;
      this.codes.set(voucherCodeKey(a.code)!, { voucherId: a.voucherId, id });
      const refused = this.host.reprice();
      if (refused) {
        this.production = this.production.filter((x) => x !== a);
        this.codes.delete(voucherCodeKey(a.code)!);
        giveBack();
        this.host.reprice();
        return { kind: 'refused' as const, text: refused };
      }
      this.c.log(`voucher ${voucherLogTail(a.code)}: applied (${a.accounting}, ${a.units.length} units${a.testMode ? ', test' : ''})`);
      const after = this.host.payment();
      const what = voucherAppliedWhat(a, 'refused' in after ? [] : after.lines);
      this.host.afterApply();
      return { kind: 'applied' as const, text: VOUCHER_TEXT.applied(what || VOUCHER_TEXT.chip(a.serial)) };
    });
  }

  private samePayment(pay: VoucherPayment): boolean {
    const now = this.host.payment();
    return !('refused' in now) && now.token === pay.token;
  }

  /* --------------------------------------------------------- the questions */

  private ask(d: { kind: 'confirm' | 'manager_approval'; title: string; body: string; fields: Array<{ name: string; label: string; kind: 'pin' | 'text' }>; actions: Array<{ id: string; label: string; primary?: boolean }>; code?: string | null; choice?: boolean }): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      void this.c.later(() => {
        this.c.ask({
          kind: d.kind,
          title: d.title,
          body: d.body,
          fields: d.fields,
          actions: d.actions,
          code: d.code ?? null,
          resume: (by) => resolve({ action: 'approve', approver: by }),
          ...(d.choice ? { onAction: (action: string) => resolve({ action, approver: null }) } : {}),
          onCancel: () => resolve(null),
        });
        this.c.changed();
      });
    });
  }

  private async approval(code: string, body: string): Promise<{ approver: ApproverRef } | null> {
    const a = await this.ask({
      kind: 'manager_approval',
      title: VOUCHER_TEXT.managerTitle,
      body,
      fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
      actions: [
        { id: 'approve', label: 'אישור', primary: true },
        { id: 'cancel', label: 'ביטול' },
      ],
      code,
    });
    return a?.approver ? { approver: a.approver } : null;
  }

  /** "מימוש": the sheet's own button when the scan is not applied by itself (`voucherAutoApply` off). */
  private async confirmRedeem(units: readonly TillVoucherUnit[]): Promise<boolean> {
    const counts = new Map<string, number>();
    for (const u of units) counts.set(u.name, (counts.get(u.name) ?? 0) + 1);
    const what = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
    const a = await this.ask({ kind: 'confirm', title: 'מימוש שובר', body: `השובר יכסה: ${what}`, fields: [], actions: [{ id: 'approve', label: `מימוש השובר (${units.length} פריטים)`, primary: true }, { id: 'cancel', label: 'ביטול' }] });
    return a !== null;
  }

  /* ------------------------------------------------- removing, the end */

  /** "הסר": one voucher off the payment — given back, the sale priced again with the others. */
  remove(id: unknown): undefined {
    this.c.signedIn();
    const pay = this.host.payment();
    if ('refused' in pay) return this.c.refuse('invalid_args', pay.refused);
    const p = this.production.find((a) => (a.reservationId ?? a.redemptionId) === id);
    const d = this.discounts.find((x) => x.reservationId === id);
    if (!p && !d) return this.c.refuse('invalid_args');
    if (p) {
      this.production = this.production.filter((a) => a !== p);
      this.giveBackProduction(p);
    }
    if (d) {
      this.discounts = this.discounts.filter((x) => x !== d);
      void releaseDiscount(this.post, d);
    }
    for (const [k, v] of this.codes) if (v.id === id) this.codes.delete(k);
    this.applied = null;
    this.error = null;
    this.closeConfirmed = false;
    this.host.reprice();
    this.c.toast(VOUCHER_TEXT.removed, 'info');
    return undefined;
  }

  private giveBackProduction(a: AppliedProduction) {
    if (a.reservationId) void this.release(a.reservationId);
    else if (!a.testMode) void this.cloud.reverse(a.redemptionId);
  }

  private async release(reservationId: string): Promise<boolean> {
    for (let i = 0; i < 3; i++) {
      const r = await this.cloud.post(`prepaid-vouchers/reservations/${encodeURIComponent(reservationId)}/release`, {}, 12_000);
      if (r.kind === 'ok') return true;
      if (r.kind === 'refused') return false;
    }
    return false;
  }

  /** The payment abandoned (cancelled, the shift's automatic close): every voucher given back. */
  abandon() {
    for (const a of this.production) this.giveBackProduction(a);
    for (const d of this.discounts) void releaseDiscount(this.post, d);
    this.clear();
  }

  /** The sale ended (written, or a simulation finished): nothing held any more. */
  clear() {
    this.production = [];
    this.discounts = [];
    this.codes.clear();
    this.applied = null;
    this.error = null;
    this.closeConfirmed = false;
  }

  /** "סיום בדיקה": what the vouchers would have covered and what would have been left to pay — nothing written. */
  testEnd(dueAgorot: number, discountAgorot: number): string[] {
    const covered = this.production.reduce((s, a) => s + productionVoucherEffect(a), 0) + discountAgorot;
    const items = this.production.reduce((s, a) => s + a.units.length, 0);
    return voucherTestEndLines({ coveredAgorot: covered, items, toPayAgorot: dueAgorot });
  }

  /**
   * The sale [doc] was written (PrepaidVoucherRepository.settleSale, ProductionVoucherService.settle): each discount voucher that
   * took something confirmed (its uses), each that took nothing released; each production voucher's hold confirmed with the
   * document, a `/redeem` one linked to it. From the document itself (a card answered after a restart too); the document names
   * them as well, so the cloud confirms them when it lands if these never do.
   */
  settle(doc: DocDraft) {
    const discounts = doc.voucherDiscounts ?? [];
    const releases = doc.voucherReleases ?? [];
    const prepaid = (doc.prepaidVouchers ?? []).filter((r) => !isTestVoucherId(r.reservationId) && !isTestVoucherId(r.redemptionId));
    if (discounts.length + releases.length + prepaid.length === 0) return;
    void (async () => {
      for (const v of discounts) await confirmDiscount(this.post, v, { transactionId: doc.id, amountAgorot: v.amountAgorot });
      for (const reservationId of releases) await releaseDiscount(this.post, { reservationId });
      for (const r of prepaid) {
        const path = r.legacy || !r.reservationId ? `prepaid-vouchers/redemptions/${encodeURIComponent(r.redemptionId)}/transaction` : `prepaid-vouchers/reservations/${encodeURIComponent(r.reservationId)}/confirm`;
        const body = r.legacy || !r.reservationId ? { transactionId: doc.id } : { transactionId: doc.id, amountAgorot: r.amountAgorot, ...(r.approval ? { approval: r.approval } : {}) };
        for (let i = 0; i < 3; i++) {
          const out = await this.cloud.post(path, body, 12_000);
          if (out.kind !== 'offline') break;
        }
      }
    })().catch((e: unknown) => this.c.log(`vouchers of ${doc.id}: ${String(e)}`));
  }
}

/* ------------------------------------------------------------------ helpers */

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The units of the payment's sale a voucher may still cover (the sale's production vouchers took theirs). */
export function voucherUnitsOfPayment(pay: Pick<VoucherPayment, 'lines' | 'prepaid'>, includeExtras: boolean): TillVoucherUnit[] {
  return voucherUnitsOf(pay.lines, { includeExtras, covered: coveredUnitCounts(pay.prepaid) });
}

/** A sale line as the discount vouchers' rules read it (lib/kioskWebOrders.ts WebOrderLine). */
export function webLineOf(l: SaleLine): WebOrderLine {
  return {
    key: l.key,
    productId: l.productId,
    name: l.name,
    qty: l.qty,
    baseAgorot: l.basePriceAgorot,
    unitAgorot: unitAgorot(l),
    options: [],
    note: null,
    categoryId: l.categoryId ?? null,
    sku: l.sku,
    barcode: null,
    imageUrl: null,
    allergens: [],
    noDiscount: l.noDiscount === true,
    promotionAgorot: l.promotionAgorot,
    promotionId: l.promotionId ?? null,
    promotionName: l.promotionName ?? null,
    voucherAgorot: l.voucherAgorot,
    promotionYieldedAgorot: l.promotionYieldedAgorot,
  };
}
