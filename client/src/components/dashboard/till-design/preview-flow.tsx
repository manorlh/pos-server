'use client';

/**
 * "זרימה" in the editor's preview column (P:/specs/flow-design.md §5.2): the handheld upright — the home
 * empty and with three sample orders, and the wizard's three steps as small pictures — and the tablet
 * sideways: the two panes (the orders at the start, the tables' map with its area chips and dotted floor),
 * then the wizard as the card over the home (§2). Drawn from the draft through `flowView` and `flowTokens`:
 * our palette (§5.3) or the chosen background, the design's accent. Right to left; the keypad and the guests
 * grid stay left to right, as a calculator (§8). Sample data only — no real tables or orders.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowRight, Check, Delete, Info, Keyboard, LayoutGrid, List, Map as MapIcon, Menu, Pencil, Plus, Receipt, Search, ShoppingBag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { flowView, formatShekels, type FlowView, type Profile } from '@/lib/tillDesign';
import { DEFAULT_STATE_COLORS } from '@/lib/tableTileLook';
import { useTillEditor } from './editor-context';
import { Segmented } from './fields';
import { FONT } from './preview-atoms';
import { flowTokens, mixHex, readableOn, type Tokens } from './preview-model';
import { ScaledScreen } from './till-preview';

type T = ReturnType<typeof useTranslations>;

const PHONE = { w: 360, h: 640 };
const TABLET = { w: 1280, h: 800 };

/* ------------------------------------------------------------ sample data */

type SampleState = 'working' | 'kitchen' | 'toPay' | 'otherTill' | 'overdue' | 'occupied' | 'free';

interface SampleOrder {
  key: string;
  /** null: a pickup (the bag). */
  table: number | null;
  sub: string;
  /** Agorot. */
  amount: number;
  state: SampleState;
}

/** "בעבודה" first, then the newest to the oldest (§1.1). */
const ORDERS: SampleOrder[] = [
  { key: 'pickup', table: null, sub: 'pickupSub', amount: 4600, state: 'working' },
  { key: 't12', table: 12, sub: 't12', amount: 28600, state: 'kitchen' },
  { key: 't15', table: 15, sub: 't15', amount: 14800, state: 'toPay' },
  { key: 't16', table: 16, sub: 't16', amount: 9700, state: 'overdue' },
  { key: 't14', table: 14, sub: 't14', amount: 51200, state: 'otherTill' },
];

interface SampleTable {
  n: number;
  x: number;
  y: number;
  w: number;
  h: number;
  round?: boolean;
  state: SampleState;
  /** "4 · 35׳" under the number. */
  info?: string;
}

/** The active area's floor ("סלון 4/8"): where the dashboard put the tables, fitted to the pane. */
const FLOOR: SampleTable[] = [
  { n: 10, x: 70, y: 70, w: 120, h: 120, state: 'free' },
  { n: 11, x: 250, y: 70, w: 120, h: 120, state: 'free' },
  { n: 12, x: 430, y: 70, w: 120, h: 120, state: 'kitchen', info: '4 · 35׳' },
  { n: 13, x: 610, y: 70, w: 170, h: 120, state: 'free' },
  { n: 14, x: 70, y: 290, w: 170, h: 120, state: 'otherTill' },
  { n: 15, x: 310, y: 290, w: 130, h: 130, round: true, state: 'toPay', info: '2 · 52׳' },
  { n: 16, x: 510, y: 290, w: 120, h: 120, state: 'overdue', info: '3 · 58׳' },
  { n: 17, x: 690, y: 290, w: 120, h: 120, state: 'free' },
];

const AREAS: Array<{ key: string; taken: number; total: number }> = [
  { key: 'salon', taken: 4, total: 8 },
  { key: 'bar', taken: 0, total: 2 },
  { key: 'garden', taken: 1, total: 4 },
];

function stateColor(k: Tokens, state: SampleState): string {
  if (state === 'working') return k.accent;
  if (state === 'free') return k.ink2;
  return DEFAULT_STATE_COLORS[state];
}

