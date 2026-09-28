'use client';

/**
 * One shop in the Z wizard: its tills, and per till what the Z would take.
 *
 * The rules shown here are the server's (docs/SHIFTS_API.md §2.3–§2.4), not choices the
 * UI makes:
 *
 * * **Oldest first, no gaps.** A Z takes a till's closed shifts from the oldest up to a
 *   chosen one. The operator picks only the end point; everything older comes too.
 * * **The open shift.** Included by default: the cloud asks the till to close it
 *   (unattended, uncounted) and the Z waits until that close has arrived with every
 *   document. Including it means taking *all* the till's closed shifts too, so the
 *   end-point picker is off while it is on.
 * * **zScope = machine.** The tenant's accountant reads the regulation as one Z per
 *   register, so every selected till becomes its own Z.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle, Info } from 'lucide-react';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import type { PosMachine, Shift, ZCandidateMachine, ZCandidates } from '@/lib/types';
import { MachineStatusDot } from '@/components/dashboard/machine-status';
import { CountedCash, ShiftBadges, useShiftLabel, useTillHeading } from '@/components/dashboard/shifts/shift-parts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';

/** What the operator chose for one till. */
export interface TillSelection {
  include: boolean;
  /**
   * Null only while untouched = every closed shift. Once the operator picks one — even
   * the last — its id is kept, so a shift closing meanwhile is not taken silently.
   */
  throughShiftId: string | null;
  includeOpenShift: boolean;
}

/**
 * Whether the till has a shift open — on the cloud, or by its own heartbeat.
 *
 * A heartbeat is older than the close it preceded: a till that reported shift S open
 * and then closed it still carries S in its last heartbeat. When S is already among the
 * closed shifts, that claim is stale and there is nothing open to close.
 */
export function hasOpenShift(m: ZCandidateMachine): boolean {
  if (m.openShift) return true;
  const reported = m.tillReportedOpenShiftId;
  return !!reported && !m.closedShifts.some((s) => s.id === reported);
}

/** Anything this till could contribute to a Z. */
export function hasSomethingToReport(m: ZCandidateMachine): boolean {
  return m.closedShifts.length > 0 || hasOpenShift(m);
}

export function defaultSelection(m: ZCandidateMachine, onlyMachineId: string | null): TillSelection {
  const eligible = !m.activeRun && hasSomethingToReport(m);
  return {
    include: eligible && (onlyMachineId === null || onlyMachineId === m.machineId),
    throughShiftId: null,
    includeOpenShift: hasOpenShift(m),
  };
}

/** The closed shifts a selection takes, oldest first. */
export function includedClosedShifts(m: ZCandidateMachine, sel: TillSelection): Shift[] {
  if (!sel.include) return [];
  if (sel.includeOpenShift && hasOpenShift(m)) return m.closedShifts;
  if (!sel.throughShiftId) return m.closedShifts;
  const idx = m.closedShifts.findIndex((s) => s.id === sel.throughShiftId);
  return idx < 0 ? m.closedShifts : m.closedShifts.slice(0, idx + 1);
}

/**
 * Business dates, late documents and warnings over everything a shop's selection takes.
 *
 * `dates` is what the mixed-dates warning lists: every date across the shop, or — when
 * each till gets its own Z (zScope = machine) — only the dates of tills whose own Z
 * would span more than one day. Two tills on two different days are two Zs then, and
 * nothing to warn about.
 */
export function selectionSummary(c: ZCandidates, sels: Record<string, TillSelection>) {
  const perTill = c.zScope === 'machine';
  const dates = new Set<string>();
  const mixedTillDates = new Set<string>();
  let late = 0;
  let shifts = 0;
  let tills = 0;
  let waitsForClose = 0;
  for (const m of c.machines) {
    const sel = sels[m.machineId];
    if (!sel?.include) continue;
    const closed = includedClosedShifts(m, sel);
    const withOpen = sel.includeOpenShift && hasOpenShift(m);
    if (closed.length === 0 && !withOpen) continue;
    tills += 1;
    shifts += closed.length + (withOpen ? 1 : 0);
    const tillDates = new Set<string>();
    for (const s of closed) {
      tillDates.add(s.businessDate);
      late += s.lateDocuments ?? 0;
    }
    if (withOpen) {
      waitsForClose += 1;
      if (m.openShift) {
        tillDates.add(m.openShift.businessDate);
        late += m.openShift.lateDocuments ?? 0;
      }
    }
    for (const d of tillDates) dates.add(d);
    if (tillDates.size > 1) for (const d of tillDates) mixedTillDates.add(d);
  }
  const warnDates = perTill ? mixedTillDates : dates;
  return { dates: warnDates.size > 1 ? [...warnDates].sort() : [], late, shifts, tills, waitsForClose };
}

