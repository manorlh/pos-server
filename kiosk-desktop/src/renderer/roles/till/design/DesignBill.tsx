/**
 * The bill of a designed screen (pos-android ui/sell/design/DesignBill.kt, PayDock.kt's selected line): its head, the
 * lines in the template's style — lines (a row with − n +), cards, compact (one 36 dp line) and seats (a quick order has
 * no seats: one group "כללי · ₪X") — the totals, the summary bar. Every change is still an op through CartActions
 * (`sell.setQty`, `sell.discount`, `sell.remove`, `oth.*`); what the operator's role hides ("כשאין הרשאה") is left out.
 *
 * A line's tap opens its own actions under it (the Windows till's line editor, as the classic cart's), or — עגינת
 * תשלום — selects it: its strip ("− 2 +", "הנחה לשורה", "הסר") stands under the lines.
 */

import { useState } from 'react';
import type { CartLine, SellState } from '../../../../shared/till/protocol';
import type { CartActions } from '../parts/CartPane';
import { money, T } from '../text';
import { DT } from './designText';

export interface BillRules {
  discountShown: boolean;
  voidShown: boolean;
  othShown: boolean;
}

export function BillHead({ title, count }: { title: string; count: string | null }) {
  return (
    <div className="d-bill-head">
      <strong>{title}</strong>
      {count ? <span>{count}</span> : null}
    </div>
  );
}

