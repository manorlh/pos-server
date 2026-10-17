'use client';

/**
 * Open tables now ("שולחנות פתוחים — חי", P:/specs/live-tables-cloud.md §1): the till's floor. Each zone
 * as the till draws it — the zone's sketch (walls, symbols, areas, greenery: the shared drawing code,
 * sketch-shapes.tsx `SketchShape` over lib/tableSketch.ts; a kind this build does not know is a labelled
 * box), the tables in their shape and place in the till's state colours (lib/liveTables.ts: free,
 * occupied blue, the kitchen orange, to pay amber, at another till violet, overdue red), each with its
 * number, guests, time seated, total and waiter, the next course's countdown ("עיקריות בעוד 6 ד׳") and
 * 🔒 with the till inside it. A grid zone is a numbered grid, as on the till. Zone tabs with how many are
 * open; filters by waiter or state dim the rest. On a phone the map fits the width, pinches to zoom and
 * drags; a tap opens the table's card (./table-card.tsx). Realtime through the shop's Ably channel when
 * the server offers it, else every 5 seconds.
 *
 * "שיוך מלצרים" (P:/specs/table-waiter-assignment.md §3, §4): each assigned table carries its waiter's
 * initials in their colour (a free one their name, faint); "לפי שיוך" dims the rest; with `tables_manage`
 * the assignment mode (./assignment-bar.tsx) — pick a waiter, tap tables or the zone. "שולחן תפוס" (§8):
 * a busy table says the device and the employee inside it ("פתוח כעת: קופה 3 · דנה") with
 * `tableBusyShowHolder` on, and a device that stopped reporting ("המכשיר לא מדווח מאז…").
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Maximize2, Radio, Users, ZoomIn, ZoomOut } from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency, formatTime } from '@/lib/format';
import { ablySseUrl } from '@/lib/eventLive';
import {
  FIT,
  NO_FILTER,
  STATE_COLOR,
  STATE_EMPHASIS,
  VISUAL_STATES,
  compactMoney,
  countdown,
  dimmed,
  filterActive,
  gridColumns,
  gridCells,
  isTap,
  liveRefetchMs,
  minutesSince,
  panBy,
  seatedText,
  tintOf,
  visualState,
  waitersOf,
  zoneCounts,
  zoomAbout,
  type FloorFilter,
  type MapView,
  type VisualState,
} from '@/lib/liveTables';
import { tableDisplay } from '@/lib/tableRestore';
import { fittedFont } from '@/lib/tableLabels';
import {
  assignedCounts,
  assignedWaiters,
  holderLine,
  inkOn,
  isAssignedTo,
  staleLine,
  tapChange,
  type AssignmentWaiter,
} from '@/lib/tableAssignment';
import { CHAIR_LOOK, PLAIN, SKETCH_STYLE, TABLE_LOOK, backgroundOf, chairLayout, type SketchElement } from '@/lib/tableSketch';
import {
  fetchTableAssignments,
  fetchTablesLive,
  fetchTablesLivePush,
  type LiveTable,
  type TableZone,
} from '@/lib/tablesApi';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentBar, useAssignmentWrites } from './assignment-bar';
import { FloorDefs, SketchShape } from './sketch-shapes';
import { TableCardSheet, useNow } from './table-card';

/** A table on the floor, as drawn: its colour word and whether a filter steps it back. */
interface FloorTable {
  table: LiveTable;
  visual: VisualState;
  dim: boolean;
  minutes: number | null;
  /** "שיוך מלצרים": its waiters, the main one first. */
  assigned: AssignmentWaiter[];
  /** The assignment mode: the table is the picked waiter's. */
  picked: boolean;
}

