/**
 * The cart, as the engine says it: lines (a return in red, an OTH line at ₪0 with its reason), quantities, discounts, the
 * total with its VAT. Every change is an op (`sell.setQty`, `sell.discount`, `sell.remove`, `sell.clear`, `oth.*`); a
 * discount above what a cashier may give comes back as the engine's manager dialog, not as a rule here. What the operator's
 * role denies under "כשאין הרשאה" = להסתיר is left out (`hidden`: core/till/permissions.ts lineDiscountPercents,
 * lineRemoveShown, basketDiscountShown).
 */

import { useState } from 'react';
import type { SellState } from '../../../../shared/till/protocol';
import { money, T } from '../text';
import { PresetChips, type PresetItem } from './TillSheets';

export interface CartActions {
  setQty(lineId: string, qty: number): void;
  discount?(lineId: string, pct: number): void;
  remove(lineId: string): void;
  clear(): void;
  pay(): void;
  /** "OTH" on one line (straight to the reason), "בטל OTH". */
  oth?(lineId: string): void;
  othUndo?(lineId: string): void;
  /** "הנחה לחשבון" (the sheet), "זיכוי" / "סיום זיכוי", "להמתנה", "מכירות בהמתנה". */
  basketDiscount?(): void;
  refund?(): void;
  hold?(): void;
  held?(): void;
  /** "פרטי הזמנה": the strip's ✎ (the configured questions, the answers shown). */
  orderEdit?(): void;
  /** "הנחות קבועות": a preset's one-tap button. */
  preset?(id: string): void;
}

export interface CartView {
  /** Codes the screens leave out for this operator ("כשאין הרשאה"). */
  hidden?: readonly string[];
  othEnabled?: boolean;
  heldCount?: number;
  /** "פרטי הזמנה": the answers in words ("לקחת  ·  דני"), and whether any question is on. */
  order?: { strip: string | null; configured: boolean } | null;
  /** "הנחות קבועות": the one-tap buttons (in order, with their colours); none — no buttons. */
  presetButtons?: ReadonlyArray<PresetItem>;
}

const CHIPS = [5, 10, 20] as const;

