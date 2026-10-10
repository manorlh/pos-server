/**
 * The kitchen screen's layouts (docs/SPEC_KDS.md §14; which card goes where: lib/kdsLayouts.ts):
 * "tickets" (today's cards in balanced columns), "columns" (a lane per station or course, and the
 * Expo's "לאיסוף"), "rail" (one row in time order), "list" (dense rows), "big" (a few large cards
 * and the queue behind them). Every layout draws the same cards and buttons (KdsCard) — only the
 * arrangement differs. Sizes are in the layout's own pixels (the screen scales the whole body by
 * the look's font scale).
 */

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { ChevronDown, ChevronLeft } from 'lucide-react';
import type { KdsOrder, KdsView } from '@/lib/kdsScreenTypes';
import {
  cardWeight,
  columnsFor,
  groupText,
  layoutColumns,
  orderButtons,
  orderTimer,
  orderTitle,
  serviceText,
  sourceText,
  TIMER_TEXT,
  waitingFor,
  type KdsButton,
  type KdsScreenRole,
} from '@/lib/kdsBoard';
import { bigCapacity, bigSplit, itemsSummary, laneButton, lanesOf, railOrder, type Lane } from '@/lib/kdsLayouts';
import { DENSITY_SPEC, screenThresholds } from '@/lib/screenLook';
import { KdsCard, type CardProps } from './KdsCard';
import { TouchButton } from './parts';
import { levelVars, useKdsLook } from './theme';

export interface LayoutProps {
  cards: KdsOrder[];
  role: KdsScreenRole;
  settings: KdsView['stationSettings'];
  nowMs: number;
  offline: boolean;
  fresh: ReadonlySet<string>;
  flashKey: string | null;
  onPress: (b: KdsButton, order: KdsOrder) => void;
  onPrint?: (order: KdsOrder) => void;
  /** The device's stations (the lanes' order). */
  stations: ReadonlyArray<{ id: string; name: string }>;
  /** The layout's size in its own pixels. */
  width: number;
  height: number;
}

/** Whether a scroller has more below (or, `axis` x, further along the row). */
function useMore(el: HTMLElement | null, axis: 'x' | 'y', deps: unknown): boolean {
  const [more, setMore] = useState(false);
  useEffect(() => {
    if (!el) return;
    const check = () =>
      setMore(axis === 'y' ? el.scrollTop + el.clientHeight < el.scrollHeight - 8 : Math.abs(el.scrollLeft) + el.clientWidth < el.scrollWidth - 8);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', check);
      ro.disconnect();
    };
  }, [el, axis, deps]);
  return more;
}

function MoreHint({ axis, text }: { axis: 'x' | 'y'; text: string }) {
  return (
    <div
      className={
        axis === 'y'
          ? 'pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-2'
          : 'pointer-events-none absolute bottom-3 left-3 flex'
      }
    >
      <span className="flex items-center gap-1 rounded-full border border-[var(--k-line)] bg-[var(--k-panel)] px-4 py-1 text-lg font-bold text-[var(--k-text)] shadow-lg">
        {axis === 'y' ? <ChevronDown size={20} /> : <ChevronLeft size={20} />} {text}
      </span>
    </div>
  );
}

function card(p: LayoutProps, o: KdsOrder, extra: Partial<CardProps> = {}, key: string = o.id) {
  return (
    <KdsCard
      key={key}
      order={o}
      role={p.role}
      settings={p.settings}
      nowMs={p.nowMs}
      offline={p.offline}
      fresh={p.fresh.has(o.id)}
      flashKey={p.flashKey}
      onPress={p.onPress}
      onPrint={p.onPrint}
      {...extra}
    />
  );
}

/* ------------------------------------------------------------------ tickets */