/** The shop's tables signal over Ably (server-sent events, no library): every change refetches. */
function useTablesPush(shopId: string, onTick: () => void): boolean {
  const [connected, setConnected] = useState(false);
  const tick = useRef(onTick);
  const last = useRef(0);
  useEffect(() => {
    tick.current = onTick;
  }, [onTick]);
  useEffect(() => {
    let source: EventSource | null = null;
    let retry: number | undefined;
    let stopped = false;
    const connect = async () => {
      try {
        const info = await fetchTablesLivePush(shopId);
        if (stopped || !info.enabled || !info.token || typeof EventSource === 'undefined') return;
        source = new EventSource(ablySseUrl(info.channel, info.token));
        source.onopen = () => setConnected(true);
        source.onmessage = () => {
          // A busy floor signals all the time: at most one refetch a second.
          const now = Date.now();
          if (now - last.current >= 1_000) {
            last.current = now;
            tick.current();
          }
        };
        source.onerror = () => {
          setConnected(false);
          source?.close();
          source = null;
          // A new token (an hour each) and a new connection in a minute; polling covers the gap.
          if (!stopped) retry = window.setTimeout(connect, 60_000);
        };
      } catch {
        // No push: the floor polls.
      }
    };
    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(retry);
      source?.close();
      setConnected(false);
    };
  }, [shopId]);
  return connected;
}