/* ------------------------------------------------------------ atoms */

function Screen({ k, w, h, children }: { k: Tokens; w: number; h: number; children: ReactNode }) {
  return (
    <div
      dir="rtl"
      lang="he"
      style={{
        width: w,
        height: h,
        position: 'relative',
        overflow: 'hidden',
        background: k.bg,
        color: k.ink,
        fontFamily: FONT,
        lineHeight: 1.3,
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {children}
    </div>
  );
}

function IconButton({ k, children, label, size = 44 }: { k: Tokens; children: ReactNode; label: string; size?: number }) {
  return (
    <span aria-label={label} style={{ width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: k.ink, borderRadius: 999 }}>
      {children}
    </span>
  );
}

/** The 56 dp bar: ☰ and the title at the start; the list / map pill and 🔍 at the end. */
function HomeBar({ k, t, toggle }: { k: Tokens; t: T; toggle: boolean }) {
  return (
    <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px', background: k.surface, borderBottom: `1px solid ${k.border}` }}>
      <IconButton k={k} label={t('menu')}>
        <Menu size={24} />
      </IconButton>
      <span style={{ fontSize: 21, fontWeight: 700 }}>{t('orders')}</span>
      <span style={{ flex: 1 }} />
      {toggle ? (
        <span style={{ display: 'inline-flex', padding: 3, gap: 2, borderRadius: 999, border: `1px solid ${k.border}`, background: k.bg }}>
          {/* [רשימה | מפה]: the active view (the list) filled in the accent. */}
          <span aria-label={t('list')} style={{ width: 38, height: 30, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: k.accent, color: k.onAccent }}>
            <List size={18} />
          </span>
          <span aria-label={t('map')} style={{ width: 38, height: 30, borderRadius: 999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: k.ink2 }}>
            <MapIcon size={18} />
          </span>
        </span>
      ) : null}
      <IconButton k={k} label={t('search')}>
        <Search size={22} />
      </IconButton>
    </div>
  );
}

function OrderRow({ k, t, o, compact = false }: { k: Tokens; t: T; o: SampleOrder; compact?: boolean }) {
  const color = stateColor(k, o.state);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        height: compact ? 68 : 72,
        padding: '0 12px',
        background: k.surface,
        border: `1px solid ${k.border}`,
        borderRadius: 14,
      }}
    >
      <span
        style={{
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: 12,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: mixHex(color, k.surface, 0.14),
          color: readableOn(color, mixHex(color, k.surface, 0.14)),
          fontSize: 18,
          fontWeight: 800,
        }}
      >
        {o.table === null ? <ShoppingBag size={22} /> : <bdi>{o.table}</bdi>}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 16, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {o.table === null ? t('sample.pickupTitle') : t('tableName', { n: o.table })}
        </span>
        <span style={{ display: 'block', fontSize: 13, color: k.ink2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {t(`sample.${o.sub}`)}
        </span>
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
        <bdi style={{ fontSize: 16, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{formatShekels(o.amount)}</bdi>
        <span style={{ fontSize: 12, fontWeight: 600, color: readableOn(color, k.surface) }}>{t(`state.${o.state}`)}</span>
      </span>
    </div>
  );
}

/** "+ הזמנה חדשה": the big pill, in the accent. */
function NewOrderPill({ k, t, style }: { k: Tokens; t: T; style?: CSSProperties }) {
  return (
    <span
      style={{
        height: 56,
        padding: '0 22px',
        borderRadius: 999,
        background: k.accent,
        color: k.onAccent,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        fontSize: 17,
        fontWeight: 700,
        ...style,
      }}
    >
      <Plus size={22} strokeWidth={2.6} /> {t('newOrder')}
    </span>
  );
}

function EmptyState({ k, t }: { k: Tokens; t: T }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, height: '100%', paddingBottom: 60 }}>
      <span style={{ width: 92, height: 92, borderRadius: 999, background: k.surface, border: `1px solid ${k.border}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: k.ink2 }}>
        <Receipt size={40} strokeWidth={1.6} />
      </span>
      <span style={{ fontSize: 19, fontWeight: 700, marginTop: 6 }}>{t('emptyTitle')}</span>
      <span style={{ fontSize: 14, color: k.ink2 }}>{t('emptySub')}</span>
    </div>
  );
}

/* ------------------------------------------------------------ the handheld */

function PhoneHome({ k, t, withOrders }: { k: Tokens; t: T; withOrders: boolean }) {
  return (
    <Screen k={k} w={PHONE.w} h={PHONE.h}>
      <HomeBar k={k} t={t} toggle />
      <div style={{ height: PHONE.h - 56, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {withOrders ? ORDERS.slice(0, 3).map((o) => <OrderRow key={o.key} k={k} t={t} o={o} />) : <EmptyState k={k} t={t} />}
      </div>
      {/* The bottom corner at the end side (the left in Hebrew). */}
      <NewOrderPill k={k} t={t} style={{ position: 'absolute', bottom: 20, insetInlineEnd: 16 }} />
    </Screen>
  );
}

/** One wizard step: ← and "הזמנה חדשה", the question, the step's body, the full-width primary pill. */
function WizardStep({
  k,
  t,
  w = PHONE.w,
  h = PHONE.h,
  question,
  primary,
  link,
  children,
}: {
  k: Tokens;
  t: T;
  w?: number;
  h?: number;
  question: string;
  primary: ReactNode;
  link?: string | null;
  children: ReactNode;
}) {
  return (
    <Screen k={k} w={w} h={h}>
      <div style={{ height: 56, display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px' }}>
        {/* "חזרה" points right in Hebrew (§8). */}
        <IconButton k={k} label={t('back')}>
          <ArrowRight size={24} />
        </IconButton>
        <span style={{ fontSize: 19, fontWeight: 700 }}>{t('newOrderTitle')}</span>
      </div>
      <div style={{ padding: '10px 16px 0', fontSize: 24, fontWeight: 800 }}>{question}</div>
      <div style={{ padding: '14px 16px 0' }}>{children}</div>
      <div style={{ position: 'absolute', insetInline: 16, bottom: 16, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        {link ? <span style={{ color: k.accent, fontSize: 16, fontWeight: 600 }}>{link}</span> : null}
        <span
          style={{
            width: '100%',
            height: 56,
            borderRadius: 999,
            background: k.accent,
            color: k.onAccent,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
            fontSize: 18,
            fontWeight: 700,
          }}
        >
          {primary}
        </span>
      </div>
    </Screen>
  );
}

function StepType({ k, t }: { k: Tokens; t: T }) {
  const pill = (filled: boolean): CSSProperties => ({
    height: 64,
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 20,
    fontWeight: 700,
    background: filled ? k.accent : 'transparent',
    color: filled ? k.onAccent : k.accent,
    border: `2px solid ${k.accent}`,
  });
  return (
    <WizardStep k={k} t={t} question={t('stepType')} primary={t('next')}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 16 }}>
        <span style={pill(true)}>{t('table')}</span>
        <span style={pill(false)}>{t('pickup')}</span>
      </div>
    </WizardStep>
  );
}

function Key({ k, children, label, h = 64 }: { k: Tokens; children: ReactNode; label?: string; h?: number }) {
  return (
    <span
      aria-label={label}
      style={{
        height: h,
        borderRadius: 16,
        background: k.surface,
        border: `1px solid ${k.border}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 26,
        fontWeight: 600,
      }}
    >
      {children}
    </span>
  );
}

