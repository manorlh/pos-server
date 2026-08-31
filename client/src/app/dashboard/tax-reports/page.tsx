'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, FileText, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import {
  downloadTaxOpenFormat,
  fetchTaxOpenFormatPreview,
  type TaxOpenFormatParams,
} from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import type { TaxOpenFormatPreview } from '@/lib/types';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function TaxReportsPage() {
  const t = useTranslations('taxReports');
  const tc = useTranslations('common');

  /**
   * The export's own "scope" select is gone: the endpoint's two modes map exactly
   * onto the shared scope's two levels, so a shop in scope exports that shop and a
   * company in scope exports the company's shops. A device cannot be exported —
   * the tax authority's format is per business, not per till — so `machine` is
   * above this page's `maxLevel` and is reported as not narrowing it.
   */
  const { resolution, effective, scope: sharedScope } = usePageScope({
    maxLevel: 'shop',
    minLevel: 'company',
  });
  const shopId = effective.shopId ?? '';
  const companyId = effective.companyId ?? '';
  const exportScope: 'shop' | 'company' = shopId ? 'shop' : 'company';
  const scopeLabel = shopId
    ? sharedScope.shop?.name ?? shopId
    : sharedScope.company?.name ?? companyId;

  const [mode, setMode] = useState<'date-range' | 'year'>('date-range');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [isExporting, setIsExporting] = useState(false);
  const [preview, setPreview] = useState<TaxOpenFormatPreview | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const entityReady = exportScope === 'shop' ? Boolean(shopId) : Boolean(companyId);
  const datesReady = mode === 'year' ? Boolean(year) : Boolean(from && to);

  function buildParams(): TaxOpenFormatParams | null {
    if (!entityReady || !datesReady) return null;
    const base: TaxOpenFormatParams = {
      scope: exportScope,
      mode,
      ...(exportScope === 'shop' ? { shopId } : { companyId }),
    };
    if (mode === 'year') {
      return { ...base, year: parseInt(year, 10) };
    }
    return { ...base, from, to };
  }

  const handleExport = async () => {
    const params = buildParams();
    if (!params) {
      setExportError(t('selectFilters'));
      return;
    }

    setIsExporting(true);
    setExportError(null);
    setPreview(null);

    try {
      const previewResult = await fetchTaxOpenFormatPreview(params);
      setPreview(previewResult);

      const blob = await downloadTaxOpenFormat(params);
      const vat8 = (previewResult.businessInfo.vatNumber || '00000000').replace(/\D/g, '').slice(0, 8).padStart(8, '0');
      const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(4, 12);
      triggerBlobDownload(blob, `OPENFRMT-${vat8}-${ts}.zip`);
      toast.success(t('exportSuccess'));
    } catch (err: unknown) {
      const msg = axiosErrorToToastMessage(err, tc('error'));
      setExportError(msg);
      toast.error(msg);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FileText className="size-6" />
          {t('title')}
        </h1>
        <p className="text-muted-foreground text-sm mt-1">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
        <Card>
          <CardHeader>
            <CardTitle>{t('exportSettings')}</CardTitle>
            <CardDescription>{t('exportSettingsHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('scope')}</Label>
              <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  {exportScope === 'shop' ? t('scopeShop') : t('scopeCompany')}
                </span>
                <span aria-hidden className="text-border">
                  ·
                </span>
                <span className="font-medium">{scopeLabel || '—'}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t('exportMode')}</Label>
              <Select value={mode} onValueChange={(v) => v && setMode(v as 'date-range' | 'year')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="date-range" label={t('modeDateRange')}>
                    {t('modeDateRange')}
                  </SelectItem>
                  <SelectItem value="year" label={t('modeYear')}>
                    {t('modeYear')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === 'date-range' ? (
              <div className="flex flex-wrap gap-4">
                <div className="space-y-1">
                  <Label>{t('from')}</Label>
                  <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>{t('to')}</Label>
                  <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
                </div>
              </div>
            ) : (
              <div className="space-y-1 max-w-[200px]">
                <Label>{t('taxYear')}</Label>
                <Input
                  type="number"
                  min={2000}
                  max={2100}
                  value={year}
                  onChange={(e) => setYear(e.target.value)}
                />
              </div>
            )}

            <Button
              className="w-full sm:w-auto"
              disabled={!entityReady || !datesReady || isExporting}
              onClick={() => void handleExport()}
            >
              {isExporting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('exporting')}
                </>
              ) : (
                <>
                  <Download className="size-4" />
                  {t('export')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {exportError && (
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertCircle className="size-4" />
              {tc('error')}
            </div>
            <p className="mt-1 text-muted-foreground">{exportError}</p>
          </div>
        )}

        {preview && (
          <div className="rounded-lg border bg-muted/30 p-4 text-sm space-y-2">
            <div className="flex items-center gap-2 font-medium">
              <CheckCircle className="size-4 text-green-600" />
              {t('exportComplete')}
            </div>
            <p className="text-muted-foreground">
              {t('summary', {
                transactions: preview.transactionCount,
                vat: preview.businessInfo.vatNumber || '—',
                rate: preview.globalTaxRate,
              })}
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1">
              {Object.entries(preview.recordCounts).map(([type, count]) => (
                <div key={type} className="rounded border px-2 py-1 bg-background">
                  <span className="font-mono text-xs">{type}</span>
                  <span className="ms-2 font-semibold">{count}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </ScopeGate>
    </div>
  );
}
