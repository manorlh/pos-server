'use client';

/**
 * The preview's building blocks, in the brief's visual language (§2): flat surfaces separated
 * by 1 px borders, one accent, radius 10 (8 for chips and small buttons), never fully round, no
 * shadows, no gradients, line icons only where they help. Sizes are dp (1 px = 1 dp); type
 * sizes go through `m.fs` (`textSize: large` × 1.15).
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Banknote, Check, ChevronDown, CreditCard, Minus, Plus, Send } from 'lucide-react';
import { formatShekels } from '@/lib/tillDesign';
import type { LineStatus, PAction, PreviewModel, Tokens } from './preview-model';

export const FONT = 'var(--font-heebo), Heebo, "Segoe UI", system-ui, sans-serif';
export const R = 10;
export const R_SMALL = 8;

/** A box's content size, kept current (layout size: a CSS scale around it does not change it). */
export function useBoxSize<T extends HTMLElement>(): [RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    const ro = new ResizeObserver(read);
    ro.observe(el);
    read();
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

export function pad(m: PreviewModel): number {
  return m.handheld ? 12 : 16;
}

export function gap(m: PreviewModel): number {
  return m.handheld ? 8 : 10;
}

export function ellipsis(lines = 1): CSSProperties {
  return lines === 1
    ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }
    : { display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' };
}

/** Hebrew text with numbers: the digits and ₪ keep their order inside RTL. */
export function Num({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <span dir="ltr" style={{ unicodeBidi: 'isolate', fontVariantNumeric: 'tabular-nums', ...style }}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ chips */

/** A category chip: selected = accent border + tint + bold, never colour alone. */
export function CategoryChip({ m, label, selected, onClick }: { m: PreviewModel; label: string; selected: boolean; onClick?: () => void }) {
  const t = m.t;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      style={{
        flex: '0 0 auto',
        height: m.handheld ? 40 : 44,
        minWidth: 64,
        padding: '0 16px',
        borderRadius: R_SMALL,
        border: `1px solid ${selected ? t.accent : t.border}`,
        background: selected ? t.tint : t.surface,
        color: selected ? t.accent : t.ink,
        fontWeight: selected ? 700 : 500,
        fontSize: m.fs(15),
        fontFamily: FONT,
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      {label}
    </button>
  );
}

/** A chip's width (dp) estimated from its label (Heebo's Hebrew runs about 0.56 em a letter). */
export function chipWidth(m: PreviewModel, label: string): number {
  return Math.max(64, Math.ceil(32 + label.length * m.fs(15) * 0.58));
}

/**
 * The categories that fit on one line (no chip cut at the edge): "הכל" and as many as fit, then
 * "עוד" when some are left out (`more`).
 */
export function fitChips<T extends { name: string }>(m: PreviewModel, items: readonly T[], width: number, more: boolean, gapPx = 8): { shown: T[]; rest: number } {
  if (width <= 0) return { shown: [], rest: items.length };
  let used = chipWidth(m, 'הכל');
  const shown: T[] = [];
  for (let i = 0; i < items.length; i++) {
    const w = chipWidth(m, items[i].name) + gapPx;
    const reserve = more && i < items.length - 1 ? 84 + gapPx : 0;
    if (used + w + reserve > width) break;
    used += w;
    shown.push(items[i]);
  }
  return { shown, rest: items.length - shown.length };
}

/** "עוד ▾": the categories that did not fit (the till opens them in a list). */
export function MoreChip({ m, n }: { m: PreviewModel; n: number }) {
  const t = m.t;
  return (
    <span
      style={{
        flex: '0 0 auto',
        height: m.handheld ? 40 : 44,
        padding: '0 12px',
        borderRadius: R_SMALL,
        border: `1px solid ${t.border}`,
        background: t.surface,
        color: t.ink,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: m.fs(15),
        fontWeight: 500,
      }}
    >
      {`עוד ${n}`}
      <ChevronDown size={16} />
    </span>
  );
}

/** A line's status with words: "חדש" / "שודר" / "ממתין" / "נכשל · נסה שוב". */
export function StatusChip({ m, status }: { m: PreviewModel; status: LineStatus }) {
  const t = m.t;
  const look: Record<LineStatus, { fg: string; bg: string; border: string; label: string }> = {
    new: { fg: t.accent, bg: t.tint, border: t.tint, label: m.text('newSuffix') },
    sent: { fg: t.ink2, bg: t.surface, border: t.border, label: 'שודר' },
    pending: { fg: t.amberInk, bg: t.amberBg, border: t.amberBg, label: 'ממתין' },
    failed: { fg: t.red, bg: t.redBg, border: t.redBg, label: 'נכשל · נסה שוב' },
  };
  const s = look[status];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 8px',
        borderRadius: 6,
        border: `1px solid ${s.border}`,
        background: s.bg,
        color: s.fg,
        fontSize: m.fs(12),
        fontWeight: 600,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
      }}
    >
      {s.label}
    </span>
  );
}

/** How many of a product are in the order, on its tile. */
export function CountBadge({ m, n }: { m: PreviewModel; n: number }) {
  if (n <= 0) return null;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 24,
        height: 22,
        padding: '0 6px',
        borderRadius: 6,
        background: m.t.tint,
        color: m.t.accent,
        fontSize: m.fs(13),
        fontWeight: 700,
        flex: '0 0 auto',
      }}
    >
      <Num>{`×${n}`}</Num>
    </span>
  );
}