/** "14:05", or the full date and time when it is not the day `sameDayAs` fell on. */
function formatTime(iso: string, sameDayAs?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const ref = new Date(sameDayAs ?? iso);
  if (d.toDateString() !== ref.toDateString()) return formatDateTime(iso);
  return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
}

function ShiftLine({ shift, included }: { shift: Shift; included: boolean }) {
  const t = useTranslations('zWizard');
  const shiftLabel = useShiftLabel();
  const x = shift.serverTotals;
  return (
    <li
      className={`space-y-0.5 rounded px-2 py-1 text-xs ${included ? 'bg-primary/5' : 'opacity-50'}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="font-medium whitespace-nowrap">{shiftLabel(shift)}</span>
        <span className="text-muted-foreground">
          {formatDate(shift.businessDate)} ·{' '}
          {/* Times run left to right even inside the RTL line, or "06:00–14:00" reads backwards. */}
          <span dir="ltr">
            {formatTime(shift.openedAt)}–{shift.closedAt ? formatTime(shift.closedAt, shift.openedAt) : '…'}
          </span>
        </span>
        <span className="ms-auto tabular-nums font-medium">{formatCurrency(x?.totalSales)}</span>
      </div>
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-0.5">
        <span>{t('cashLine', { cash: formatCurrency(x?.totalCash), card: formatCurrency(x?.totalCard) })}</span>
        <span>
          {t('countedLabel')} <CountedCash value={shift.countedCash} />
        </span>
        <span>{t('docsLine', { count: x?.transactionsCount ?? 0 })}</span>
        <ShiftBadges shift={shift} showStatus={false} showZ={false} />
      </div>
    </li>
  );
}

function TillRow({
  m,
  sel,
  onChange,
}: {
  m: ZCandidateMachine;
  sel: TillSelection;
  onChange: (next: TillSelection) => void;
}) {
  const t = useTranslations('zWizard');
  const tStatus = useTranslations('machineStatus');
  const shiftLabel = useShiftLabel();
  const heading = useTillHeading()(m);
  const open = hasOpenShift(m);
  const withOpen = sel.includeOpenShift && open;
  const blocked = !!m.activeRun;
  const nothing = !hasSomethingToReport(m);
  const lastId = m.closedShifts.length > 0 ? m.closedShifts[m.closedShifts.length - 1].id : null;
  const throughId = sel.throughShiftId ?? lastId;
  const throughIdx = m.closedShifts.findIndex((s) => s.id === throughId);
  const status = (m.status ?? 'not_paired') as NonNullable<PosMachine['status']>;
  const pickerItems = m.closedShifts.map((s) => ({
    value: s.id,
    label: `${shiftLabel(s)} · ${formatDate(s.businessDate)}`,
  }));

  return (
    <div className={`space-y-2 rounded-md border p-3 ${sel.include ? '' : 'bg-muted/30'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={sel.include}
            disabled={blocked || nothing}
            onChange={(e) => onChange({ ...sel, include: e.target.checked })}
          />
          {heading.title}
          {heading.name ? <span className="text-muted-foreground font-normal">{heading.name}</span> : null}
        </label>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <MachineStatusDot m={{ status } as PosMachine} />
          {tStatus(`status.${status}`)}
          {(m.pendingDocuments ?? 0) > 0 ? (
            <span className="text-muted-foreground">
              · {tStatus('pendingDocuments', { count: m.pendingDocuments ?? 0 })}
              {m.pendingAsOf ? ` (${tStatus('pendingAsOf', { when: formatDateTime(m.pendingAsOf) })})` : ''}
            </span>
          ) : null}
        </span>
      </div>

      {(m.orphanDocuments ?? 0) > 0 ? (
        <p className="flex gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('tillOrphans', { count: m.orphanDocuments ?? 0 })}
        </p>
      ) : null}
      {blocked ? (
        <p className="text-xs text-amber-700 dark:text-amber-500">{t('tillInRun')}</p>
      ) : nothing ? (
        <p className="text-muted-foreground text-xs">{t('tillNothing')}</p>
      ) : null}

      {open ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-muted/40 px-2 py-1.5 text-xs">
          <span>
            {m.openShift
              ? t('openShift', {
                  shift: shiftLabel(m.openShift),
                  since: formatDateTime(m.openShift.openedAt),
                  by: m.openShift.openedByName ?? '—',
                })
              : t('openShiftTillOnly')}
          </span>
          <label className="flex items-center gap-2">
            <Switch
              size="sm"
              checked={sel.includeOpenShift}
              disabled={!sel.include || blocked}
              onCheckedChange={(checked) =>
                onChange({ ...sel, includeOpenShift: checked, throughShiftId: checked ? null : sel.throughShiftId })
              }
            />
            {t('includeOpen')}
          </label>
        </div>
      ) : null}
      {withOpen && sel.include ? (
        <p className="text-muted-foreground text-xs">
          {m.online ? t('includeOpenHint') : t('includeOpenOffline')}
        </p>
      ) : null}

      {m.closedShifts.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">{t('through')}</span>
            <Select
              value={throughId ?? ''}
              // The picked id is sent as is, the last shift included: "through the last"
              // means that shift, not whatever is last when the run is created.
              onValueChange={(v) => onChange({ ...sel, throughShiftId: v || null })}
              items={pickerItems}
              disabled={!sel.include || withOpen || blocked}
            >
              <SelectTrigger size="sm" className="min-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pickerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value} label={item.label}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground">
              {withOpen ? t('throughAllWithOpen') : t('throughHint')}
            </span>
          </div>
          <ol className="space-y-1">
            {m.closedShifts.map((s, i) => (
              <ShiftLine
                key={s.id}
                shift={s}
                included={sel.include && (withOpen || throughIdx < 0 || i <= throughIdx)}
              />
            ))}
          </ol>
        </>
      ) : !nothing ? (
        <p className="text-muted-foreground text-xs">{t('noClosedShifts')}</p>
      ) : null}
    </div>
  );
}

