'use client';

/**
 * "ייבוא פריטים מאקסל" — a company's menu as a spreadsheet, for a dealer onboarding a
 * customer: download the blank template (pre-filled with the company's categories and
 * printers) or the current catalog, send the customer a 7-day download link, and import a
 * filled-in file — drop it, see row by row what would happen, confirm, done.
 *
 * Laid out the iOS way, like the compare board (dashboard/compare): a large title, a
 * grouped grey background with white rounded cards, inset lists, segmented controls; dark
 * mode too. The rules — matching, routing by printer name, permissions — are the server's:
 * pos-server app/services/catalog_import.py.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronLeft,
  Copy,
  Download,
  FileDown,
  FileSpreadsheet,
  Link2,
  Loader2,
  Mail,
  MessageCircle,
  RefreshCw,
} from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { useAuth } from '@/lib/auth';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import {
  commitCatalogImport,
  createCatalogShareLink,
  downloadCatalogTemplate,
  fetchCatalogImportSummary,
  importErrorDetail,
  previewCatalogImport,
  type ImportPreview,
  type ImportResult,
  type ShareLink,
} from '@/lib/catalogImportApi';
import {
  IOS,
  SF_FONT,
  IosButton,
  IosCard,
  IosHairline,
  IosRow,
  IosSectionHeader,
  IosSegmented,
} from '@/components/dashboard/products/catalog-import/ios';
import { DropZone } from '@/components/dashboard/products/catalog-import/drop-zone';
import {
  CategoryRows,
  ProductRows,
  type RowFilter,
} from '@/components/dashboard/products/catalog-import/preview-rows';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** Where the import stands; a preview or a result belongs to the company it was made for. */
type Step =
  | { kind: 'idle' }
  | { kind: 'preview'; companyId: string | null; file: File; preview: ImportPreview }
  | { kind: 'done'; companyId: string | null; result: ImportResult };

type Download = 'blank' | 'current' | 'csv';

const FILTERS: RowFilter[] = ['all', 'create', 'update', 'warning', 'error', 'unchanged'];

function formatExpiry(iso: string): string {
  return formatDateTime(iso);
}

/** A count on the preview, iOS-widget style: a coloured label over a large figure. */
function Tile({
  label,
  value,
  color,
  active,
  onClick,
}: {
  label: string;
  value: number;
  color: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'flex flex-col items-start gap-0.5 rounded-[18px] bg-white px-3.5 py-3 text-start shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_16px_rgba(0,0,0,0.04)] transition-shadow dark:bg-[#1C1C1E] dark:shadow-none',
        active && 'ring-2',
        !onClick && 'cursor-default',
      )}
      style={active ? ({ '--tw-ring-color': color } as React.CSSProperties) : undefined}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-semibold" style={{ color }}>
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
        {label}
      </span>
      <span
        className={cn('text-[26px] font-bold leading-tight tabular-nums', value === 0 && 'text-[#C7C7CC] dark:text-[#48484A]')}
      >
        {value.toLocaleString('he-IL')}
      </span>
    </button>
  );
}

