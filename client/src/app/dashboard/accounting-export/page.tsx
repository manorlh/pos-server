'use client';

/**
 * Accounting export (ייצוא להנהלת חשבונות) — docs/ACCOUNTING_EXPORT_AND_REPORTS.md §2.
 *
 * Pick a company's Zs (by shop, business date, "only not exported"), preview the journal
 * entries they make, and export them as a batch: MOVEIN.DAT + MOVEIN.PRM + an Excel
 * journal, zipped and stored on the server. A Z already in a batch needs an explicit
 * confirmation to export again (no double posting by accident). Past batches download
 * again byte for byte.
 *
 * Export level (the company's setting, or chosen here): "ברמת חברה" writes one batch —
 * optionally consolidated into company entries with each line's shop as cost centre —
 * and "לפי סניף" writes a batch per shop, downloaded together as one zip. The lock is
 * per Z across both levels.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Download, Eye, FileArchive, Settings2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import {
  createAccountingExport,
  downloadAccountingExport,
  downloadAccountingExportBundle,
  fetchAccountingExports,
  fetchAccountingSettings,
  fetchAccountingZs,
  previewAccountingExport,
  type AccountingExportLevel,
  type AccountingFormat,
  type AccountingGrouping,
  type AlreadyExportedBatch,
  type AccountingZRow,
  type ExportBatch,
  type ExportPreview,
  type ExportProblem,
  type ExportRequest,
} from '@/lib/accountingApi';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SELECT =
  'border-input bg-background h-9 rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

type ApiError = { response?: { status?: number; data?: { detail?: unknown } } };

function problemsOf(err: unknown): ExportProblem[] | null {
  const detail = (err as ApiError)?.response?.data?.detail as { problems?: ExportProblem[] } | undefined;
  return detail && Array.isArray(detail.problems) ? detail.problems : null;
}

export default function AccountingExportPage() {
  const t = useTranslations('accounting');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'company' });
  const shopId = effective.shopId ?? undefined;
  const companyId = scope.shop?.companyId ?? effective.companyId ?? null;

  const [from, setFrom] = useState(daysBackIso(30));
  const [to, setTo] = useState(todayIso());
  const [onlyUnexported, setOnlyUnexported] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<AccountingFormat>('hashavshevet');
  const [grouping, setGrouping] = useState<AccountingGrouping>('z');
  const [encoding, setEncoding] = useState<'' | 'cp1255' | 'cp862'>('');
  const [method, setMethod] = useState<'' | 'flexible' | 'detailed'>('');
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [problems, setProblems] = useState<ExportProblem[] | null>(null);
  const [confirmReexport, setConfirmReexport] = useState<{
    batchNumbers: number[];
    batches: AlreadyExportedBatch[];
  } | null>(null);
  const [level, setLevel] = useState<'' | AccountingExportLevel>('');
  const [consolidate, setConsolidate] = useState<'' | 'true' | 'false'>('');

  const zs = useQuery({
    queryKey: ['accounting-zs', companyId, shopId, from, to, onlyUnexported],
    queryFn: () => fetchAccountingZs({ companyId: companyId!, shopId, from, to, onlyUnexported }),
    enabled: Boolean(companyId) && Boolean(from) && Boolean(to) && from <= to,
  });
  const settings = useQuery({
    queryKey: ['accounting-settings', companyId, null],
    queryFn: () => fetchAccountingSettings(companyId!, null),
    enabled: Boolean(companyId),
  });
  const batches = useQuery<ExportBatch[]>({
    queryKey: ['accounting-batches', companyId, shopId],
    queryFn: () => fetchAccountingExports(companyId!, shopId),
    enabled: Boolean(companyId),
  });

  const rows: AccountingZRow[] = useMemo(() => zs.data?.items ?? [], [zs.data]);
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const selectedRows = rows.filter((r) => selected.has(r.id));
  const selectedNet = selectedRows.reduce((s, r) => s + (r.netSales ?? 0), 0);
  const settingsLevel: AccountingExportLevel = settings.data?.company?.exportLevel === 'shop' ? 'shop' : 'company';
  const effectiveLevel: AccountingExportLevel = level || settingsLevel;
  const levelLabel = (l?: string | null) => t(`exportLevel.${l === 'shop' ? 'shop' : 'company'}`);

  const request = (confirm = false): ExportRequest => ({
    companyId: companyId!,
    zReportIds: selectedRows.map((r) => r.id),
    format,
    grouping,
    ...(encoding ? { encoding } : {}),
    ...(method ? { method } : {}),
    ...(level ? { level } : {}),
    ...(consolidate && effectiveLevel === 'company' ? { consolidate: consolidate === 'true' } : {}),
    confirmReexport: confirm,
  });

  const previewMutation = useMutation({
    mutationFn: () => previewAccountingExport(request()),
    onSuccess: (p) => {
      setPreview(p);
      setProblems(p.problems.length ? p.problems : null);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const exportMutation = useMutation({
    mutationFn: (confirm: boolean) => createAccountingExport(request(confirm)),
    onSuccess: async (batch) => {
      setConfirmReexport(null);
      setProblems(null);
      setSelected(new Set());
      setPreview(null);
      const group = batch.groupBatches ?? [];
      if (group.length > 1) {
        toast.success(
          t('exportedShops', {
            count: group.length,
            numbers: group.map((b) => b.batchNumber).join(', '),
          }),
        );
        await downloadAccountingExportBundle(group.map((b) => b.id));
      } else {
        toast.success(t('exported', { number: batch.batchNumber }));
        await downloadAccountingExport(batch);
      }
      qc.invalidateQueries({ queryKey: ['accounting-zs'] });
      qc.invalidateQueries({ queryKey: ['accounting-batches'] });
    },
    onError: (err) => {
      const status = (err as ApiError)?.response?.status;
      const detail = (err as ApiError)?.response?.data?.detail as
        | { batchNumbers?: number[]; batches?: AlreadyExportedBatch[] }
        | undefined;
      if (status === 409) {
        setConfirmReexport({ batchNumbers: detail?.batchNumbers ?? [], batches: detail?.batches ?? [] });
        return;
      }
      const list = problemsOf(err);
      if (list) {
        setProblems(list);
        return;
      }
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    setPreview(null);
    setConfirmReexport(null);
  };

  const problemText = (p: ExportProblem) => {
    const where = [p.zNumber != null ? `Z ${p.zNumber}` : null, p.shopName || null].filter(Boolean).join(' · ');
    let what: string;
    if (p.code === 'missing_mapping') {
      const key = p.detail.replace('accounts.', '');
      what = t('problem.missing_mapping', {
        field: p.detail === 'movementType' ? t('fields.movementType') : t.has(`accounts.${key}`) ? t(`accounts.${key}`) : key,
      });
    } else if (t.has(`problem.${p.code}`)) {
      what = t(`problem.${p.code}`, { detail: p.detail });
    } else {
      what = `${p.code}: ${p.detail}`;
    }
    return where ? `${where} — ${what}` : what;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('exportTitle')}</h1>
          <p className="text-muted-foreground text-sm">{t('exportSubtitle')}</p>
        </div>
        <Link href="/dashboard/accounting-settings" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <Settings2 className="h-4 w-4" aria-hidden /> {t('settingsTitle')}
        </Link>
      </div>

      <ScopeGate resolution={resolution}>
        {!companyId ? (
          <p className="text-muted-foreground py-12 text-center text-sm">{t('pickCompany')}</p>
        ) : (
          <>
            {settings.data && settings.data.missing.length > 0 ? (
              <div className="border-destructive/50 bg-destructive/5 text-destructive flex items-center gap-2 rounded-md border p-3 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                <span>{t('settingsIncomplete')}</span>
                <Link href="/dashboard/accounting-settings" className="underline">
                  {t('settingsTitle')}
                </Link>
              </div>
            ) : null}

            <Card>
              <CardContent className="flex flex-wrap items-end gap-4 pt-6">
                <div className="space-y-1">
                  <Label className="text-xs">{t('from')}</Label>
                  <DatePicker value={from} max={to} onChange={(e) => setFrom(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('to')}</Label>
                  <DatePicker value={to} min={from} onChange={(e) => setTo(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
                </div>
                <label className="flex items-center gap-2 pb-2 text-sm">
                  <input
                    type="checkbox"
                    checked={onlyUnexported}
                    onChange={(e) => {
                      setOnlyUnexported(e.target.checked);
                      setSelected(new Set());
                    }}
                  />
                  {t('onlyUnexported')}
                </label>
              </CardContent>
            </Card>

            {zs.isLoading ? (
              <Skeleton className="h-48 w-full" />
            ) : zs.isError ? (
              <ReportErrorState message={axiosErrorToToastMessage(zs.error, tc('error'))} />
            ) : (
              <div className="rounded-lg border bg-card overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">
                        <input
                          type="checkbox"
                          aria-label={t('selectAll')}
                          checked={allSelected}
                          onChange={() => {
                            setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)));
                            setPreview(null);
                          }}
                        />
                      </TableHead>
                      <TableHead>{t('col.z')}</TableHead>
                      <TableHead>{t('col.shop')}</TableHead>
                      <TableHead>{t('col.businessDate')}</TableHead>
                      <TableHead className="text-end">{t('col.net')}</TableHead>
                      <TableHead className="text-end">{t('col.vat')}</TableHead>
                      <TableHead>{t('col.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                          {t('noZs')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      rows.map((z) => (
                        <TableRow key={z.id} className="cursor-pointer" onClick={() => toggle(z.id)}>
                          <TableCell onClick={(e) => e.stopPropagation()}>
                            <input type="checkbox" checked={selected.has(z.id)} onChange={() => toggle(z.id)} />
                          </TableCell>
                          <TableCell className="font-medium">
                            <Link
                              href={`/dashboard/z-reports/${z.id}`}
                              className="hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Z {z.shopSequenceNumber ?? '—'}
                            </Link>
                          </TableCell>
                          <TableCell>{z.shopName ?? '—'}</TableCell>
                          <TableCell>{formatDate(z.businessDate)}</TableCell>
                          <TableCell className="text-end tabular-nums">{formatCurrency(z.netSales)}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {z.vatTotal != null ? formatCurrency(z.vatTotal) : '—'}
                          </TableCell>
                          <TableCell>
                            {z.exported.length === 0 ? (
                              <span className="text-muted-foreground text-xs">{t('notExported')}</span>
                            ) : (
                              <Badge variant="secondary">
                                {t('exportedIn', {
                                  numbers: z.exported
                                    .map((b) => `${b.batchNumber} (${levelLabel(b.level)})`)
                                    .join(', '),
                                })}
                              </Badge>
                            )}
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                  {selectedRows.length > 0 ? (
                    <TableFooter>
                      <TableRow>
                        <TableCell />
                        <TableCell colSpan={3}>{t('selectedCount', { count: selectedRows.length })}</TableCell>
                        <TableCell className="text-end font-semibold tabular-nums">
                          {formatCurrency(selectedNet)}
                        </TableCell>
                        <TableCell colSpan={2} />
                      </TableRow>
                    </TableFooter>
                  ) : null}
                </Table>
                {zs.data?.truncated ? (
                  <p className="text-muted-foreground p-3 text-xs">{t('truncated')}</p>
                ) : null}
              </div>
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('optionsTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-end gap-4">
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.format')}</Label>
                  <select className={SELECT} value={format} onChange={(e) => setFormat(e.target.value as AccountingFormat)}>
                    <option value="hashavshevet">{t('format.hashavshevet')}</option>
                    <option value="priority">{t('format.priority')}</option>
                    <option value="excel">{t('format.excel')}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.grouping')}</Label>
                  <select
                    className={SELECT}
                    value={grouping}
                    onChange={(e) => {
                      setGrouping(e.target.value as AccountingGrouping);
                      setPreview(null);
                    }}
                  >
                    <option value="z">{t('grouping.z')}</option>
                    <option value="day">{t('grouping.day')}</option>
                    <option value="month">{t('grouping.month')}</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t('fields.exportLevel')}</Label>
                  <select
                    className={SELECT}
                    value={level}
                    onChange={(e) => {
                      setLevel(e.target.value as typeof level);
                      setPreview(null);
                    }}
                  >
                    <option value="">{t('fromSettingsValue', { value: levelLabel(settingsLevel) })}</option>
                    <option value="company">{t('exportLevel.company')}</option>
                    <option value="shop">{t('exportLevel.shop')}</option>
                  </select>
                </div>
                {effectiveLevel === 'company' ? (
                  <div className="space-y-1">
                    <Label className="text-xs">{t('fields.consolidate')}</Label>
                    <select
                      className={SELECT}
                      value={consolidate}
                      onChange={(e) => {
                        setConsolidate(e.target.value as typeof consolidate);
                        setPreview(null);
                      }}
                    >
                      <option value="">{t('fromSettings')}</option>
                      <option value="false">{t('consolidate.false')}</option>
                      <option value="true">{t('consolidate.true')}</option>
                    </select>
                  </div>
                ) : null}
                {format !== 'excel' ? (
                  <>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('fields.encoding')}</Label>
                      <select className={SELECT} value={encoding} onChange={(e) => setEncoding(e.target.value as typeof encoding)}>
                        <option value="">{t('fromSettings')}</option>
                        <option value="cp1255">{t('encoding.cp1255')}</option>
                        <option value="cp862">{t('encoding.cp862')}</option>
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">{t('fields.method')}</Label>
                      <select className={SELECT} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
                        <option value="">{t('fromSettings')}</option>
                        <option value="flexible">{t('method.flexible')}</option>
                        <option value="detailed">{t('method.detailed')}</option>
                      </select>
                    </div>
                  </>
                ) : null}
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    disabled={selectedRows.length === 0 || previewMutation.isPending}
                    onClick={() => previewMutation.mutate()}
                  >
                    <Eye className="h-4 w-4" aria-hidden /> {t('preview')}
                  </Button>
                  <Button
                    disabled={selectedRows.length === 0 || exportMutation.isPending}
                    onClick={() => exportMutation.mutate(false)}
                  >
                    <FileArchive className="h-4 w-4" aria-hidden /> {t('export')}
                  </Button>
                </div>
              </CardContent>
              <CardContent className="pt-0">
                <p className="text-muted-foreground text-xs">{t('verifyNote')}</p>
              </CardContent>
            </Card>

            {confirmReexport ? (
              <div className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/60 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
                <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
                <span>
                  {t('reexportWarning', {
                    numbers:
                      confirmReexport.batches.length > 0
                        ? confirmReexport.batches
                            .map((b) => `${b.batchNumber} (${levelLabel(b.level)})`)
                            .join(', ')
                        : confirmReexport.batchNumbers.join(', '),
                  })}
                  {confirmReexport.batches.some((b) => b.level !== effectiveLevel)
                    ? ` ${t('reexportOtherLevel')}`
                    : ''}
                </span>
                <Button size="sm" variant="destructive" onClick={() => exportMutation.mutate(true)}>
                  {t('reexportConfirm')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReexport(null)}>
                  {tc('cancel')}
                </Button>
              </div>
            ) : null}

            {problems && problems.length > 0 ? (
              <div className="border-destructive/50 bg-destructive/5 space-y-1 rounded-md border p-3 text-sm">
                <div className="text-destructive flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" aria-hidden /> {t('problemsTitle')}
                </div>
                <ul className="list-disc ps-6">
                  {problems.map((p, i) => (
                    <li key={i}>{problemText(p)}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview && preview.entries.length > 0 ? (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base">{t('previewTitle', { count: preview.entries.length })}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {preview.entries.map((e, i) => (
                    <div key={i} className="rounded-md border">
                      <div className="bg-muted/40 flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 text-xs">
                        <span className="font-medium">{e.details}</span>
                        <span>{formatDate(e.entryDate)}</span>
                        <span>{t('ref1', { value: e.reference1 })}</span>
                        <span>{t('ref2', { value: e.reference2 || '—' })}</span>
                        <span>{t('movementTypeShort', { value: e.movementType })}</span>
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t('col.line')}</TableHead>
                            {e.lines.some((l) => l.branch != null) ? (
                              <TableHead>{t('col.costCenter')}</TableHead>
                            ) : null}
                            <TableHead>{t('col.account')}</TableHead>
                            <TableHead className="text-end">{t('col.debit')}</TableHead>
                            <TableHead className="text-end">{t('col.credit')}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {e.lines.map((l, j) => (
                            <TableRow key={j}>
                              <TableCell>{l.label}</TableCell>
                              {e.lines.some((x) => x.branch != null) ? (
                                <TableCell className="text-xs">
                                  {[l.shopName, l.branch].filter(Boolean).join(' · ') || '—'}
                                </TableCell>
                              ) : null}
                              <TableCell className="font-mono text-xs" dir="ltr">
                                {l.account ?? '—'}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {l.side === 'D' ? formatCurrency(l.amount) : ''}
                              </TableCell>
                              <TableCell className="text-end tabular-nums">
                                {l.side === 'C' ? formatCurrency(l.amount) : ''}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                        <TableFooter>
                          <TableRow>
                            <TableCell
                              colSpan={e.lines.some((l) => l.branch != null) ? 3 : 2}
                              className="font-semibold"
                            >
                              {t('total')}
                            </TableCell>
                            <TableCell className="text-end font-semibold tabular-nums">
                              {formatCurrency(e.totalDebit)}
                            </TableCell>
                            <TableCell className="text-end font-semibold tabular-nums">
                              {formatCurrency(e.totalCredit)}
                            </TableCell>
                          </TableRow>
                        </TableFooter>
                      </Table>
                    </div>
                  ))}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{t('batchesTitle')}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('col.batch')}</TableHead>
                      <TableHead>{t('col.createdAt')}</TableHead>
                      <TableHead>{t('col.createdBy')}</TableHead>
                      <TableHead>{t('col.shop')}</TableHead>
                      <TableHead>{t('col.range')}</TableHead>
                      <TableHead>{t('fields.format')}</TableHead>
                      <TableHead className="text-end">{t('col.zCount')}</TableHead>
                      <TableHead className="text-end">{t('col.debit')}</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(batches.data ?? []).length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} className="text-muted-foreground py-6 text-center">
                          {t('noBatches')}
                        </TableCell>
                      </TableRow>
                    ) : (
                      (batches.data ?? []).map((b) => (
                        <TableRow key={b.id}>
                          <TableCell className="font-medium">
                            {t('batchNumber', { number: b.batchNumber })}
                            {b.isReexport ? (
                              <Badge variant="outline" className="ms-2">
                                {t('reexportBadge')}
                              </Badge>
                            ) : null}
                            <Badge variant="secondary" className="ms-2">
                              {levelLabel(b.level)}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">{formatDateTime(b.createdAt)}</TableCell>
                          <TableCell className="text-xs">{b.createdBy ?? '—'}</TableCell>
                          <TableCell>{b.shopName ?? t('severalShops')}</TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            {formatDate(b.dateFrom)} – {formatDate(b.dateTo)}
                          </TableCell>
                          <TableCell className="text-xs">
                            {t(`format.${b.format}`)} · {t(`grouping.${b.grouping}`)}
                            {b.format !== 'excel' ? ` · ${b.encoding}` : ''}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{b.zCount}</TableCell>
                          <TableCell className="text-end tabular-nums">{formatCurrency(b.totalDebit)}</TableCell>
                          <TableCell>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                downloadAccountingExport(b).catch((err) =>
                                  toast.error(axiosErrorToToastMessage(err, tc('error'))),
                                )
                              }
                            >
                              <Download className="h-4 w-4" aria-hidden /> {t('download')}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}
      </ScopeGate>
    </div>
  );
}
