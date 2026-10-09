/**
 * The cart, as the engine says it: lines, quantities, discounts, the total with its VAT. Every
 * change is an op (`sell.setQty`, `sell.discount`, `sell.remove`, `sell.clear`); a discount above
 * what a cashier may give comes back as the engine's manager dialog, not as a rule here.
 */

import { useState } from 'react';
import type { SellState } from '../../../../shared/till/protocol';
import { money, T } from '../text';

export interface CartActions {
  setQty(lineId: string, qty: number): void;
  discount(lineId: string, pct: number): void;
  remove(lineId: string): void;
  clear(): void;
  pay(): void;
}

export function CartPane({ sell, actions, compact }: { sell: SellState; actions: CartActions; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  const empty = sell.lines.length === 0;
  return (
    <section className={`t-cart${compact ? ' t-cart-compact' : ''}`} aria-label={T.cart}>
      <header className="t-cart-head">
        <span>{T.cart}</span>
        <span className="t-muted">
          {sell.itemCount} {T.items}
        </span>
      </header>
      <ol className="t-lines">
        {empty ? <li className="t-empty">{T.cartEmpty}</li> : null}
        {sell.lines.map((l) => (
          <li key={l.lineId} className="t-line">
            <button type="button" className="t-line-main" onClick={() => setOpen(open === l.lineId ? null : l.lineId)} aria-expanded={open === l.lineId}>
              <span className="t-line-name">{l.name}</span>
              {l.discountPct > 0 ? <span className="t-badge">-{l.discountPct}%</span> : null}
              <span className="t-line-total">{money(l.totalAgorot)}</span>
            </button>
            <div className="t-qty">
              <button type="button" className="t-step" aria-label="פחות" onClick={() => actions.setQty(l.lineId, l.qty - 1)}>
                −
              </button>
              <span className="t-qty-n">{l.qty}</span>
              <button type="button" className="t-step" aria-label="עוד" onClick={() => actions.setQty(l.lineId, l.qty + 1)}>
                +
              </button>
            </div>
            {open === l.lineId ? (
              <div className="t-line-actions">
                <button type="button" className="t-chip" onClick={() => actions.discount(l.lineId, 10)}>
                  {T.discount} 10%
                </button>
                <button type="button" className="t-chip" onClick={() => actions.discount(l.lineId, 50)}>
                  {T.discount} 50%
                </button>
                <button type="button" className="t-chip t-chip-danger" onClick={() => actions.remove(l.lineId)}>
                  {T.remove}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ol>
      <footer className="t-cart-foot">
        <div className="t-total-row">
          <span>{T.total}</span>
          <strong className="t-total">{money(sell.totalAgorot)}</strong>
        </div>
        <div className="t-muted t-small">
          {T.vatIncluded} {money(sell.vatAgorot)}
        </div>
        <div className="t-cart-buttons">
          <button type="button" className="t-btn t-btn-ghost" disabled={empty} onClick={actions.clear}>
            {T.clear}
          </button>
          <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={empty} onClick={actions.pay}>
            {T.pay} {empty ? '' : money(sell.totalAgorot)}
          </button>
        </div>
      </footer>
    </section>
  );
}