export default function CatalogImportPage() {
  const t = useTranslations('catalogImport');
  const qc = useQueryClient();
  const { user } = useAuth();
  const { scope, effective } = usePageScope({ maxLevel: 'company' });

  // One company's catalog: the one in scope, else the user's own, else the only one.
  const companies = scope.companies;
  const companyId =
    effective.companyId ??
    (user?.role === 'company_manager' ? user.companyId : undefined) ??
    (companies.length === 1 ? companies[0].id : undefined) ??
    null;
  const mustChoose = !companyId && companies.length > 1;

  const summary = useQuery({
    queryKey: ['catalog-import-summary', companyId],
    queryFn: () => fetchCatalogImportSummary(companyId),
    enabled: !mustChoose && !scope.companiesLoading,
    retry: false,
  });
  const forbidden = importErrorDetail(summary.error)?.code === 'forbidden';
  const companyName = summary.data?.companyName ?? '';

  const [stepState, setStep] = useState<Step>({ kind: 'idle' });
  const [tab, setTab] = useState<'products' | 'categories'>('products');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [shareState, setShare] = useState<(ShareLink & { forCompany: string | null }) | null>(null);
  // Another company picked in the scope bar: what was shown for the previous one is gone.
  const step: Step = stepState.kind !== 'idle' && stepState.companyId !== companyId ? { kind: 'idle' } : stepState;
  const share = shareState && shareState.forCompany === companyId ? shareState : null;

  // ── downloads ──
  const download = useMutation({
    mutationFn: (kind: Download) =>
      downloadCatalogTemplate(
        { companyId, withData: kind !== 'blank', format: kind === 'csv' ? 'csv' : 'xlsx' },
        kind === 'blank'
          ? t('template.fileBlank', { company: companyName })
          : kind === 'csv'
            ? t('template.fileCsv', { company: companyName })
            : t('template.fileCurrent', { company: companyName }),
      ),
    onError: (err: unknown) => toast.error(err instanceof Error && err.message ? err.message : t('template.error')),
  });

  // ── the share link ──
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('share.copied'));
    } catch {
      toast.error(t('share.copyFailed'));
    }
  };
  const makeLink = useMutation({
    mutationFn: () => createCatalogShareLink(companyId),
    onSuccess: (link) => {
      setShare({ ...link, forCompany: companyId });
      void copy(link.link);
    },
    onError: (err: unknown) =>
      toast.error(importErrorDetail(err)?.msg ?? axiosErrorToToastMessage(err, t('share.error'))),
  });
  const shareMessage = share
    ? t('share.message', { company: share.companyName, date: formatExpiry(share.expiresAt), link: share.link })
    : '';

  // ── preview and commit ──
  const resetRows = () => {
    setTab('products');
    setFilter('all');
  };
  const check = useMutation({
    mutationFn: (file: File) => previewCatalogImport(file, companyId).then((preview) => ({ file, preview })),
    onSuccess: ({ file, preview }) => {
      setStep({ kind: 'preview', companyId, file, preview });
      resetRows();
      if (preview.products.length === 0 && preview.categories.length > 0) setTab('categories');
    },
    onError: (err: unknown) => toast.error(importErrorDetail(err)?.msg ?? axiosErrorToToastMessage(err, t('drop.error'))),
  });

  const commit = useMutation({
    mutationFn: (args: { file: File; token: string; skipErrors: boolean }) =>
      commitCatalogImport(args.file, { companyId, token: args.token, skipErrors: args.skipErrors }),
    onSuccess: (result) => {
      setConfirmOpen(false);
      setStep({ kind: 'done', companyId, result });
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['catalog-import-summary'] });
      qc.invalidateQueries({ queryKey: ['kitchen-printer-routing'] });
    },
    onError: (err: unknown, args) => {
      setConfirmOpen(false);
      const detail = importErrorDetail(err);
      if (detail?.code === 'plan_changed' && detail.preview) {
        setStep({ kind: 'preview', companyId, file: args.file, preview: detail.preview });
        toast.warning(t('commit.planChanged'));
        return;
      }
      if (detail?.code === 'token_expired' || detail?.code === 'token_invalid' || detail?.code === 'file_changed') {
        toast.info(t('commit.recheck'));
        check.mutate(args.file);
        return;
      }
      toast.error(detail?.msg ?? axiosErrorToToastMessage(err, t('commit.error')));
    },
  });

  const preview = step.kind === 'preview' ? step.preview : null;
  const s = preview?.summary;
  const fileErrors = preview?.issues.filter((i) => i.level === 'error') ?? [];
  const rowErrors = preview ? (s?.errors ?? 0) - fileErrors.length : 0;
  const actionable = (s?.productsNew ?? 0) + (s?.productsUpdated ?? 0) + (s?.categoriesNew ?? 0) +
    (s?.categoriesUpdated ?? 0) + (s?.routingChanges ?? 0);
  const canImport = !!preview && preview.canCommit && fileErrors.length === 0;

  const confirmLines: string[] = [];
  if (s) {
    if (s.productsNew) confirmLines.push(t('commit.confirmCreate', { count: s.productsNew }));
    if (s.productsUpdated) confirmLines.push(t('commit.confirmUpdate', { count: s.productsUpdated }));
    if (s.categoriesNew) confirmLines.push(t('commit.confirmCategories', { count: s.categoriesNew }));
    if (s.categoriesUpdated) confirmLines.push(t('commit.confirmCategoriesUpdated', { count: s.categoriesUpdated }));
    if (s.routingChanges) {
      confirmLines.push(t('commit.confirmRouting', { count: s.routingChanges, shops: s.routingShops }));
    }
    if (rowErrors > 0) confirmLines.push(t('commit.confirmSkip', { count: rowErrors }));
  }

  const resultLines = (r: ImportResult): string[] => {
    const lines: string[] = [];
    if (r.productsCreated) lines.push(t('result.productsCreated', { count: r.productsCreated }));
    if (r.productsUpdated) lines.push(t('result.productsUpdated', { count: r.productsUpdated }));
    if (r.categoriesCreated) lines.push(t('result.categoriesCreated', { count: r.categoriesCreated }));
    if (r.categoriesUpdated) lines.push(t('result.categoriesUpdated', { count: r.categoriesUpdated }));
    if (r.routingChanges) lines.push(t('result.routingChanges', { count: r.routingChanges }));
    if (r.costsUpdated) lines.push(t('result.costsUpdated', { count: r.costsUpdated }));
    if (r.skippedErrorRows) lines.push(t('result.skipped', { count: r.skippedErrorRows }));
    return lines;
  };

  const startOver = () => {
    setStep({ kind: 'idle' });
    resetRows();
  };

  const busyDownload = download.isPending ? download.variables : null;

  return (
    <div
      className="-mx-2 rounded-[28px] bg-[#F2F2F7] px-3 pb-8 pt-4 text-black antialiased dark:bg-black dark:text-white sm:mx-0 sm:px-5"
      style={{ fontFamily: SF_FONT }}
    >
      {/* Large title */}
      <div className="flex items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold uppercase tracking-wide text-[#8E8E93]">
            {companyName ? t('kicker', { company: companyName }) : ' '}
          </p>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">{t('title')}</h1>
          {summary.data ? (
            <p className="text-[15px] text-[#8E8E93]">
              {t('stats', {
                products: summary.data.products,
                categories: summary.data.categories,
                printers: summary.data.printers.length,
              })}
            </p>
          ) : null}
        </div>
        <Link
          href="/dashboard/products"
          className="mb-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-white px-3 py-2 text-[15px] font-medium text-[#007AFF] shadow-sm active:opacity-60 dark:bg-[#1C1C1E]"
        >
          <ArrowRight className="h-4 w-4" />
          {t('back')}
        </Link>
      </div>

      {mustChoose ? (
        <>
          <IosSectionHeader>{t('chooseCompanyTitle')}</IosSectionHeader>
          <IosCard className="p-0">
            <p className="px-4 pb-1 pt-3 text-[13px] text-[#8E8E93]">{t('chooseCompanyHint')}</p>
            {companies.map((c, i) => (
              <IosRow
                key={c.id}
                first={i === 0}
                icon={<Building2 />}
                iconColor={IOS.indigo}
                title={c.name}
                onClick={() => scope.setCompany(c.id)}
                trailing={<ChevronLeft className="h-5 w-5 text-[#C7C7CC]" />}
              />
            ))}
          </IosCard>
        </>
      ) : forbidden ? (
        <IosCard className="mt-5 text-center text-[15px] text-[#8E8E93]">{t('noPermission')}</IosCard>
      ) : summary.isLoading || scope.companiesLoading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-[112px] animate-pulse rounded-[22px] bg-white dark:bg-[#1C1C1E]" />
          ))}
        </div>
      ) : (
        <>
          {/* Template and catalog */}
          <IosSectionHeader>{t('sections.template')}</IosSectionHeader>
          <IosCard className="overflow-hidden p-0">
            <IosRow
              first
              icon={<FileSpreadsheet />}
              iconColor={IOS.green}
              title={t('template.blank')}
              subtitle={t('template.blankHint')}
              onClick={() => download.mutate('blank')}
              disabled={download.isPending}
              trailing={
                busyDownload === 'blank' ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#007AFF]" />
                ) : (
                  <Download className="h-5 w-5 text-[#007AFF]" />
                )
              }
            />
            <IosRow
              icon={<FileDown />}
              iconColor={IOS.blue}
              title={t('template.current')}
              subtitle={t('template.currentHint', { count: summary.data?.products ?? 0 })}
              onClick={() => download.mutate('current')}
              disabled={download.isPending}
              trailing={
                busyDownload === 'current' ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#007AFF]" />
                ) : (
                  <Download className="h-5 w-5 text-[#007AFF]" />
                )
              }
            />
            <IosRow
              icon={<FileDown />}
              iconColor={IOS.grey}
              title={t('template.csvLabel')}
              subtitle={t('template.csvHint')}
              onClick={() => download.mutate('csv')}
              disabled={download.isPending}
              trailing={
                busyDownload === 'csv' ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#007AFF]" />
                ) : (
                  <Download className="h-5 w-5 text-[#007AFF]" />
                )
              }
            />
          </IosCard>
          {summary.data ? (
            <p className="mt-1.5 px-4 text-[13px] leading-snug text-[#6D6D72] dark:text-[#8E8E93]">
              {summary.data.printers.length > 0
                ? t('template.printersNote', {
                    list: summary.data.printers
                      .map((p) => (summary.data.shops > 1 ? `${p.name} (${p.shopName})` : p.name))
                      .join(', '),
                  })
                : t('template.printersNone')}
            </p>
          ) : null}

          {/* Send to the customer */}
          <IosSectionHeader>{t('sections.share')}</IosSectionHeader>
          <IosCard className="overflow-hidden p-0">
            <IosRow
              first
              icon={<Link2 />}
              iconColor={IOS.orange}
              title={makeLink.isPending ? t('share.creating') : t('share.copy')}
              subtitle={t('share.copyHint')}
              onClick={() => makeLink.mutate()}
              disabled={makeLink.isPending}
              trailing={
                makeLink.isPending ? (
                  <Loader2 className="h-5 w-5 animate-spin text-[#007AFF]" />
                ) : (
                  <Copy className="h-5 w-5 text-[#007AFF]" />
                )
              }
            />
            {share ? (
              <div className="relative space-y-3 px-4 pb-4 pt-3">
                <IosHairline />
                <label className="block space-y-1">
                  <span className="text-[13px] text-[#8E8E93]">{t('share.linkLabel')}</span>
                  <input
                    readOnly
                    dir="ltr"
                    value={share.link}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full rounded-[10px] bg-[#7676801F] px-3 py-2 font-mono text-[13px] outline-none"
                  />
                </label>
                <p className="text-[13px] font-medium" style={{ color: IOS.orange }}>
                  {t('share.validUntil', { date: formatExpiry(share.expiresAt) })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <IosButton variant="tinted" onClick={() => void copy(share.link)}>
                    <Copy />
                    {t('share.again')}
                  </IosButton>
                  <a
                    href={`https://wa.me/?text=${encodeURIComponent(shareMessage)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-[12px] px-4 text-[15px] font-semibold text-white active:opacity-60"
                    style={{ backgroundColor: IOS.whatsapp }}
                  >
                    <MessageCircle className="h-4 w-4" />
                    {t('share.whatsapp')}
                  </a>
                  <a
                    href={`mailto:?subject=${encodeURIComponent(t('share.subject', { company: share.companyName }))}&body=${encodeURIComponent(shareMessage)}`}
                    className="inline-flex min-h-10 items-center gap-1.5 rounded-[12px] px-4 text-[15px] font-semibold active:opacity-60"
                    style={{ backgroundColor: `${IOS.blue}1F`, color: IOS.blue }}
                  >
                    <Mail className="h-4 w-4" />
                    {t('share.email')}
                  </a>
                </div>
              </div>
            ) : null}
          </IosCard>

          {/* Import */}
          {step.kind === 'idle' ? (
            <>
              <IosSectionHeader>{t('sections.import')}</IosSectionHeader>
              <IosCard>
                <DropZone onFile={(file) => check.mutate(file)} busy={check.isPending} />
              </IosCard>
            </>
          ) : null}

          {preview && s ? (
            <>
              <IosSectionHeader
                trailing={
                  <IosButton variant="plain" onClick={startOver} disabled={commit.isPending}>
                    <RefreshCw />
                    {t('preview.replace')}
                  </IosButton>
                }
              >
                {t('sections.preview')}
              </IosSectionHeader>
              <IosCard className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-[#34C759]/15 text-[#34C759]">
                    <FileSpreadsheet className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <div className="truncate text-[17px] font-semibold" dir="auto">{preview.fileName}</div>
                    <div className="text-[13px] text-[#8E8E93]">
                      {preview.companyName}
                      {s.examplesSkipped ? ` · ${t('preview.examples', { count: s.examplesSkipped })}` : ''}
                    </div>
                  </div>
                </div>
                {preview.issues.length > 0 ? (
                  <ul className="space-y-1">
                    {preview.issues.map((issue, i) => (
                      <li
                        key={i}
                        className={cn(
                          'rounded-[12px] px-3 py-2 text-[13px]',
                          issue.level === 'error'
                            ? 'bg-[#FF3B30]/10 text-[#D70015] dark:text-[#FF6961]'
                            : 'bg-[#FF9500]/10 text-[#A05A00] dark:text-[#FFD60A]',
                        )}
                      >
                        {issue.text}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </IosCard>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
                <Tile label={t('preview.tiles.productsNew')} value={s.productsNew} color={IOS.green}
                  active={tab === 'products' && filter === 'create'}
                  onClick={() => { setTab('products'); setFilter('create'); }} />
                <Tile label={t('preview.tiles.productsUpdated')} value={s.productsUpdated} color={IOS.blue}
                  active={tab === 'products' && filter === 'update'}
                  onClick={() => { setTab('products'); setFilter('update'); }} />
                <Tile label={t('preview.tiles.productsUnchanged')} value={s.productsUnchanged} color={IOS.grey}
                  active={tab === 'products' && filter === 'unchanged'}
                  onClick={() => { setTab('products'); setFilter('unchanged'); }} />
                <Tile label={t('preview.tiles.categoriesNew')} value={s.categoriesNew} color={IOS.teal}
                  active={tab === 'categories' && filter === 'create'}
                  onClick={() => { setTab('categories'); setFilter('create'); }} />
                <Tile label={t('preview.tiles.routingChanges')} value={s.routingChanges} color={IOS.indigo} />
                <Tile label={t('preview.tiles.warnings')} value={s.warnings} color={IOS.orange}
                  active={filter === 'warning'} onClick={() => setFilter('warning')} />
                <Tile label={t('preview.tiles.errors')} value={s.errors} color={IOS.red}
                  active={filter === 'error'} onClick={() => setFilter('error')} />
              </div>

              <IosSectionHeader>{t('sections.rows')}</IosSectionHeader>
              <div className="space-y-2 px-1">
                <IosSegmented
                  value={tab}
                  onChange={setTab}
                  options={[
                    { id: 'products', label: t('preview.tabs.products', { count: preview.products.length }) },
                    { id: 'categories', label: t('preview.tabs.categories', { count: preview.categories.length }) },
                  ]}
                />
                <div className="overflow-x-auto pb-1">
                  <IosSegmented
                    value={filter}
                    onChange={setFilter}
                    className="min-w-[420px]"
                    options={FILTERS.map((f) => ({ id: f, label: t(`preview.filters.${f}`) }))}
                  />
                </div>
              </div>
              <IosCard className="mt-2 overflow-hidden p-0">
                {tab === 'products' ? (
                  <ProductRows key={`p-${preview.token}`} rows={preview.products} filter={filter} />
                ) : (
                  <CategoryRows rows={preview.categories} filter={filter} />
                )}
              </IosCard>

              {/* The action bar */}
              <div className="sticky bottom-3 z-10 mt-4">
                <IosCard className="flex flex-col gap-3 bg-white/90 backdrop-blur-xl sm:flex-row sm:items-center sm:justify-between dark:bg-[#1C1C1E]/90">
                  <p className="text-[13px] text-[#6D6D72] dark:text-[#8E8E93]">
                    {fileErrors.length > 0
                      ? t('commit.fileErrors')
                      : rowErrors > 0
                        ? t('commit.blockedByErrors', { count: rowErrors })
                        : actionable === 0
                          ? t('preview.nothing')
                          : confirmLines.join(' · ')}
                  </p>
                  <IosButton
                    onClick={() => setConfirmOpen(true)}
                    disabled={!canImport || commit.isPending || check.isPending}
                    className="shrink-0"
                  >
                    {commit.isPending ? <Loader2 className="animate-spin" /> : null}
                    {rowErrors > 0 ? t('commit.buttonSkipping') : t('commit.button')}
                  </IosButton>
                </IosCard>
              </div>
            </>
          ) : null}

          {step.kind === 'done' ? (
            <>
              <IosSectionHeader>{t('sections.result')}</IosSectionHeader>
              <IosCard className="flex flex-col items-center gap-3 py-8 text-center">
                <CheckCircle2 className="h-14 w-14" style={{ color: IOS.green }} />
                <h2 className="text-[22px] font-bold">{t('result.title')}</h2>
                {resultLines(step.result).length === 0 ? (
                  <p className="text-[15px] text-[#8E8E93]">{t('result.nothing')}</p>
                ) : (
                  <ul className="space-y-1 text-[17px]">
                    {resultLines(step.result).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <p className="text-[13px] text-[#8E8E93]">{t('result.tills', { count: step.result.machinesNotified })}</p>
                <div className="mt-2 flex flex-wrap justify-center gap-2">
                  <Link
                    href="/dashboard/products"
                    className="inline-flex min-h-10 items-center rounded-[12px] px-4 text-[15px] font-semibold text-white active:opacity-60"
                    style={{ backgroundColor: IOS.blue }}
                  >
                    {t('result.toProducts')}
                  </Link>
                  <IosButton variant="tinted" onClick={startOver}>
                    {t('result.another')}
                  </IosButton>
                </div>
              </IosCard>
            </>
          ) : null}
        </>
      )}

      <Dialog open={confirmOpen} onOpenChange={(open) => !commit.isPending && setConfirmOpen(open)}>
        <DialogContent className="max-w-md" style={{ fontFamily: SF_FONT }}>
          <DialogHeader>
            <DialogTitle>{t('commit.confirmTitle')}</DialogTitle>
          </DialogHeader>
          <ul className="space-y-1.5 text-[15px]">
            {confirmLines.map((line) => (
              <li key={line} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: IOS.blue }} />
                {line}
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted-foreground">{t('commit.confirmScope')}</p>
          <DialogFooter>
            <IosButton variant="tinted" onClick={() => setConfirmOpen(false)} disabled={commit.isPending}>
              {t('commit.cancel')}
            </IosButton>
            <IosButton
              onClick={() =>
                step.kind === 'preview' &&
                commit.mutate({ file: step.file, token: step.preview.token, skipErrors: rowErrors > 0 })
              }
              disabled={commit.isPending}
            >
              {commit.isPending ? <Loader2 className="animate-spin" /> : null}
              {commit.isPending ? t('commit.importing') : rowErrors > 0 ? t('commit.buttonSkipping') : t('commit.button')}
            </IosButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