/** "+" on a tile: a small tinted square (never a circle). */
export function PlusSquare({ m, size = 28 }: { m: PreviewModel; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: R_SMALL,
        background: m.t.tint,
        color: m.t.accent,
        flex: '0 0 auto',
      }}
    >
      <Plus size={Math.round(size * 0.58)} strokeWidth={2.2} />
    </span>
  );
}

/** − qty + on a new line (a sent line changes through the line's own menu, never here). */
export function Stepper({ m, qty, onStep, size }: { m: PreviewModel; qty: number; onStep?: (delta: number) => void; size?: number }) {
  const s = size ?? (m.handheld ? 36 : 40);
  const t = m.t;
  const btn = (delta: number, icon: ReactNode, label: string) => (
    <button
      type="button"
      aria-label={label}
      onClick={() => onStep?.(delta)}
      style={{
        width: s,
        height: s,
        borderRadius: R_SMALL,
        border: `1px solid ${t.border}`,
        background: t.surface,
        color: t.ink,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: onStep ? 'pointer' : 'default',
        padding: 0,
      }}
    >
      {icon}
    </button>
  );
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
      {btn(1, <Plus size={18} />, 'הוסף')}
      <Num style={{ minWidth: 18, textAlign: 'center', fontSize: m.fs(16), fontWeight: 600 }}>{qty}</Num>
      {btn(-1, <Minus size={18} />, 'הפחת')}
    </span>
  );
}

/* ------------------------------------------------------------ fields */

/** The service type, segmented (לקחת / לשבת). "לשבת" never assigns a table. */
export function ServiceSegment({ m, onPick, wide }: { m: PreviewModel; onPick?: (v: 'takeAway' | 'eatIn') => void; wide?: boolean }) {
  const t = m.t;
  const opt = (value: 'takeAway' | 'eatIn') => {
    const on = m.state.serviceType === value;
    return (
      <button
        key={value}
        type="button"
        aria-pressed={on}
        onClick={() => onPick?.(value)}
        style={{
          flex: wide ? '1 1 0' : '0 0 auto',
          minWidth: 96,
          height: 44,
          padding: '0 18px',
          borderRadius: R_SMALL,
          border: `1px solid ${on ? t.accent : t.border}`,
          background: on ? t.tint : t.surface,
          color: on ? t.accent : t.ink,
          fontWeight: on ? 700 : 500,
          fontSize: m.fs(15),
          fontFamily: FONT,
          cursor: onPick ? 'pointer' : 'default',
        }}
      >
        {m.text(value)}
      </button>
    );
  };
  return <div style={{ display: 'flex', gap: 8, flex: wide ? '1 1 auto' : '0 0 auto' }}>{[opt('takeAway'), opt('eatIn')]}</div>;
}

/** The customer's name field ("חובה" said in words when the field is required). */
export function NameField({ m, grow = true, inline = false }: { m: PreviewModel; grow?: boolean; inline?: boolean }) {
  const t = m.t;
  const required = m.fields.customerName === 'required';
  const box = (
    <div
      style={{
        height: 44,
        borderRadius: R_SMALL,
        border: `1px solid ${t.border}`,
        background: t.surface,
        display: 'flex',
        alignItems: 'center',
        padding: '0 12px',
        color: t.ink2,
        fontSize: m.fs(15),
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {inline ? `${m.text('customerName')}${required ? ' · חובה' : ''}` : required ? 'הזינו שם לפני התשלום' : 'לא חובה'}
    </div>
  );
  if (inline) return box;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: grow ? '1 1 0' : '0 0 auto', minWidth: 0 }}>
      <span style={{ fontSize: m.fs(13), color: t.ink2 }}>
        {m.text('customerName')}
        {required ? <span style={{ color: t.ink, fontWeight: 600 }}> · חובה</span> : null}
      </span>
      {box}
    </div>
  );
}

/* ------------------------------------------------------------ buttons */

function ActionIcon({ icon, size }: { icon: PAction['icon']; size: number }) {
  if (icon === 'send') return <Send size={size} strokeWidth={2} style={{ transform: 'scaleX(-1)' }} />;
  if (icon === 'card') return <CreditCard size={size} strokeWidth={2} />;
  if (icon === 'cash') return <Banknote size={size} strokeWidth={2} />;
  return null;
}

