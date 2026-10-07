'use client';

/**
 * The five new templates (touch, professional, seated, fast, mobile) as compositions of the
 * brief's regions (§3): the order header, the mode extras (seat cards, the seat picker, the
 * quantity presets and favourites, the quick order's service type and customer name), the
 * category bar (top chips or a side rail), the product grid by tile style, the bill at its
 * position (a side panel, a bottom block, a collapsible summary, a sheet bar) in its style, and
 * the action bar.
 */

import type { CSSProperties, ReactNode } from 'react';
import { ChevronDown, ChevronUp, MoreVertical, Plus, Search } from 'lucide-react';
import { gridColumns, sideBillWidth, tileHeight } from '@/lib/tillDesign';
import {
  ActionBar,
  CategoryChip,
  Chosen,
  CountBadge,
  FONT,
  NameField,
  Num,
  PlusSquare,
  R,
  R_SMALL,
  ServiceSegment,
  StatusChip,
  Stepper,
  TotalRow,
  ellipsis,
  fitChips,
  formatMoney,
  gap,
  MoreChip,
  pad,
  useBoxSize,
} from './preview-atoms';
import type { PLine, PProduct, PreviewEvent, PreviewModel } from './preview-model';

type D = (e: PreviewEvent) => void;

/* ------------------------------------------------------------ header */

function IconButton({ m, children, label }: { m: PreviewModel; children: ReactNode; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      style={{
        width: 44,
        height: 44,
        borderRadius: R,
        border: `1px solid ${m.t.border}`,
        background: m.t.surface,
        color: m.t.ink,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: '0 0 auto',
      }}
    >
      {children}
    </span>
  );
}

function OrderHeader({ m }: { m: PreviewModel }) {
  const P = pad(m);
  const searchField = m.view.features.includes('searchField');
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: `${m.handheld ? 10 : 14}px ${P}px ${m.handheld ? 8 : 10}px` }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: m.fs(m.handheld ? 20 : 22), fontWeight: 700, lineHeight: 1.25, ...ellipsis(1) }}>{m.title}</div>
        <div style={{ fontSize: m.fs(13), color: m.t.ink2, marginTop: 2, ...ellipsis(1) }}>{m.subtitle}</div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {searchField ? null : (
          <IconButton m={m} label="חיפוש">
            <Search size={20} strokeWidth={2} />
          </IconButton>
        )}
        <IconButton m={m} label="עוד">
          <MoreVertical size={20} strokeWidth={2} />
        </IconButton>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ mode extras */

