'use client';

/**
 * "נקי" = today's screens, as the till draws them now (pos-android ui/sell/TableOrderLayout.kt,
 * TabletQuickOrder.kt, SellScreen.kt), drawn flat:
 *
 *  - a table: the table's bar in the brand colour, the categories, the dish cards (the name is the
 *    card's face when there is no photo), and the bottom bar — the mini cart ("4 פריטים • ₪108 ·
 *    הצג הזמנה") and the green "שלח למטבח" with how many are new; the order opens in its sheet;
 *  - a quick order on a tablet: the catalogue and the order panel at the end (sideways) or under
 *    it (upright): the lines, the total, the two quick-pay buttons and "תשלום";
 *  - a quick order on the handheld: the total bar at the top (the way to pay), the categories and
 *    the product tiles; the basket is a page of its own.
 *
 * The columns and heights follow the till's own rules (ui/common/Adaptive.kt: tableDishColumnsFor,
 * productColumnsFor, productTileHeightDp; domain/TileSize.kt).
 */

import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, MoreVertical, Plus, ScanLine, Search, Send, ShoppingCart } from 'lucide-react';
import { DENSITY_FACTOR, TILE_HEIGHT_DP, type TileSize } from '@/lib/tillDesign';
import { FONT, Num, ellipsis, fitChips, formatMoney, useBoxSize } from './preview-atoms';
import { mixHex, type PAction, type PProduct, type PreviewEvent, type PreviewModel } from './preview-model';

type D = (e: PreviewEvent) => void;
type Size = Exclude<TileSize, 'auto'>;

/** Today's fixed colours: the kitchen's green, the quick-pay tenders, the badge red. */
const SEND_GREEN = '#34C759';
const CARD_BLUE = '#2563EB';
const CASH_GREEN = '#16A34A';
const CASH_DARK = '#15803D';
const BADGE_RED = '#FF3B30';

const PHONE_COLUMNS: Record<Size, number> = { xs: 5, s: 4, m: 3, l: 2 };

/** ui/common/Adaptive.kt tableDishColumnsFor. */
function tableDishColumns(paneWidth: number, size: Size, handheld: boolean): number {
  const phoneColumns = PHONE_COLUMNS[size];
  const phone = phoneColumns >= 5 ? 6 : phoneColumns >= 4 ? 5 : phoneColumns === 3 ? 4 : 3;
  if (handheld) return phone;
  const target = phoneColumns >= 5 ? 92 : phoneColumns >= 4 ? 110 : phoneColumns === 3 ? 130 : 170;
  return Math.max(phone, Math.min(8, Math.floor((paneWidth - 24) / target)));
}

/** ui/common/Adaptive.kt productColumnsFor (the quick order's grid). */
function productColumns(paneWidth: number, size: Size, handheld: boolean): number {
  const phoneColumns = PHONE_COLUMNS[size];
  if (handheld) return Math.max(2, Math.min(6, phoneColumns));
  const target = phoneColumns >= 5 ? 110 : phoneColumns >= 4 ? 135 : phoneColumns === 3 ? 200 : 270;
  return Math.max(2, Math.min(8, Math.floor((paneWidth - 16 + 6) / (target + 6))));
}

/** The largest name size (sp) that keeps a dish's name to three lines on its card's face. */
function faceNameSp(name: string, tileWidth: number): number {
  const width = tileWidth > 0 ? tileWidth : 82;
  const length = Math.max(1, name.trim().length);
  const inner = Math.max(40, width - 8);
  for (const sp of [22, 20, 18, 16, 15, 14, 13]) {
    const perLine = Math.max(1, Math.floor((inner / (sp * 0.5)) * 0.85));
    if (sp <= width / 5 && Math.ceil(length / perLine) <= 3) return sp;
  }
  return 13;
}

function faceInk(m: PreviewModel): string {
  return m.t.dark ? mixHex(m.t.accent, '#FFFFFF', 0.35) : mixHex(m.t.accent, '#111827', 0.45);
}

