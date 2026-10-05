'use client';

/**
 * "מעבר לעבודה אמיתית" — the wizard that turns a shop's training mode off
 * (docs/SPEC_TRAINING_MODE.md, "כיבוי מצב ההדרכה"):
 *
 *   1. בדיקות — every till synced, no table open. Either may be overridden with
 *      "הבנתי, להמשיך בכל זאת" (sent as `force`); a training shift still open does not block.
 *   2. סיכום — what will be deleted, and what stays.
 *   3. בחירות — remove the demo menu (when one is loaded), then on to the real menu's import.
 *      Resetting the stock the practice sales moved is a later phase.
 *   4. אישור — the shop's name, typed.
 *   5. סיום — what was deleted; the tills follow on their next sync.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  disableTrainingMode,
  fetchTrainingDisablePreview,
  type TrainingDisablePreview,
  type TrainingDisableResult,
} from '@/lib/trainingModeApi';
import {
  apiErrorInfo,
  canPassChecks,
  confirmNameMatches,
  deletionEntries,
  deletionTotal,
  pendingOf,
  splitBlockers,
  tableLabel,
  type TrainingDeletionCounts,
} from '@/lib/trainingMode';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useDemoCountsText } from '@/components/dashboard/demo-menu-card';
import { useTrainingTillLabel } from '@/components/dashboard/training-badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const IMPORT_HREF = '/dashboard/products/import';
const STEPS = ['checks', 'summary', 'choices', 'confirm', 'done'] as const;
type Step = (typeof STEPS)[number];

export function TrainingModeDisableWizard({
  shopId,
  shopName,
  open,
  onOpenChange,
}: {
  shopId: string;
  shopName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {/* Mounted only while open: every run starts from fresh checks and a clean slate. */}
        {open ? <Wizard shopId={shopId} shopName={shopName} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** "HH:MM" today, "dd/MM HH:MM" before that. */
function formatAsOf(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function Wizard({ shopId, shopName, onClose }: { shopId: string; shopName: string; onClose: () => void }) {
  const t = useTranslations('trainingMode.wizard');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();

  const [step, setStep] = useState<Step>('checks');
  const [force, setForce] = useState(false);
  // Null until touched: the demo menu is removed by default when one is loaded.
  const [removeDemo, setRemoveDemo] = useState<boolean | null>(null);
  const [goImport, setGoImport] = useState(false);
  const [typed, setTyped] = useState('');
  const [nameRefused, setNameRefused] = useState(false);
  const [result, setResult] = useState<TrainingDisableResult | null>(null);

  const preview = useQuery({
    queryKey: ['training-disable-preview', shopId],
    queryFn: () => fetchTrainingDisablePreview(shopId),
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const p = preview.data;
  const name = (p?.shopName || shopName).trim();
  const demoLoaded = !!p?.demoMenu?.loaded;
  const willRemoveDemo = demoLoaded && (removeDemo ?? true);

  const disable = useMutation({
    mutationFn: () =>
      disableTrainingMode(shopId, { confirmName: typed.trim(), removeDemoMenu: willRemoveDemo, force }),
    onSuccess: (out) => {
      setResult(out);
      setStep('done');
      // The response carries the new status; the preview is fetched afresh on the next run.
      qc.setQueryData(['training-mode', shopId], out.status);
      void qc.invalidateQueries({ queryKey: ['shops'] });
      void qc.invalidateQueries({ queryKey: ['training-report', shopId] });
      if (out.demoMenu) {
        void qc.invalidateQueries({ queryKey: ['demo-menu-status'] });
        void qc.invalidateQueries({ queryKey: ['products'] });
        void qc.invalidateQueries({ queryKey: ['categories'] });
      }
      toast.success(t('done.toast'));
    },
    onError: (err: unknown) => {
      const { status, code } = apiErrorInfo(err);
      if (code === 'name_mismatch') {
        setNameRefused(true);
        return;
      }
      if (code === 'blockers') {
        // Something changed since the checks: show them again, and ask again.
        toast.warning(t('confirm.blockersChanged'));
        setForce(false);
        setStep('checks');
        void preview.refetch();
        return;
      }
      if (code === 'not_in_training') {
        toast.info(t('notInTraining'));
        void qc.invalidateQueries({ queryKey: ['shops'] });
        void qc.invalidateQueries({ queryKey: ['training-mode', shopId] });
        onClose();
        return;
      }
      toast.error(status === 403 ? t('forbidden') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const next = () => setStep((s) => STEPS[Math.min(STEPS.indexOf(s) + 1, STEPS.length - 1)]);
  const back = () => setStep((s) => STEPS[Math.max(STEPS.indexOf(s) - 1, 0)]);

  const nameOk = confirmNameMatches(typed, name);
  const ready = !!p && p.trainingMode;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
        <StepBar step={step} />
      </DialogHeader>

      <div className="min-h-32 space-y-3 text-sm">
        {step === 'done' && result ? (
          <DoneStep result={result} />
        ) : preview.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : preview.isError || !p ? (
          <p className="text-destructive">{axiosErrorToToastMessage(preview.error, t('loadError'))}</p>
        ) : !p.trainingMode ? (
          <p className="text-muted-foreground">{t('notInTraining')}</p>
        ) : step === 'checks' ? (
          <ChecksStep
            preview={p}
            force={force}
            onForce={setForce}
            refreshing={preview.isFetching}
            onRefresh={() => void preview.refetch()}
          />
        ) : step === 'summary' ? (
          <SummaryStep counts={p.counts} />
        ) : step === 'choices' ? (
          <ChoicesStep
            preview={p}
            removeDemo={willRemoveDemo}
            onRemoveDemo={setRemoveDemo}
            goImport={goImport}
            onGoImport={setGoImport}
          />
        ) : (
          <ConfirmStep
            name={name}
            typed={typed}
            onTyped={(v) => {
              setTyped(v);
              setNameRefused(false);
            }}
            refused={nameRefused}
            onSubmit={() => {
              if (nameOk && !disable.isPending) disable.mutate();
            }}
          />
        )}
      </div>

      <DialogFooter>
        {step === 'done' ? (
          goImport ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {t('close')}
              </Button>
              <Button
                onClick={() => {
                  onClose();
                  router.push(IMPORT_HREF);
                }}
              >
                {t('done.import')}
              </Button>
            </>
          ) : (
            <Button onClick={onClose}>{t('close')}</Button>
          )
        ) : (
          <>
            {step === 'checks' ? (
              <Button variant="outline" onClick={onClose}>
                {tc('cancel')}
              </Button>
            ) : (
              <Button variant="outline" onClick={back} disabled={disable.isPending}>
                {t('back')}
              </Button>
            )}
            {step === 'confirm' ? (
              <Button variant="destructive" onClick={() => disable.mutate()} disabled={!ready || !nameOk || disable.isPending}>
                {disable.isPending ? t('confirm.working') : t('confirm.submit')}
              </Button>
            ) : (
              <Button
                onClick={next}
                disabled={!ready || (step === 'checks' && (preview.isFetching || !canPassChecks(p?.blockers, force)))}
              >
                {t('next')}
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  );
}

function StepBar({ step }: { step: Step }) {
  const t = useTranslations('trainingMode.wizard.steps');
  const at = STEPS.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-xs" aria-label={t('label')}>
      {STEPS.map((s, i) => (
        <li key={s} className="flex items-center gap-1" aria-current={i === at ? 'step' : undefined}>
          <span
            className={cn(
              'inline-flex h-5 w-5 items-center justify-center rounded-full border text-[0.7rem] tabular-nums',
              i < at && 'border-orange-500 bg-orange-500 text-white',
              i === at && 'border-orange-500 text-orange-700 dark:text-orange-300',
              i > at && 'text-muted-foreground',
            )}
          >
            {i + 1}
          </span>
          <span className={i === at ? 'font-medium' : 'text-muted-foreground'}>{t(s)}</span>
          {i < STEPS.length - 1 ? <span className="px-0.5 text-muted-foreground">‹</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Ok({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function Blocked({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <li className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="flex items-start gap-2 font-medium text-amber-800 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {title}
      </p>
      <div className="ps-6">{children}</div>
    </li>
  );
}

function ChecksStep({
  preview,
  force,
  onForce,
  refreshing,
  onRefresh,
}: {
  preview: TrainingDisablePreview;
  force: boolean;
  onForce: (v: boolean) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const t = useTranslations('trainingMode.wizard.checks');
  const tw = useTranslations('trainingMode.wizard');
  const tillLabel = useTrainingTillLabel();
  const { unsyncedTills, openTables } = splitBlockers(preview.blockers);
  const blocked = (preview.blockers ?? []).length > 0;
  const tableNames = (openTables?.tables ?? []).map(tableLabel).filter((x): x is string => !!x);

  return (
    <>
      <ul className="space-y-2">
        {unsyncedTills.length === 0 ? (
          <Ok>{t('allSynced')}</Ok>
        ) : (
          <Blocked title={t('unsyncedTitle')}>
            <ul className="space-y-0.5">
              {unsyncedTills.map((b) => {
                const pending = pendingOf(b);
                const asOf = formatAsOf(b.asOf);
                return (
                  <li key={b.machineId}>
                    <span className="font-medium">{tillLabel(b)}</span>
                    {' — '}
                    {pending === null ? t('pendingUnknown') : t('pending', { count: pending })}
                    {' · '}
                    <span className="text-muted-foreground">{asOf ? t('asOf', { time: asOf }) : t('asOfUnknown')}</span>
                  </li>
                );
              })}
            </ul>
          </Blocked>
        )}
        {!openTables || openTables.count === 0 ? (
          <Ok>{t('noOpenTables')}</Ok>
        ) : (
          <Blocked title={t('openTablesTitle', { count: openTables.count })}>
            {tableNames.length > 0 ? <p>{t('tables', { list: tableNames.join(', ') })}</p> : null}
          </Blocked>
        )}
      </ul>
      <p className="text-xs text-muted-foreground">{t('trainingShift')}</p>
      {blocked ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs">{t('blockersNote')}</p>
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={force} onChange={(e) => onForce(e.target.checked)} />
            {t('force')}
          </label>
        </div>
      ) : null}
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} aria-hidden />
          {tw('refresh')}
        </Button>
      </div>
    </>
  );
}

function DeletionList({ counts }: { counts: Partial<TrainingDeletionCounts> }) {
  const t = useTranslations('trainingMode.wizard.summary');
  return (
    <ul className="list-inside list-disc space-y-0.5">
      {deletionEntries(counts).map(([k, n]) => (
        <li key={k} className={n === 0 ? 'text-muted-foreground' : undefined}>
          {t(`delete.${k}`, { count: n })}
        </li>
      ))}
    </ul>
  );
}

function SummaryStep({ counts }: { counts: TrainingDisablePreview['counts'] }) {
  const t = useTranslations('trainingMode.wizard.summary');
  return (
    <>
      <div className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3">
        <p className="font-medium">{t('deleteTitle')}</p>
        {deletionTotal(counts) === 0 ? <p className="text-muted-foreground">{t('nothing')}</p> : <DeletionList counts={counts} />}
      </div>
      <div className="space-y-1 rounded-md border bg-muted/30 p-3">
        <p className="font-medium">{t('keepTitle')}</p>
        <p>{t('keep')}</p>
        <p className="text-xs text-muted-foreground">{t('realUntouched')}</p>
      </div>
    </>
  );
}

function ChoicesStep({
  preview,
  removeDemo,
  onRemoveDemo,
  goImport,
  onGoImport,
}: {
  preview: TrainingDisablePreview;
  removeDemo: boolean;
  onRemoveDemo: (v: boolean) => void;
  goImport: boolean;
  onGoImport: (v: boolean) => void;
}) {
  const t = useTranslations('trainingMode.wizard.choices');
  const td = useTranslations('demoMenu');
  const counts = useDemoCountsText();
  const loads = preview.demoMenu?.loads ?? [];
  return (
    <>
      <div className="space-y-2 rounded-md border p-3">
        {preview.demoMenu?.loaded ? (
          <>
            <label className="flex items-center gap-2 font-medium">
              <input type="checkbox" checked={removeDemo} onChange={(e) => onRemoveDemo(e.target.checked)} />
              {t('removeDemo')}
            </label>
            <ul className="space-y-1 ps-6 text-xs">
              {loads.map((load) => (
                <li key={load.loadId}>
                  <span className="font-medium">{load.templateName || load.template}</span>
                  {' · '}
                  <span className="text-muted-foreground">
                    {td('loadedAt', { at: formatDateTime(load.createdAt) })} ·{' '}
                    {load.shopId ? td('scopeShop') : td('scopeCompany')}
                  </span>
                  {counts.text(load.counts) ? <span className="block">{counts.text(load.counts)}</span> : null}
                </li>
              ))}
            </ul>
            <p className="ps-6 text-xs text-muted-foreground">{removeDemo ? t('removeDemoHint') : t('keepDemoHint')}</p>
          </>
        ) : (
          <p className="text-muted-foreground">{t('noDemo')}</p>
        )}
      </div>
      <div className="space-y-1 rounded-md border p-3 opacity-60">
        <label className="flex items-center gap-2">
          <input type="checkbox" disabled checked={false} readOnly />
          {t('resetStock')}
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{t('soon')}</span>
        </label>
      </div>
      <div className="space-y-1 rounded-md border p-3">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={goImport} onChange={(e) => onGoImport(e.target.checked)} />
          {t('goImport')}
        </label>
        <p className="ps-6 text-xs text-muted-foreground">{t('importHint')}</p>
      </div>
    </>
  );
}

function ConfirmStep({
  name,
  typed,
  onTyped,
  refused,
  onSubmit,
}: {
  name: string;
  typed: string;
  onTyped: (v: string) => void;
  refused: boolean;
  onSubmit: () => void;
}) {
  const t = useTranslations('trainingMode.wizard.confirm');
  const mismatch = refused || (typed.trim().length > 0 && !confirmNameMatches(typed, name) && typed.trim().length >= name.length);
  return (
    <>
      <p className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-destructive">{t('irreversible')}</p>
      <label htmlFor="training-confirm-name" className="block">
        {t('prompt')} <span className="font-semibold">{name}</span>
      </label>
      <Input
        id="training-confirm-name"
        value={typed}
        autoComplete="off"
        placeholder={t('placeholder')}
        aria-invalid={mismatch || undefined}
        onChange={(e) => onTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit();
        }}
      />
      {mismatch ? <p className="text-xs text-destructive">{t('mismatch')}</p> : null}
    </>
  );
}

function DoneStep({ result }: { result: TrainingDisableResult }) {
  const t = useTranslations('trainingMode.wizard.done');
  const counts = useDemoCountsText();
  const demo = result.demoMenu;
  const demoDeleted = counts.text(demo?.deleted);
  const demoDeactivated = counts.text(demo?.deactivated);
  const demoKept = counts.text(demo?.kept);
  return (
    <>
      <p className="flex items-center gap-2 text-base font-medium">
        <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden />
        {t('title')}
      </p>
      <div className="space-y-1 rounded-md border bg-muted/30 p-3">
        <p className="font-medium">{t('deleted')}</p>
        {deletionTotal(result.deleted) === 0 ? (
          <p className="text-muted-foreground">{t('nothingDeleted')}</p>
        ) : (
          <DeletionList counts={result.deleted} />
        )}
      </div>
      {demo ? (
        <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
          <p className="text-sm font-medium">{t('demoTitle')}</p>
          {demoDeleted ? <p>{t('demoDeleted', { items: demoDeleted })}</p> : null}
          {demoDeactivated ? <p className="text-amber-700 dark:text-amber-400">{t('demoDeactivated', { items: demoDeactivated })}</p> : null}
          {demoKept ? <p className="text-muted-foreground">{t('demoKept', { items: demoKept })}</p> : null}
          {!demoDeleted && !demoDeactivated && !demoKept ? <p className="text-muted-foreground">{t('demoNothing')}</p> : null}
        </div>
      ) : null}
      <p>{t('tills')}</p>
      <p className="text-xs text-muted-foreground">
        {t('importLead')}{' '}
        <Link href={IMPORT_HREF} className={cn(buttonVariants({ variant: 'link', size: 'sm' }), 'h-auto p-0')}>
          {t('import')}
        </Link>
      </p>
    </>
  );
}