export function TablesLive({ shopId }: { shopId: string }) {
  const t = useTranslations('tables');
  const tl = useTranslations('tables.live');
  const qc = useQueryClient();
  const now = useNow();
  const refetch = useCallback(() => qc.invalidateQueries({ queryKey: ['tables-live', shopId] }), [qc, shopId]);
  const pushed = useTablesPush(shopId, refetch);
  const { data, isLoading } = useQuery({
    queryKey: ['tables-live', shopId],
    queryFn: () => fetchTablesLive(shopId),
    refetchInterval: (q) =>
      liveRefetchMs(pushed, (q.state.data?.tables ?? []).some((tb) => tb.order?.source === 'local')),
  });
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FloorFilter>(NO_FILTER);
  const [picked, setPicked] = useState<string | null>(null);
  // "שיוך מלצרים": the mode's data (who may change it, the copy sources), the mode, the waiter picked in
  // it, and the "לפי שיוך" filter.
  const assignView = useQuery({ queryKey: ['tables-assignments', shopId], queryFn: () => fetchTableAssignments(shopId) });
  const canAssign = assignView.data?.canManage === true;
  const [assigning, setAssigning] = useState(false);
  const [assignFor, setAssignFor] = useState<string | null>(null);
  const [assignee, setAssignee] = useState<string | null>(null);
  const writes = useAssignmentWrites(shopId, refetch);

  const zones = useMemo(() => data?.zones ?? [], [data]);
  const tables = useMemo(() => data?.tables ?? [], [data]);
  const assignWaiters = useMemo(() => data?.assignment?.waiters ?? assignView.data?.waiters ?? [], [data, assignView.data]);
  const assignRows = useMemo(() => data?.assignment?.rows ?? [], [data]);
  const assignCounts = useMemo(() => assignedCounts(tables.map((tb) => tb.assignment)), [tables]);
  const alertMinutes = data?.thresholds?.alertMinutes ?? 90;
  const counts = useMemo(() => zoneCounts(tables), [tables]);
  // The first zone with open tables, else the first — until the manager picks one.
  const zone = useMemo(() => {
    const chosen = zones.find((z) => z.id === zoneId);
    if (chosen) return chosen;
    return zones.find((z) => (counts[z.id] ?? 0) > 0) ?? zones[0] ?? null;
  }, [zones, zoneId, counts]);
  const floor = useMemo<FloorTable[]>(
    () =>
      tables
        .filter((tb) => zone && tb.zoneId === zone.id)
        .map((tb) => {
          const visual = visualState(tb, now, alertMinutes);
          return {
            table: tb,
            visual,
            dim: dimmed(tb, visual, filter) || !isAssignedTo(tb.assignment, assignee),
            minutes: minutesSince(tb.order?.openedAt, now),
            assigned: assignedWaiters(tb.assignment, assignWaiters),
            picked: assigning && !!assignFor && isAssignedTo(tb.assignment, assignFor),
          };
        }),
    [tables, zone, now, alertMinutes, filter, assignee, assignWaiters, assigning, assignFor],
  );
  const waiters = useMemo(() => waitersOf(tables), [tables]);

  if (isLoading) return <Skeleton className="h-64 w-full" />;
  const summary = data?.summary;
  const voidTickets = data?.voidTickets ?? [];
  const toggleState = (s: VisualState) =>
    setFilter((f) => ({ ...f, states: f.states.includes(s) ? f.states.filter((x) => x !== s) : [...f.states, s] }));
  // A tap on the floor: the card — or, in the assignment mode, the picked waiter on (or off) the table.
  const onTable = (id: string) => {
    if (!assigning) {
      setPicked(id);
      return;
    }
    if (!assignFor) {
      toast.message(tl('assign.pickFirst'));
      return;
    }
    if (!writes.busy) writes.tap.mutate([tapChange(assignRows, assignFor, { tableId: id })]);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2 sm:gap-3">
        <Stat label={t('liveOpen')} value={String(summary?.openTables ?? 0)} />
        <Stat label={t('liveTotal')} value={formatCurrency(summary?.openTotal ?? 0)} />
        <Stat label={t('liveGuests')} value={String(summary?.guests ?? 0)} />
      </div>

      {voidTickets.length > 0 ? (
        // "בון ביטול ממתין למדפסת": a void of a table cancelled here, not on paper yet.
        <div className="space-y-1 rounded-lg border border-amber-500 bg-amber-50 p-3 text-sm dark:bg-amber-950/40">
          {voidTickets.map((v) => (
            <div key={v.id} className={v.state === 'failed' ? 'font-medium text-destructive' : undefined}>
              {t(v.state === 'failed' ? 'voidTicket.failed' : 'voidTicket.waiting', {
                table: v.tableName ?? '?',
                printer: v.printerName ?? '?',
              })}
            </div>
          ))}
        </div>
      ) : null}

      {/* The zones, as the till's tabs: each with how many of its tables are open. */}
      <div className="flex flex-wrap items-center gap-2">
        {zones.map((z) => (
          <Button key={z.id} size="sm" variant={zone?.id === z.id ? 'default' : 'outline'} onClick={() => setZoneId(z.id)}>
            {z.name}
            <span className="ms-1 rounded-full bg-background/20 px-1.5 text-xs tabular-nums">{counts[z.id] ?? 0}</span>
          </Button>
        ))}
        {canAssign && !assigning ? (
          <Button size="sm" variant="outline" className="ms-auto" onClick={() => setAssigning(true)}>
            <Users className="me-1 h-4 w-4" />
            {tl('assign.open')}
          </Button>
        ) : null}
        <span
          className={`${canAssign && !assigning ? '' : 'ms-auto '}flex items-center gap-1 text-xs text-muted-foreground`}
          title={pushed ? tl('realtime') : tl('polling')}
        >
          <Radio className={`h-3.5 w-3.5 ${pushed ? 'text-green-600' : ''}`} />
          {pushed ? tl('realtime') : tl('polling')}
        </span>
      </div>

      {assigning ? (
        <AssignmentBar
          view={assignView.data}
          zone={zone}
          rows={assignRows}
          waiters={assignWaiters}
          counts={assignCounts}
          picked={assignFor}
          onPick={setAssignFor}
          writes={writes}
          onDone={() => {
            setAssigning(false);
            setAssignFor(null);
          }}
        />
      ) : null}

      {/* "הצג": by waiter or state — the rest are dimmed, never hidden. */}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <select
          className="h-8 rounded-md border bg-background px-2 text-sm"
          value={filter.waiter ?? ''}
          aria-label={tl('waiterFilter')}
          onChange={(e) => setFilter((f) => ({ ...f, waiter: e.target.value || null }))}
        >
          <option value="">{tl('anyWaiter')}</option>
          {waiters.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
        {assignWaiters.length > 0 && assignRows.length > 0 ? (
          // "לפי שיוך": the tables assigned to one waiter (their zones' too).
          <select
            className="h-8 rounded-md border bg-background px-2 text-sm"
            value={assignee ?? ''}
            aria-label={tl('assign.filter')}
            onChange={(e) => setAssignee(e.target.value || null)}
          >
            <option value="">{tl('assign.anyAssignee')}</option>
            {assignWaiters
              .filter((w) => assignCounts[w.posUserId])
              .map((w) => (
                <option key={w.posUserId} value={w.posUserId}>
                  {tl('assign.assigneeOption', { name: w.name ?? '?', count: assignCounts[w.posUserId] ?? 0 })}
                </option>
              ))}
          </select>
        ) : null}
        {VISUAL_STATES.map((s) => {
          const on = filter.states.includes(s);
          return (
            <button
              key={s}
              type="button"
              onClick={() => toggleState(s)}
              aria-pressed={on}
              className={`flex h-8 items-center gap-1 rounded-full border px-2.5 ${on ? 'border-foreground bg-muted font-medium' : 'border-border'}`}
            >
              <span className="inline-block h-3 w-3 rounded-full border" style={{ background: tintOf(STATE_COLOR[s], 0.35), borderColor: STATE_COLOR[s] }} />
              {tl(`state.${s}`)}
            </button>
          );
        })}
        {filterActive(filter) || assignee ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8"
            onClick={() => {
              setFilter(NO_FILTER);
              setAssignee(null);
            }}
          >
            {tl('clearFilters')}
          </Button>
        ) : null}
      </div>

      {!zone ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">{t('noZones')}</div>
      ) : floor.length === 0 ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">{tl('emptyZone')}</div>
      ) : zone.layout === 'map' ? (
        <LiveMap key={zone.id} zone={zone} floor={floor} now={now} onPick={onTable} />
      ) : (
        <LiveGrid floor={floor} now={now} onPick={onTable} />
      )}

      {picked ? (
        <TableCardSheet
          shopId={shopId}
          tableId={picked}
          live={data ?? null}
          onClose={() => setPicked(null)}
          onChanged={refetch}
        />
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card p-2 sm:p-3">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums sm:text-2xl">{value}</div>
    </div>
  );
}