function InCart({ m, n, compact }: { m: PreviewModel; n: number; compact: boolean }) {
  if (n <= 0) return null;
  return (
    <span
      style={{
        position: 'absolute',
        top: compact ? 4 : 8,
        insetInlineStart: compact ? 4 : 8,
        minWidth: compact ? 20 : 24,
        height: compact ? 20 : 24,
        padding: '0 6px',
        borderRadius: 8,
        background: m.t.accent,
        color: m.t.onAccent,
        fontSize: compact ? 12 : 13,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Num>{n}</Num>
    </span>
  );
}

function SoldOutBadge({ m }: { m: PreviewModel }) {
  return (
    <span style={{ position: 'absolute', bottom: 6, insetInlineStart: 6, fontSize: 11, fontWeight: 700, background: m.t.red, color: '#FFFFFF', borderRadius: 6, padding: '1px 6px' }}>
      אזל
    </span>
  );
}

function Chips({ m, d, height }: { m: PreviewModel; d: D; height: number }) {
  const t = m.t;
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const { shown } = fitChips(m, m.categories, size.w, false);
  const chip = (id: string | null, label: string) => {
    const on = m.state.category === id;
    return (
      <button
        key={id ?? 'all'}
        type="button"
        aria-pressed={on}
        onClick={() => d({ type: 'category', id })}
        style={{
          flex: '0 0 auto',
          height,
          minWidth: 64,
          padding: '0 16px',
          borderRadius: 12,
          border: on ? `1px solid ${t.accent}` : `1px solid ${t.border}`,
          background: on ? t.accent : t.surface,
          color: on ? t.onAccent : t.ink,
          fontWeight: on ? 700 : 500,
          fontSize: m.fs(14),
          fontFamily: FONT,
          cursor: 'pointer',
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div ref={ref} style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', gap: 8, overflow: 'hidden', minHeight: height }}>
      {size.w > 0 ? (
        <>
          {chip(null, 'הכל')}
          {shown.map((c) => chip(c.id, c.name))}
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ a table */

function DishCard({ m, p, w, compact, d }: { m: PreviewModel; p: PProduct; w: number; compact: boolean; d: D }) {
  const t = m.t;
  const n = m.inOrder[p.id] ?? 0;
  const face = Math.round(w * 0.75) + (compact ? 18 : 22);
  const plus = compact ? 24 : 32;
  const photo = m.showImages && p.imageUrl ? p.imageUrl : null;
  return (
    <button
      type="button"
      aria-label={p.name}
      onClick={() => d({ type: 'add', product: p })}
      style={{
        position: 'relative',
        padding: 0,
        minWidth: 0,
        borderRadius: compact ? 12 : 14,
        border: n > 0 ? `2px solid ${t.accent}` : `1px solid ${t.border}`,
        background: t.surface,
        overflow: 'hidden',
        fontFamily: FONT,
        color: t.ink,
        cursor: 'pointer',
        textAlign: 'start',
      }}
    >
      <div style={{ opacity: p.available ? 1 : 0.45 }}>
        <div style={{ height: face, background: t.tint, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '28px 4px 4px' }}>
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span style={{ fontSize: faceNameSp(p.name, w), fontWeight: 700, lineHeight: 1.15, color: faceInk(m), textAlign: 'center', ...ellipsis(3) }}>{p.name}</span>
          )}
          <InCart m={m} n={n} compact={compact} />
          {p.available ? null : <SoldOutBadge m={m} />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: compact ? '5px 6px' : '8px 10px', minHeight: plus + (compact ? 10 : 16) }}>
          <Num style={{ flex: '1 1 auto', fontSize: m.fs(compact ? 13 : 15), fontWeight: 700, color: t.accent }}>{formatMoney(p.price)}</Num>
          <span
            aria-hidden
            style={{ width: plus, height: plus, borderRadius: 8, background: t.accent, color: t.onAccent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <Plus size={Math.round(plus * 0.62)} strokeWidth={2.4} />
          </span>
        </div>
      </div>
    </button>
  );
}

function DishGrid({ m, d }: { m: PreviewModel; d: D }) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  let body: ReactNode = null;
  if (size.w > 0) {
    const cols = m.view.columns || tableDishColumns(size.w + 2 * (m.handheld ? 8 : 12), m.tileSize, m.handheld);
    const g = cols >= 4 ? 6 : 10;
    const w = (size.w - (cols - 1) * g) / cols;
    const compact = cols >= 4;
    const h = Math.round(w * 0.75) + (compact ? 18 : 22) + (compact ? 34 : 48) + 2;
    const rows = Math.max(1, Math.floor((size.h + g) / (h + g)));
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: g }}>
        {m.products.slice(0, cols * rows).map((p) => (
          <DishCard key={p.id} m={m} p={p} w={w} compact={compact} d={d} />
        ))}
      </div>
    );
  }
  return (
    <div style={{ flex: '1 1 0', minHeight: 0, padding: `8px ${m.handheld ? 8 : 12}px 12px`, display: 'flex' }}>
      <div ref={ref} style={{ flex: '1 1 0', minWidth: 0, overflow: 'hidden' }}>
        {body}
      </div>
    </div>
  );
}

function TableBar({ m }: { m: PreviewModel }) {
  const t = m.t;
  const ready = m.toSend > 0;
  const extra = m.actions.filter((a) => a.action !== 'send');
  const sendLabel = m.cfg.texts.sendToKitchen?.trim() || 'שלח למטבח';
  return (
    <div style={{ flex: '0 0 auto', display: 'flex', gap: 10, alignItems: 'center', padding: '10px 12px 12px', background: t.surface, borderTop: `1px solid ${t.border}` }}>
      <div style={{ flex: '1 1 0', minWidth: 0, height: 56, borderRadius: 12, background: t.bg, border: `1px solid ${t.border}`, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px' }}>
        <span style={{ position: 'relative', color: t.accent, display: 'inline-flex' }}>
          <ShoppingCart size={26} strokeWidth={2} />
          {m.units > 0 ? (
            <span style={{ position: 'absolute', top: -8, insetInlineStart: -10, minWidth: 18, height: 18, padding: '0 5px', borderRadius: 8, background: BADGE_RED, color: '#FFFFFF', fontSize: 11, fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
              <Num>{m.units}</Num>
            </span>
          ) : null}
        </span>
        <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: m.fs(15), fontWeight: 700, ...ellipsis(1) }}>
            {m.units > 0 ? (
              <>
                {`${m.units} פריטים • `}
                <Num>{formatMoney(m.total)}</Num>
              </>
            ) : (
              m.text('emptyOrder')
            )}
          </span>
          <span style={{ fontSize: m.fs(13), color: t.accent }}>הצג הזמנה</span>
        </span>
      </div>
      {extra.map((a) => (
        <span key={a.key} style={{ height: 56, padding: '0 14px', borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, display: 'inline-flex', alignItems: 'center', fontSize: m.fs(14), fontWeight: 600, whiteSpace: 'nowrap' }}>
          {a.label}
        </span>
      ))}
      <span
        style={{
          height: 56,
          padding: '0 16px',
          borderRadius: 12,
          background: ready ? SEND_GREEN : t.bg,
          color: ready ? '#FFFFFF' : t.ink2,
          border: ready ? `1px solid ${SEND_GREEN}` : `1px solid ${t.border}`,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          flex: '0 0 auto',
        }}
      >
        <Send size={20} strokeWidth={2} style={{ transform: 'scaleX(-1)' }} />
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <span style={{ fontSize: m.fs(15), fontWeight: 700, whiteSpace: 'nowrap' }}>{sendLabel}</span>
          {ready ? <span style={{ fontSize: m.fs(12), whiteSpace: 'nowrap' }}>{`${m.toSend} חדשים`}</span> : null}
        </span>
      </span>
    </div>
  );
}

function TableHeaderBar({ m }: { m: PreviewModel }) {
  const t = m.t;
  const icon = (node: ReactNode, label: string) => (
    <span role="img" aria-label={label} style={{ width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.onAccent }}>
      {node}
    </span>
  );
  return (
    <div style={{ flex: '0 0 auto', height: m.handheld ? 60 : 64, background: t.accent, color: t.onAccent, display: 'flex', alignItems: 'center', gap: 6, padding: '0 6px' }}>
      {icon(<ArrowRight size={22} />, 'חזרה לשולחנות')}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={{ fontSize: m.fs(19), fontWeight: 700, ...ellipsis(1) }}>{m.title}</div>
        <div style={{ fontSize: m.fs(12), opacity: 0.85, ...ellipsis(1) }}>מלצר רן · נפתח 19:42 · 4 סועדים</div>
      </div>
      {icon(<Search size={21} />, 'חיפוש')}
      {m.handheld ? null : icon(<ScanLine size={21} />, 'סריקה')}
      {icon(<MoreVertical size={21} />, 'עוד')}
    </div>
  );
}

function CleanTable({ m, d }: { m: PreviewModel; d: D }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TableHeaderBar m={m} />
      <div style={{ display: 'flex', gap: 8, overflow: 'hidden', padding: `10px ${m.handheld ? 8 : 12}px 2px`, flex: '0 0 auto' }}>
        <Chips m={m} d={d} height={44} />
      </div>
      <DishGrid m={m} d={d} />
      <TableBar m={m} />
    </div>
  );
}

/* ------------------------------------------------------------ a quick order */

function ProductTileToday({ m, p, w, h, d }: { m: PreviewModel; p: PProduct; w: number; h: number; d: D }) {
  const t = m.t;
  const n = m.inOrder[p.id] ?? 0;
  const photo = m.showImages && p.imageUrl ? p.imageUrl : null;
  const compact = w < 100;
  return (
    <button
      type="button"
      aria-label={p.name}
      onClick={() => d({ type: 'add', product: p })}
      style={{
        position: 'relative',
        height: h,
        minWidth: 0,
        padding: 0,
        borderRadius: 14,
        border: n > 0 ? `2px solid ${t.accent}` : `1px solid ${t.border}`,
        background: t.surface,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: FONT,
        color: t.ink,
        cursor: 'pointer',
      }}
    >
      <div style={{ flex: '1 1 auto', width: '100%', background: t.tint, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px', opacity: p.available ? 1 : 0.45 }}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <span style={{ fontSize: Math.min(faceNameSp(p.name, w), compact ? 15 : 22), fontWeight: 700, lineHeight: 1.15, color: faceInk(m), textAlign: 'center', ...ellipsis(3) }}>{p.name}</span>
        )}
        <InCart m={m} n={n} compact={compact} />
        {p.available ? null : <SoldOutBadge m={m} />}
      </div>
      <div style={{ flex: '0 0 auto', width: '100%', height: compact ? 26 : 32, display: 'flex', alignItems: 'center', justifyContent: 'center', borderTop: `1px solid ${t.border}` }}>
        <Num style={{ fontSize: m.fs(compact ? 13 : 15), fontWeight: 700 }}>{formatMoney(p.price)}</Num>
      </div>
    </button>
  );
}

function QuickGrid({ m, d, padding }: { m: PreviewModel; d: D; padding: number }) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  let body: ReactNode = null;
  if (size.w > 0) {
    const g = 6;
    const cols = m.view.columns || productColumns(size.w + 2 * padding, m.tileSize, m.handheld);
    const w = (size.w - (cols - 1) * g) / cols;
    const base = Math.round(TILE_HEIGHT_DP[m.tileSize] * (DENSITY_FACTOR[m.view.density] ?? 1));
    const h = m.handheld ? base : Math.max(base, Math.min(Math.max(base, 280), Math.round(w * 0.9)));
    const rows = Math.max(1, Math.floor((size.h + g) / (h + g)));
    body = (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: g }}>
        {m.products.slice(0, cols * rows).map((p) => (
          <ProductTileToday key={p.id} m={m} p={p} w={w} h={h} d={d} />
        ))}
      </div>
    );
  }
  return (
    <div ref={ref} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      {body}
    </div>
  );
}

function TabletCatalogue({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
      <div style={{ height: 48, borderRadius: 12, border: `1px solid ${t.border}`, background: t.surface, display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px', color: t.ink2, fontSize: m.fs(15), flex: '0 0 auto' }}>
        <Search size={20} />
        חיפוש מוצר
      </div>
      <div style={{ display: 'flex', gap: 8, overflow: 'hidden', flex: '0 0 auto' }}>
        <Chips m={m} d={d} height={44} />
      </div>
      <QuickGrid m={m} d={d} padding={12} />
    </div>
  );
}

function tenderColor(a: PAction): string | null {
  if (a.action === 'fastCard') return CARD_BLUE;
  if (a.action === 'cashWithChange') return CASH_GREEN;
  if (a.action === 'fastCash') return CASH_DARK;
  return null;
}

/** The quick order panel (TabletQuickOrder.kt QuickOrderPanel), or a table's order drawn the same way. */
function OrderPanel({ m, width, stacked, side = 'end' }: { m: PreviewModel; width?: number; stacked: boolean; side?: 'end' | 'start' }) {
  const t = m.t;
  const table = m.mode === 'table';
  const pay = m.actions.filter((a) => a.action === 'pay' && !table);
  const quickPay = m.actions.filter((a) => !(a.action === 'pay' && !table) && a.action !== 'send');
  const send = m.actions.filter((a) => a.action === 'send');
  const service = m.fields.serviceType !== 'off' ? (m.state.serviceType === 'eatIn' ? m.text('eatIn') : m.text('takeAway')) : null;
  const subtitle = [`${m.units} פריטים`, table ? null : service].filter(Boolean).join(' · ');
  return (
    <div
      style={{
        width: width ?? '100%',
        flex: width ? `0 0 ${width}px` : stacked ? '0 0 50%' : '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        background: t.bg,
        borderInlineStart: width && side === 'end' ? `1px solid ${t.border}` : undefined,
        borderInlineEnd: width && side === 'start' ? `1px solid ${t.border}` : undefined,
        borderTop: stacked ? `1px solid ${t.border}` : undefined,
        minHeight: 0,
      }}
    >
      {stacked ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 0' }}>
          <span style={{ width: 40, height: 4, borderRadius: 2, background: t.border }} />
        </div>
      ) : null}
      <div style={{ minHeight: 64, display: 'flex', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 6, paddingInlineStart: 14, paddingInlineEnd: 4 }}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <div style={{ fontSize: m.fs(22), fontWeight: 700 }}>{table ? m.title : m.text('orderTitle')}</div>
          <div style={{ fontSize: m.fs(14), color: t.ink2, ...ellipsis(1) }}>{subtitle}</div>
        </div>
        <span style={{ width: 48, height: 48, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.ink }}>
          <MoreVertical size={22} />
        </span>
      </div>
      <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden', borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}`, background: t.surface }}>
        {m.lines.length === 0 ? (
          <p style={{ padding: 24, color: t.ink2, textAlign: 'center', fontSize: m.fs(15) }}>ההזמנה ריקה — בחרו מוצרים מהקטלוג</p>
        ) : (
          m.lines.map((l) => (
            <div key={l.id} style={{ padding: '10px 14px', borderBottom: `1px solid ${t.border}`, display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Num style={{ fontSize: m.fs(15), fontWeight: 700, color: t.accent, minWidth: 26 }}>{`×${l.qty}`}</Num>
              <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: m.fs(15), fontWeight: 600, ...ellipsis(1) }}>{l.name}</span>
                {l.note ? <span style={{ display: 'block', fontSize: m.fs(13), color: t.ink2, ...ellipsis(1) }}>{l.note}</span> : null}
                {table && l.status === 'sent' ? <span style={{ display: 'block', fontSize: m.fs(12), color: CASH_GREEN }}>נשלח 19:44</span> : null}
              </span>
              <Num style={{ fontSize: m.fs(15), fontWeight: 600 }}>{formatMoney(l.qty * l.unit)}</Num>
            </div>
          ))
        )}
      </div>
      <div style={{ padding: '10px 12px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: m.fs(16), color: t.ink2 }}>סה״כ</span>
          <Num style={{ fontSize: m.fs(28), fontWeight: 700 }}>{formatMoney(m.total)}</Num>
        </div>
        {quickPay.length ? (
          <div style={{ display: 'flex', gap: 8 }}>
            {quickPay.map((a) => {
              const color = tenderColor(a);
              return (
                <span
                  key={a.key}
                  style={{
                    flex: '1 1 0',
                    minWidth: 0,
                    minHeight: 64,
                    borderRadius: 12,
                    background: color ?? t.surface,
                    color: color ? '#FFFFFF' : t.ink,
                    border: color ? `1px solid ${color}` : `1px solid ${t.border}`,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '6px 8px',
                    fontSize: m.fs(16),
                    fontWeight: 700,
                    textAlign: 'center',
                  }}
                >
                  {a.action === 'note' ? <Num>{a.label}</Num> : <span style={ellipsis(2)}>{a.label}</span>}
                  {a.sub ? <span style={{ fontSize: m.fs(12), fontWeight: 500, color: t.ink2 }}>{a.sub}</span> : null}
                </span>
              );
            })}
          </div>
        ) : null}
        {send.map((a) => (
          <span key={a.key} style={{ height: 56, borderRadius: 12, background: m.toSend > 0 ? SEND_GREEN : t.surface, color: m.toSend > 0 ? '#FFFFFF' : t.ink2, border: `1px solid ${m.toSend > 0 ? SEND_GREEN : t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: m.fs(16), fontWeight: 700 }}>
            <Send size={20} style={{ transform: 'scaleX(-1)' }} />
            {m.toSend > 0 ? `${m.cfg.texts.sendToKitchen?.trim() || 'שלח למטבח'} · ${m.toSend} חדשים` : a.label}
          </span>
        ))}
        {pay.map((a) => {
          const prominent = quickPay.length === 0;
          return (
            <span
              key={a.key}
              style={{
                minHeight: 56,
                borderRadius: 12,
                background: prominent ? t.accent : t.tint,
                color: prominent ? t.onAccent : t.ink,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '6px 10px',
              }}
            >
              <span style={{ fontSize: m.fs(16), fontWeight: 700 }}>{m.cfg.texts.pay?.trim() || 'תשלום'}</span>
              <span style={{ fontSize: m.fs(12) }}>כל אמצעי התשלום · פיצול</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function TotalBarToday({ m }: { m: PreviewModel }) {
  const t = m.t;
  const payable = m.total > 0;
  return (
    <div
      style={{
        margin: '8px 8px 6px',
        height: 64,
        borderRadius: 12,
        background: payable ? t.accent : t.surface,
        color: payable ? t.onAccent : t.ink2,
        border: payable ? `1px solid ${t.accent}` : `1px solid ${t.border}`,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 8px',
        flex: '0 0 auto',
      }}
    >
      <span style={{ width: 56, height: 48, borderRadius: 10, background: payable ? 'rgba(255,255,255,0.18)' : t.bg, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <ShoppingCart size={20} />
        <Num style={{ fontSize: 15, fontWeight: 700 }}>{m.units}</Num>
      </span>
      <span style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', padding: '0 6px' }}>
        <span style={{ fontSize: m.fs(12), opacity: 0.85 }}>{payable ? 'לתשלום' : m.text('emptyOrder')}</span>
        <Num style={{ fontSize: m.fs(22), fontWeight: 600 }}>{formatMoney(m.total)}</Num>
      </span>
      {payable ? <ArrowLeft size={22} /> : null}
    </div>
  );
}

function HandheldQuick({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const square = (node: ReactNode, label: string) => (
    <span role="img" aria-label={label} style={{ width: 40, height: 40, borderRadius: 10, border: `1px solid ${t.border}`, background: t.surface, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: t.ink, flex: '0 0 auto' }}>
      {node}
    </span>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TotalBarToday m={m} />
      <div style={{ display: 'flex', gap: 6, overflow: 'hidden', padding: '4px 8px 8px', flex: '0 0 auto' }}>
        {square(<Search size={18} />, 'חיפוש')}
        {square(<ScanLine size={18} />, 'סריקה')}
        <Chips m={m} d={d} height={40} />
      </div>
      <div style={{ flex: '1 1 0', minHeight: 0, padding: '0 8px 8px', display: 'flex' }}>
        <QuickGrid m={m} d={d} padding={8} />
      </div>
    </div>
  );
}

export function CleanScreen({ m, d }: { m: PreviewModel; d: D }) {
  const bill = m.view.billPosition[m.mode];
  if (m.mode === 'table' && bill === 'sheet') return <CleanTable m={m} d={d} />;
  if (bill === 'sheet' || (m.handheld && m.mode === 'quick')) return <HandheldQuick m={m} d={d} />;
  if (bill === 'end' || bill === 'start') {
    const width = Math.round(Math.max(360, Math.min(440, m.W * 0.3)));
    const catalogue = <TabletCatalogue key="catalogue" m={m} d={d} />;
    const panel = <OrderPanel key="panel" m={m} width={width} stacked={false} side={bill} />;
    return <div style={{ display: 'flex', height: '100%' }}>{bill === 'start' ? [panel, catalogue] : [catalogue, panel]}</div>;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <TabletCatalogue m={m} d={d} />
      <OrderPanel m={m} stacked />
    </div>
  );
}
