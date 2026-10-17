/**
 * The order panel, as the Android tablet's quick order draws it (ui/sell/TabletQuickOrder.kt QuickOrderPanel; P:/specs/
 * till-visual-parity): the head — "הזמנה", how many items and the order's details, and "⋮" with what an ordinary sale
 * never needs (the discount, the details, parking, the parked sales, clearing); the lines (a tap opens a line's options);
 * the total; the quick bar (the design's, else the parameters' two quick-pay buttons) and "תשלום" across the width.
 *
 * Every change is still an op (`sell.setQty`, `sell.discount`, `sell.remove`, `sell.clear`, `oth.*`); a discount above
 * what a cashier may give comes back as the engine's manager dialog, not as a rule here. What the operator's role denies
 * under "כשאין הרשאה" = להסתיר is left out (`hidden`: core/till/permissions.ts lineDiscountPercents, lineRemoveShown,
 * basketDiscountShown).
 */

import { useState } from 'react';
import type { SellState, TillDesignAction } from '../../../../shared/till/protocol';
import { money, T } from '../text';
import { PresetChips, type PresetItem } from './TillSheets';
import { Icon } from '../theme/icons';

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
  /**
   * A quick-bar button (Android QuickPayButtonView / DesignBarButtonView): a tender straight into the payment's own flow
   * (fastCard, cashWithChange, fastCash, a banknote), or one of the order's own actions. Absent: the bar shows "תשלום" only.
   */
  quick?(button: QuickButton): void;
}

/** One button of the quick bar as drawn: the design's action, a banknote's value for "שטרות". */
export interface QuickButton {
  action: string;
  label: string;
  presetId?: string;
  /** "שטרות": the note (₪) this button counts. */
  noteShekels?: number;
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
  /** "עיצוב קופה": the quick bar (TillState.design's profile `actionBar`), and the banknotes offered over the total. */
  bar?: ReadonlyArray<TillDesignAction>;
  notes?: readonly number[];
  /** The design's word for "תשלום" (texts.pay). */
  payWord?: string;
}

const CHIPS = [5, 10, 20] as const;

/** The tenders (enabled only for a payable order) and the buttons that are always there (Android designTenders). */
const TENDERS = new Set(['fastCard', 'cashWithChange', 'fastCash', 'cashNotes']);
const ALWAYS = new Set(['orderDetails']);

/** The bar's buttons as Android lays them out (designBarButtons): "שטרות" one button per note, "pay" taken out. */
export function quickButtons(bar: ReadonlyArray<TillDesignAction>, notes: readonly number[]): QuickButton[] {
  const out: QuickButton[] = [];
  for (const b of bar) {
    if (b.action === 'pay' || b.action === 'repeatRound' || b.action === 'customer') continue;
    if (b.action === 'cashNotes') {
      for (const n of notes) out.push({ action: 'cashNotes', label: money(n * 100), noteShekels: n });
      continue;
    }
    out.push({ action: b.action, label: b.label, ...(b.presetId ? { presetId: b.presetId } : {}) });
  }
  return out;
}

function tenderClass(action: string): string {
  if (action === 'fastCard') return 't-quickpay-card';
  if (action === 'cashWithChange' || action === 'cashNotes') return 't-quickpay-cash';
  if (action === 'fastCash') return 't-quickpay-fastcash';
  return 't-quickpay-other';
}