/** "עיקריות בעוד 6 ד׳" — the next course's tag, or null. */
function useCourseTag() {
  const tl = useTranslations('tables.live');
  return (tb: LiveTable, now: number): string | null => {
    const next = tb.nextCourse;
    const c = countdown(next, now);
    if (!c || !next) return null;
    switch (c.kind) {
      case 'in':
        return tl('nextIn', { course: next.name, minutes: c.minutes });
      case 'now':
        return tl('nextNow', { course: next.name });
      case 'paused':
        return tl('nextPaused', { course: next.name });
      default:
        return tl('nextWaiting', { course: next.name });
    }
  };
}

// ── A map zone ────────────────────────────────────────────────────────────────

function LiveMap({ zone, floor, now, onPick }: { zone: TableZone; floor: FloorTable[]; now: number; onPick: (id: string) => void }) {
  const tl = useTranslations('tables.live');
  const courseTag = useCourseTag();
  const cw = zone.canvasWidth || 1000;
  const ch = zone.canvasHeight || 700;
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // The observer reports the box's size as soon as it starts watching it, then on every change.
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const height = (width * ch) / cw;
  // Canvas units per screen pixel at the fitted size: what keeps the words readable at any width.
  const perPx = cw / Math.max(1, width);
  // Fitted again for every zone: the parent keys the map by its zone.
  const [view, setView] = useState<MapView>(FIT);

  // Pinch and drag: the pointers down now, and whether this press moved (then it is no tap).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const moved = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const local = (e: React.PointerEvent | React.WheelEvent) => {
    const r = boxRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const onDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, local(e));
    if (pointers.current.size === 1) {
      moved.current = false;
      start.current = local(e);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const p = local(e);
    if (pointers.current.size >= 2) {
      const others = [...pointers.current.entries()].filter(([id]) => id !== e.pointerId).map(([, v]) => v);
      const o = others[0];
      const before = Math.hypot(prev.x - o.x, prev.y - o.y);
      const after = Math.hypot(p.x - o.x, p.y - o.y);
      if (before > 0) setView((v) => zoomAbout(v, after / before, (p.x + o.x) / 2, (p.y + o.y) / 2, width, height));
      moved.current = true;
    } else if (start.current && !isTap(p.x - start.current.x, p.y - start.current.y)) {
      moved.current = true;
      setView((v) => panBy(v, p.x - prev.x, p.y - prev.y, width, height));
    }
    pointers.current.set(e.pointerId, p);
  };
  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const p = local(e);
    setView((v) => zoomAbout(v, e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y, width, height));
  };
  const zoomBy = (factor: number) => setView((v) => zoomAbout(v, factor, width / 2, height / 2, width, height));

  const background = backgroundOf(zone.sketch ?? null, !!zone.backgroundUrl);
  const elements = (zone.sketch?.elements ?? []) as SketchElement[];

  return (
    <div className="space-y-1">
      <div className="flex justify-end gap-1">
        <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => zoomBy(1.4)} title={tl('zoomIn')}>
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => zoomBy(1 / 1.4)} title={tl('zoomOut')}>
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button size="sm" variant="outline" className="h-8 w-8 p-0" onClick={() => setView(FIT)} title={tl('fit')}>
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
      <div
        ref={boxRef}
        dir="ltr"
        className="relative w-full overflow-hidden rounded-xl border shadow-sm select-none"
        style={{ height, touchAction: view.scale > 1 ? 'none' : 'pan-y' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={onUp}
        onWheel={onWheel}
      >
        <div style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: '0 0', width, height }}>
          <svg viewBox={`0 0 ${cw} ${ch}`} width={width} height={height} className="block">
            <FloorDefs />
            {background === 'image' && zone.backgroundUrl ? (
              <image href={zone.backgroundUrl} x={0} y={0} width={cw} height={ch} preserveAspectRatio="none" />
            ) : (
              <rect
                x={0}
                y={0}
                width={cw}
                height={ch}
                fill={
                  background === 'tiles'
                    ? 'url(#floor-tiles)'
                    : background === 'light'
                      ? PLAIN.light
                      : background === 'dark'
                        ? PLAIN.dark
                        : background === 'wood'
                          ? 'url(#floor-wood)'
                          : 'url(#floor-clean)'
                }
              />
            )}
            <g pointerEvents="none">
              {elements.map((el) =>
                el.kind in SKETCH_STYLE ? (
                  <SketchShape key={el.id} el={el} perPx={perPx} />
                ) : (
                  <UnknownShape key={el.id} el={el} perPx={perPx} />
                ),
              )}
            </g>
            {/* The tables, then their tags over every table (a tag never hides under the next row's chairs). */}
            {(['body', 'labels'] as const).map((layer) =>
              floor.map((f) => (
                <MapTable
                  key={`${layer}-${f.table.id}`}
                  layer={layer}
                  f={f}
                  perPx={perPx}
                  tag={courseTag(f.table, now)}
                  onPick={() => {
                    if (!moved.current) onPick(f.table.id);
                  }}
                />
              )),
            )}
          </svg>
        </div>
      </div>
    </div>
  );
}

