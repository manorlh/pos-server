/**
 * "עמדת שובר" (the Android VoucherStationScreen; core/till/voucherStation.ts, main/till/tillVoucherStation.ts): while the station
 * is on it takes the sell screen's place. Its home — "סרקו שובר" with the scan frame, "הקלדת קוד", the sale so far and
 * "סיום וסגירת העסקה", an order left open; "בודק…"; a refusal in red; the voucher's picker ("תנאי המימוש", its groups, "הוסף
 * למימוש", "הוסף פריט בתשלום", "סריקת שובר נוסף", the bar); the smart basket (the catalog, the basket's rows, the banner and
 * the bar). The scanner types into the field (always focused) and presses Enter. This only draws what the state says.
 */

import { useEffect, useRef, useState } from 'react';
import { VOUCHER_STATION_TEXT as T, type StationItemView, type VoucherStationState } from '../../../../core/till/voucherStation';
import { typedByHand } from '../../../../core/till/voucherBalance';

export interface VoucherStationActions {
  /** A scan (the scanner's Enter) or a typed code. */
  scan(code: string, typed: boolean): void;
  dismiss(): void;
  pick(productId: string, groupKey: string, delta: 1 | -1): void;
  /** "הוסף למימוש". */
  commit(): void;
  closePicker(): void;
  /** "הוסף פריט בתשלום". */
  basket(): void;
  add(productId: string): void;
  toggle(lineId: string, toVoucher: boolean): void;
  category(categoryId: string | null): void;
  /** "חזרה לסריקה". */
  backToScan(): void;
  removeVoucher(voucherId: string): void;
  /** The primary button / "סיום וסגירת העסקה". */
  pay(): void;
  /** "המשך לתשלום" (an order left open). */
  payOpen(): void;
  /** "ביטול ההזמנה". */
  clear(): void;
}

/** The field the scanner types into (and the cashier, when typing is on). */
function ScanField({ manual, busy, onScan, label }: { manual: boolean; busy: boolean; onScan(code: string, typed: boolean): void; label: string }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setInterval(() => {
      // The scanner needs the field: focus comes back unless the cashier is typing elsewhere.
      const a = document.activeElement;
      if (ref.current && (!a || a === document.body)) ref.current.focus();
    }, 500);
    ref.current?.focus();
    return () => clearInterval(t);
  }, []);
  const submit = () => {
    const v = text.trim();
    if (!v || busy) return;
    setText('');
    onScan(v, manual && typedByHand(v));
  };
  return (
    <div className={`vst-scanfield${manual ? '' : ' vst-scanfield-quiet'}`}>
      <input
        ref={ref}
        className="t-input vst-input"
        aria-label={label}
        placeholder={manual ? label : ''}
        value={text}
        maxLength={60}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setText(e.target.value.slice(0, 60))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      {manual ? (
        <button type="button" className="t-btn" disabled={busy || !text.trim()} onClick={submit}>
          {T.lookup}
        </button>
      ) : null}
    </div>
  );
}

/** The big voucher in the scan frame (a ticket, its notch and lines) — no movement: a Celeron draws it once. */
function VoucherGlyph() {
  return (
    <svg className="vst-glyph" viewBox="0 0 100 58" aria-hidden="true">
      <rect x="0" y="0" width="100" height="58" rx="7" fill="#1f5fd1" />
      <circle cx="68" cy="0" r="8" fill="#e5edfb" />
      <circle cx="68" cy="58" r="8" fill="#e5edfb" />
      <line x1="68" y1="11" x2="68" y2="47" stroke="#ffffff" strokeWidth="2" strokeDasharray="4 3" />
      <line x1="10" y1="17" x2="52" y2="17" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
      <line x1="10" y1="29" x2="44" y2="29" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
      <line x1="10" y1="41" x2="36" y2="41" stroke="#ffffff" strokeWidth="4" strokeLinecap="round" />
      <circle cx="84" cy="29" r="7.5" fill="#ffffff" />
      <circle cx="84" cy="29" r="4" fill="#1f5fd1" />
    </svg>
  );
}

function ItemButton({ item, onAdd, onRemove }: { item: StationItemView; onAdd(): void; onRemove?: () => void }) {
  return (
    <div className={`vst-item${item.tag ? ` vst-tag-${item.tag}` : ''}${item.why ? ' vst-item-off' : ''}`}>
      <button type="button" className="vst-item-main" disabled={!item.available} onClick={onAdd} title={item.why ?? undefined}>
        <span className="vst-item-name">{item.name}</span>
        <span className="vst-item-price">{item.tagText ?? item.price}</span>
        {item.why ? <span className="vst-item-why">{item.why}</span> : null}
      </button>
      {item.count > 0 ? (
        <span className="vst-item-count">
          {onRemove ? (
            <button type="button" className="t-btn t-btn-small" onClick={onRemove} aria-label="−">
              −
            </button>
          ) : null}
          <b>{item.count}</b>
        </span>
      ) : null}
    </div>
  );
}