function SeatCards({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  const G = gap(m);
  const t = m.t;
  const [ref, size] = useBoxSize<HTMLDivElement>();
  // On a tablet every card fits the row (narrow cards say less: "נבחר · ₪80"); the handheld's row scrolls.
  const cardW = m.handheld ? 128 : (size.w - 48 - G * m.seats.length) / Math.max(1, m.seats.length);
  const narrow = !m.handheld && cardW < 136;
  return (
    <div style={{ padding: `2px ${P}px 10px`, flex: '0 0 auto' }}>
      <div ref={ref} style={{ display: 'flex', gap: G, overflow: 'hidden' }}>
        {m.seats.map((s) => {
          const on = m.state.seat === s.seat;
          const detail = s.items > 0 ? (
            narrow ? (
              <Num>{formatMoney(s.total)}</Num>
            ) : (
              <>
                {`${s.items} פריטים · `}
                <Num>{formatMoney(s.total)}</Num>
              </>
            )
          ) : (
            'ללא פריטים'
          );
          return (
            <button
              key={s.seat}
              type="button"
              aria-pressed={on}
              onClick={() => d({ type: 'seat', seat: s.seat })}
              style={{
                flex: m.handheld ? '0 0 128px' : '1 1 0',
                minWidth: m.handheld ? 128 : 0,
                height: m.handheld ? 60 : 64,
                borderRadius: R,
                border: `1px solid ${on ? t.accent : t.border}`,
                background: on ? t.tint : t.surface,
                color: t.ink,
                padding: narrow ? '8px 10px' : '8px 12px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 2,
                textAlign: 'start',
                fontFamily: FONT,
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, width: '100%' }}>
                <span style={{ fontSize: m.fs(15), fontWeight: on ? 700 : 600, ...ellipsis(1) }}>{s.name}</span>
                {on && !narrow ? <Chosen t={t} label="נבחר" /> : null}
              </span>
              <span style={{ fontSize: m.fs(13), color: on && narrow ? t.accent : t.ink2, fontWeight: on && narrow ? 700 : 400, width: '100%', ...ellipsis(1) }}>
                {on && narrow ? (
                  <>
                    {'נבחר · '}
                    {s.items > 0 ? <Num>{formatMoney(s.total)}</Num> : 'ללא פריטים'}
                  </>
                ) : (
                  detail
                )}
              </span>
            </button>
          );
        })}
        <span
          aria-label="הוספת סועד"
          role="img"
          style={{
            flex: '0 0 48px',
            height: m.handheld ? 60 : 64,
            borderRadius: R,
            border: `1px solid ${t.border}`,
            background: t.surface,
            color: t.ink,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Plus size={20} />
        </span>
      </div>
    </div>
  );
}

function SeatPicker({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  const t = m.t;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `0 ${P}px 10px`, flex: '0 0 auto' }}>
      <span style={{ fontSize: m.fs(14), color: t.ink2, marginInlineEnd: 4, whiteSpace: 'nowrap' }}>{m.text('addToSeat')}</span>
      {m.seats
        .filter((s) => s.seat > 0)
        .map((s) => {
          const on = m.state.seat === s.seat;
          return (
            <button
              key={s.seat}
              type="button"
              aria-pressed={on}
              aria-label={s.name}
              onClick={() => d({ type: 'seat', seat: s.seat })}
              style={{
                width: 48,
                height: 44,
                borderRadius: R_SMALL,
                border: `1px solid ${on ? t.accent : t.border}`,
                background: on ? t.tint : t.surface,
                color: on ? t.accent : t.ink,
                fontWeight: on ? 700 : 500,
                fontSize: m.fs(16),
                fontFamily: FONT,
                cursor: 'pointer',
              }}
            >
              <Num>{s.seat}</Num>
            </button>
          );
        })}
    </div>
  );
}

function hasQuickFields(m: PreviewModel): boolean {
  return m.mode === 'quick' && (m.fields.serviceType !== 'off' || m.fields.customerName !== 'off');
}

/** The quick order's service type and customer name, in a row (wrapping on the handheld). */
function QuickFields({ m, d, stacked = false }: { m: PreviewModel; d: D; stacked?: boolean }) {
  const t = m.t;
  const service = m.fields.serviceType !== 'off';
  const name = m.fields.customerName !== 'off';
  if (!service && !name) return null;
  const column = stacked || m.handheld;
  return (
    <div style={{ display: 'flex', flexDirection: column ? 'column' : 'row', gap: column ? 10 : 16, alignItems: column ? 'stretch' : 'flex-end' }}>
      {service ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: column ? undefined : '0 0 auto' }}>
          <span style={{ fontSize: m.fs(13), color: t.ink2 }}>
            {m.text('serviceType')}
            {m.fields.serviceType === 'required' ? <span style={{ color: t.ink, fontWeight: 600 }}> · חובה</span> : null}
          </span>
          <ServiceSegment m={m} wide={column} onPick={(v) => d({ type: 'service', value: v })} />
        </div>
      ) : null}
      {name ? <NameField m={m} /> : null}
    </div>
  );
}

function QuickFieldsCard({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  if (!hasQuickFields(m)) return null;
  return (
    <div style={{ margin: `0 ${P}px 10px`, padding: 12, borderRadius: R, border: `1px solid ${m.t.border}`, background: m.t.surface, flex: '0 0 auto' }}>
      <QuickFields m={m} d={d} />
    </div>
  );
}

/** The quick order's fields on one line under the header (the mobile template, the handheld). */
function QuickFieldsInline({ m, d, bare = false }: { m: PreviewModel; d: D; bare?: boolean }) {
  const P = pad(m);
  const t = m.t;
  if (!hasQuickFields(m)) return null;
  const service = m.fields.serviceType !== 'off';
  const name = m.fields.customerName !== 'off';
  return (
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, padding: bare ? 0 : `0 ${P}px 10px`, flex: '0 0 auto' }}>
      {service ? (
        <>
          <span style={{ fontSize: m.fs(14), color: t.ink2, marginInlineEnd: 4, whiteSpace: 'nowrap' }}>
            {m.text('serviceType')}
            {m.fields.serviceType === 'required' ? <span style={{ color: t.ink, fontWeight: 600 }}> · חובה</span> : null}
          </span>
          <ServiceSegment m={m} onPick={(v) => d({ type: 'service', value: v })} />
        </>
      ) : null}
      {name ? (
        <div style={{ flex: '1 1 180px', minWidth: 160 }}>
          <NameField m={m} inline />
        </div>
      ) : null}
    </div>
  );
}

