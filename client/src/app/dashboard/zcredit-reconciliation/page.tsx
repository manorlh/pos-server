'use client';

/**
 * "התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳"): per day and Z-Credit terminal, our
 * card legs against the terminal's own report — transaction by transaction — and its deposits
 * against our transmissions. Matched and unmatched lists with filters and a CSV, links to our
 * documents, "צור זיכוי" for a charge with no document (through the existing credit flows),
 * "טופל" with a note, and "הרץ התאמה עכשיו".
 *
 * Read-only toward Z-Credit; the terminal is shown by its last four digits, a card by its last four.
 * Server: `/zcredit-reconciliation/*`.
 */

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Loader2, Play, RotateCcw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Section, SimpleTable } from '@/components/dashboard/report-center/parts';
import { ZCreditCreditDialog } from '@/components/dashboard/zcredit-recon/credit-dialog';
import { ZCreditHandleDialog } from '@/components/dashboard/zcredit-recon/handle-dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { downloadCsv, toCsv } from '@/lib/csv';
import { formatCurrency, formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { usePageScope } from '@/lib/scope';
import {
  CSV_COLUMNS,
  DEFAULT_FILTER,
  RECON_CATEGORIES,
  SEVERITY_MARK,
  CATEGORY_SEVERITY,
  cardTail,
  countByCategory,
  csvFileName,
  defaultRunDay,
  filterItems,
  itemsCsvRows,
  type ItemFilter,
  type ReconCategory,
  type ReconItem,
  type ReconRun,
} from '@/lib/zcreditRecon';
import {
  fetchReconRun,
  fetchReconRuns,
  fetchReconTerminals,
  reopenReconItem,
  runReconNow,
} from '@/lib/zcreditReconApi';

const ROW_TONE: Record<string, string | undefined> = {
  error: 'bg-red-50 dark:bg-red-950/30',
  warning: 'bg-amber-50 dark:bg-amber-950/30',
  ok: undefined,
};
const SCREEN_ROWS = 300;
const ANY = '__any__';

function CategoryBadge({ category, label }: { category: ReconCategory; label: string }) {
  const severity = CATEGORY_SEVERITY[category];
  return (
    <Badge
      variant={severity === 'error' ? 'destructive' : severity === 'ok' ? 'secondary' : 'outline'}
      className={severity === 'warning' ? 'border-amber-500 text-amber-700 dark:text-amber-400' : undefined}
    >
      {SEVERITY_MARK[severity]} {label}
    </Badge>
  );
}

export default function ZCreditReconciliationPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ZCreditReconciliation />
    </Suspense>
  );
}