function Keypad({ k, t, keyH = 64 }: { k: Tokens; t: T; keyH?: number }) {
  return (
    // Left to right in Hebrew too, as a calculator (§8).
    <div dir="ltr" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
        <Key key={n} k={k} h={keyH}>
          {n}
        </Key>
      ))}
      <Key k={k} h={keyH}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>{t('clear')}</span>
      </Key>
      <Key k={k} h={keyH}>
        0
      </Key>
      <Key k={k} h={keyH} label={t('deleteDigit')}>
        <Delete size={26} />
      </Key>
    </div>
  );
}

function TableNumber({ k, t }: { k: Tokens; t: T }) {
  const free = DEFAULT_STATE_COLORS.free;
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontSize: 40, lineHeight: '48px', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>12</div>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 14, color: k.ink2, height: 22 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: free }} />
        {t('tableStatus')}
      </div>
    </div>
  );
}

function StepTable({ k, t, view }: { k: Tokens; t: T; view: FlowView }) {
  return (
    <WizardStep k={k} t={t} question={t('stepTable')} primary={t('next')} link={view.notes ? t('addNote') : null}>
      <TableNumber k={k} t={t} />
      <div style={{ marginTop: 12 }}>
        <Keypad k={k} t={t} />
      </div>
    </WizardStep>
  );
}