function qtyText(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

/** What the line was given (the details line under its name): the discount, OTH, the receipt, the voucher. */
function detailsOf(l: CartLine): string | null {
  const parts: string[] = [];
  if (l.oth) parts.push(T.othTag(l.oth));
  else if (l.discountPct > 0) parts.push(`${T.discount} ${l.discountPct}%`);
  if (l.fromReceipt) parts.push(T.receiptDoc(l.fromReceipt));
  if (l.voucher) parts.push(l.voucher);
  return parts.length ? parts.join(' · ') : null;
}

function lineAmount(l: CartLine) {
  return l.refund ? `−${money(Math.abs(l.totalAgorot))}` : money(l.totalAgorot);
}

export function Stepper({ line, rules, onQty }: { line: CartLine; rules: BillRules; onQty(q: number): void }) {
  const canRemove = rules.voidShown || line.refund;
  return (
    <span className="d-stepper">
      <button type="button" className="d-step" aria-label={DT.increase} onClick={() => onQty(line.qty + 1)}>
        +
      </button>
      <span className="d-step-n">
        <bdi>{qtyText(line.qty)}</bdi>
      </span>
      <button type="button" className="d-step" aria-label={DT.decrease} disabled={!canRemove && line.qty <= 1} onClick={() => onQty(line.qty - 1)}>
        −
      </button>
    </span>
  );
}

/** The line's own actions (a tap on it): today's chips — the discount, OTH, "הסר". */
function LineActions({ line, actions, rules }: { line: CartLine; actions: CartActions; rules: BillRules }) {
  return (
    <div className="d-line-actions">
      {!line.refund && !line.oth && !line.noDiscount && actions.discount && rules.discountShown
        ? [5, 10, 20].map((pct) => (
            <button key={pct} type="button" className={`d-chip${line.discountPct === pct ? ' d-chip-on' : ''}`} onClick={() => actions.discount?.(line.lineId, pct)}>
              {T.discount} {pct}%
            </button>
          ))
        : null}
      {line.discountPct > 0 && actions.discount ? (
        <button type="button" className="d-chip" onClick={() => actions.discount?.(line.lineId, 0)}>
          {DT.lineNoDiscount}
        </button>
      ) : null}
      {!line.refund && rules.othShown && !line.oth && !line.noDiscount && actions.oth ? (
        <button type="button" className="d-chip" onClick={() => actions.oth?.(line.lineId)}>
          {T.oth}
        </button>
      ) : null}
      {line.oth && rules.othShown && actions.othUndo ? (
        <button type="button" className="d-chip" onClick={() => actions.othUndo?.(line.lineId)}>
          {T.othUndo}
        </button>
      ) : null}
      {rules.voidShown || line.refund ? (
        <button type="button" className="d-chip d-chip-danger" onClick={() => actions.remove(line.lineId)}>
          {DT.lineRemove}
        </button>
      ) : null}
    </div>
  );
}

export function BillLines({
  sell,
  style,
  layout,
  actions,
  rules,
  emptyText,
  selecting,
  selectedId,
  onSelect,
  widthDp,
  seatGeneral,
}: {
  sell: SellState;
  style: string;
  /** side / block (under the menu) / summary (over it). */
  layout: 'side' | 'block' | 'summary';
  actions: CartActions;
  rules: BillRules;
  emptyText: string;
  /** עגינת תשלום: a tap selects the line (its strip under the lines). */
  selecting: boolean;
  selectedId: string | null;
  onSelect(id: string | null): void;
  widthDp: number;
  /** "כללי" (texts.seatGeneral): the seats style's one group on a quick order. */
  seatGeneral: string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (sell.lines.length === 0) return <div className="d-bill-empty">{emptyText}</div>;
  const cardColumns = style !== 'cards' ? 1 : layout === 'block' ? 3 : layout === 'summary' && widthDp >= 500 ? 2 : 1;
  const compactColumns = style === 'compact' && layout === 'block' ? Math.min(3, Math.max(1, Math.floor(widthDp / 260))) : 1;
  const columns = Math.max(cardColumns, compactColumns);
  const tap = (id: string) => {
    if (selecting) onSelect(selectedId === id ? null : id);
    else setOpen(open === id ? null : id);
  };
  const row = (l: CartLine) => {
    const stepper = !l.refund;
    const details = detailsOf(l);
    const selected = selecting && selectedId === l.lineId;
    if (style === 'compact') {
      return (
        <li key={l.lineId} className="d-cline">
          <button type="button" className="d-cline-main" onClick={() => tap(l.lineId)}>
            <span className={`d-cline-name${l.refund ? ' d-red' : ''}`}>
              <bdi>{qtyText(l.qty)}</bdi>× {l.name}
            </span>
            <span className="d-cline-price">{lineAmount(l)}</span>
          </button>
          {open === l.lineId && !selecting ? <LineActions line={l} actions={actions} rules={rules} /> : null}
        </li>
      );
    }
    if (style === 'cards') {
      return (
        <li key={l.lineId} className={`d-lcard${selected ? ' d-selected' : ''}`}>
          <button type="button" className="d-lcard-main" onClick={() => tap(l.lineId)}>
            <span className="d-lcard-top">
              <span className={`d-line-name${l.refund ? ' d-red' : ''}`}>{l.name}</span>
              <span className="d-line-price">{lineAmount(l)}</span>
            </span>
            {details ? <span className="d-line-sub">{details}</span> : null}
          </button>
          <div className="d-lcard-foot">
            {stepper ? (
              <Stepper line={l} rules={rules} onQty={(q) => actions.setQty(l.lineId, q)} />
            ) : (
              <span className="d-lcard-qty">
                <bdi>{qtyText(l.qty)}</bdi>×
              </span>
            )}
          </div>
          {open === l.lineId && !selecting ? <LineActions line={l} actions={actions} rules={rules} /> : null}
        </li>
      );
    }
    return (
      <li key={l.lineId} className={`d-lrow${selected ? ' d-selected' : ''}`}>
        <div className="d-lrow-main">
          <button type="button" className="d-lrow-text" onClick={() => tap(l.lineId)}>
            <span className={`d-line-name${l.refund ? ' d-red' : ''}`}>
              {stepper ? l.name : `${qtyText(l.qty)}× ${l.name}`}
            </span>
            {details ? <span className="d-line-sub">{details}</span> : null}
            {selected ? <span className="d-line-selected">{DT.selected}</span> : null}
          </button>
          <span className="d-line-price">{lineAmount(l)}</span>
          {stepper ? <Stepper line={l} rules={rules} onQty={(q) => actions.setQty(l.lineId, q)} /> : null}
        </div>
        {open === l.lineId && !selecting ? <LineActions line={l} actions={actions} rules={rules} /> : null}
      </li>
    );
  };
  return (
    <div className="d-bill-lines">
      {style === 'seats' ? (
        // "חלוקה לפי סועד" on a quick order: no seats — one group, the order's "כללי".
        <div className="d-group-head">
          {seatGeneral} · {money(sell.totalAgorot)}
        </div>
      ) : null}
      <ol className={`d-lines d-lines-${style === 'seats' ? 'lines' : style}`} style={columns > 1 ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}>
        {sell.lines.map(row)}
      </ol>
    </div>
  );
}

/** עגינת תשלום's selected line: its name, "− 2 +", "הנחה לשורה" (5 / 10 / 15 / 20 / ללא) and "הסר" — today's ops. */
export function SelectedLineStrip({ line, actions, rules, onDone }: { line: CartLine; actions: CartActions; rules: BillRules; onDone(): void }) {
  const [discountOpen, setDiscountOpen] = useState(false);
  return (
    <div className="d-strip">
      <div className="d-strip-top">
        <span className="d-line-name">{line.name}</span>
        {!line.refund ? <Stepper line={line} rules={rules} onQty={(q) => actions.setQty(line.lineId, q)} /> : null}
      </div>
      <div className="d-strip-buttons">
        {rules.discountShown && actions.discount && !line.refund && !line.oth && !line.noDiscount ? (
          <span className="d-rel">
            <button type="button" className="d-strip-btn" onClick={() => setDiscountOpen(true)}>
              {DT.lineDiscount}
            </button>
            {discountOpen ? (
              <>
                <div className="t-dropdown-scrim" onClick={() => setDiscountOpen(false)} />
                <div className="t-dropdown d-menu-up" role="menu">
                  {[5, 10, 15, 20, 0].map((p) => (
                    <button
                      key={p}
                      type="button"
                      role="menuitem"
                      className="t-dropdown-row"
                      onClick={() => {
                        setDiscountOpen(false);
                        actions.discount?.(line.lineId, p);
                      }}
                    >
                      {p === 0 ? DT.lineNoDiscount : DT.percent(p)}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </span>
        ) : null}
        {rules.voidShown || line.refund ? (
          <button
            type="button"
            className="d-strip-btn d-red"
            onClick={() => {
              onDone();
              actions.remove(line.lineId);
            }}
          >
            {DT.lineRemove}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The totals: the basket's discount, "סה״כ לתשלום" (not over a dock — the dock says it), and the shift's warning. */
export function TotalsBlock({ sell, withTotal, shiftOpen }: { sell: SellState; withTotal: boolean; shiftOpen: boolean }) {
  const payout = sell.totalAgorot < 0;
  return (
    <div className="d-totals">
      {sell.basketDiscount ? (
        <div className="d-total-row d-red">
          <span>{sell.basketDiscount.preset ? sell.basketDiscount.preset.name : DT.basketDiscount}</span>
          <span>−{money(sell.basketDiscount.amountAgorot)}</span>
        </div>
      ) : null}
      {withTotal ? (
        <div className={`d-total-row d-total-main${payout ? ' d-red' : ''}`}>
          <span>{payout ? T.basketToRefund : DT.totalToPay}</span>
          <strong>{money(Math.abs(sell.totalAgorot))}</strong>
        </div>
      ) : null}
      {!shiftOpen ? <div className="d-total-warn">{DT.noShift}</div> : null}
    </div>
  );
}

/** "סיכום ההזמנה · 4 פריטים ⌃" and the total: a tap opens the summary (or the order sheet). */
export function SummaryBar({ label, total, open, onClick }: { label: string; total: string; open: boolean; onClick(): void }) {
  return (
    <button type="button" className="d-summary-bar" aria-label={open ? DT.summaryClose : DT.summaryOpen} aria-expanded={open} onClick={onClick}>
      <span className="d-summary-label">{label}</span>
      <span className={`d-summary-chev${open ? ' d-summary-chev-open' : ''}`} aria-hidden="true">
        ⌃
      </span>
      <span className="d-summary-spacer" />
      <strong className="d-summary-total">{total}</strong>
    </button>
  );
}