function PresetsCard({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  const t = m.t;
  const box = m.handheld ? 44 : 52;
  return (
    <div
      style={{
        margin: `0 ${P}px 10px`,
        padding: m.handheld ? 10 : 12,
        borderRadius: R,
        border: `1px solid ${t.border}`,
        background: t.surface,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        flex: '0 0 auto',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: m.fs(13), color: t.ink2 }}>{m.text('nextQuantity')}</span>
        <span
          style={{
            height: 32,
            padding: '0 12px',
            borderRadius: R_SMALL,
            border: `1px solid ${t.border}`,
            display: 'inline-flex',
            alignItems: 'center',
            fontSize: m.fs(14),
            color: t.ink,
            fontWeight: 500,
          }}
        >
          {m.text('otherQuantity')}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          aria-label="הכמות לפריט הבא"
          style={{
            width: box + 16,
            height: box,
            borderRadius: R_SMALL,
            border: `1px solid ${t.ink}`,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: m.fs(24),
            fontWeight: 700,
            flex: '0 0 auto',
          }}
        >
          <Num>{m.state.nextQty}</Num>
        </span>
        {m.presets.map((n) => {
          const on = m.state.nextQty === n;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              onClick={() => d({ type: 'qty', n })}
              style={{
                width: box,
                height: box,
                borderRadius: R_SMALL,
                border: `1px solid ${on ? t.accent : t.border}`,
                background: on ? t.tint : t.surface,
                color: on ? t.accent : t.ink,
                fontWeight: on ? 700 : 500,
                fontSize: m.fs(18),
                fontFamily: FONT,
                cursor: 'pointer',
                flex: '0 0 auto',
              }}
            >
              <Num>{n}</Num>
            </button>
          );
        })}
      </div>
      {hasQuickFields(m) ? (
        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 10, marginTop: 2 }}>
          <QuickFieldsInline m={m} d={d} bare />
        </div>
      ) : null}
    </div>
  );
}

function FavoritesStrip({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  const t = m.t;
  const [ref, size] = useBoxSize<HTMLDivElement>();
  if (m.favorites.length === 0) return null;
  // As many favourites as fit on the line (none cut at the edge); the strip scrolls on the till.
  const label = Math.ceil(m.text('favorites').length * m.fs(13) * 0.58) + 8;
  let used = label;
  const shown = m.favorites.filter((p) => {
    const w = Math.ceil(24 + 8 + p.name.length * m.fs(15) * 0.55 + 30) + 8;
    if (size.w > 0 && used + w > size.w) return false;
    used += w;
    return true;
  });
  return (
    <div style={{ padding: `0 ${P}px 10px`, flex: '0 0 auto' }}>
      <div ref={ref} style={{ display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden', minHeight: 44 }}>
        <span style={{ fontSize: m.fs(13), color: t.ink2, whiteSpace: 'nowrap' }}>{m.text('favorites')}</span>
        {size.w > 0
          ? shown.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => d({ type: 'add', product: p })}
                style={{
                  flex: '0 0 auto',
                  height: 44,
                  padding: '0 12px',
                  borderRadius: R_SMALL,
                  border: `1px solid ${t.border}`,
                  background: t.surface,
                  color: t.ink,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  fontFamily: FONT,
                  cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: m.fs(15), fontWeight: 600 }}>{p.name}</span>
                <Num style={{ fontSize: m.fs(13), color: t.accent, fontWeight: 600 }}>{formatMoney(p.price)}</Num>
              </button>
            ))
          : null}
      </div>
    </div>
  );
}

function Extras({ m, d }: { m: PreviewModel; d: D }) {
  const f = m.view.features;
  const bill = m.view.billPosition[m.mode];
  const fieldsUp =
    m.view.template === 'seated' ||
    m.view.template === 'mobile' ||
    bill === 'sheet' ||
    (m.handheld && bill === 'bottom');
  return (
    <>
      {f.includes('seatCards') && m.mode === 'table' ? <SeatCards m={m} d={d} /> : null}
      {f.includes('seatPicker') && m.mode === 'table' ? <SeatPicker m={m} d={d} /> : null}
      {f.includes('quantityPresets') ? <PresetsCard m={m} d={d} /> : null}
      {f.includes('favorites') ? <FavoritesStrip m={m} d={d} /> : null}
      {!f.includes('quantityPresets') && fieldsUp ? (
        m.view.template === 'seated' && !m.handheld && m.fields.customerName !== 'off' ? <QuickFieldsCard m={m} d={d} /> : <QuickFieldsInline m={m} d={d} />
      ) : null}
    </>
  );
}

/** Whether the quick order's fields stand at the top of the bill (not over the menu). */
function fieldsInBill(m: PreviewModel): boolean {
  const bill = m.view.billPosition[m.mode];
  if (!hasQuickFields(m)) return false;
  if (m.view.features.includes('quantityPresets')) return false;
  if (m.view.template === 'seated' || m.view.template === 'mobile') return false;
  return bill === 'end' || bill === 'start' || (bill === 'bottom' && !m.handheld);
}

/* ------------------------------------------------------------ the menu */

function SoldOut({ m }: { m: PreviewModel }) {
  return (
    <span style={{ fontSize: m.fs(12), fontWeight: 600, color: m.t.ink2, border: `1px solid ${m.t.border}`, borderRadius: 6, padding: '1px 8px' }}>
      אזל
    </span>
  );
}