/**
 * A sketch shape of a kind this build does not draw yet (a newer decor — feat/table-map-decor-v3): a
 * labelled box in its place, never a crash or a hole in the plan.
 */
function UnknownShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const word = (el.text ?? String(el.kind ?? '')).replace(/_/g, ' ');
  const fs = Math.max(9 * perPx, Math.min(el.h * 0.4, (el.w * 1.4) / Math.max(3, word.length)));
  return (
    <g transform={`rotate(${el.rotation || 0} ${cx} ${cy})`}>
      <rect
        x={el.x} y={el.y} width={el.w} height={el.h} rx={4 * perPx}
        fill="#f1f5f9" stroke="#64748b" strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`}
      />
      {word ? (
        <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={fs} fill="#334155">
          {word}
        </text>
      ) : null}
    </g>
  );
}

/**
 * A table on the map: its shape and chairs in its state's colour; inside it the number, the guests and
 * the time seated, and the total; under it the waiter (or 🔒 the till inside it), over it the next course.
 */
function MapTable({ layer, f, perPx, tag, onPick }: {
  layer: 'body' | 'labels';
  f: FloorTable;
  perPx: number;
  tag: string | null;
  onPick: () => void;
}) {
  const tl = useTranslations('tables.live');
  const tb = f.table;
  const color = STATE_COLOR[f.visual];
  const emphasis = STATE_EMPHASIS[f.visual];
  const cx = tb.x + tb.width / 2;
  const cy = tb.y + tb.height / 2;
  const short = Math.min(tb.width, tb.height);
  const fs = Math.max(11 * perPx, short * 0.28);
  const small = Math.max(9 * perPx, Math.min(fs * 0.42, 12 * perPx));
  const label = tableDisplay(tb);
  const o = tb.order;
  const inner = o ? [o.guests ? `${o.guests}👤` : null, seatedText(f.minutes)].filter(Boolean).join(' · ') : null;
  // Three lines when the table is tall enough, else the number and the guests / time.
  const roomy = tb.height >= fs * 2.9;
  // §8: "ק3 · ד.כ" — the device and the employee inside, when the shop shows them; else the till as before.
  const held = tb.holder?.short ? `🔒 ${tb.holder.short}` : tb.heldBy ? `🔒 ${tl('heldTill', { till: tb.heldBy })}` : null;
  // §4: a free table assigned to a waiter shows their name, faint, in their colour.
  const main = f.assigned[0] ?? null;
  const assignedName = !o && !held && main ? f.assigned.map((w) => w.name ?? '?').join(', ') : null;
  const below = held ?? o?.waiterName ?? assignedName;
  const fill = emphasis.tint > 0 ? tintOf(color, emphasis.tint) : TABLE_LOOK.fill;
  const pill = (y: number, text: string, bg: string, ink: string) => {
    const w = Math.max(text.length * small * 0.62 + 12 * perPx, 26 * perPx);
    const h = small * 1.6;
    return (
      <g>
        <rect x={cx - w / 2} y={y} width={w} height={h} rx={h / 2} fill={bg} stroke="#ffffff" strokeWidth={perPx} />
        <text x={cx} y={y + h / 2} textAnchor="middle" dominantBaseline="central" fontSize={small} fill={ink} fontWeight={600} direction="rtl">
          {text}
        </text>
      </g>
    );
  };
  const reach = short * 0.27;
  const numberY = o ? (roomy ? cy - fs * 0.42 : cy - fs * 0.22) : cy;
  if (layer === 'labels') {
    if (!tag && !below && !main) return null;
    const r = small * 1.05;
    const badge = main ? (main.initials ?? '?') + (f.assigned.length > 1 ? `+${f.assigned.length - 1}` : '') : '';
    const badgeW = Math.max(r * 2, badge.length * small * 0.55 + small * 0.6);
    const belowY = tb.y + tb.height + reach + small * 0.15;
    return (
      <g opacity={f.dim ? 0.25 : 1} style={{ cursor: 'pointer' }} onClick={onPick}>
        {tag ? pill(tb.y - reach - small * 1.75, tag, '#fff7ed', '#c2410c') : null}
        {below
          ? assignedName && main
            ? pill(belowY, below, tintOf(main.color, 0.18), main.color)
            : pill(belowY, below, held ? '#7c3aed' : color, '#ffffff')
          : null}
        {main ? (
          // The waiter's initials in their colour, at the table's corner (+N for helpers).
          <g>
            <rect
              x={tb.x + tb.width - badgeW / 2} y={tb.y - r} width={badgeW} height={r * 2} rx={r}
              fill={main.color} stroke="#ffffff" strokeWidth={perPx * 1.5}
            />
            <text
              x={tb.x + tb.width} y={tb.y} textAnchor="middle" dominantBaseline="central"
              fontSize={small * 0.82} fontWeight={700} fill={inkOn(main.color)} direction="rtl"
            >
              {badge}
            </text>
          </g>
        ) : null}
      </g>
    );
  }
  return (
    <g
      opacity={f.dim ? 0.25 : 1}
      style={{ cursor: 'pointer' }}
      onClick={onPick}
      role="button"
      aria-label={`${label.text} · ${tl(`state.${f.visual}`)}`}
    >
      <g transform={`rotate(${tb.rotation || 0} ${cx} ${cy})`}>
        {f.picked && main ? (
          // The assignment mode: the picked waiter's tables, ringed in their colour.
          tb.shape === 'round' ? (
            <ellipse
              cx={cx} cy={cy} rx={tb.width / 2 + 6 * perPx} ry={tb.height / 2 + 6 * perPx} fill="none"
              stroke={main.color} strokeWidth={4 * perPx} strokeDasharray={`${8 * perPx} ${4 * perPx}`}
            />
          ) : (
            <rect
              x={tb.x - 6 * perPx} y={tb.y - 6 * perPx} width={tb.width + 12 * perPx} height={tb.height + 12 * perPx}
              rx={short * 0.22} fill="none" stroke={main.color} strokeWidth={4 * perPx} strokeDasharray={`${8 * perPx} ${4 * perPx}`}
            />
          )
        ) : null}
        {chairLayout(tb.shape === 'round', tb.width, tb.height, tb.seats).map((c, i) => (
          <g key={`c${i}`} transform={`translate(${tb.x + c.cx} ${tb.y + c.cy}) rotate(${c.angle})`}>
            <rect
              x={-c.width / 2} y={-c.depth / 2} width={c.width} height={c.depth} rx={c.depth * 0.28}
              fill={emphasis.tint > 0 ? tintOf(color, 0.25) : CHAIR_LOOK.wood}
              stroke={CHAIR_LOOK.edge} strokeWidth={Math.max(perPx, c.depth * 0.06)}
            />
          </g>
        ))}
        {tb.shape === 'round' ? (
          <ellipse
            cx={cx} cy={cy} rx={tb.width / 2} ry={tb.height / 2} fill={fill}
            stroke={f.visual === 'free' ? TABLE_LOOK.border : color} strokeWidth={emphasis.edge * 1.5 * perPx}
            filter="url(#table-shadow)"
          />
        ) : (
          <rect
            x={tb.x} y={tb.y} width={tb.width} height={tb.height} rx={short * 0.18} fill={fill}
            stroke={f.visual === 'free' ? TABLE_LOOK.border : color} strokeWidth={emphasis.edge * 1.5 * perPx}
            filter="url(#table-shadow)"
          />
        )}
      </g>
      <text
        x={cx} y={numberY} textAnchor="middle" dominantBaseline="central"
        fontSize={fittedFont(label.main, tb.labelOnly ? fs * 0.7 : fs, tb.width)} fontWeight={700} fill={TABLE_LOOK.number} direction="rtl"
      >
        {label.main}
      </text>
      {inner ? (
        <text x={cx} y={roomy ? cy + fs * 0.22 : cy + fs * 0.55} textAnchor="middle" dominantBaseline="central" fontSize={small} fill="#475569" direction="rtl">
          {inner}
        </text>
      ) : null}
      {o && roomy ? (
        <text x={cx} y={cy + fs * 0.22 + small * 1.25} textAnchor="middle" dominantBaseline="central" fontSize={small} fontWeight={700} fill="#1e293b" direction="rtl">
          {compactMoney(o.total)}
        </text>
      ) : null}
    </g>
  );
}

// ── A grid zone ───────────────────────────────────────────────────────────────

function LiveGrid({ floor, now, onPick }: { floor: FloorTable[]; now: number; onPick: (id: string) => void }) {
  const tl = useTranslations('tables.live');
  const courseTag = useCourseTag();
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    // The observer reports the box's size as soon as it starts watching it, then on every change.
    const ro = new ResizeObserver(() => setWidth(el.clientWidth || 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const columns = gridColumns(width);
  // In the natural order of labels and numbers (3, 3A, 3B, 10 — P:/specs/table-scope.md §6.2).
  const cells = gridCells(floor.map((f) => ({ ...f, number: f.table.number, label: f.table.label ?? null })), columns);
  return (
    <div ref={boxRef} className="grid gap-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
      {cells.map(({ table: f }) => {
        const tb = f.table;
        const color = STATE_COLOR[f.visual];
        const emphasis = STATE_EMPHASIS[f.visual];
        const tag = courseTag(tb, now);
        const label = tableDisplay(tb);
        const main = f.assigned[0] ?? null;
        const holder = holderLine(tb.holder);
        const stale = staleLine(tb.staleLock, (iso) => formatTime(iso));
        return (
          <button
            key={tb.id}
            type="button"
            onClick={() => onPick(tb.id)}
            className="relative flex min-h-28 flex-col items-center justify-center overflow-hidden rounded-xl p-2 text-center shadow-sm transition-opacity"
            style={{
              opacity: f.dim ? 0.25 : 1,
              background: tintOf(color, emphasis.tint),
              border: `${emphasis.edge}px solid ${f.visual === 'free' ? '#cbd5e1' : color}`,
              ...(f.picked && main ? { outline: `3px dashed ${main.color}`, outlineOffset: '2px' } : {}),
            }}
            aria-label={`${label.text} · ${tl(`state.${f.visual}`)}`}
          >
            {main ? (
              <span
                className="absolute start-1 top-1 rounded-full px-1.5 text-[10px] font-bold leading-4"
                style={{ background: main.color, color: inkOn(main.color) }}
                title={f.assigned.map((w) => w.name ?? '?').join(', ')}
              >
                {(main.initials ?? '?') + (f.assigned.length > 1 ? `+${f.assigned.length - 1}` : '')}
              </span>
            ) : null}
            <span
              className={`max-w-full truncate font-bold tabular-nums leading-tight text-slate-800 ${Array.from(label.main).length > 4 ? 'text-lg' : 'text-2xl'}`}
            >
              {label.main}
            </span>
            {label.sub ? <span className="max-w-full truncate text-xs text-slate-500">{label.sub}</span> : null}
            {tb.order ? (
              <>
                <span className="text-xs text-slate-600">
                  {[tb.order.guests ? `${tb.order.guests}👤` : null, seatedText(f.minutes)].filter(Boolean).join(' · ')}
                </span>
                <span className="text-sm font-semibold tabular-nums text-slate-800">{formatCurrency(tb.order.total)}</span>
                {tb.order.waiterName ? <span className="max-w-full truncate text-xs text-slate-600">{tb.order.waiterName}</span> : null}
              </>
            ) : !tb.order && tb.cleaningSince ? (
              <span className="text-xs font-medium text-slate-500">{tl('state.cleaning')}</span>
            ) : !tb.order && main ? (
              // §4: free and assigned — the waiter's name, faint, in their colour.
              <span className="max-w-full truncate text-xs font-medium opacity-70" style={{ color: main.color }}>
                {f.assigned.map((w) => w.name ?? '?').join(', ')}
              </span>
            ) : null}
            {tag ? <span className="mt-1 rounded-full bg-orange-50 px-2 text-[11px] font-medium text-orange-700">{tag}</span> : null}
            {holder || tb.heldBy ? (
              <span className="mt-1 flex max-w-full items-center gap-1 rounded-full bg-violet-600 px-2 text-[11px] font-medium text-white">
                <Lock className="h-3 w-3 shrink-0" />
                <span className="truncate">{holder ?? tl('heldTill', { till: tb.heldBy ?? '?' })}</span>
              </span>
            ) : stale ? (
              <span className="mt-1 max-w-full truncate text-[11px] text-slate-500">{stale}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
