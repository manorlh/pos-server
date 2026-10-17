/**
 * The sell screen's sheets for refunds, discounts, OTH and held sales — the Android till's (SellSheets.kt, OthClubUi.kt,
 * HeldSalesAtCloseUi.kt) in their words. Every figure and every decision is the engine's: a sheet keys, asks the engine
 * (`discount.preview`, `refund.find`…) and sends the op; a manager's code, a ceiling or a refusal comes back from the engine
 * as its dialog or its sentence.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BasketDiscountMode, CartLine, HeldState, PresetDiscountsState, RefundableLine } from '../../../../shared/till/protocol';
import { money, T } from '../text';

/* ---------------------------------------------------------------- the frame */

function Sheet({ title, onClose, children, wide }: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className={`t-dialog${wide ? ' t-dialog-wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{title}</h2>
        {children}
        <div className="t-dialog-actions">
          <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
            {T.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- the basket discount */

export interface DiscountPreview {
  amountAgorot: number;
  newTotalAgorot: number;
  exceedsBasket: boolean;
  excludedAgorot: number;
  canApply: boolean;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'] as const;

export type PresetItem = PresetDiscountsState['items'][number];

/**
 * "הנחות קבועות": one chip per preset (its name, in its colour), the one on the basket highlighted — a tap applies it, the
 * same tap takes it off (the engine decides both).
 */
export function PresetChips({ items, activeId, disabled, onTap }: { items: readonly PresetItem[]; activeId: string | null; disabled?: boolean; onTap(id: string): void }) {
  if (items.length === 0) return null;
  return (
    <div className="t-quick t-presets" role="group" aria-label={T.presetDiscounts}>
      {items.map((p) => {
        const on = p.id === activeId;
        const style = p.color ? (on ? { background: p.color, borderColor: p.color, color: '#fff' } : { borderColor: p.color, color: p.color }) : undefined;
        return (
          <button key={p.id} type="button" className={`t-chip${on ? ' t-chip-on' : ''}`} style={style} aria-pressed={on} disabled={disabled && !on} onClick={() => onTap(p.id)}>
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

/** "הנחה לחשבון" (BasketDiscountSheet): %, ₪ or "לתשלום ₪" — keyed here, previewed and applied by the engine. */
export function BasketDiscountSheet({
  preview,
  apply,
  remove,
  current,
  presets,
  onPreset,
  onClose,
}: {
  preview(mode: BasketDiscountMode, input: string): Promise<DiscountPreview | undefined>;
  apply(mode: BasketDiscountMode, input: string): void;
  remove?(): void;
  current: { amountAgorot: number; preset?: { id: string } } | null;
  /** "הנחות קבועות" at the top (none: as before). */
  presets?: readonly PresetItem[];
  onPreset?(id: string): void;
  onClose(): void;
}) {
  const [mode, setMode] = useState<BasketDiscountMode>('percent');
  const [input, setInput] = useState('');
  const [p, setP] = useState<DiscountPreview | null>(null);
  useEffect(() => {
    let alive = true;
    void preview(mode, input).then((r) => alive && setP(r ?? null));
    return () => {
      alive = false;
    };
  }, [mode, input, preview]);
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'back') setInput((t) => t.slice(0, -1));
    else if (k === '.') setInput((t) => (mode === 'percent' || t.includes('.') ? t : t === '' ? '0.' : `${t}.`));
    else
      setInput((t) => {
        const next = t === '0' ? k : t + k;
        if (mode === 'percent') return Number(next) > 100 ? t : next;
        return /^\d{0,6}(\.\d{0,2})?$/.test(next) ? next : t;
      });
  };
  return (
    <Sheet title={T.basketDiscount} onClose={onClose}>
      {presets && presets.length > 0 && onPreset ? <PresetChips items={presets} activeId={current?.preset?.id ?? null} onTap={onPreset} /> : null}
      <div className="t-departments" role="tablist">
        {(['percent', 'fixed', 'target'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className={`t-chip${mode === m ? ' t-chip-on' : ''}`}
            onClick={() => {
              // Switching between % and ₪ drops the digits: "10" means two different sums.
              setMode(m);
              setInput('');
            }}
          >
            {m === 'percent' ? T.basketDiscountPercent : m === 'fixed' ? T.basketDiscountFixed : T.basketDiscountTarget}
          </button>
        ))}
      </div>
      <div className="t-cash-input" aria-live="polite">
        <strong className="t-amount">{mode === 'percent' ? `${input || '0'}%` : `₪${input || '0'}`}</strong>
      </div>
      {p ? (
        <div className={`t-change-line${p.exceedsBasket ? ' t-change-short' : ''}`}>
          {p.exceedsBasket ? 'ההנחה גדולה מהסכום לתשלום' : `${T.basketDiscountNewTotal}: ${money(p.newTotalAgorot)} (−${money(p.amountAgorot)})`}
        </div>
      ) : null}
      {p && p.excludedAgorot > 0 ? <p className="t-muted t-small">{T.basketDiscountExcluded(money(p.excludedAgorot))}</p> : null}
      <div className="t-pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="t-key" disabled={k === '.' && mode === 'percent'} onClick={() => press(k)}>
            {k === 'back' ? '⌫' : k}
          </button>
        ))}
      </div>
      <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={!p?.canApply} onClick={() => apply(mode, input)}>
        {T.basketDiscountApply}
      </button>
      {current && remove ? (
        <button type="button" className="t-btn t-btn-wide" onClick={remove}>
          {T.basketDiscountRemove} (−{money(current.amountAgorot)})
        </button>
      ) : null}
    </Sheet>
  );
}

/**
 * "עבור מי" before a preset that asks it: an employee picked (`employees`), or a name typed (`free`, and `club` — this till
 * attaches no club customer to a sale, so it is typed). `required`: no name, no discount.
 */
export function PresetForSheet({
  preset,
  employees,
  onApply,
  onClose,
}: {
  preset: PresetItem;
  employees: ReadonlyArray<{ id: string; name: string }>;
  onApply(who: { for?: string; forKind?: 'employee' | 'typed'; forRef?: string }): void;
  onClose(): void;
}) {
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [typed, setTyped] = useState('');
  const pick = preset.forWhomSource === 'employees' ? employees : [];
  const name = picked ? picked.name : typed.trim();
  const required = preset.forWhom === 'required';
  return (
    <Sheet title={T.presetForTitle(preset.name)} onClose={onClose}>
      {pick.length > 0 ? (
        <>
          <p className="t-small t-muted">{T.presetForEmployees}</p>
          <div className="t-quick">
            {pick.map((e) => (
              <button
                key={e.id}
                type="button"
                className={`t-chip${picked?.id === e.id ? ' t-chip-on' : ''}`}
                onClick={() => {
                  setPicked(picked?.id === e.id ? null : e);
                  setTyped('');
                }}
              >
                {e.name}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <input
        className="t-input"
        placeholder={T.presetForName}
        maxLength={60}
        value={picked ? '' : typed}
        onChange={(e) => {
          setPicked(null);
          setTyped(e.target.value);
        }}
      />
      {required && !name ? <p className="t-small t-muted">{T.presetForRequired}</p> : null}
      <button
        type="button"
        className="t-btn t-btn-primary t-btn-wide"
        disabled={required && !name}
        onClick={() => onApply(picked ? { for: picked.name, forKind: 'employee', forRef: picked.id } : name ? { for: name, forKind: 'typed' } : {})}
      >
        {T.presetForApply}
      </button>
      {!required ? (
        <button type="button" className="t-btn t-btn-wide" onClick={() => onApply({})}>
          {T.presetForSkip}
        </button>
      ) : null}
    </Sheet>
  );
}

/* ----------------------------------------------------------------------- OTH */

/** "OTH — על חשבון הבית": the lines (one picked for you when there is one) and the reason. */
export function OthSheet({ lines, reasons, requiresManager, initial, onConfirm, onClose }: { lines: CartLine[]; reasons: string[]; requiresManager: boolean; initial?: string | null; onConfirm(lineIds: string[], reason: string): void; onClose(): void }) {
  const candidates = lines.filter((l) => !l.refund && !l.oth && !l.noDiscount);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(initial ? [initial] : candidates.length === 1 ? [candidates[0].lineId] : []));
  const [reason, setReason] = useState<string | null>(null);
  const worth = candidates.filter((l) => picked.has(l.lineId)).reduce((s, l) => s + l.unitAgorot * l.qty, 0);
  return (
    <Sheet title={T.othTitle} onClose={onClose}>
      <p className="t-small t-muted">{T.othPickLines}</p>
      <ul className="t-menu">
        {candidates.map((l) => (
          <li key={l.lineId}>
            <label className="t-menu-row">
              <input
                type="checkbox"
                checked={picked.has(l.lineId)}
                onChange={() =>
                  setPicked((s) => {
                    const n = new Set(s);
                    if (n.has(l.lineId)) n.delete(l.lineId);
                    else n.add(l.lineId);
                    return n;
                  })
                }
              />
              <span>
                {l.name} × {l.qty}
              </span>
              <small>{money(l.unitAgorot * l.qty)}</small>
            </label>
          </li>
        ))}
      </ul>
      <p className="t-small t-muted">{T.othPickReason}</p>
      <div className="t-quick">
        {reasons.map((r) => (
          <button key={r} type="button" className={`t-chip${reason === r ? ' t-chip-on' : ''}`} onClick={() => setReason(r)}>
            {r}
          </button>
        ))}
      </div>
      {requiresManager ? <p className="t-small t-muted">{T.othNeedsManager}</p> : null}
      <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={picked.size === 0 || !reason} onClick={() => reason && onConfirm([...picked], reason)}>
        {T.othConfirm(money(worth))}
      </button>
    </Sheet>
  );
}

/* --------------------------------------------------------------- refunds */

/** The refund's authority given: the two ways a return gets in. */
export function RefundChooser({ onCatalog, onReceipt, onClose }: { onCatalog(): void; onReceipt(): void; onClose(): void }) {
  return (
    <Sheet title={T.refund} onClose={onClose}>
      <ul className="t-menu">
        <li>
          <button type="button" className="t-menu-row" onClick={onCatalog}>
            <span>{T.refundChoiceCatalog}</span>
            <small className="t-reason">{T.refundChoiceCatalogSub}</small>
          </button>
        </li>
        <li>
          <button type="button" className="t-menu-row" onClick={onReceipt}>
            <span>{T.refundChoiceReceipt}</span>
            <small className="t-reason">{T.refundChoiceReceiptSub}</small>
          </button>
        </li>
      </ul>
    </Sheet>
  );
}

export interface ReceiptRow {
  transactionId: string;
  number: string;
  at: string;
  documentType: number;
  totalAgorot: number;
}

export interface ReceiptFind {
  notFound?: boolean;
  message?: string;
  matches?: ReceiptRow[];
  document?: ReceiptRow;
  lines?: RefundableLine[];
}

/** "זיכוי מקבלה": the recent receipts, a number looked up, a receipt's lines picked, into the cart as returns. */
export function ReceiptPicker({
  recent,
  find,
  pick,
  add,
  onClose,
}: {
  recent(): Promise<ReceiptRow[] | undefined>;
  find(query: string): Promise<ReceiptFind | undefined>;
  pick(transactionId: string): Promise<ReceiptFind | undefined>;
  add(transactionId: string, quantities: Record<string, number>): Promise<boolean>;
  onClose(): void;
}) {
  const [rows, setRows] = useState<ReceiptRow[]>([]);
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<ReceiptFind | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    void recent().then((r) => alive && setRows(r ?? []));
    return () => {
      alive = false;
    };
  }, [recent]);
  const show = (r: ReceiptFind | undefined) => {
    setResult(r ?? null);
    setQty({});
  };
  const doc = result?.document ?? null;
  return (
    <Sheet title={T.receiptTitle} onClose={onClose} wide>
      <div className="t-row-input">
        <input className="t-input" inputMode="numeric" placeholder={T.receiptNumber} value={query} onChange={(e) => setQuery(e.target.value.replace(/[^0-9\-–—־]/g, '').slice(0, 16))} onKeyDown={(e) => e.key === 'Enter' && void find(query).then(show)} />
        <button type="button" className="t-btn" disabled={!query} onClick={() => void find(query).then(show)}>
          {T.receiptFind}
        </button>
      </div>
      {result?.message ? <p className="t-warn t-small">{result.message}</p> : null}
      {result?.matches ? (
        <ul className="t-menu">
          {result.matches.map((m) => (
            <li key={m.transactionId}>
              <button type="button" className="t-menu-row" onClick={() => void pick(m.transactionId).then(show)}>
                <span>{T.receiptDoc(m.number)}</span>
                <small>
                  {m.documentType} · {money(m.totalAgorot)}
                </small>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {doc && result?.lines ? (
        <>
          <h3 className="t-menu-title">{T.receiptDoc(doc.number)}</h3>
          <ul className="t-menu">
            {result.lines.map((l) => (
              <li key={l.itemId} className="t-menu-row">
                <span>{l.name}</span>
                <small className="t-reason">{l.remainingQty > 0 ? T.receiptLine(money(l.unitNetAgorot), String(l.remainingQty)) : T.receiptNothingLeft}</small>
                <div className="t-qty">
                  <button type="button" className="t-step" aria-label="פחות" disabled={(qty[l.itemId] ?? 0) <= 0} onClick={() => setQty((q) => ({ ...q, [l.itemId]: Math.max(0, (q[l.itemId] ?? 0) - 1) }))}>
                    −
                  </button>
                  <span className="t-qty-n">{qty[l.itemId] ?? 0}</span>
                  <button type="button" className="t-step" aria-label="עוד" disabled={(qty[l.itemId] ?? 0) >= l.remainingQty} onClick={() => setQty((q) => ({ ...q, [l.itemId]: Math.min(l.remainingQty, (q[l.itemId] ?? 0) + 1) }))}>
                    +
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="t-btn t-btn-primary t-btn-wide"
            disabled={!Object.values(qty).some((n) => n > 0)}
            onClick={() => void add(doc.transactionId, qty).then((ok) => ok && onClose())}
          >
            {T.receiptAdd}
          </button>
        </>
      ) : (
        <>
          <h3 className="t-menu-title">{T.receiptRecent}</h3>
          <ul className="t-menu">
            {rows.map((r) => (
              <li key={r.transactionId}>
                <button type="button" className="t-menu-row" onClick={() => void pick(r.transactionId).then(show)}>
                  <span>{T.receiptDoc(r.number)}</span>
                  <small>
                    {new Date(r.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · {money(r.totalAgorot)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}

/* ------------------------------------------------------------- held sales */

/**
 * "מכירות בהמתנה": the list (pick one up, cancel one with a reason) — and, at a close, the same list with "יש N מכירות
 * מושהות" and, where the shop allows it, "סגור והשאר מושהות".
 */
export function HeldSheet({
  held,
  canHold,
  hideCancel,
  closing,
  onHold,
  onResume,
  onCancel,
  onKeepAndClose,
  onClose,
}: {
  held: HeldState;
  canHold: boolean;
  /** "כשאין הרשאה" = להסתיר: "מחק" left out of the sell screen's list (never at a close). */
  hideCancel?: boolean;
  closing?: boolean;
  onHold?(label: string): void;
  onResume(id: string): void;
  onCancel(id: string, reason: string): void;
  onKeepAndClose?(): void;
  onClose(): void;
}) {
  const [label, setLabel] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const target = useMemo(() => held.sales.find((s) => s.id === cancelling) ?? null, [held.sales, cancelling]);
  return (
    <Sheet title={closing ? T.heldCloseTitle(held.count) : T.heldTitle} onClose={onClose} wide>
      {closing ? <p className="t-small">{held.count === 0 ? 'אין מכירות מושהות — אפשר להמשיך בסגירה.' : T.heldCloseBody}</p> : null}
      {!closing && canHold && onHold ? (
        <div className="t-row-input">
          <input className="t-input" placeholder={T.holdLabelTitle} maxLength={24} value={label} onChange={(e) => setLabel(e.target.value)} />
          <button type="button" className="t-btn t-btn-primary" onClick={() => onHold(label)}>
            {label.trim() ? T.holdWithLabel : T.holdNow}
          </button>
        </div>
      ) : null}
      {!closing && canHold ? <p className="t-muted t-small">{T.holdLabelWhy}</p> : null}
      {held.sales.length === 0 ? <p className="t-muted">{T.heldEmpty}</p> : null}
      <ul className="t-menu">
        {held.sales.map((h) => (
          <li key={h.id} className="t-menu-row">
            <span>
              {h.label ?? T.heldUnnamed} · {h.itemCount} {T.items} · {money(h.totalAgorot)}
            </span>
            <small className="t-reason">
              {new Date(h.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · {h.cashier ?? ''} · {h.items.map((i) => `${i.name}×${i.quantity}`).join(', ')}
            </small>
            <div className="t-line-actions">
              <button type="button" className="t-chip" onClick={() => onResume(h.id)}>
                {closing ? T.heldClosePay : T.heldResume}
              </button>
              {hideCancel && !closing ? null : (
                <button type="button" className="t-chip t-chip-danger" onClick={() => setCancelling(h.id)}>
                  {closing ? T.heldCloseCancel : T.heldDiscard}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {target ? (
        <div className="t-ask">
          <p>ביטול מכירה מושהית ({money(target.totalAgorot)})</p>
          <input className="t-input" placeholder={T.heldCancelReason} value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="t-ask-actions">
            <button
              type="button"
              className="t-btn t-btn-primary"
              disabled={!reason.trim()}
              onClick={() => {
                onCancel(target.id, reason.trim());
                setCancelling(null);
                setReason('');
              }}
            >
              {T.heldCancelConfirm}
            </button>
            <button type="button" className="t-btn" onClick={() => setCancelling(null)}>
              {T.cancel}
            </button>
          </div>
        </div>
      ) : null}
      {closing && held.keepAllowed && onKeepAndClose ? (
        <button type="button" className="t-btn t-btn-wide" onClick={onKeepAndClose}>
          {T.heldCloseKeep}
        </button>
      ) : null}
    </Sheet>
  );
}

/** A notice the shift opens with ("סגירה אוטומטית במשמרת הקודמת"), until "הבנתי". */
export function NoticeDialog({ title, text, onOk }: { title: string; text: string; onOk(): void }) {
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="t-dialog">
        <h2 className="t-dialog-title">{title}</h2>
        {text.split('\n').map((line, i) => (
          <p key={i} className="t-dialog-body">
            {line}
          </p>
        ))}
        <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={onOk}>
          {T.noticeOk}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- the order's details */

/**
 * "פרטי הזמנה" (Android OrderNameSheet.kt `OrderDetailsSheet`): a question at a time — "לקחת או לשבת?" as two big buttons (a
 * tap answers and moves on), then the customer's name; only what the engine asks shows. Both are mandatory: the button stays
 * off without a name. The engine keeps the answers and goes on (the held first item, the payment).
 */
export function OrderDetailsSheet({
  ask,
  dining: initialDining,
  name: initialName,
  texts,
  onConfirm,
  onDismiss,
}: {
  ask: { dining: boolean; name: boolean; confirmLabel: string };
  dining: 'take_away' | 'eat_in' | null;
  name: string | null;
  texts: { diningQuestion: string; nameTitle: string; takeAway: string; eatIn: string; nameLabel: string; nameHint: string; back: string; cancel: string };
  onConfirm(dining: 'take_away' | 'eat_in' | null, name: string | null): void;
  onDismiss(): void;
}) {
  const [dining, setDining] = useState(initialDining);
  const [name, setName] = useState(initialName ?? '');
  const [step, setStep] = useState<'dining' | 'name' | null>(ask.dining ? 'dining' : ask.name ? 'name' : null);
  const finish = (d = dining) => onConfirm(ask.dining ? d : null, ask.name ? name.trim() : null);
  const choose = (d: 'take_away' | 'eat_in') => {
    setDining(d);
    if (ask.name) setStep('name');
    else finish(d);
  };
  const title = step === 'dining' ? texts.diningQuestion : texts.nameTitle;
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onDismiss}>
      <div className="t-dialog t-order-details" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{title}</h2>
        {step === 'dining' ? (
          <>
            <div className="t-order-dining">
              <button type="button" className={`t-order-choice${dining === 'take_away' ? ' t-order-choice-on' : ''}`} onClick={() => choose('take_away')}>
                <span className="t-order-icon" aria-hidden="true">
                  🛍
                </span>
                <span>{texts.takeAway}</span>
              </button>
              <button type="button" className={`t-order-choice${dining === 'eat_in' ? ' t-order-choice-on' : ''}`} onClick={() => choose('eat_in')}>
                <span className="t-order-icon" aria-hidden="true">
                  🍽
                </span>
                <span>{texts.eatIn}</span>
              </button>
            </div>
            <div className="t-dialog-actions">
              <button type="button" className="t-btn t-btn-ghost" onClick={onDismiss}>
                {texts.cancel}
              </button>
            </div>
          </>
        ) : (
          <>
            {ask.dining && dining ? <p className="t-order-answered">{dining === 'take_away' ? texts.takeAway : texts.eatIn}</p> : null}
            <label className="t-field">
              <span>{texts.nameLabel}</span>
              <input
                className="t-input"
                autoFocus
                value={name}
                maxLength={40}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && name.trim()) finish();
                }}
              />
            </label>
            <p className="t-muted t-small">{texts.nameHint}</p>
            <div className="t-dialog-actions">
              {ask.dining ? (
                <button type="button" className="t-btn t-btn-ghost" onClick={() => setStep('dining')}>
                  {texts.back}
                </button>
              ) : (
                <button type="button" className="t-btn t-btn-ghost" onClick={onDismiss}>
                  {texts.cancel}
                </button>
              )}
              <button type="button" className="t-btn t-btn-primary" disabled={!name.trim()} onClick={() => finish()}>
                {ask.confirmLabel}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * "כשאין מספיק מזומן לטיפים באשראי" = ask (P:/specs/x-z-cash-with-tips.md §2): at the close, only when the drawer is short
 * of the card tips — pay only what is there (the rest owed to staff) or pay all, the drawer below zero.
 */
export function CardTipsChoiceSheet({ title, body, partial, negative, onChoose, onClose }: { title: string; body: string; partial: string; negative: string; onChoose(choice: 'partial' | 'negative'): void; onClose(): void }) {
  return (
    <Sheet title={title} onClose={onClose}>
      {body ? <p className="t-small">{body}</p> : null}
      <div className="t-shift-actions">
        <button type="button" className="t-btn t-btn-primary" onClick={() => onChoose('partial')}>
          {partial}
        </button>
        <button type="button" className="t-btn" onClick={() => onChoose('negative')}>
          {negative}
        </button>
      </div>
    </Sheet>
  );
}