function tileBase(m: PreviewModel, p: PProduct, height: number): CSSProperties {
  return {
    height,
    minWidth: 0,
    borderRadius: R,
    border: `1px solid ${m.t.border}`,
    background: m.t.surface,
    color: m.t.ink,
    textAlign: 'start',
    fontFamily: FONT,
    cursor: p.available ? 'pointer' : 'not-allowed',
    position: 'relative',
    overflow: 'hidden',
    padding: 0,
  };
}

function Photo({ url, height }: { url: string; height: number | string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" style={{ display: 'block', width: '100%', height, objectFit: 'cover' }} />
  );
}

function CardTile({ m, p, h, d }: { m: PreviewModel; p: PProduct; h: number; d: D }) {
  const small = h < 100;
  const photo = m.showImages && p.imageUrl && h >= 130 ? p.imageUrl : null;
  const n = m.inOrder[p.id] ?? 0;
  const inner = small ? 8 : 12;
  return (
    <button type="button" onClick={() => d({ type: 'add', product: p })} style={tileBase(m, p, h)} aria-label={p.name}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', opacity: p.available ? 1 : 0.45 }}>
        {photo ? <Photo url={photo} height={Math.round(h * 0.42)} /> : null}
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: inner, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: m.fs(small ? 15 : 16), fontWeight: 600, lineHeight: 1.25, ...ellipsis(small || photo ? 1 : 2) }}>{p.name}</span>
            {photo ? null : <PlusSquare m={m} size={small ? 24 : 28} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Num style={{ fontSize: m.fs(15), color: m.t.ink2 }}>{formatMoney(p.price)}</Num>
            {p.available ? <CountBadge m={m} n={n} /> : <SoldOut m={m} />}
          </div>
        </div>
      </div>
    </button>
  );
}

function PhotoTile({ m, p, h, d }: { m: PreviewModel; p: PProduct; h: number; d: D }) {
  const photo = m.showImages && p.imageUrl ? p.imageUrl : null;
  const n = m.inOrder[p.id] ?? 0;
  return (
    <button type="button" onClick={() => d({ type: 'add', product: p })} style={tileBase(m, p, h)} aria-label={p.name}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', opacity: p.available ? 1 : 0.45 }}>
        {photo ? <Photo url={photo} height="auto" /> : null}
        <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: 14, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ fontSize: m.fs(photo ? 18 : 20), fontWeight: 700, lineHeight: 1.2, ...ellipsis(2) }}>{p.name}</span>
            {p.available ? <CountBadge m={m} n={n} /> : <SoldOut m={m} />}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <Num style={{ fontSize: m.fs(16), color: m.t.ink2 }}>{formatMoney(p.price)}</Num>
            <PlusSquare m={m} size={36} />
          </div>
        </div>
      </div>
    </button>
  );
}

function KeyTile({ m, p, h, d }: { m: PreviewModel; p: PProduct; h: number; d: D }) {
  const n = m.inOrder[p.id] ?? 0;
  return (
    <button type="button" onClick={() => d({ type: 'add', product: p })} style={tileBase(m, p, h)} aria-label={p.name}>
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: h < 66 ? '6px 10px' : '9px 10px', opacity: p.available ? 1 : 0.45 }}>
        <span style={{ fontSize: m.fs(16), fontWeight: 700, lineHeight: 1.2, ...ellipsis(h < 70 ? 1 : 2) }}>{p.name}</span>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <Num style={{ fontSize: m.fs(13), color: m.t.accent, fontWeight: 600 }}>{formatMoney(p.price)}</Num>
          {p.available ? <CountBadge m={m} n={n} /> : <SoldOut m={m} />}
        </div>
      </div>
    </button>
  );
}

function RowItem({ m, p, h, last, d }: { m: PreviewModel; p: PProduct; h: number; last: boolean; d: D }) {
  const n = m.inOrder[p.id] ?? 0;
  const t = m.t;
  return (
    <button
      type="button"
      onClick={() => d({ type: 'add', product: p })}
      aria-label={p.name}
      style={{
        height: h,
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 12px',
        border: 'none',
        borderBottom: last ? 'none' : `1px solid ${t.border}`,
        background: 'transparent',
        color: t.ink,
        fontFamily: FONT,
        textAlign: 'start',
        cursor: p.available ? 'pointer' : 'not-allowed',
      }}
    >
      <span style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, opacity: p.available ? 1 : 0.45 }}>
        <span style={{ fontSize: m.fs(16), fontWeight: 500, ...ellipsis(1) }}>{p.name}</span>
        {p.available ? <CountBadge m={m} n={n} /> : <SoldOut m={m} />}
      </span>
      <Num style={{ width: 72, fontSize: m.fs(15), color: t.ink2, textAlign: 'start', flex: '0 0 auto' }}>{formatMoney(p.price)}</Num>
      <PlusSquare m={m} size={h >= 56 ? 40 : 36} />
    </button>
  );
}