function StepGuests({ k, t }: { k: Tokens; t: T }) {
  return (
    <WizardStep
      k={k}
      t={t}
      question={t('stepGuests')}
      primary={
        <>
          {t('open')} <Check size={20} strokeWidth={2.6} />
        </>
      }
    >
      <div dir="ltr" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, paddingTop: 8 }}>
        {Array.from({ length: 19 }, (_, i) => i + 1).map((n) => {
          const chosen = n === 1;
          return (
            <span
              key={n}
              style={{
                height: 56,
                borderRadius: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                fontWeight: chosen ? 800 : 500,
                background: chosen ? k.tint : k.surface,
                color: chosen ? readableOn(k.accent, k.tint) : k.ink,
                border: `${chosen ? 2 : 1}px solid ${chosen ? k.accent : k.border}`,
              }}
            >
              {n}
            </span>
          );
        })}
        <span
          aria-label={t('moreGuests')}
          style={{ height: 56, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', background: k.surface, border: `1px solid ${k.border}`, color: k.ink2 }}
        >
          <Keyboard size={22} />
        </span>
      </div>
    </WizardStep>
  );
}

/* ------------------------------------------------------------ the tablet */

function MapTable({ k, t, tb }: { k: Tokens; t: T; tb: SampleTable }) {
  const color = stateColor(k, tb.state);
  const free = tb.state === 'free';
  const other = tb.state === 'otherTill';
  const fill = free ? k.surface : mixHex(color, k.bg, other ? 0.06 : 0.14);
  return (
    <span
      style={{
        position: 'absolute',
        left: tb.x,
        top: tb.y,
        width: tb.w,
        height: tb.h,
        borderRadius: tb.round ? 999 : 20,
        background: fill,
        border: free ? `1.5px solid ${k.ink2}` : other ? `2px dashed ${color}` : `3px solid ${color}`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
      }}
    >
      <span style={{ fontSize: 30, fontWeight: 800, color: free ? k.ink : readableOn(color, fill) }}>
        <bdi>{tb.n}</bdi>
      </span>
      {other ? (
        <span style={{ fontSize: 14, fontWeight: 600, color: readableOn(color, fill) }}>{t('state.otherTill')}</span>
      ) : tb.info ? (
        <bdi style={{ fontSize: 14, color: k.ink2 }}>{tb.info}</bdi>
      ) : null}
    </span>
  );
}