function Home({ view, actions }: { view: VoucherStationState; actions: VoucherStationActions }) {
  const h = view.home;
  return (
    <div className="vst-home">
      {h.strip ? (
        <section className="vst-sale">
          <p className="vst-strip">{h.strip}</p>
          <ul className="t-list vst-vouchers">
            {h.vouchers.map((v) => (
              <li key={v.voucherId} className="t-list-row vst-voucher-row">
                <span>
                  <b>{v.title}</b>
                  {v.covers ? <span className="t-muted"> · {v.covers}</span> : null}
                </span>
                <button type="button" className="t-btn t-btn-small" onClick={() => actions.removeVoucher(v.voucherId)}>
                  {T.removeVoucher}
                </button>
              </li>
            ))}
          </ul>
          {h.finish ? (
            <button type="button" className="t-btn t-btn-primary t-btn-big" disabled={view.busy} onClick={actions.pay}>
              {T.finish}
            </button>
          ) : null}
          {h.basket ? (
            <button type="button" className="t-btn" onClick={actions.basket}>
              {T.paidItem}
            </button>
          ) : null}
        </section>
      ) : null}
      {h.scanText ? (
        <div className="vst-frame-wrap">
          <div className="vst-frame">
            <VoucherGlyph />
          </div>
          <div className="vst-words">
            <p className="vst-scan-text">{h.scanText}</p>
            <p className="t-muted">{h.hint}</p>
          </div>
        </div>
      ) : null}
      {h.nothing ? <p className="t-bad vst-center">{h.nothing}</p> : null}
      {h.openOrder ? (
        <section className="vst-open">
          <p>{h.openOrder}</p>
          <div className="vst-row">
            <button type="button" className="t-btn t-btn-primary" onClick={actions.payOpen}>
              {T.pay}
            </button>
            <button type="button" className="t-btn" onClick={actions.clear}>
              {T.clear}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Picker({ view, actions }: { view: VoucherStationState; actions: VoucherStationActions }) {
  const p = view.picker!;
  return (
    <div className="vst-picker">
      {p.testBar ? <div className="vst-test">{p.testBar}</div> : null}
      <section className="vst-card">
        <p className="vst-card-title">{p.title}</p>
        {p.typeName ? <p className="vst-card-type">{p.typeName}</p> : null}
        {p.event ? <p>{p.event}</p> : null}
        {p.production ? <p className="t-small">{p.production}</p> : null}
        {p.validUntil ? <p className="t-small t-muted">{p.validUntil}</p> : null}
        {p.discount ? (
          <>
            <p className="vst-strong">{p.discount.card}</p>
            <p className="t-small">{p.discount.header}</p>
          </>
        ) : null}
      </section>
      {p.conditions.length > 0 ? (
        <details className="vst-conditions" open>
          <summary className="t-menu-title">{T.conditions}</summary>
          <ul>
            {p.conditions.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {p.groups.map((g) => (
        <section key={g.key} className="t-menu-group vst-group">
          <h2 className={`t-menu-title${g.full ? ' t-ok' : ''}`}>{g.counter}</h2>
          <div className="vst-items">
            {g.items.map((it) => (
              <ItemButton key={`${it.productId}|${it.groupKey}`} item={it} onAdd={() => actions.pick(it.productId, it.groupKey ?? g.key, 1)} onRemove={() => actions.pick(it.productId, it.groupKey ?? g.key, -1)} />
            ))}
          </div>
        </section>
      ))}
      {p.more > 0 ? <p className="t-small t-muted">+{p.more}</p> : null}
      <p className="t-muted">{p.limitNote}</p>
      {p.refusal ? <p className="t-bad">{p.refusal}</p> : null}
      {p.entitlement ? <p className="vst-alert">{p.entitlement}</p> : null}
      <div className="vst-row">
        <button type="button" className="t-btn t-btn-primary" disabled={!p.canAdd || view.busy} onClick={actions.commit}>
          {T.add}
        </button>
        <button type="button" className="t-btn" disabled={!p.paidButton.enabled || view.busy} onClick={actions.basket}>
          {p.paidButton.text}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.closePicker}>
          {T.cancel}
        </button>
      </div>
      {p.paidButton.why ? <p className="t-small t-muted">{p.paidButton.why}</p> : null}
      {p.scanAnother ? <p className="t-small t-muted">{T.scanAnother}: {T.hintHead}</p> : null}
      {p.bar ? (
        <div className="vst-bar">
          <span className="vst-bar-text">{p.bar.text}</span>
          <button type="button" className={`t-btn t-btn-big${p.bar.green ? ' vst-green' : ' t-btn-primary'}`} disabled={view.busy} onClick={actions.pay}>
            {p.bar.button}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Basket({ view, actions }: { view: VoucherStationState; actions: VoucherStationActions }) {
  const b = view.basket!;
  return (
    <div className="vst-basket">
      <section className={`vst-banner vst-banner-${b.banner.tone}`}>
        <p className="vst-strong">{b.banner.title}</p>
        {b.banner.status ? <p>{b.banner.status}</p> : null}
        {b.banner.note ? <p className="t-small">{b.banner.note}</p> : null}
      </section>
      {b.refused ? <p className="vst-refused">{b.refused}</p> : null}
      {b.hint ? <p className={b.hint.covered ? 't-ok' : 't-warn'}>{b.hint.text}</p> : null}
      {b.bar.usage.length > 0 ? <p className="t-small">{b.bar.usage.join(' · ')}</p> : null}
      <div className="vst-basket-body">
        <section className="vst-catalog">
          <div className="t-chips vst-chips">
            {b.categories.map((c) => (
              <button key={c.id ?? 'all'} type="button" className={`t-chip${c.on ? ' t-chip-on' : ''}`} onClick={() => actions.category(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
          <div className="vst-items">
            {b.items.map((it) => (
              <ItemButton key={it.productId} item={{ ...it, count: 0 }} onAdd={() => actions.add(it.productId)} />
            ))}
          </div>
          {b.more > 0 ? <p className="t-small t-muted">+{b.more}</p> : null}
        </section>
        <section className="vst-cart">
          <ul className="t-list">
            {b.rows.map((r) => (
              <li key={`${r.lineId}:${r.covered ? 'v' : 'p'}`} className="t-list-row vst-cart-row">
                <button type="button" className="vst-cart-main" disabled={!r.mayMove} onClick={() => actions.toggle(r.lineId, !r.covered)}>
                  <span>
                    {r.name} ×{r.quantity}
                  </span>
                  <span className={r.covered ? 'vst-chip-voucher' : 'vst-chip-paid'}>{r.tagText}</span>
                  <span>{r.amount}</span>
                </button>
              </li>
            ))}
          </ul>
          <dl className="t-figures vst-totals">
            <dt>{T.orderTotal}</dt>
            <dd>{b.totals.order}</dd>
            <dt>{T.inVouchers}</dt>
            <dd>{b.totals.vouchers}</dd>
            <dt>{T.toPay}</dt>
            <dd>{b.totals.toPay}</dd>
          </dl>
        </section>
      </div>
      <div className="vst-bar">
        <button type="button" className="t-btn" onClick={actions.backToScan}>
          {T.backToScan}
        </button>
        {b.scanAnother ? <span className="t-small t-muted">{T.scanAnother}: {T.hintHead}</span> : null}
        <button type="button" className={`t-btn t-btn-big${b.primary.green ? ' vst-green' : ' t-btn-primary'}`} disabled={!b.primary.enabled || view.busy} onClick={actions.pay}>
          {b.primary.text}
        </button>
      </div>
    </div>
  );
}

export function VoucherStationScreen({ view, actions, back }: { view: VoucherStationState; actions: VoucherStationActions; back(): void }) {
  const manual = view.phase === 'basket' ? (view.basket?.typeCode ?? false) || view.home.manual : view.home.manual;
  return (
    <div className="t-report vst" dir="rtl">
      <div className="t-report-head vst-head">
        <button type="button" className="t-btn t-btn-ghost vst-menu" aria-label={T.menu} onClick={back}>
          ☰
        </button>
        {view.header ? <h1 className="t-report-title vst-title">{view.header}</h1> : <span />}
      </div>
      {view.testBar && view.phase !== 'picker' ? <div className="vst-test">{view.testBar}</div> : null}
      <ScanField manual={manual} busy={view.phase === 'checking'} onScan={actions.scan} label={T.codeLabel} />
      {view.phase === 'checking' ? (
        <div className="vst-checking" role="status">
          <p>{T.checking}</p>
        </div>
      ) : view.phase === 'refused' && view.notice ? (
        <button type="button" className="vst-refused-screen" onClick={actions.dismiss}>
          <span className="vst-x" aria-hidden="true">
            ✕
          </span>
          <span className="vst-refused-text">{view.notice.text}</span>
          {view.notice.detail ? <span className="vst-refused-detail">{view.notice.detail}</span> : null}
          <span className="vst-next">{T.next}</span>
        </button>
      ) : view.phase === 'picker' && view.picker ? (
        <>
          {view.notice ? <p className="vst-refused">{view.notice.text}</p> : null}
          <Picker view={view} actions={actions} />
        </>
      ) : view.phase === 'basket' && view.basket ? (
        <Basket view={view} actions={actions} />
      ) : (
        <Home view={view} actions={actions} />
      )}
    </div>
  );
}