function RowList({ m, items, h, header, d, w, clipped }: { m: PreviewModel; items: PProduct[]; h: number; header: boolean; d: D; w: number; clipped: boolean }) {
  const t = m.t;
  // A list longer than the pane runs to its bottom, the last row cut there (it scrolls on the till).
  return (
    <div style={{ flex: '1 1 0', minWidth: 0, width: w, border: `1px solid ${t.border}`, borderRadius: R, background: t.surface, overflow: 'hidden', alignSelf: clipped ? 'stretch' : 'flex-start' }}>
      {header ? (
        <div style={{ height: 36, display: 'flex', alignItems: 'center', gap: 12, padding: '0 12px', borderBottom: `1px solid ${t.border}`, color: t.ink2, fontSize: m.fs(13), background: t.bg }}>
          <span style={{ flex: '1 1 auto' }}>פריט</span>
          <span style={{ width: 72 }}>מחיר</span>
          <span style={{ width: h >= 56 ? 40 : 36, textAlign: 'center' }}>הוסף</span>
        </div>
      ) : null}
      {items.map((p, i) => (
        <RowItem key={p.id} m={m} p={p} h={h} last={i === items.length - 1} d={d} />
      ))}
    </div>
  );
}

function ProductGrid({ m, d }: { m: PreviewModel; d: D }) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const G = gap(m);
  const style = m.view.tileStyle;
  const items = m.products;
  let body: ReactNode = null;
  if (size.w > 0 && size.h > 0) {
    const cols = gridColumns({ style, size: m.tileSize, paneWidth: size.w, handheld: m.handheld, columns: m.view.columns, gap: G });
    const tileW = (size.w - (cols - 1) * G) / cols;
    const withPhoto = m.showImages && items.some((p) => !!p.imageUrl);
    const th = tileHeight({ style, size: m.tileSize, density: m.view.density, tileWidth: tileW, withPhoto });
    if (style === 'row') {
      const header = m.view.template === 'professional';
      // Every row that shows at all, the last one cut at the pane's bottom (the list scrolls on the till).
      const perList = Math.max(1, Math.ceil((size.h - (header ? 37 : 2)) / (th + 1)));
      const lists = cols >= 2 ? [items.slice(0, perList), items.slice(perList, perList * 2)] : [items.slice(0, perList)];
      body = (
        <div style={{ display: 'flex', gap: G, height: '100%' }}>
          {lists
            .filter((l, i) => i === 0 || l.length > 0)
            .map((list, i) => (
              <RowList key={i} m={m} items={list} h={th} header={header} d={d} w={tileW} clipped={list.length * (th + 1) + (header ? 37 : 2) > size.h} />
            ))}
        </div>
      );
    } else {
      // The grid fills the pane down to the bill: the last row cut at the bottom, never an empty band.
      const rows = Math.max(1, Math.ceil((size.h + G) / (th + G)));
      const shown = items.slice(0, cols * rows);
      body = (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridAutoRows: th, gap: G }}>
          {shown.map((p) =>
            style === 'photo' ? (
              <PhotoTile key={p.id} m={m} p={p} h={th} d={d} />
            ) : style === 'key' ? (
              <KeyTile key={p.id} m={m} p={p} h={th} d={d} />
            ) : (
              <CardTile key={p.id} m={m} p={p} h={th} d={d} />
            ),
          )}
        </div>
      );
    }
  }
  return (
    <div ref={ref} style={{ flex: '1 1 0', minWidth: 0, minHeight: 0, overflow: 'hidden' }}>
      {items.length === 0 ? <p style={{ color: m.t.ink2, fontSize: m.fs(15), padding: 24, textAlign: 'center' }}>אין מוצרים בקטגוריה</p> : body}
    </div>
  );
}

function CategoryRow({ m, d }: { m: PreviewModel; d: D }) {
  const [ref, size] = useBoxSize<HTMLDivElement>();
  const { shown, rest } = fitChips(m, m.categories, size.w, true);
  return (
    <div ref={ref} style={{ display: 'flex', gap: 8, overflow: 'hidden', flex: '0 0 auto', minHeight: m.handheld ? 40 : 44 }}>
      {size.w > 0 ? (
        <>
          <CategoryChip m={m} label="הכל" selected={m.state.category === null} onClick={() => d({ type: 'category', id: null })} />
          {shown.map((c) => (
            <CategoryChip key={c.id} m={m} label={c.name} selected={m.state.category === c.id} onClick={() => d({ type: 'category', id: c.id })} />
          ))}
          {rest > 0 ? <MoreChip m={m} n={rest} /> : null}
        </>
      ) : null}
    </div>
  );
}