function MapPane({ k, t }: { k: Tokens; t: T }) {
  return (
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {/* The areas: "בר 0/2" — taken of all; the active one filled; ▦ at the end (map or grid). */}
      <div style={{ height: 64, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderBottom: `1px solid ${k.border}`, background: k.surface }}>
        {AREAS.map((a, i) => (
          <span
            key={a.key}
            style={{
              height: 40,
              padding: '0 16px',
              borderRadius: 999,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontSize: 16,
              fontWeight: 600,
              background: i === 0 ? k.accent : k.bg,
              color: i === 0 ? k.onAccent : k.ink,
              border: `1px solid ${i === 0 ? k.accent : k.border}`,
            }}
          >
            {t(`areas.${a.key}`)}{' '}
            <bdi style={{ fontVariantNumeric: 'tabular-nums' }}>
              {a.taken}/{a.total}
            </bdi>
          </span>
        ))}
        <span style={{ flex: 1 }} />
        <IconButton k={k} label={t('gridToggle')}>
          <LayoutGrid size={22} />
        </IconButton>
      </div>
      {/* The floor: a clean surface with a fine grid of dots, no wood and no shadows. */}
      <div
        dir="ltr"
        style={{
          position: 'relative',
          flex: 1,
          backgroundColor: k.bg,
          backgroundImage: `radial-gradient(${k.border} 1.6px, transparent 1.6px)`,
          backgroundSize: '28px 28px',
        }}
      >
        {FLOOR.map((tb) => (
          <MapTable key={tb.n} k={k} t={t} tb={tb} />
        ))}
      </div>
      <div style={{ height: 72, display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px', borderTop: `1px solid ${k.border}`, background: k.surface }}>
        <span
          style={{
            height: 48,
            padding: '0 20px',
            borderRadius: 999,
            border: `2px solid ${k.accent}`,
            color: k.accent,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 17,
            fontWeight: 700,
          }}
        >
          <ShoppingBag size={20} /> {t('pickup')}
        </span>
        <span style={{ flex: 1 }} />
        <IconButton k={k} label={t('mapInfo')} size={48}>
          <Info size={24} />
        </IconButton>
        <IconButton k={k} label={t('mapEdit')} size={48}>
          <Pencil size={22} />
        </IconButton>
      </div>
    </div>
  );
}

/** ≥ 600 dp: two panes, no toggle — the orders at the start (360 dp), the map in the rest; "+ הזמנה חדשה" under the list. */
function TabletHome({ k, t, children }: { k: Tokens; t: T; children?: ReactNode }) {
  return (
    <Screen k={k} w={TABLET.w} h={TABLET.h}>
      <div style={{ display: 'flex', height: '100%' }}>
        <div style={{ width: 360, flexShrink: 0, display: 'flex', flexDirection: 'column', borderInlineEnd: `1px solid ${k.border}` }}>
          <HomeBar k={k} t={t} toggle={false} />
          <div style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ORDERS.map((o) => (
              <OrderRow key={o.key} k={k} t={t} o={o} compact />
            ))}
          </div>
          <div style={{ padding: 12 }}>
            <NewOrderPill k={k} t={t} style={{ width: '100%', boxSizing: 'border-box' }} />
          </div>
        </div>
        <MapPane k={k} t={t} />
      </div>
      {children}
    </Screen>
  );
}

/** The wizard on a wide screen: a card in the middle (up to 520 dp) over the dimmed home, keys of 72 dp. */
function TabletWizard({ k, t, view }: { k: Tokens; t: T; view: FlowView }) {
  return (
    <TabletHome k={k} t={t}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 520, height: 720, borderRadius: 24, overflow: 'hidden', position: 'relative', border: `1px solid ${k.border}` }}>
          <WizardStep k={k} t={t} w={520} h={720} question={t('stepTable')} primary={t('next')} link={view.notes ? t('addNote') : null}>
            <TableNumber k={k} t={t} />
            <div style={{ marginTop: 12 }}>
              <Keypad k={k} t={t} keyH={72} />
            </div>
          </WizardStep>
        </div>
      </div>
    </TabletHome>
  );
}

/* ------------------------------------------------------------ the panel */

function Thumb({ caption, note, dim = false, children }: { caption: string; note?: string | null; dim?: boolean; children: ReactNode }) {
  return (
    <figure className="min-w-0 space-y-1">
      <div aria-hidden className={cn('overflow-hidden rounded-lg border', dim && 'opacity-40')}>
        <ScaledScreen width={PHONE.w} height={PHONE.h} frame={false}>
          {children}
        </ScaledScreen>
      </div>
      <figcaption className="text-center text-[11px] leading-tight text-muted-foreground">
        {caption}
        {note ? <span className="block text-amber-700 dark:text-amber-300">{note}</span> : null}
      </figcaption>
    </figure>
  );
}