/** One action: the required one accent-filled, the rest surface + border; disabled says why. */
export function ActionButton({ m, a, height, style }: { m: PreviewModel; a: PAction; height: number; style?: CSSProperties }) {
  const t = m.t;
  const primary = a.primary && !a.disabled;
  const look: CSSProperties = a.disabled
    ? { background: 'transparent', color: t.ink2, border: `1px solid ${t.border}` }
    : primary
      ? { background: t.accent, color: t.onAccent, border: `1px solid ${t.accent}` }
      : { background: t.surface, color: t.ink, border: `1px solid ${t.border}` };
  return (
    <button
      type="button"
      disabled={a.disabled}
      style={{
        height,
        minWidth: 0,
        borderRadius: R,
        padding: '0 12px',
        display: 'flex',
        flexDirection: a.sub ? 'column' : 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: a.sub ? 0 : 8,
        fontFamily: FONT,
        fontSize: m.fs(a.primary ? 16 : 15),
        fontWeight: 600,
        cursor: 'default',
        ...look,
        ...style,
      }}
    >
      {a.icon && !a.disabled && a.primary ? <ActionIcon icon={a.icon} size={18} /> : null}
      <span style={{ ...ellipsis(1), maxWidth: '100%' }}>
        {a.action === 'note' ? <Num style={{ fontWeight: 700, fontSize: m.fs(17) }}>{a.label}</Num> : a.label}
      </span>
      {a.sub ? <span style={{ fontSize: m.fs(12), fontWeight: 500, color: t.ink2 }}>{a.sub}</span> : null}
    </button>
  );
}

/**
 * The action bar. `row`: one line, the required button first and wider (a tablet's bottom
 * block); `stack`: the required button across, the rest two by two under it (a side panel);
 * `handheld`: the rest in rows of up to three, the required button across at the bottom.
 */
export function ActionBar({ m, layout }: { m: PreviewModel; layout: 'row' | 'stack' | 'handheld' }) {
  const primary = m.actions.filter((a) => a.primary);
  const rest = m.actions.filter((a) => !a.primary);
  const g = m.handheld ? 8 : 10;
  if (layout === 'row') {
    const many = m.actions.length > 5;
    if (many) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: g }}>
          <div style={{ display: 'flex', gap: g }}>
            {rest.map((a) => (
              <ActionButton key={a.key} m={m} a={a} height={52} style={{ flex: '1 1 0' }} />
            ))}
          </div>
          {primary.map((a) => (
            <ActionButton key={a.key} m={m} a={a} height={56} style={{ width: '100%' }} />
          ))}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', gap: g }}>
        {primary.map((a) => (
          <ActionButton key={a.key} m={m} a={a} height={56} style={{ flex: rest.length ? '1.6 1 0' : '1 1 0' }} />
        ))}
        {rest.map((a) => (
          <ActionButton key={a.key} m={m} a={a} height={56} style={{ flex: '1 1 0' }} />
        ))}
      </div>
    );
  }
  // The handheld with one other button: both on one line, the required one wider.
  if (layout === 'handheld' && rest.length <= 1) {
    return (
      <div style={{ display: 'flex', gap: g }}>
        {primary.map((a) => (
          <ActionButton key={a.key} m={m} a={a} height={52} style={{ flex: rest.length ? '1.5 1 0' : '1 1 0' }} />
        ))}
        {rest.map((a) => (
          <ActionButton key={a.key} m={m} a={a} height={52} style={{ flex: '1 1 0' }} />
        ))}
      </div>
    );
  }
  const perRow = layout === 'stack' ? 2 : 3;
  const rows: PAction[][] = [];
  for (let i = 0; i < rest.length; i += perRow) rows.push(rest.slice(i, i + perRow));
  const primaryRow = primary.map((a) => <ActionButton key={a.key} m={m} a={a} height={layout === 'stack' ? 56 : 52} style={{ width: '100%' }} />);
  const restRows = rows.map((row, i) => (
    <div key={i} style={{ display: 'flex', gap: g }}>
      {row.map((a) => (
        <ActionButton key={a.key} m={m} a={a} height={layout === 'stack' ? 52 : 48} style={{ flex: '1 1 0' }} />
      ))}
    </div>
  ));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: g }}>
      {layout === 'stack' ? (
        <>
          {primaryRow}
          {restRows}
        </>
      ) : (
        <>
          {restRows}
          {primaryRow}
        </>
      )}
    </div>
  );
}

/** "סה״כ לתשלום" and the total. */
export function TotalRow({ m, size = 28, label }: { m: PreviewModel; size?: number; label?: string }) {
  const t = m.t;
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ fontSize: m.fs(16), color: t.ink, fontWeight: 500 }}>{label ?? 'סה״כ לתשלום'}</span>
      <Num style={{ fontSize: m.fs(size), fontWeight: 700, color: t.ink }}>{formatMoney(m.total)}</Num>
    </div>
  );
}

/** Shekels as the till writes them ("₪108", "₪2.80"). */
export function formatMoney(agorot: number): string {
  return formatShekels(agorot);
}

/** A check mark with words, for "נבחר". */
export function Chosen({ t, label }: { t: Tokens; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: t.accent, fontWeight: 700, fontSize: 12 }}>
      <Check size={13} strokeWidth={2.6} />
      {label}
    </span>
  );
}