function CategoryRail({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const item = (id: string | null, label: string) => {
    const on = m.state.category === id;
    return (
      <button
        key={id ?? 'all'}
        type="button"
        aria-pressed={on}
        onClick={() => d({ type: 'category', id })}
        style={{
          height: 48,
          width: '100%',
          padding: '0 12px',
          borderRadius: R_SMALL,
          border: `1px solid ${on ? t.accent : 'transparent'}`,
          background: on ? t.tint : 'transparent',
          color: on ? t.accent : t.ink,
          fontWeight: on ? 700 : 500,
          fontSize: m.fs(15),
          textAlign: 'start',
          fontFamily: FONT,
          cursor: 'pointer',
          ...ellipsis(1),
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      style={{
        width: 120,
        flex: '0 0 120px',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: 6,
        borderRadius: R,
        border: `1px solid ${t.border}`,
        background: t.surface,
        overflow: 'hidden',
        alignSelf: 'stretch',
      }}
    >
      {item(null, 'הכל')}
      {m.categories.map((c) => item(c.id, c.name))}
    </div>
  );
}

function SearchField({ m }: { m: PreviewModel }) {
  const t = m.t;
  return (
    <div
      style={{
        height: 48,
        borderRadius: R,
        border: `1px solid ${t.border}`,
        background: t.surface,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '0 14px',
        color: t.ink2,
        fontSize: m.fs(15),
        flex: '0 0 auto',
      }}
    >
      <Search size={20} strokeWidth={2} />
      חיפוש פריט בתפריט
    </div>
  );
}

function MenuArea({ m, d }: { m: PreviewModel; d: D }) {
  const P = pad(m);
  const G = gap(m);
  const side = m.view.categoryBar === 'side';
  // Tiles run to the bill's own border (the last row cut there); a bordered list or rail keeps a gap.
  const bottom = side || m.view.tileStyle === 'row' ? G : 0;
  return (
    <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10, padding: `0 ${P}px ${bottom}px` }}>
      {m.view.features.includes('searchField') ? <SearchField m={m} /> : null}
      {side ? null : <CategoryRow m={m} d={d} />}
      <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', gap: G }}>
        {side ? <CategoryRail m={m} d={d} /> : null}
        <ProductGrid m={m} d={d} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ the bill */

function orderLines(m: PreviewModel): PLine[] {
  if (m.mode !== 'table') return m.lines;
  // A table: the new lines first (what "שדר" sends), the sent ones apart after them.
  return [...m.lines.filter((l) => l.status === 'new'), ...m.lines.filter((l) => l.status !== 'new')];
}

function editable(m: PreviewModel, l: PLine): boolean {
  return m.mode === 'quick' || l.status === 'new';
}

function LineRow({ m, l, d, last }: { m: PreviewModel; l: PLine; d: D; last: boolean }) {
  const t = m.t;
  const canEdit = editable(m, l);
  const status = m.mode === 'table' && m.lineStatus;
  return (
    <div style={{ padding: '10px 0', borderBottom: last ? 'none' : `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <span style={{ fontSize: m.fs(15), fontWeight: 600, minWidth: 0, ...ellipsis(1) }}>
          {canEdit ? null : <Num style={{ color: t.ink2, fontWeight: 500, marginLeft: 6 }}>{`×${l.qty}`}</Num>}
          {l.name}
        </span>
        <Num style={{ fontSize: m.fs(15), fontWeight: 600, flex: '0 0 auto' }}>{formatMoney(l.qty * l.unit)}</Num>
      </div>
      {l.note ? <span style={{ fontSize: m.fs(13), color: t.ink2, marginTop: -4, ...ellipsis(1) }}>{l.note}</span> : null}
      {canEdit || status ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {canEdit ? <Stepper m={m} qty={l.qty} size={m.handheld ? 32 : 36} onStep={(delta) => d({ type: 'step', lineId: l.id, delta })} /> : <span />}
          {status ? <StatusChip m={m} status={l.status} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function CompactLine({ m, l }: { m: PreviewModel; l: PLine }) {
  const t = m.t;
  return (
    <div style={{ height: 36, display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${t.border}` }}>
      <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: m.fs(15), ...ellipsis(1) }}>
        <Num style={{ color: t.ink2, marginLeft: 6 }}>{`×${l.qty}`}</Num>
        {l.name}
      </span>
      {m.mode === 'table' && m.lineStatus ? <StatusChip m={m} status={l.status} /> : null}
      <Num style={{ fontSize: m.fs(15), fontWeight: 600, flex: '0 0 auto' }}>{formatMoney(l.qty * l.unit)}</Num>
    </div>
  );
}

function LineCard({ m, l, d }: { m: PreviewModel; l: PLine; d: D }) {
  const t = m.t;
  const canEdit = editable(m, l);
  return (
    <div style={{ border: `1px solid ${t.border}`, borderRadius: R, background: t.bg, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: m.fs(15), fontWeight: 700, minWidth: 0, ...ellipsis(1) }}>{l.name}</span>
        <Num style={{ fontSize: m.fs(15), flex: '0 0 auto' }}>{formatMoney(l.qty * l.unit)}</Num>
      </div>
      <span style={{ fontSize: m.fs(13), color: t.ink2, minHeight: 18, ...ellipsis(1) }}>{l.note ?? ''}</span>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 36 }}>
        {canEdit ? (
          <Stepper m={m} qty={l.qty} size={36} onStep={(delta) => d({ type: 'step', lineId: l.id, delta })} />
        ) : (
          <Num style={{ fontSize: m.fs(15), color: t.ink2 }}>{`×${l.qty}`}</Num>
        )}
        {m.mode === 'table' && m.lineStatus ? <StatusChip m={m} status={l.status} /> : null}
      </div>
    </div>
  );
}