export function ShopCandidatesCard({
  candidates,
  selections,
  onChange,
}: {
  candidates: ZCandidates;
  selections: Record<string, TillSelection>;
  onChange: (machineId: string, next: TillSelection) => void;
}) {
  const t = useTranslations('zWizard');
  const summary = selectionSummary(candidates, selections);
  const perTill = candidates.zScope === 'machine';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{candidates.shopName ?? candidates.shopId}</CardTitle>
        <p className="text-muted-foreground text-xs">
          {summary.tills === 0
            ? t('summaryNone')
            : perTill
              ? t('summaryPerTill', { tills: summary.tills, shifts: summary.shifts })
              : t('summary', { tills: summary.tills, shifts: summary.shifts })}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {perTill ? (
          <div className="flex gap-2 rounded-md border bg-muted/40 p-2 text-xs">
            <Info className="h-4 w-4 shrink-0" aria-hidden />
            {t('zScopeMachine')}
          </div>
        ) : null}
        {summary.dates.length > 1 ? (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {t('warnDates', { dates: summary.dates.map((d) => formatDate(d)).join(', ') })}
          </div>
        ) : null}
        {summary.late > 0 ? (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-800 dark:bg-amber-950">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            {t('warnLate', { count: summary.late })}
          </div>
        ) : null}
        {candidates.machines.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noTills')}</p>
        ) : (
          candidates.machines.map((m) => (
            <TillRow
              key={m.machineId}
              m={m}
              sel={selections[m.machineId] ?? defaultSelection(m, null)}
              onChange={(next) => onChange(m.machineId, next)}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