export function CartPane({ sell, actions, compact, view = {} }: { sell: SellState; actions: CartActions; compact?: boolean; view?: CartView }) {
  const [open, setOpen] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const empty = sell.lines.length === 0;
  const hidden = new Set(view.hidden ?? []);
  const discountShown = !hidden.has('DISCOUNT');
  const voidShown = !hidden.has('LINE_VOID');
  const othShown = view.othEnabled === true && !hidden.has('OTH');
  const mixed = (sell.refundTotalAgorot ?? 0) > 0;
  const payout = sell.totalAgorot < 0;
  const refund = payout || mixed || sell.refundMode === true;
  const payable = !empty && sell.totalAgorot > 0 && !refund;
  const heldCount = view.heldCount ?? 0;
  const buttons = actions.quick && !refund ? quickButtons(view.bar ?? [], view.notes ?? []).filter((b) => b.action !== 'discount' || discountShown) : [];
  const rows: QuickButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  const subtitle = [sell.itemCount > 0 ? `${sell.itemCount} ${T.items}` : null, view.order?.strip ?? null].filter(Boolean).join(' · ');
  const close = (fn?: () => void) => () => {
    setMore(false);
    fn?.();
  };
  return (
    <section className={`t-cart${compact ? ' t-cart-compact' : ''}`} aria-label={T.cart}>
      <header className="t-cart-head">
        <div className="t-cart-title">
          <strong>{T.order}</strong>
          {subtitle ? <span>{subtitle}</span> : null}
        </div>
        <div style={{ position: 'relative' }}>
          <button type="button" className="t-more" aria-label={T.moreOptions} aria-expanded={more} onClick={() => setMore(true)}>
            <Icon name="moreVert" />
            {heldCount > 0 ? <span className="t-more-count">{heldCount}</span> : null}
          </button>
          {more ? (
            <>
              <div className="t-dropdown-scrim" onClick={() => setMore(false)} />
              <div className="t-dropdown" role="menu" style={{ top: 44, left: 0 }}>
                {actions.basketDiscount && (discountShown || sell.basketDiscount) ? (
                  <button type="button" role="menuitem" className="t-dropdown-row" disabled={empty} onClick={close(actions.basketDiscount)}>
                    <span className="t-dropdown-icon">%</span>
                    {T.menuDiscount}
                  </button>
                ) : null}
                {actions.orderEdit && view.order?.configured ? (
                  <button type="button" role="menuitem" className="t-dropdown-row" onClick={close(actions.orderEdit)}>
                    <Icon name="edit" className="t-dropdown-icon" />
                    {T.menuDetails}
                  </button>
                ) : null}
                {actions.hold ? (
                  <button type="button" role="menuitem" className="t-dropdown-row" disabled={empty || refund} onClick={close(actions.hold)}>
                    <Icon name="pause" className="t-dropdown-icon" />
                    {T.hold}
                  </button>
                ) : null}
                {actions.held && heldCount > 0 ? (
                  <button type="button" role="menuitem" className="t-dropdown-row" onClick={close(actions.held)}>
                    <Icon name="list" className="t-dropdown-icon" />
                    {T.menuHeld(heldCount)}
                  </button>
                ) : null}
                <div className="t-dropdown-sep" />
                <button type="button" role="menuitem" className="t-dropdown-row t-dropdown-danger" disabled={empty} onClick={close(actions.clear)}>
                  <Icon name="delete" className="t-dropdown-icon" />
                  {T.menuClear}
                </button>
              </div>
            </>
          ) : null}
        </div>
      </header>
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
              <span className="t-line-text">
                <span className="t-line-name">
                  {l.refund ? `${T.returnedLine}: ` : ''}
                  {l.name}
                </span>
                <span className="t-line-sub">
                  <bdi>{l.refund ? `−${money(l.totalAgorot)}` : money(l.totalAgorot)}</bdi>
                  {l.oth ? <span className="t-badge">{T.othTag(l.oth)}</span> : l.discountPct > 0 ? <span className="t-line-off">-{l.discountPct}%</span> : null}
                  {l.fromReceipt ? <span className="t-badge">{T.receiptDoc(l.fromReceipt)}</span> : null}
                  {/* "כלול בשובר #12" (a production voucher covers it); a ₪0 line's value beside it. */}
                  {l.voucher ? <span className="t-badge">{l.voucherValueAgorot ? `${money(l.voucherValueAgorot)} · ${l.voucher}` : l.voucher}</span> : null}
                </span>
              </span>
              <span className="t-line-chev" aria-hidden="true">
                {open === l.lineId ? '⌃' : '⌄'}
              </span>
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
          <div className="t-total-row t-discount-row">
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
          <strong className={`t-total${payout ? ' t-total-refund' : ''}`}>{money(Math.abs(sell.totalAgorot))}</strong>
        </div>
        <div className="t-muted t-small t-vat">
          {T.vatIncluded} {money(Math.abs(sell.vatAgorot))}
          {sell.promotionsAgorot ? ` · הנחת מבצע −${money(sell.promotionsAgorot)}` : ''}
        </div>
        {actions.preset && view.presetButtons && view.presetButtons.length > 0 && (discountShown || sell.basketDiscount?.preset) ? (
          // "הנחות קבועות": a tap applies (in the preset's colour), the same tap takes it off.
          <PresetChips
            items={discountShown ? view.presetButtons : view.presetButtons.filter((p) => p.id === sell.basketDiscount?.preset?.id)}
            activeId={sell.basketDiscount?.preset?.id ?? null}
            disabled={empty || sell.refundMode === true}
            onTap={(id) => actions.preset?.(id)}
          />
        ) : null}
        {rows.map((row, i) => (
          // The bar two to a row over the payment (Android: `chunked(2)`), a tender in its colour, the rest quiet.
          <div key={i} className="t-quickpay">
            {row.map((b) => (
              <button
                key={`${b.action}:${b.presetId ?? ''}:${b.noteShekels ?? ''}`}
                type="button"
                className={`t-quickpay-btn ${tenderClass(b.action)}`}
                disabled={TENDERS.has(b.action) ? !payable : !(ALWAYS.has(b.action) || !empty)}
                onClick={() => actions.quick?.(b)}
              >
                {b.action === 'fastCash' ? `${b.label} · ${money(sell.totalAgorot)}` : b.label}
                {b.action === 'cashNotes' && b.noteShekels ? <small>{T.noteChange(money(Math.max(0, b.noteShekels * 100 - sell.totalAgorot)))}</small> : null}
              </button>
            ))}
            {row.length === 1 ? <span style={{ flex: 1 }} /> : null}
          </div>
        ))}
        <button type="button" className={`t-payall${buttons.length === 0 || refund ? ' t-payall-prominent' : ''}`} disabled={empty} onClick={actions.pay}>
          {refund ? (
            <span>{payout ? `${T.basketToRefund} ${money(-sell.totalAgorot)}` : `${T.charge} ${money(sell.totalAgorot)}`}</span>
          ) : (
            <>
              <span>{view.payWord?.trim() || T.payWord}</span>
              <small>{T.payHint}</small>
            </>
          )}
        </button>
      </footer>
    </section>
  );
}
