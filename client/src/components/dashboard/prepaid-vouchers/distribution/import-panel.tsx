'use client';

/**
 * "רשימת נמענים": the production's list — an Excel / CSV file or rows pasted — read into name /
 * phone / group / count (columns found by their headers, changeable), the assignment mode, and a
 * preview of who gets which serials (the server's own computation) before anything is stored.
 */

import { useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileSpreadsheet, Loader2, Upload } from 'lucide-react';
import {
  cellText,
  detectColumns,
  parseDelimited,
  rowsFromTable,
  type ColumnRole,
  type DistributionMode,
} from '@/lib/voucherDistribution';
import {
  importDistribution,
  previewDistribution,
  type DistributionOverview,
  type PlannedRow,
  type PlanSummary,
} from '@/lib/voucherDistributionApi';
import type { PrepaidVoucherBatch } from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useDistributionError, useRefreshDistribution } from './shared';

const ROLES: ColumnRole[] = ['name', 'phone', 'group', 'count', 'ignore'];
const PREVIEW_ROWS = 300;

async function readSheet(file: File): Promise<string[][]> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c).value));
    if (cells.some((x) => x !== '')) out.push(cells);
  });
  return out;
}

export function ImportPanel({ batch, overview }: { batch: PrepaidVoucherBatch; overview: DistributionOverview }) {
  const t = useTranslations('voucherDistribution.import');
  const tp = useTranslations('voucherDistribution.problems');
  const errorText = useDistributionError();
  const refresh = useRefreshDistribution(batch.id);
  const fileRef = useRef<HTMLInputElement>(null);

  const [pasted, setPasted] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [table, setTable] = useState<string[][]>([]);
  const [header, setHeader] = useState(false);
  const [roles, setRoles] = useState<ColumnRole[]>([]);
  const [mode, setMode] = useState<DistributionMode>(overview.grouped ? 'group' : 'count');
  const [perRecipient, setPerRecipient] = useState('1');
  const [allowDuplicates, setAllowDuplicates] = useState(false);
  const [plan, setPlan] = useState<{ rows: PlannedRow[]; summary: PlanSummary } | null>(null);
  const [reading, setReading] = useState(false);

  const load = (cells: string[][], name: string | null) => {
    const found = detectColumns(cells, mode);
    setTable(cells);
    setHeader(found.header);
    setRoles(found.roles);
    setFileName(name);
    setPlan(null);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      const isSheet = /\.xlsx$/i.test(file.name);
      const cells = isSheet ? await readSheet(file) : parseDelimited(await file.text());
      if (!cells.length) toast.error(t('emptyFile'));
      load(cells, file.name);
      setPasted('');
    } catch {
      toast.error(t('unreadable'));
    } finally {
      setReading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const onPaste = (text: string) => {
    setPasted(text);
    load(text.trim() ? parseDelimited(text) : [], null);
  };

  const rows = useMemo(() => rowsFromTable(table, roles, header), [table, roles, header]);
  const per = Math.max(1, Math.min(500, parseInt(perRecipient, 10) || 1));
  const body = { rows, mode, perRecipient: per, kind: 'person' as const, allowDuplicates };
  const hasPhone = roles.includes('phone');

  const preview = useMutation({
    mutationFn: () => previewDistribution(batch.id, body),
    onSuccess: (out) => setPlan(out),
    onError: (err) => toast.error(errorText(err)),
  });
  const commit = useMutation({
    mutationFn: () => importDistribution(batch.id, body),
    onSuccess: (out) => {
      toast.success(t('imported', { n: out.summary.created, skipped: out.summary.errors }));
      setPlan(null);
      setTable([]);
      setPasted('');
      setFileName(null);
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const setRole = (i: number, role: ColumnRole) =>
    setRoles((prev) => prev.map((r, k) => (k === i ? role : r !== 'ignore' && r === role ? 'ignore' : r)));
  const width = Math.max(0, ...table.slice(0, 20).map((r) => r.length));
  const sample = (header ? table.slice(1) : table).slice(0, 3);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <p className="text-sm text-muted-foreground">{t('intro')}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 rounded-lg border p-3">
            <p className="text-sm font-medium">{t('fromFile')}</p>
            <input ref={fileRef} type="file" accept=".xlsx,.csv,.tsv,.txt,text/csv" className="hidden"
              onChange={(e) => void onFile(e.target.files?.[0])} />
            <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={reading}>
              {reading ? <Loader2 className="animate-spin" aria-hidden /> : <Upload aria-hidden />}
              {t('chooseFile')}
            </Button>
            {fileName ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden /> {fileName}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">{t('fileHint')}</p>
          </div>
          <div className="space-y-2 rounded-lg border p-3">
            <Label htmlFor="vd-paste">{t('paste')}</Label>
            <textarea id="vd-paste" dir="auto" rows={4} value={pasted} onChange={(e) => onPaste(e.target.value)}
              placeholder={t('pastePlaceholder')}
              className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs" />
          </div>
        </div>

        {table.length ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{t('columns', { rows: rows.length })}</p>
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={header} onCheckedChange={(v) => { setHeader(!!v); setPlan(null); }} aria-label={t('firstRowHeader')} />
                {t('firstRowHeader')}
              </label>
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-muted/50">
                    {Array.from({ length: width }, (_, i) => (
                      <th key={i} className="p-1.5 text-start font-normal">
                        <select value={roles[i] ?? 'ignore'} aria-label={t('columnRole', { n: i + 1 })}
                          onChange={(e) => { setRole(i, e.target.value as ColumnRole); setPlan(null); }}
                          className="w-full rounded border bg-background px-1 py-0.5">
                          {ROLES.map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
                        </select>
                        {header ? <span className="mt-0.5 block truncate text-muted-foreground">{table[0]?.[i]}</span> : null}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sample.map((r, k) => (
                    <tr key={k} className="border-t">
                      {Array.from({ length: width }, (_, i) => <td key={i} className="p-1.5" dir="auto">{r[i]}</td>)}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!hasPhone ? <p className="text-xs text-destructive">{t('noPhoneColumn')}</p> : null}
          </div>
        ) : null}

        <fieldset className="space-y-2 rounded-lg border p-3">
          <legend className="px-1 text-sm font-medium">{t('modeTitle')}</legend>
          {(['group', 'count', 'one'] as const).map((m) => (
            <label key={m} className={cn('flex items-start gap-2 text-sm', m === 'group' && !overview.grouped && 'opacity-50')}>
              <input type="radio" name="vd-mode" className="mt-1" checked={mode === m} disabled={m === 'group' && !overview.grouped}
                onChange={() => {
                  setMode(m);
                  setPlan(null);
                  // A number column read without a header follows the mode: an envelope, or a count.
                  if (!header && m === 'group' && !roles.includes('group')) {
                    setRoles(roles.map((r) => (r === 'count' ? 'group' : r)));
                  } else if (!header && m === 'count' && !roles.includes('count')) {
                    setRoles(roles.map((r) => (r === 'group' ? 'count' : r)));
                  }
                }} />
              <span>
                {t(`mode.${m}`)}
                <span className="block text-xs text-muted-foreground">
                  {m === 'group' && !overview.grouped ? t('mode.groupUnavailable') : t(`modeHint.${m}`)}
                </span>
              </span>
              {m === 'count' && mode === 'count' ? (
                <Input type="number" min={1} max={500} value={perRecipient} className="ms-auto h-8 w-20"
                  aria-label={t('perRecipient')} onChange={(e) => { setPerRecipient(e.target.value); setPlan(null); }} />
              ) : null}
            </label>
          ))}
          <label className="flex items-center gap-2 pt-1 text-xs">
            <Switch checked={allowDuplicates} onCheckedChange={(v) => { setAllowDuplicates(!!v); setPlan(null); }}
              aria-label={t('allowDuplicates')} />
            {t('allowDuplicates')}
          </label>
          <p className="text-xs text-muted-foreground">
            {t('free', { free: overview.vouchers.free, total: overview.vouchers.total })}
          </p>
        </fieldset>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={!rows.length || !hasPhone || preview.isPending}
            onClick={() => preview.mutate()}>
            {preview.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('preview')}
          </Button>
          <Button type="button" disabled={!plan || plan.summary.ok === 0 || commit.isPending || overview.batchCancelled}
            onClick={() => commit.mutate()}>
            {commit.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
            {t('confirm', { n: plan?.summary.ok ?? 0 })}
          </Button>
        </div>

        {plan ? (
          <div className="space-y-2">
            <p className="text-sm">
              {t('summary', {
                ok: plan.summary.ok, errors: plan.summary.errors, warnings: plan.summary.warnings,
                assigned: plan.summary.vouchersAssigned, left: plan.summary.vouchersLeft,
              })}
            </p>
            {plan.summary.errors ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('errorsSkipped')}</p> : null}
            <div className="max-h-96 overflow-auto rounded-lg border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th className="p-1.5 text-start">#</th>
                    <th className="p-1.5 text-start">{t('col.name')}</th>
                    <th className="p-1.5 text-start">{t('col.phone')}</th>
                    <th className="p-1.5 text-start">{mode === 'group' ? t('col.group') : t('col.count')}</th>
                    <th className="p-1.5 text-start">{t('col.serials')}</th>
                    <th className="p-1.5 text-start">{t('col.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.rows.slice(0, PREVIEW_ROWS).map((r) => (
                    <tr key={r.row} className={cn('border-t', r.status === 'error' && 'bg-destructive/5')}>
                      <td className="p-1.5 tabular-nums">{r.row}</td>
                      <td className="p-1.5" dir="auto">{r.name}</td>
                      <td className="p-1.5 tabular-nums" dir="ltr">{r.phoneDisplay || r.phoneRaw}</td>
                      <td className="p-1.5 tabular-nums">{mode === 'group' ? r.group : r.count}</td>
                      <td className="p-1.5 tabular-nums" dir="ltr">{r.serialsText}</td>
                      <td className="p-1.5">
                        {r.status === 'ok' ? <span className="text-emerald-700 dark:text-emerald-400">{t('ok', { n: r.voucherCount })}</span> : null}
                        {[...r.problems, ...r.warnings].map((p) => (
                          <span key={p} className={cn('block', r.problems.includes(p) ? 'text-destructive' : 'text-amber-700 dark:text-amber-400')}>
                            {tp.has(p) ? tp(p) : p}
                          </span>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.rows.length > PREVIEW_ROWS ? (
              <p className="text-xs text-muted-foreground">{t('moreRows', { n: plan.rows.length - PREVIEW_ROWS })}</p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