function ShellBadge({ on, label }: { on: boolean; label: string }) {
  const t = useTranslations('tillDesign.flow.preview');
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      <span className="font-medium">{label}</span>
      <span className={cn('rounded-md px-1.5 py-0.5', on ? 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200' : 'bg-muted text-muted-foreground')}>
        {on ? t('on') : t('off')}
      </span>
    </span>
  );
}

const LANDSCAPES: Profile[] = ['tabletLandscape', 'ipadLandscape'];

/** The editor's preview column on "סגנון מסכים". */
export function FlowPreviewPanel() {
  const ed = useTillEditor();
  const t = useTranslations('tillDesign.flow.preview');
  const tv = useTranslations('tillDesign.values');
  const [device, setDevice] = useState<'phone' | 'tablet'>(LANDSCAPES.includes(ed.profile) ? 'tablet' : 'phone');
  const view = flowView(ed.draft);
  const k = flowTokens(ed.draft);
  const skipType = view.firstStep !== 'type';
  const skipGuests = view.askGuests === 'never';
  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          value={device}
          onChange={setDevice}
          ariaLabel={t('device')}
          options={[
            { value: 'phone', label: t('phone') },
            { value: 'tablet', label: t('tablet') },
          ]}
        />
        <ShellBadge
          label={device === 'phone' ? t('phone') : t('tablet')}
          on={device === 'phone' ? view.shell.handheld === 'flow' : view.shell.tabletLandscape === 'flow'}
        />
      </div>
      {device === 'phone' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <figure className="min-w-0 space-y-1">
              <ScaledScreen width={PHONE.w} height={PHONE.h} maxHeight={380}>
                <PhoneHome k={k} t={t} withOrders={false} />
              </ScaledScreen>
              <figcaption className="text-center text-[11px] text-muted-foreground">{t('emptyCaption')}</figcaption>
            </figure>
            <figure className="min-w-0 space-y-1">
              <ScaledScreen width={PHONE.w} height={PHONE.h} maxHeight={380}>
                <PhoneHome k={k} t={t} withOrders />
              </ScaledScreen>
              <figcaption className="text-center text-[11px] text-muted-foreground">{t('ordersCaption')}</figcaption>
            </figure>
          </div>
          <p className="text-xs font-medium">{t('stepsCaption')}</p>
          <div className="grid grid-cols-3 gap-2">
            <Thumb caption={t('stepType')} dim={skipType} note={skipType ? t('skipped', { why: tv(`flowFirstStep.${view.firstStep}`) }) : null}>
              <StepType k={k} t={t} />
            </Thumb>
            <Thumb caption={t('stepTable')}>
              <StepTable k={k} t={t} view={view} />
            </Thumb>
            <Thumb
              caption={t('stepGuests')}
              dim={skipGuests}
              note={skipGuests ? t('skipped', { why: tv(`flowAskGuests.${view.askGuests}`) }) : view.askGuests === 'auto' ? tv('flowAskGuests.auto') : null}
            >
              <StepGuests k={k} t={t} />
            </Thumb>
          </div>
        </>
      ) : (
        <>
          <figure className="space-y-1">
            <ScaledScreen width={TABLET.w} height={TABLET.h} maxHeight={340}>
              <TabletHome k={k} t={t} />
            </ScaledScreen>
            <figcaption className="text-center text-[11px] text-muted-foreground">{t('tabletCaption')}</figcaption>
          </figure>
          <figure className="space-y-1">
            <ScaledScreen width={TABLET.w} height={TABLET.h} maxHeight={340}>
              <TabletWizard k={k} t={t} view={view} />
            </ScaledScreen>
            <figcaption className="text-center text-[11px] text-muted-foreground">{t('tabletWizardCaption')}</figcaption>
          </figure>
        </>
      )}
      <ul className="space-y-0.5 text-xs text-muted-foreground">
        <li>{t('opensOn', { view: tv(`flowHome.${view.home}`) })}</li>
        <li>{t('pickupName', { mode: tv(`flowPickupName.${view.pickupName}`) })}</li>
      </ul>
    </div>
  );
}