export function TicketsLayout(p: LayoutProps) {
  const { look } = useKdsLook();
  const spec = DENSITY_SPEC[look.density] ?? DENSITY_SPEC.normal;
  const [el, setEl] = useState<HTMLElement | null>(null);
  const columns = useMemo(() => layoutColumns(p.cards, columnsFor(p.width - 24, spec.minWidth, spec.gap), cardWeight), [p.cards, p.width, spec]);
  const more = useMore(el, 'y', columns);
  return (
    <div className="relative h-full">
      <main ref={setEl} className="h-full touch-pan-y overflow-y-auto overscroll-contain p-3">
        <div className="flex items-start" style={{ gap: spec.gap }}>
          {columns.map((col, i) => (
            <div key={i} className="flex min-w-0 flex-1 flex-col" style={{ gap: spec.gap }}>
              {col.map((o) => card(p, o))}
            </div>
          ))}
        </div>
      </main>
      {more ? <MoreHint axis="y" text="עוד הזמנות למטה" /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ columns */

export function ColumnsLayout(p: LayoutProps) {
  const { look } = useKdsLook();
  const spec = DENSITY_SPEC[look.density] ?? DENSITY_SPEC.normal;
  const lanes = useMemo(() => lanesOf(p.cards, look.columnsBy, p.role, p.stations), [p.cards, look.columnsBy, p.role, p.stations]);
  const laneMin = Math.max(260, spec.minWidth - 30);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const more = useMore(el, 'x', lanes);
  return (
    <div className="relative h-full">
      <div ref={setEl} className="flex h-full touch-pan-x overflow-x-auto p-3" style={{ gap: spec.gap }}>
        {lanes.map((lane) => (
          <LaneColumn key={lane.key} lane={lane} p={p} minWidth={laneMin} gap={spec.gap} />
        ))}
      </div>
      {more ? <MoreHint axis="x" text="עוד טורים" /> : null}
    </div>
  );
}

function LaneColumn({ lane, p, minWidth, gap }: { lane: Lane; p: LayoutProps; minWidth: number; gap: number }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const more = useMore(el, 'y', lane.entries);
  const pickup = lane.kind === 'pickup';
  return (
    <section className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-[var(--k-line)] bg-[var(--k-panel)]" style={{ minWidth }}>
      <header className={`flex shrink-0 items-center justify-between gap-2 border-b border-[var(--k-line)] px-4 py-3 ${pickup ? 'bg-[var(--k-pickup)] text-[var(--k-on-pickup)]' : ''}`}>
        <h2 className="truncate text-[26px] font-black leading-none">{lane.title}</h2>
        <span className={`shrink-0 rounded-lg px-2.5 py-1 text-lg font-extrabold tabular-nums ${pickup ? 'bg-black/15' : 'bg-[var(--k-chip)]'}`}>
          {lane.open} {pickup ? 'הזמנות' : 'פריטים'}
        </span>
      </header>
      <div ref={setEl} className="flex min-h-0 flex-1 touch-pan-y flex-col overflow-y-auto overscroll-contain p-2" style={{ gap }}>
        {lane.entries.length === 0 ? <div className="py-6 text-center text-lg text-[var(--k-faint)]">אין פריטים</div> : null}
        {lane.entries.map((e) =>
          pickup
            ? card(p, e.order, { variant: 'summary' })
            : card(p, e.order, { variant: 'lane', laneTasks: e.tasks, laneButton: laneButton(e.order, lane, e.tasks), onPrint: undefined }, `${lane.key}:${e.order.id}`),
        )}
      </div>
      {more ? (
        <div className="flex shrink-0 items-center justify-center gap-1 border-t border-[var(--k-line)] py-1.5 text-base font-bold text-[var(--k-muted)]">
          <ChevronDown size={18} /> עוד למטה
        </div>
      ) : null}
    </section>
  );
}

/* --------------------------------------------------------------------- rail */

export function RailLayout(p: LayoutProps) {
  const { look } = useKdsLook();
  const spec = DENSITY_SPEC[look.density] ?? DENSITY_SPEC.normal;
  const cards = useMemo(() => railOrder(p.cards, p.role), [p.cards, p.role]);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const more = useMore(el, 'x', cards);
  const width = spec.minWidth + 30;
  return (
    <div className="relative h-full">
      {more ? (
        <div className="pointer-events-none absolute left-3 top-1.5 z-10 flex items-center gap-1 text-base font-extrabold text-[var(--k-accent-text)]">
          <ChevronLeft size={18} /> עוד {Math.max(1, cards.length - Math.floor(p.width / (width + spec.gap)))} הזמנות
        </div>
      ) : null}
      <div ref={setEl} className="flex h-full touch-pan-x overflow-x-auto p-3" style={{ gap: spec.gap }}>
        {cards.map((o, i) => (
          <div key={o.id} className="flex h-full shrink-0 flex-col" style={{ width }}>
            <div className="mb-1.5 flex items-center justify-between px-1 text-base font-bold text-[var(--k-faint)]">
              <span className="tabular-nums">{i + 1}</span>
              {i === 0 ? <span>הוותיקה ביותר</span> : null}
            </div>
            <div className="min-h-0 flex-1">{card(p, o, { fill: true })}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------- list */

export function ListLayout(p: LayoutProps) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const more = useMore(el, 'y', p.cards);
  return (
    <div className="relative h-full">
      <div ref={setEl} className="h-full touch-pan-y overflow-y-auto overscroll-contain">
        <div className="sticky top-0 z-10 grid grid-cols-[112px_minmax(200px,260px)_minmax(0,1fr)_minmax(160px,230px)_auto] gap-4 border-b border-[var(--k-line)] bg-[var(--k-bg)] px-4 py-2 text-base font-bold text-[var(--k-faint)]">
          <span>זמן</span>
          <span>הזמנה</span>
          <span>פריטים</span>
          <span>מצב</span>
          <span className="w-[280px]">פעולה</span>
        </div>
        {p.cards.map((o) => (
          <ListRow key={o.id} order={o} p={p} />
        ))}
      </div>
      {more ? <MoreHint axis="y" text="עוד הזמנות למטה" /> : null}
    </div>
  );
}

function ListRow({ order: o, p }: { order: KdsOrder; p: LayoutProps }) {
  const { theme, look } = useKdsLook();
  const timer = orderTimer(o, p.settings, p.nowMs, { thresholds: screenThresholds(look), ageColors: look.ageColors });
  const parts = itemsSummary(o, look.fields);
  const buttons = orderButtons(o, p.role).slice(0, 2);
  const group = groupText(o);
  const waiting = p.role !== 'station' && !o.allReady && (o.groupState === 'waiting' || o.groupState === null) ? waitingFor(o) : [];
  const service = serviceText(o.serviceType);
  const who = [look.fields.name ? o.pickupName : null, look.fields.waiter && o.waiterName ? `מלצר: ${o.waiterName}` : null].filter(Boolean);
  const urgent = (o.priority ?? 0) > 0;
  const changes = o.changes.filter((c) => c.requiresAck && !c.acked).length;
  return (
    <div
      style={levelVars(theme, timer.level) as CSSProperties}
      className={[
        'grid grid-cols-[112px_minmax(200px,260px)_minmax(0,1fr)_minmax(160px,230px)_auto] items-center gap-4 border-b border-[var(--k-line)] px-4 py-2.5',
        urgent ? 'border-s-8 border-s-[var(--k-late)]' : '',
        p.fresh.has(o.id) ? 'r2m-kds-fresh' : '',
      ].join(' ')}
    >
      <div className="flex h-[68px] flex-col items-center justify-center rounded-lg border-[length:var(--k-ring-w)] border-[var(--k-lv-ring)] bg-[var(--k-lv-head)] text-[var(--k-lv-time)]">
        <div className={`text-[30px] font-black leading-none tabular-nums ${timer.level === 'late' ? 'r2m-kds-late' : ''}`}>
          {timer.minutes}
          <span className="ms-1 text-sm font-bold">דק׳</span>
        </div>
        <div className="mt-0.5 text-sm font-extrabold">{TIMER_TEXT[timer.level]}</div>
      </div>
      <div className="min-w-0">
        <div className="truncate text-[28px] font-black leading-tight">
          <bdi>{orderTitle(o)}</bdi>
          {urgent ? <span className="ms-2 rounded bg-[var(--k-late)] px-1.5 align-middle text-sm font-black text-white">דחוף</span> : null}
        </div>
        <div className="truncate text-base text-[var(--k-muted)]">{[look.fields.table ? sourceText(o.source) : null, service, ...who].filter(Boolean).join(' · ')}</div>
      </div>
      <div className="line-clamp-2 min-w-0 text-[20px] font-bold leading-snug">
        {changes > 0 ? <span className="me-2 rounded bg-[var(--k-warn)] px-1.5 text-base font-black text-black">{changes === 1 ? 'שינוי לאישור' : `${changes} שינויים`}</span> : null}
        {/* Allergies first: a long row is cut at two lines, an allergy never is. */}
        {[...new Set(parts.map((x) => x.allergyText).filter(Boolean))].map((a) => (
          <span key={a} className="me-2 rounded bg-[#dc2626] px-1.5 text-base font-black text-white">
            {a}
          </span>
        ))}
        {look.fields.notes && o.orderNote ? <span className="me-2 rounded bg-[var(--k-note)] px-1.5 text-base font-black text-[var(--k-on-note)]">הערה: {o.orderNote}</span> : null}
        {parts.map((x, i) => (
          <span key={i} className={x.done ? 'text-[var(--k-faint)] line-through' : undefined}>
            {i > 0 ? <span className="text-[var(--k-faint)]"> · </span> : null}
            {x.text}
          </span>
        ))}
      </div>
      <div className="min-w-0 text-lg font-bold">
        {group ? (
          <span className={`rounded-md px-2 py-0.5 ${o.groupState === 'ready_for_pickup' ? 'bg-[var(--k-pickup)] text-[var(--k-on-pickup)]' : 'bg-[var(--k-chip)]'}`}>{group}</span>
        ) : waiting.length > 0 ? (
          <span className="text-[var(--k-warn)]">ממתין ל: {waiting.join(', ')}</span>
        ) : timer.level === 'done' ? (
          <span className="text-[var(--k-lv-time)]">הכול מוכן</span>
        ) : (
          <span className="text-[var(--k-muted)]">בהכנה</span>
        )}
      </div>
      <div className="flex w-[280px] gap-2">
        {buttons.map((b) => (
          <TouchButton key={b.key + b.label} button={b} onPress={(x) => p.onPress(x, o)} flashing={p.flashKey === `${b.key}|${b.label}`} className={b.primary ? 'flex-[2]' : 'flex-1'} />
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------- big */

export function BigLayout(p: LayoutProps) {
  const ctx = useKdsLook();
  const capacity = bigCapacity(p.width, p.height);
  const { shown, queue } = bigSplit(p.cards, capacity);
  return (
    <div className="flex h-full flex-col gap-3 p-3">
      {/* The big cards: the largest size, whatever the screen's density. */}
      <div className="grid min-h-0 flex-1 gap-3" style={{ gridTemplateColumns: `repeat(${capacity}, minmax(0, 1fr))` }}>
        {shown.map((o) => (
          <div key={o.id} className="min-h-0">
            {card(p, o, { fill: true, tier: 'huge' })}
          </div>
        ))}
      </div>
      {queue.length > 0 ? (
        <div className="flex shrink-0 items-center gap-3 overflow-hidden rounded-xl border border-[var(--k-line)] bg-[var(--k-panel)] px-4 py-3">
          <span className="shrink-0 text-xl font-black">ממתינות: {queue.length}</span>
          <div className="flex min-w-0 gap-2 overflow-hidden">
            {queue.slice(0, 12).map((o) => {
              const t = orderTimer(o, p.settings, p.nowMs, { thresholds: screenThresholds(ctx.look), ageColors: ctx.look.ageColors });
              return (
                <span
                  key={o.id}
                  style={levelVars(ctx.theme, t.level)}
                  className="shrink-0 rounded-lg border-[length:var(--k-ring-w)] border-[var(--k-lv-ring)] bg-[var(--k-lv-head)] px-3 py-1 text-xl font-extrabold"
                >
                  <bdi>{orderTitle(o)}</bdi> <span className="tabular-nums text-[var(--k-lv-time)]">{t.minutes} דק׳</span>
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