function ZCreditReconciliation() {
  const t = useTranslations('zcreditRecon');
  const tcommon = useTranslations('common');
  const qc = useQueryClient();
  const params = useSearchParams();
  const access = useDashboardAccess();
  const canEdit = canAccess(access, 'reports', 'edit') || canAccess(access, 'z', 'edit');
  const { resolution, effective } = usePageScope({ maxLevel: 'shop' });
  const shopId = effective.shopId ?? null;

  const [from, setFrom] = useState(() => daysBackIso(6));
  const [to, setTo] = useState(() => todayIso());
  const [terminalKey, setTerminalKey] = useState(() => params.get('terminal') ?? '');
  const [runDay, setRunDay] = useState(() => params.get('date') ?? defaultRunDay(todayIso()));
  const [selected, setSelected] = useState<string | null>(() => params.get('run'));
  const [filter, setFilter] = useState<ItemFilter>(DEFAULT_FILTER);
  const [creditItem, setCreditItem] = useState<ReconItem | null>(null);
  const [handleItem, setHandleItem] = useState<ReconItem | null>(null);

  const terminals = useQuery({
    queryKey: ['zcredit-recon-terminals', shopId],
    queryFn: () => fetchReconTerminals(shopId),
  });
  const runs = useQuery({
    queryKey: ['zcredit-recon-runs', from, to, terminalKey, shopId],
    queryFn: () => fetchReconRuns({ from, to, terminalKey, shopId }),
    enabled: Boolean(from && to && from <= to),
  });
  const detail = useQuery({
    queryKey: ['zcredit-recon-run', selected],
    queryFn: () => fetchReconRun(selected!),
    enabled: !!selected,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['zcredit-recon-runs'] });
    qc.invalidateQueries({ queryKey: ['zcredit-recon-run'] });
    qc.invalidateQueries({ queryKey: ['zcredit-recon-terminals'] });
    qc.invalidateQueries({ queryKey: ['zcredit-recon-attention'] });
  };

  const runNow = useMutation({
    mutationFn: () => runReconNow({ date: runDay, terminalKey: terminalKey || null, shopId }),
    onSuccess: (out) => {
      const failed = out.runs.filter((r) => r.status === 'failed');
      if (failed.length) toast.error(t('runFailed', { message: failed[0].errorMessage ?? '' }));
      else toast.success(t('runDone', { count: out.runs.length }));
      if (out.runs.length === 1) setSelected(out.runs[0].id);
      refresh();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tcommon('error'))),
  });
  const reopen = useMutation({
    mutationFn: (id: string) => reopenReconItem(id),
    onSuccess: refresh,
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tcommon('error'))),
  });

  const terminalItems = useMemo(
    () => [
      { value: ANY, label: t('allTerminals') },
      ...(terminals.data?.terminals ?? []).map((x) => ({
        value: x.key,
        label: `${x.terminal} · ${x.shops.map((s) => s.name).join(', ')}`,
      })),
    ],
    [terminals.data, t],
  );
  const run = detail.data ?? null;
  const counts = useMemo(() => countByCategory(run?.items ?? []), [run]);
  const shown = useMemo(() => filterItems(run?.items ?? [], filter), [run, filter]);
  const toggle = (c: ReconCategory) =>
    setFilter((f) => ({ ...f, categories: f.categories.includes(c) ? f.categories.filter((x) => x !== c) : [...f.categories, c] }));

  const exportCsv = () => {
    if (!run) return;
    const header = CSV_COLUMNS.map((c) => t(`csv.${c}`));
    const rows = itemsCsvRows(run, shown, {
      header,
      category: (c) => t(`category.${c}`),
      yes: t('yes'),
      no: t('no'),
    });
    downloadCsv(csvFileName(run), toCsv(header, rows));
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        {/* Terminals, and the Z-Credit tills whose terminal cannot be read. */}
        <Section title={t('terminals')} note={t('terminalsNote')}>
          {terminals.isLoading ? (
            <Skeleton className="m-3 h-16" />
          ) : terminals.isError ? (
            <ReportErrorState message={axiosErrorToToastMessage(terminals.error, tcommon('error'))} />
          ) : (
            <SimpleTable
              empty={t('noTerminals')}
              rows={terminals.data?.terminals ?? []}
              columns={[
                { label: t('cols.terminal'), cell: (x) => <span className="font-mono">{x.terminal}</span> },
                { label: t('cols.shops'), cell: (x) => x.shops.map((s) => s.name).join(', ') || '—' },
                { label: t('cols.tills'), cell: (x) => x.machines.map((m) => m.name).join(', ') || '—', className: 'whitespace-normal' },
                { label: t('cols.nightly'), cell: (x) => (x.enabled ? t('nightlyAt', { time: x.runTime }) : t('nightlyOff')) },
                {
                  label: t('cols.lastRun'),
                  cell: (x) =>
                    x.lastRun ? (
                      <button type="button" className="hover:underline" onClick={() => setSelected(x.lastRun!.id)}>
                        {formatDate(x.lastRun.businessDate)} · {t(`status.${x.lastRun.status}`)}
                      </button>
                    ) : (
                      '—'
                    ),
                },
              ]}
            />
          )}
          {terminals.data?.problems.length ? (
            <ul className="space-y-1 p-3 text-sm text-destructive">
              {terminals.data.problems.map((p) => (
                <li key={p.machineId}>
                  {p.machineName}: {p.message}
                </li>
              ))}
            </ul>
          ) : null}
        </Section>

        {/* Filters and "הרץ התאמה עכשיו". */}
        <div className="rounded-lg border bg-card p-4 print:hidden">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1">
              <Label className="text-xs">{t('from')}</Label>
              <DatePicker value={from} onValueChange={setFrom} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{t('to')}</Label>
              <DatePicker value={to} onValueChange={setTo} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="zc-terminal">{t('terminal')}</Label>
              <select
                id="zc-terminal"
                className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                value={terminalKey || ANY}
                onChange={(e) => setTerminalKey(e.target.value === ANY ? '' : e.target.value)}
              >
                {terminalItems.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {canEdit ? (
              <div className="space-y-1">
                <Label className="text-xs">{t('runDay')}</Label>
                <div className="flex gap-2">
                  <DatePicker value={runDay} onValueChange={setRunDay} max={todayIso()} />
                  <Button onClick={() => runNow.mutate()} disabled={runNow.isPending || !runDay}>
                    {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                    {t('runNow')}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-2 text-xs">{t('readOnlyNote')}</p>
        </div>

        {/* Per day and terminal. */}
        <Section title={t('runs')}>
          {runs.isLoading ? (
            <Skeleton className="m-3 h-24" />
          ) : runs.isError ? (
            <ReportErrorState message={axiosErrorToToastMessage(runs.error, tcommon('error'))} />
          ) : (
            <SimpleTable
              empty={t('noRuns')}
              rows={runs.data ?? []}
              rowClassName={(r) => (r.id === selected ? 'bg-muted' : r.openHard ? ROW_TONE.error : undefined)}
              columns={[
                {
                  label: t('cols.day'),
                  cell: (r: ReconRun) => (
                    <button type="button" className="font-medium hover:underline" onClick={() => setSelected(r.id)}>
                      {formatDate(r.businessDate)}
                    </button>
                  ),
                },
                { label: t('cols.terminal'), cell: (r) => <span className="font-mono">{r.terminal}</span> },
                {
                  label: t('cols.status'),
                  cell: (r) => (
                    <span className={r.status === 'failed' ? 'text-destructive' : undefined} title={r.errorMessage ?? undefined}>
                      {t(`status.${r.status}`)} · {t(`trigger.${r.trigger}`)}
                    </span>
                  ),
                },
                ...RECON_CATEGORIES.map((c) => ({
                  label: `${SEVERITY_MARK[CATEGORY_SEVERITY[c]]} ${t(`categoryShort.${c}`)}`,
                  end: true,
                  cell: (r: ReconRun) => {
                    const n = r.summary[c]?.count ?? 0;
                    return <span className={n && c !== 'matched' ? 'font-semibold' : 'text-muted-foreground'}>{formatQuantity(n)}</span>;
                  },
                })),
                { label: t('cols.openErrors'), end: true, cell: (r) => <span className={r.openHard ? 'font-bold text-destructive' : undefined}>{formatQuantity(r.openHard ?? 0)}</span> },
                { label: t('cols.finishedAt'), cell: (r) => (r.finishedAt ? formatDateTime(r.finishedAt) : '—') },
              ]}
            />
          )}
        </Section>

        {selected ? (
          detail.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : detail.isError ? (
            <ReportErrorState message={axiosErrorToToastMessage(detail.error, tcommon('error'))} />
          ) : run ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">
                  {t('runTitle', { day: formatDate(run.businessDate), terminal: run.terminal })}
                </h2>
                <span className="text-muted-foreground text-xs">
                  {t('runMeta', { rows: run.zcreditRows, legs: run.ourLegs, lookups: run.lookups })}
                </span>
                <Button size="sm" variant="outline" className="ms-auto" onClick={exportCsv} disabled={!shown.length}>
                  <Download className="h-4 w-4" aria-hidden />
                  {t('exportCsv')}
                </Button>
              </div>
              {run.status === 'failed' ? <p className="text-destructive text-sm">{run.errorMessage}</p> : null}

              {/* Totals per category — a click narrows the list to it. */}
              <Section title={t('summary')}>
                <SimpleTable
                  empty={t('noItems')}
                  rows={RECON_CATEGORIES}
                  columns={[
                    {
                      label: t('cols.category'),
                      cell: (c) => (
                        <button type="button" className="hover:underline" onClick={() => setFilter((f) => ({ ...f, categories: [c] }))}>
                          <CategoryBadge category={c} label={t(`category.${c}`)} />
                        </button>
                      ),
                    },
                    { label: t('cols.count'), end: true, cell: (c) => formatQuantity(run.summary[c]?.count ?? 0) },
                    { label: t('cols.zcreditSum'), end: true, cell: (c) => formatCurrency(run.summary[c]?.zcredit ?? 0) },
                    { label: t('cols.oursSum'), end: true, cell: (c) => formatCurrency(run.summary[c]?.ours ?? 0) },
                  ]}
                />
              </Section>

              {/* Deposits against our transmissions. */}
              <Section title={t('deposits')} note={t('depositsNote')}>
                <SimpleTable
                  empty={t('noDeposits')}
                  rows={run.deposits}
                  rowClassName={(d) => (d.status === 'missing' ? ROW_TONE.error : d.status === 'difference' ? ROW_TONE.warning : undefined)}
                  columns={[
                    { label: t('cols.deposit'), cell: (d) => d.depositId ?? '—' },
                    { label: t('cols.status'), cell: (d) => t(`depositStatus.${d.status}`) },
                    { label: t('cols.zcreditNet'), end: true, cell: (d) => (d.zcredit?.net === null || d.zcredit?.net === undefined ? '—' : formatCurrency(d.zcredit.net)) },
                    { label: t('cols.zcreditCount'), end: true, cell: (d) => d.zcredit?.count ?? '—' },
                    { label: t('cols.oursNet'), end: true, cell: (d) => (d.ours?.legsNet === null || d.ours?.legsNet === undefined ? '—' : formatCurrency(d.ours.legsNet)) },
                    { label: t('cols.oursCount'), end: true, cell: (d) => d.ours?.legsCount ?? '—' },
                    {
                      label: t('cols.transmissions'),
                      cell: (d) => (d.ours?.transmissions ?? []).map((x) => `${x.machineName ?? '—'} ${x.startedAt ? formatDateTime(x.startedAt) : ''}`).join(' · ') || '—',
                      className: 'whitespace-normal',
                    },
                    { label: t('cols.reason'), cell: (d) => <span className="text-xs">{d.reason}</span>, className: 'min-w-64 whitespace-normal' },
                  ]}
                />
              </Section>

              {/* The items, filtered. */}
              <div className="flex flex-wrap items-center gap-2 print:hidden">
                {RECON_CATEGORIES.map((c) => (
                  <Button
                    key={c}
                    size="sm"
                    variant={filter.categories.includes(c) ? 'default' : 'outline'}
                    className="rounded-full"
                    aria-pressed={filter.categories.includes(c)}
                    onClick={() => toggle(c)}
                  >
                    {SEVERITY_MARK[CATEGORY_SEVERITY[c]]} {t(`categoryShort.${c}`)} ({formatQuantity(counts[c] ?? 0)})
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => setFilter({ ...filter, categories: [...RECON_CATEGORIES] })}>
                  {t('allCategories')}
                </Button>
                <label className="ms-2 flex items-center gap-2 text-sm">
                  <Switch checked={filter.openOnly} onCheckedChange={(v) => setFilter({ ...filter, openOnly: Boolean(v) })} />
                  {t('openOnly')}
                </label>
                <Input
                  className="ms-auto h-8 w-56"
                  value={filter.search}
                  placeholder={t('search')}
                  onChange={(e) => setFilter({ ...filter, search: e.target.value })}
                />
              </div>

              <Section title={t('items', { count: shown.length })}>
                <SimpleTable
                  empty={t('noItems')}
                  rows={shown}
                  limit={SCREEN_ROWS}
                  more={(n) => t('moreInCsv', { count: n })}
                  rowClassName={(i) => (i.handled ? 'opacity-60' : ROW_TONE[i.severity])}
                  columns={[
                    { label: t('cols.category'), cell: (i) => <CategoryBadge category={i.category} label={i.categoryLabel} /> },
                    {
                      label: t('cols.zcredit'),
                      className: 'whitespace-normal',
                      cell: (i) =>
                        i.zcredit ? (
                          <div className="text-xs">
                            <div className="font-mono text-sm">{i.zcredit.reference ?? '—'}</div>
                            <div>
                              {i.zcredit.isRefund ? t('refund') : t('charge')} · {i.zcredit.statusLabel ?? i.zcredit.statusCode ?? '—'}
                              {i.zcredit.source === 'lookup' ? ` · ${t('byLookup')}` : ''}
                            </div>
                            <div className="text-muted-foreground">
                              {i.zcredit.savedAt ? i.zcredit.savedAt.replace('T', ' ') : ''}
                              {i.zcredit.depositId ? ` · ${t('depositShort', { id: i.zcredit.depositId })}` : ''}
                            </div>
                          </div>
                        ) : (
                          '—'
                        ),
                    },
                    { label: t('cols.zcreditAmount'), end: true, cell: (i) => (i.zcredit?.amount === null || i.zcredit?.amount === undefined ? '—' : formatCurrency(i.zcredit.amount)) },
                    { label: t('cols.card'), cell: (i) => cardTail(i.zcredit?.cardLast4 ?? i.ours?.cardLast4) ?? '—' },
                    {
                      label: t('cols.document'),
                      className: 'whitespace-normal',
                      cell: (i) =>
                        i.ours?.transactionId ? (
                          <div className="text-xs">
                            <Link className="text-sm font-medium hover:underline" href={`/dashboard/transactions?tx=${i.ours.transactionId}`}>
                              {i.ours.documentNumber ?? '—'}
                            </Link>
                            <div className="text-muted-foreground">
                              {i.ours.machineName ?? ''}
                              {i.ours.createdAt ? ` · ${formatDateTime(i.ours.createdAt)}` : ''}
                            </div>
                            <div className="text-muted-foreground">
                              {i.ours.transmitted ? t('transmitted', { batch: i.ours.batch ?? '—' }) : t('notTransmitted')}
                            </div>
                          </div>
                        ) : (
                          '—'
                        ),
                    },
                    { label: t('cols.oursAmount'), end: true, cell: (i) => (i.ours?.amount === null || i.ours?.amount === undefined ? '—' : formatCurrency(i.ours.amount)) },
                    { label: t('cols.reason'), cell: (i) => <span className="text-xs">{i.reason}</span>, className: 'min-w-72 whitespace-normal' },
                    {
                      label: t('cols.handled'),
                      className: 'min-w-40 whitespace-normal',
                      cell: (i) =>
                        i.handled ? (
                          <div className="text-xs">
                            <div>{t('handledBy', { by: i.handled.by ?? '—', at: i.handled.at ? formatDateTime(i.handled.at) : '' })}</div>
                            {i.handled.note ? <div className="text-muted-foreground">{i.handled.note}</div> : null}
                          </div>
                        ) : (
                          '—'
                        ),
                    },
                    {
                      label: t('cols.actions'),
                      className: 'min-w-48',
                      cell: (i) =>
                        !canEdit ? null : (
                          <div className="flex flex-wrap gap-1">
                            {i.canCredit && !i.handled ? (
                              <Button size="xs" variant="outline" onClick={() => setCreditItem(i)}>
                                <Undo2 className="h-3 w-3" aria-hidden />
                                {t('createCredit')}
                              </Button>
                            ) : null}
                            {i.category !== 'matched' && !i.handled ? (
                              <Button size="xs" variant="outline" onClick={() => setHandleItem(i)}>
                                {t('markHandled')}
                              </Button>
                            ) : null}
                            {i.handled ? (
                              <Button size="xs" variant="ghost" onClick={() => reopen.mutate(i.id)} disabled={reopen.isPending}>
                                <RotateCcw className="h-3 w-3" aria-hidden />
                                {t('reopen')}
                              </Button>
                            ) : null}
                          </div>
                        ),
                    },
                  ]}
                />
              </Section>
            </div>
          ) : null
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">{t('pickRun')}</p>
        )}
      </ScopeGate>

      <ZCreditCreditDialog
        item={creditItem}
        open={!!creditItem}
        onOpenChange={(o) => !o && setCreditItem(null)}
        onHandle={(i) => {
          setCreditItem(null);
          setHandleItem(i);
        }}
      />
      <ZCreditHandleDialog item={handleItem} open={!!handleItem} onOpenChange={(o) => !o && setHandleItem(null)} onDone={refresh} />
    </div>
  );
}