function GroupLabel({ m, children }: { m: PreviewModel; children: ReactNode }) {
  return <div style={{ fontSize: m.fs(12), fontWeight: 600, color: m.t.ink2, padding: '8px 0 0' }}>{children}</div>;
}

/** The lines in the template's bill style. `columns`: the bottom block's width (cards 3 across, groups 2). */
function BillLines({ m, d, wide }: { m: PreviewModel; d: D; wide: boolean }) {
  const lines = orderLines(m);
  const style = m.view.billStyle;
  const G = gap(m);
  if (lines.length === 0) {
    return <p style={{ color: m.t.ink2, fontSize: m.fs(15), padding: '16px 0', textAlign: 'center' }}>{m.text('emptyOrder')}</p>;
  }
  if (style === 'cards') {
    const cols = wide ? 3 : 1;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap: G, paddingTop: wide ? 0 : 10 }}>
        {lines.map((l) => (
          <LineCard key={l.id} m={m} l={l} d={d} />
        ))}
      </div>
    );
  }
  if (style === 'seats' && m.mode === 'table') {
    const groups = m.seats.filter((s) => lines.some((l) => l.seat === s.seat));
    return (
      <div style={{ display: 'grid', gridTemplateColumns: wide ? 'repeat(2, minmax(0, 1fr))' : '1fr', columnGap: 24, rowGap: 4 }}>
        {groups.map((s) => {
          const own = lines.filter((l) => l.seat === s.seat);
          return (
            <div key={s.seat} style={{ minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '8px 0 2px', borderBottom: `1px solid ${m.t.border}` }}>
                <span style={{ fontSize: m.fs(14), fontWeight: 700 }}>{s.name}</span>
                <Num style={{ fontSize: m.fs(14), color: m.t.ink2 }}>{formatMoney(s.total)}</Num>
              </div>
              {own.map((l, i) => (
                <LineRow key={l.id} m={m} l={l} d={d} last={i === own.length - 1} />
              ))}
            </div>
          );
        })}
      </div>
    );
  }
  if (style === 'compact') {
    const half = Math.ceil(lines.length / 2);
    const cols = wide ? [lines.slice(0, half), lines.slice(half)] : [lines];
    return (
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))`, columnGap: 24 }}>
        {cols.map((col, i) => (
          <div key={i} style={{ minWidth: 0 }}>
            {col.map((l) => (
              <CompactLine key={l.id} m={m} l={l} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  // lines: a table's new lines apart from the sent ones.
  if (m.mode === 'table') {
    const fresh = lines.filter((l) => l.status === 'new');
    const sent = lines.filter((l) => l.status !== 'new');
    return (
      <div>
        {fresh.length ? <GroupLabel m={m}>{`${m.text('newSuffix')} · ${fresh.length}`}</GroupLabel> : null}
        {fresh.map((l, i) => (
          <LineRow key={l.id} m={m} l={l} d={d} last={i === fresh.length - 1} />
        ))}
        {sent.length ? <GroupLabel m={m}>{`שודר · ${sent.length}`}</GroupLabel> : null}
        {sent.map((l, i) => (
          <LineRow key={l.id} m={m} l={l} d={d} last={i === sent.length - 1} />
        ))}
      </div>
    );
  }
  return (
    <div>
      {lines.map((l, i) => (
        <LineRow key={l.id} m={m} l={l} d={d} last={i === lines.length - 1} />
      ))}
    </div>
  );
}

function BillHead({ m, title }: { m: PreviewModel; title?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
      <span style={{ fontSize: m.fs(18), fontWeight: 700 }}>{title ?? m.text('orderTitle')}</span>
      <span style={{ fontSize: m.fs(13), color: m.t.ink2 }}>{`${m.units} פריטים`}</span>
    </div>
  );
}

function SidePanel({ m, d, side }: { m: PreviewModel; d: D; side: 'end' | 'start' }) {
  const t = m.t;
  const P = pad(m);
  const width = sideBillWidth(m.view.template, m.W);
  const border = `1px solid ${t.border}`;
  return (
    <div
      style={{
        width,
        flex: `0 0 ${width}px`,
        height: '100%',
        background: t.surface,
        borderInlineStart: side === 'end' ? border : undefined,
        borderInlineEnd: side === 'start' ? border : undefined,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ padding: `16px ${P}px 12px`, borderBottom: border }}>
        <BillHead m={m} />
      </div>
      {fieldsInBill(m) ? (
        <div style={{ padding: `12px ${P}px`, borderBottom: border }}>
          <QuickFields m={m} d={d} stacked />
        </div>
      ) : null}
      <div style={{ flex: '1 1 0', minHeight: 0, overflow: 'hidden', padding: `0 ${P}px` }}>
        <BillLines m={m} d={d} wide={false} />
      </div>
      <div style={{ padding: P, borderTop: border, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <TotalRow m={m} />
        <ActionBar m={m} layout="stack" />
      </div>
    </div>
  );
}

function BottomBlock({ m, d }: { m: PreviewModel; d: D }) {
  const t = m.t;
  const P = pad(m);
  return (
    <div
      style={{
        flex: '0 0 auto',
        maxHeight: '52%',
        background: t.surface,
        borderTop: `1px solid ${t.border}`,
        padding: `14px ${P}px ${P}px`,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <BillHead m={m} title={m.view.template === 'touch' ? 'ההזמנה שלי' : undefined} />
      {fieldsInBill(m) ? <QuickFields m={m} d={d} /> : null}
      <div style={{ minHeight: 0, overflow: 'hidden', flex: '0 1 auto' }}>
        <BillLines m={m} d={d} wide />
      </div>
      <TotalRow m={m} />
      <ActionBar m={m} layout="row" />
    </div>
  );
}

/** The handheld's (and the mobile template's) summary: a bar that opens upward, the total and the bar always in sight. */
function CollapsibleSummary({ m, d, sheet }: { m: PreviewModel; d: D; sheet: boolean }) {
  const t = m.t;
  const P = pad(m);
  const open = m.summaryOpen;
  return (
    <div style={{ flex: '0 0 auto', background: t.surface, borderTop: `1px solid ${t.border}`, display: 'flex', flexDirection: 'column', maxHeight: open ? '78%' : undefined }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => d({ type: 'summary', open: !open })}
        style={{
          height: m.handheld ? 52 : 48,
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: `0 ${P}px`,
          border: 'none',
          borderBottom: `1px solid ${t.border}`,
          background: 'transparent',
          color: t.ink,
          fontFamily: FONT,
          fontSize: m.fs(15),
          cursor: 'pointer',
        }}
      >
        <span style={{ fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {open ? <ChevronDown size={20} /> : <ChevronUp size={20} />}
          {sheet ? (
            <>
              {`${m.units} פריטים · `}
              <Num>{formatMoney(m.total)}</Num>
            </>
          ) : (
            `${m.text('summary')} · ${m.units} פריטים`
          )}
        </span>
        {sheet ? (
          <span style={{ color: t.accent, fontSize: m.fs(14) }}>הצג הזמנה</span>
        ) : m.handheld ? (
          <Num style={{ fontSize: m.fs(22), fontWeight: 700 }}>{formatMoney(m.total)}</Num>
        ) : null}
      </button>
      {open ? (
        <div style={{ flex: '0 1 auto', minHeight: 0, maxHeight: Math.round(m.H * 0.6) - 48, overflow: 'hidden', padding: `0 ${P}px`, borderBottom: `1px solid ${t.border}` }}>
          <BillLines m={m} d={d} wide={!m.handheld} />
        </div>
      ) : null}
      <div style={{ padding: `10px ${P}px ${P}px`, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sheet || m.handheld ? null : <TotalRow m={m} />}
        <ActionBar m={m} layout={m.handheld ? 'handheld' : 'row'} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ the screen */

export function DesignedScreen({ m, d }: { m: PreviewModel; d: D }) {
  const bill = m.view.billPosition[m.mode];
  if (bill === 'end' || bill === 'start') {
    const menu = (
      <div key="menu" style={{ flex: '1 1 0', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <OrderHeader m={m} />
        <Extras m={m} d={d} />
        <MenuArea m={m} d={d} />
      </div>
    );
    const panel = <SidePanel key="panel" m={m} d={d} side={bill} />;
    return <div style={{ display: 'flex', height: '100%' }}>{bill === 'start' ? [panel, menu] : [menu, panel]}</div>;
  }
  const collapsible = bill === 'sheet' || m.handheld || m.view.summaryCollapsible;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <OrderHeader m={m} />
      <Extras m={m} d={d} />
      <MenuArea m={m} d={d} />
      {collapsible ? <CollapsibleSummary m={m} d={d} sheet={bill === 'sheet'} /> : <BottomBlock m={m} d={d} />}
    </div>
  );
}
