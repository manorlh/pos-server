'use client';

/**
 * "שיוך מלצרים" on the live floor (P:/specs/table-waiter-assignment.md §3): the assignment mode's bar —
 * pick a waiter (each in their colour, with how many tables they cover), then tap tables on the floor or
 * "כל האזור"; copy yesterday's or the previous shift's; "נקה הכל"; done. Needs `tables_manage` at edit
 * (`canManage` from `GET /tables/assignments`; the server checks it again). The tills pull the change with
 * the tables signal.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, Copy, Eraser, Users } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  copyLabel,
  inkOn,
  tapChange,
  type AssignmentChange,
  type AssignmentRow,
  type AssignmentWaiter,
} from '@/lib/tableAssignment';
import {
  copyTableAssignments,
  postTableAssignments,
  tablesErrorCode,
  type TableAssignmentsView,
  type TableZone,
} from '@/lib/tablesApi';
import { Button } from '@/components/ui/button';

/** The mutations of the mode, shared by the bar and the floor's taps. */
export function useAssignmentWrites(shopId: string, onChanged: () => void) {
  const tl = useTranslations('tables.live.assign');
  const qc = useQueryClient();
  const done = () => {
    onChanged();
    void qc.invalidateQueries({ queryKey: ['tables-assignments', shopId] });
  };
  const fail = (err: unknown) => {
    const code = tablesErrorCode(err);
    toast.error(code && tl.has(`errors.${code}`) ? tl(`errors.${code}`) : axiosErrorToToastMessage(err, tl('errors.other')));
  };
  const tap = useMutation({
    mutationFn: (changes: AssignmentChange[]) => postTableAssignments(shopId, changes),
    onSuccess: done,
    onError: fail,
  });
  const clear = useMutation({
    mutationFn: () => postTableAssignments(shopId, [], true),
    onSuccess: () => {
      toast.success(tl('cleared'));
      done();
    },
    onError: fail,
  });
  const copy = useMutation({
    mutationFn: (from: 'yesterday' | 'previous_shift') => copyTableAssignments(shopId, from),
    onSuccess: (out) => {
      toast.success(tl('copied', { count: out.copied ?? 0 }));
      done();
    },
    onError: fail,
  });
  return { tap, clear, copy, busy: tap.isPending || clear.isPending || copy.isPending };
}

export function AssignmentBar({
  view,
  zone,
  rows,
  waiters,
  counts,
  picked,
  onPick,
  writes,
  onDone,
}: {
  view: TableAssignmentsView | undefined;
  zone: TableZone | null;
  rows: AssignmentRow[];
  waiters: AssignmentWaiter[];
  counts: Record<string, number>;
  picked: string | null;
  onPick: (posUserId: string | null) => void;
  writes: ReturnType<typeof useAssignmentWrites>;
  onDone: () => void;
}) {
  const tl = useTranslations('tables.live.assign');
  const byId = new Map(waiters.map((w) => [w.posUserId, w]));
  const zoneRows = zone ? rows.filter((r) => r.zoneId === zone.id) : [];
  const pickedWaiter = picked ? byId.get(picked) ?? null : null;
  const zoneIsPicked = !!picked && zoneRows.some((r) => r.posUserId === picked);
  const yesterday = copyLabel('yesterday', view?.copySources.yesterday);
  const previous = copyLabel('previous_shift', view?.copySources.previous_shift);
  const off = view?.config.mode === 'off';

  return (
    <div className="space-y-2 rounded-lg border-2 border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold">{tl('title')}</span>
        <span className="text-xs text-muted-foreground">{picked ? tl('tapHint') : tl('pickHint')}</span>
        <Button size="sm" className="ms-auto h-8" onClick={onDone}>
          <Check className="me-1 h-4 w-4" />
          {tl('done')}
        </Button>
      </div>
      {off ? <p className="rounded-md bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{tl('modeOff')}</p> : null}

      {/* The waiters: on shift first, each in their colour, with how many tables they cover. */}
      <div className="flex flex-wrap gap-1.5">
        {waiters.map((w) => {
          const on = w.posUserId === picked;
          return (
            <button
              key={w.posUserId}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(on ? null : w.posUserId)}
              className={`flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-sm ${on ? 'ring-2 ring-offset-1' : ''}`}
              style={{ borderColor: w.color, ...(on ? { background: w.color, color: inkOn(w.color) } : {}) }}
            >
              <span
                className="flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[11px] font-bold"
                style={{ background: on ? inkOn(w.color) : w.color, color: on ? w.color : inkOn(w.color) }}
              >
                {w.initials ?? '?'}
              </span>
              <span className="max-w-32 truncate">{w.name ?? '?'}</span>
              {counts[w.posUserId] ? <span className="text-xs tabular-nums opacity-80">· {counts[w.posUserId]}</span> : null}
              {w.onShift ? <span className="text-[10px] text-green-700 dark:text-green-400">●</span> : null}
            </button>
          );
        })}
        {waiters.length === 0 ? <span className="text-sm text-muted-foreground">{tl('noWaiters')}</span> : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {zone ? (
          <Button
            size="sm"
            variant={zoneIsPicked ? 'default' : 'outline'}
            className="h-8"
            disabled={!pickedWaiter || writes.busy}
            onClick={() => picked && writes.tap.mutate([tapChange(rows, picked, { zoneId: zone.id })])}
            style={zoneIsPicked && pickedWaiter ? { background: pickedWaiter.color, color: inkOn(pickedWaiter.color) } : undefined}
          >
            {zoneIsPicked ? tl('zoneRemove', { zone: zone.name }) : tl('zoneAssign', { zone: zone.name })}
          </Button>
        ) : null}
        {zoneRows.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {tl('zoneOf', {
              zone: zone?.name ?? '',
              names: zoneRows.map((r) => byId.get(r.posUserId)?.name ?? '?').join(', '),
            })}
          </span>
        ) : null}
        <span className="ms-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" className="h-8" disabled={!yesterday || writes.busy} onClick={() => writes.copy.mutate('yesterday')}>
            <Copy className="me-1 h-3.5 w-3.5" />
            {yesterday ?? tl('copyYesterdayNone')}
          </Button>
          <Button size="sm" variant="outline" className="h-8" disabled={!previous || writes.busy} onClick={() => writes.copy.mutate('previous_shift')}>
            <Copy className="me-1 h-3.5 w-3.5" />
            {previous ?? tl('copyPreviousNone')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-destructive"
            disabled={rows.length === 0 || writes.busy}
            onClick={() => {
              if (window.confirm(tl('clearConfirm'))) writes.clear.mutate();
            }}
          >
            <Eraser className="me-1 h-3.5 w-3.5" />
            {tl('clear')}
          </Button>
        </span>
      </div>
    </div>
  );
}
