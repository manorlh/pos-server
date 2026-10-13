'use client';

/**
 * "יעדים" — daily or event sales targets per shop, point of sale or cashier (pos-server
 * app/routers/targets.py): the progress now with the pace forecast ("בקצב הנוכחי: ₪X עד סוף היום"),
 * and the targets themselves. Reaching one raises "יעד הושג" in the exception alerts. The tills'
 * small leaderboard is the till parameter "לוח מובילים" (off by default).
 *
 * Export (P:\specs\reports-upgrade.md §2ה, §4.6; `StandaloneExportBar`, report key `targets`):
 * today's progress (the list's own query, so the figures are the ones on screen) and every
 * target, each a sheet; the PDF is the progress (the targets when there is none today).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope, useScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { cn } from '@/lib/utils';
import { fetchBlockTargets, liveKeys } from '@/lib/liveControlApi';
import { parseHhmm } from '@/lib/liveControl';
import { paceLine, parseQty, shekels } from '@/lib/stockLive';
import { deleteTarget, fetchTargets, saveTarget, stockKeys, type TargetProgressRow, type TargetRow } from '@/lib/stockLiveApi';
import type { PosUser } from '@/lib/types';
import { anyRowHas, targetWhen } from '@/lib/menuTargetsReports';
import { dmy } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import { TargetsProgressList, useTargetsProgress } from '@/components/dashboard/live-control';
import { StandaloneExportBar, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';

type Form = {
  id?: string;
  shopId: string;
  scope: 'shop' | 'area' | 'cashier';
  period: 'day' | 'event';
  areaId: string;
  posUserId: string;
  eventId: string;
  day: string;
  amount: string;
  dayStart: string;
  dayEnd: string;
  name: string;
};

const SCOPE_LABELS = { shop: 'סניף', area: 'נקודת מכירה', cashier: 'קופאי' } as const;

function formOf(row: TargetRow | null, shopId: string): Form {
  return {
    id: row?.id,
    shopId: row?.shopId ?? shopId,
    scope: row?.scope ?? 'shop',
    period: row?.period ?? 'day',
    areaId: row?.areaId ?? '',
    posUserId: row?.posUserId ?? '',
    eventId: row?.eventId ?? '',
    day: row?.day ?? '',
    amount: row ? String(row.amount) : '',
    dayStart: row?.dayStart ?? '08:00',
    dayEnd: row?.dayEnd ?? '23:00',
    name: row?.name ?? '',
  };
}

export default function TargetsPage() {
  const qc = useQueryClient();
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  const ctx = useScope();
  const scope = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };
  const targets = useQuery({ queryKey: stockKeys.targets(scope), queryFn: () => fetchTargets(scope), enabled: resolution.status === 'ok' });
  const [form, setForm] = useState<Form | null>(null);
  const shopChoices = effective.shopId ? ctx.shops.filter((s) => s.id === effective.shopId) : ctx.shopOptions.length ? ctx.shopOptions : ctx.shops;
  const shopName = (id: string) => ctx.shops.find((s) => s.id === id)?.name ?? '';

  const remove = useMutation({
    mutationFn: (id: string) => deleteTarget(id),
    onSuccess: () => {
      toast.success('היעד הוסר');
      qc.invalidateQueries({ queryKey: ['targets'] });
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'ההסרה נכשלה')),
  });

  // ── The export: today's progress (the list's own query) and every target ──
  const tt = useTranslations('targetsPage');
  const progress = useTargetsProgress(scope, resolution.status === 'ok');
  const progressRows = (progress.data ?? []) as TargetProgressRow[];
  const targetRows = targets.data ?? [];
  const progressColumns: ReportColumn<TargetProgressRow>[] = [
    { key: 'target', header: tt('col.target'), required: true, width: 26, value: (r) => r.label },
  ];
  // The shop: a field of a newer server (§4.6) — its column only when it came.
  if (anyRowHas(progressRows, (r) => r.shopName ?? r.shopId)) {
    progressColumns.push({
      key: 'shop',
      header: tt('col.shop'),
      width: 18,
      value: (r) => r.shopName ?? (r.shopId ? shopName(r.shopId) || null : null),
    });
  }
  progressColumns.push(
    { key: 'scope', header: tt('col.scope'), width: 12, value: (r) => SCOPE_LABELS[r.scope] },
    { key: 'period', header: tt('col.period'), width: 10, value: (r) => tt(`period.${r.period}`) },
    { key: 'amount', header: tt('col.amount'), kind: 'money', value: (r) => r.amount },
    { key: 'actual', header: tt('col.actual'), kind: 'money', value: (r) => r.actual },
    { key: 'percent', header: tt('col.percent'), kind: 'percent', value: (r) => r.percent },
    { key: 'forecast', header: tt('col.forecast'), kind: 'money', value: (r) => r.forecast },
    { key: 'status', header: tt('col.status'), width: 30, value: (r) => (r.reached ? tt('reached') : paceLine(r)) },
  );
  if (anyRowHas(progressRows, (r) => r.reachedAt)) {
    progressColumns.push({ key: 'reachedAt', header: tt('col.reachedAt'), kind: 'datetime', defaultHidden: true, value: (r) => r.reachedAt ?? null });
  }
  const progressTable: ReportTableSpec<TargetProgressRow> = {
    id: 'main',
    title: tt('progressTitle'),
    columns: progressColumns,
    rows: progressRows,
    rowKey: (r) => r.targetId,
  };
  const targetsTable: ReportTableSpec<TargetRow> = {
    id: 'targets',
    title: tt('targetsTitle'),
    columns: [
      { key: 'target', header: tt('col.target'), required: true, width: 26, value: (r) => r.label },
      { key: 'shop', header: tt('col.shop'), width: 18, value: (r) => r.shopName ?? (shopName(r.shopId) || null) },
      { key: 'scope', header: tt('col.scope'), width: 12, value: (r) => SCOPE_LABELS[r.scope] },
      { key: 'amount', header: tt('col.amount'), kind: 'money', value: (r) => r.amount },
      { key: 'period', header: tt('col.period'), width: 10, value: (r) => tt(`period.${r.period}`) },
      {
        key: 'when',
        header: tt('col.when'),
        width: 22,
        value: (r) =>
          targetWhen(r, {
            event: tt('when.event'),
            day: (day) => tt('when.day', { day: dmy(day) }),
            everyDay: (from, to) => tt('when.everyDay', { from, to }),
          }),
      },
    ],
    rows: targetRows,
    rowKey: (r) => r.id,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">יעדים</h1>
          <p className="text-sm text-muted-foreground">יעדי מכירות יומיים או לאירוע — לסניף, לנקודת מכירה או לקופאי. כשיעד מושג נשלחת התראה.</p>
        </div>
        <Button className="min-h-10 gap-1" disabled={shopChoices.length === 0} onClick={() => setForm(formOf(null, effective.shopId ?? (shopChoices.length === 1 ? shopChoices[0].id : '')))}>
          <Plus className="size-4" /> יעד חדש
        </Button>
      </div>
      <ScopeGate resolution={resolution}>
        <div className="mb-4">
          <StandaloneExportBar
            reportKey="targets"
            title={tt('exportTitle')}
            tables={[progressTable, targetsTable] as ReportTableSpec<unknown>[]}
            pdfTableId={progressRows.length ? 'main' : 'targets'}
            from={todayIso()}
            to={todayIso()}
            disabled={progressRows.length === 0 && targetRows.length === 0}
          />
        </div>
        <section className="space-y-2">
          <h2 className="font-semibold">היום</h2>
          <TargetsProgressList scope={scope} emptyText="אין יעדים פעילים היום" />
        </section>
        <section className="mt-6 space-y-2">
          <h2 className="font-semibold">כל היעדים</h2>
          {targets.isPending ? (
            <div className="h-24 animate-pulse rounded-2xl bg-muted" />
          ) : targets.isError ? (
            <p className="text-sm text-destructive">{axiosErrorToToastMessage(targets.error, 'הטעינה נכשלה')}</p>
          ) : (targets.data ?? []).length === 0 ? (
            <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">עוד אין יעדים. &quot;יעד חדש&quot; מגדיר יעד יומי לסניף, לנקודת מכירה או לקופאי.</p>
          ) : (
            <ul className="divide-y rounded-2xl border bg-card">
              {(targets.data ?? []).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{r.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {shekels(r.amount)} · {SCOPE_LABELS[r.scope]}
                      {!effective.shopId ? ` · ${shopName(r.shopId)}` : ''} ·{' '}
                      {r.period === 'event' ? 'לאירוע' : r.day ? `ליום ${r.day}` : `כל יום ${r.dayStart}–${r.dayEnd}`}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="size-10" aria-label={`ערוך ${r.label}`} onClick={() => setForm(formOf(r, r.shopId))}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-10"
                      aria-label={`הסר ${r.label}`}
                      disabled={remove.isPending}
                      onClick={() => {
                        if (window.confirm(`להסיר את "${r.label}"?`)) remove.mutate(r.id);
                      }}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">לוח מובילים בקופה: פרמטר הקופה &quot;לוח מובילים&quot; (כבוי כברירת מחדל) — מציג בקופה את היעד והקופאים המובילים היום.</p>
        </section>
      </ScopeGate>
      {form ? <TargetDialog form={form} setForm={setForm} shops={shopChoices} /> : null}
    </div>
  );
}

function TargetDialog({ form, setForm, shops }: { form: Form; setForm: (f: Form | null) => void; shops: { id: string; name: string }[] }) {
  const qc = useQueryClient();
  const options = useQuery({ queryKey: liveKeys.targets(form.shopId), queryFn: () => fetchBlockTargets(form.shopId), enabled: !!form.shopId });
  const cashiers = useQuery<PosUser[]>({
    queryKey: ['pos-users', form.shopId, false],
    queryFn: () => api.get(`/shops/${form.shopId}/pos-users`, { params: { include_inactive: false } }).then((r) => r.data),
    enabled: !!form.shopId && form.scope === 'cashier',
  });
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const amount = parseQty(form.amount);
  const start = parseHhmm(form.dayStart);
  const end = parseHhmm(form.dayEnd);
  const valid =
    !!form.shopId &&
    amount != null &&
    amount > 0 &&
    (form.scope !== 'area' || !!form.areaId) &&
    (form.scope !== 'cashier' || !!form.posUserId) &&
    (form.period !== 'event' || !!form.eventId) &&
    (form.period === 'event' || (!!start && !!end));

  const save = useMutation({
    mutationFn: () =>
      saveTarget(
        {
          shopId: form.shopId,
          scope: form.scope,
          period: form.period,
          areaId: form.scope === 'area' ? form.areaId : null,
          posUserId: form.scope === 'cashier' ? form.posUserId : null,
          eventId: form.period === 'event' ? form.eventId : null,
          day: form.period === 'day' && form.day ? form.day : null,
          amount: amount!,
          dayStart: start ?? undefined,
          dayEnd: end ?? undefined,
          name: form.name.trim() || null,
        },
        form.id,
      ),
    onSuccess: () => {
      toast.success('היעד נשמר');
      qc.invalidateQueries({ queryKey: ['targets'] });
      setForm(null);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'השמירה נכשלה')),
  });

  const chip = (on: boolean) => cn('min-h-10 rounded-full border px-3 text-sm', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted');
  const selectClass = 'h-11 w-full rounded-lg border bg-background px-3 text-sm';

  return (
    <Dialog open onOpenChange={(o) => !o && setForm(null)}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{form.id ? 'עריכת יעד' : 'יעד חדש'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {shops.length > 1 && !form.id ? (
            <div className="space-y-1.5">
              <Label>סניף</Label>
              <select className={selectClass} value={form.shopId} onChange={(e) => set({ shopId: e.target.value, areaId: '', posUserId: '', eventId: '' })}>
                <option value="">בחרו סניף</option>
                {shops.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label>יעד של</Label>
            <div className="flex flex-wrap gap-2">
              {(['shop', 'area', 'cashier'] as const).map((s) => (
                <button key={s} type="button" className={chip(form.scope === s)} onClick={() => set({ scope: s })}>
                  {SCOPE_LABELS[s]}
                </button>
              ))}
            </div>
            {form.scope === 'area' ? (
              <select className={selectClass} value={form.areaId} onChange={(e) => set({ areaId: e.target.value })} aria-label="נקודת מכירה">
                <option value="">בחרו נקודת מכירה</option>
                {(options.data?.areas ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            ) : null}
            {form.scope === 'cashier' ? (
              <select className={selectClass} value={form.posUserId} onChange={(e) => set({ posUserId: e.target.value })} aria-label="קופאי">
                <option value="">בחרו קופאי</option>
                {(cashiers.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {[u.firstName, u.lastName].filter(Boolean).join(' ') || u.username}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label>תקופה</Label>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={chip(form.period === 'day')} onClick={() => set({ period: 'day' })}>
                יומי
              </button>
              <button type="button" className={chip(form.period === 'event')} disabled={(options.data?.events.length ?? 0) === 0 && form.period !== 'event'} onClick={() => set({ period: 'event' })}>
                אירוע
              </button>
            </div>
            {form.period === 'event' ? (
              <select className={selectClass} value={form.eventId} onChange={(e) => set({ eventId: e.target.value })} aria-label="אירוע">
                <option value="">בחרו אירוע</option>
                {(options.data?.events ?? []).map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name}
                  </option>
                ))}
              </select>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">מ</span>
                    <Input value={form.dayStart} onChange={(e) => set({ dayStart: e.target.value })} inputMode="numeric" placeholder="08:00" className={cn('h-11', !start && 'border-destructive')} />
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="text-muted-foreground">עד</span>
                    <Input value={form.dayEnd} onChange={(e) => set({ dayEnd: e.target.value })} inputMode="numeric" placeholder="23:00" className={cn('h-11', !end && 'border-destructive')} />
                  </label>
                </div>
                <label className="block space-y-1 text-sm">
                  <span className="text-muted-foreground">ליום מסוים (ריק: כל יום)</span>
                  <Input type="date" value={form.day} onChange={(e) => set({ day: e.target.value })} className="h-11" />
                </label>
                {start && end && end <= start ? <p className="text-xs text-muted-foreground">שעת הסיום לפני ההתחלה: היום נמשך אחרי חצות.</p> : null}
              </>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">סכום (₪)</span>
              <Input value={form.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" className="h-11" />
            </label>
            <label className="space-y-1 text-sm">
              <span className="text-muted-foreground">שם (לא חובה)</span>
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} className="h-11" />
            </label>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={() => setForm(null)}>
            ביטול
          </Button>
          <Button className="min-h-11" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'שומר…' : 'שמור'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