export function CartPane({ sell, actions, compact, view = {} }: { sell: SellState; actions: CartActions; compact?: boolean; view?: CartView }) {
  const [open, setOpen] = useState<string | null>(null);
  const empty = sell.lines.length === 0;
  const hidden = new Set(view.hidden ?? []);
  const discountShown = !hidden.has('DISCOUNT');
  const voidShown = !hidden.has('LINE_VOID');
  const othShown = view.othEnabled === true && !hidden.has('OTH');
  const refundShown = !hidden.has('REFUND') || sell.refundMode === true;
  const mixed = (sell.refundTotalAgorot ?? 0) > 0;
  const payout = sell.totalAgorot < 0;
  return (
    <section className={`t-cart${compact ? ' t-cart-compact' : ''}`} aria-label={T.cart}>
      <header className="t-cart-head">
        <span>{T.cart}</span>
        <span className="t-muted">
          {sell.itemCount} {T.items}
        </span>
      </header>
      {view.order && (view.order.strip || (view.order.configured && !empty)) ? (
        // The quick order's details (Android OrderDetailsStrip): a tap changes them.
        <button type="button" className="t-order-strip" onClick={() => actions.orderEdit?.()} disabled={!actions.orderEdit || !view.order.configured}>
          <span>{view.order.strip ?? T.orderDetails}</span>
          {view.order.configured ? <span aria-hidden="true">✎</span> : null}
        </button>
      ) : null}
      {sell.refundMode ? (
        <div className="t-warn t-small" role="note">
          {T.refundModeBanner}
        </div>
      ) : null}
      <ol className="t-lines">
        {empty ? <li className="t-empty">{T.cartEmpty}</li> : null}
        {sell.lines.map((l) => (
          <li key={l.lineId} className={`t-line${l.refund ? ' t-line-refund' : ''}`}>
            <button type="button" className="t-line-main" onClick={() => setOpen(open === l.lineId ? null : l.lineId)} aria-expanded={open === l.lineId}>
              <span className="t-line-name">
                {l.refund ? `${T.returnedLine}: ` : ''}
                {l.name}
              </span>
              {l.oth ? <span className="t-badge">{T.othTag(l.oth)}</span> : l.discountPct > 0 ? <span className="t-badge">-{l.discountPct}%</span> : null}
              {l.fromReceipt ? <span className="t-badge">{T.receiptDoc(l.fromReceipt)}</span> : null}
              {/* "כלול בשובר #12" (a production voucher covers it); a ₪0 line's value beside it. */}
              {l.voucher ? <span className="t-badge">{l.voucherValueAgorot ? `${money(l.voucherValueAgorot)} · ${l.voucher}` : l.voucher}</span> : null}
              <span className="t-line-total">{l.refund ? `−${money(l.totalAgorot)}` : money(l.totalAgorot)}</span>
            </button>
            <div className="t-qty">
              <button type="button" className="t-step" aria-label="פחות" disabled={l.qty <= 1 && !voidShown && !l.refund} onClick={() => actions.setQty(l.lineId, l.qty - 1)}>
                −
              </button>
              <span className="t-qty-n">{l.qty}</span>
              <button type="button" className="t-step" aria-label="עוד" onClick={() => actions.setQty(l.lineId, l.qty + 1)}>
                +
              </button>
            </div>
            {open === l.lineId ? (
              <div className="t-line-actions">
                {!l.refund && !l.oth && !l.noDiscount && actions.discount ? (
                  <>
                    {discountShown
                      ? CHIPS.map((pct) => (
                          <button key={pct} type="button" className={`t-chip${l.discountPct === pct ? ' t-chip-on' : ''}`} onClick={() => actions.discount?.(l.lineId, pct)}>
                            {T.discount} {pct}%
                          </button>
                        ))
                      : null}
                    {l.discountPct > 0 ? (
                      <button type="button" className="t-chip" onClick={() => actions.discount?.(l.lineId, 0)}>
                        {T.noDiscountChip}
                      </button>
                    ) : null}
                  </>
                ) : null}
                {!l.refund && othShown && !l.oth && !l.noDiscount && actions.oth ? (
                  <button type="button" className="t-chip" onClick={() => actions.oth?.(l.lineId)}>
                    {T.oth}
                  </button>
                ) : null}
                {l.oth && othShown && actions.othUndo ? (
                  <button type="button" className="t-chip" onClick={() => actions.othUndo?.(l.lineId)}>
                    {T.othUndo}
                  </button>
                ) : null}
                {voidShown || l.refund ? (
                  <button type="button" className="t-chip t-chip-danger" onClick={() => actions.remove(l.lineId)}>
                    {T.remove}
                  </button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <footer className="t-cart-foot">
        {sell.basketDiscount ? (
          <div className="t-total-row t-small">
            <span>{sell.basketDiscount.preset ? sell.basketDiscount.preset.name : T.basketDiscount}</span>
            <span>−{money(sell.basketDiscount.amountAgorot)}</span>
          </div>
        ) : null}
        {sell.basketDiscount?.preset?.for ? <div className="t-muted t-small">{T.presetFor(sell.basketDiscount.preset.for)}</div> : null}
        {mixed ? (
          <>
            <div className="t-total-row t-small">
              <span>{T.basketSold}</span>
              <span>{money(sell.saleTotalAgorot ?? 0)}</span>
            </div>
            <div className="t-total-row t-small">
              <span>{T.basketReturned}</span>
              <span>−{money(sell.refundTotalAgorot ?? 0)}</span>
            </div>
          </>
        ) : null}
        <div className="t-total-row">
          <span>{payout ? T.basketToRefund : T.total}</span>
          <strong className="t-total">{money(Math.abs(sell.totalAgorot))}</strong>
        </div>
        <div className="t-muted t-small">
          {T.vatIncluded} {money(Math.abs(sell.vatAgorot))}
        </div>
        {sell.promotionsAgorot ? (
          <div className="t-muted t-small">
            הנחת מבצע −{money(sell.promotionsAgorot)}
          </div>
        ) : null}
        {actions.preset && view.presetButtons && view.presetButtons.length > 0 && (discountShown || sell.basketDiscount?.preset) ? (
          // "הנחות קבועות": a tap applies (in the preset's colour), the same tap takes it off.
          <PresetChips
            items={discountShown ? view.presetButtons : view.presetButtons.filter((p) => p.id === sell.basketDiscount?.preset?.id)}
            activeId={sell.basketDiscount?.preset?.id ?? null}
            disabled={empty || sell.refundMode === true}
            onTap={(id) => actions.preset?.(id)}
          />
        ) : null}
        <div className="t-cart-tools">
          {actions.basketDiscount && (discountShown || sell.basketDiscount) ? (
            <button type="button" className="t-chip" disabled={empty} onClick={actions.basketDiscount}>
              {T.basketDiscount}
            </button>
          ) : null}
          {actions.refund && refundShown ? (
            <button type="button" className={`t-chip${sell.refundMode ? ' t-chip-on' : ''}`} onClick={actions.refund}>
              {sell.refundMode ? T.refundEnd : T.refund}
            </button>
          ) : null}
          {actions.hold ? (
            <button type="button" className="t-chip" disabled={empty} onClick={actions.hold}>
              {T.hold}
            </button>
          ) : null}
          {actions.held && (view.heldCount ?? 0) > 0 ? (
            <button type="button" className="t-chip" onClick={actions.held}>
              {T.heldOpen(view.heldCount ?? 0)}
            </button>
          ) : null}
        </div>
        <div className="t-cart-buttons">
          <button type="button" className="t-btn t-btn-ghost" disabled={empty} onClick={actions.clear}>
            {T.cartClear}
          </button>
          <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={empty} onClick={actions.pay}>
            {empty ? T.barEmpty : payout ? `${T.basketToRefund} ${money(-sell.totalAgorot)}` : `${T.charge} ${money(sell.totalAgorot)}`}
          </button>
        </div>
      </footer>
    </section>
  );
}
