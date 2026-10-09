'use client';

/**
 * A local shop Z's verification against the cloud's documents. The Z is stored exactly as
 * printed; every till part carries a manifest the till and the cloud compute the same way,
 * and the cloud compares only once every document it names has arrived. Until then a till
 * part waits ("ממתין למסמכים מקופה N"); a dead, removed or 24 h-late till is incomplete,
 * for support to close ("סגירה ע״י התמיכה"); a mismatch — everything arrived and the same
 * computation disagrees — is a bug, its figures for super admins only.
 * pos-server `GET /shops/{s}/local-shop-zs/{z}/verification`, `POST …/tills/{m}/close`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  canSupportCloseTill,
  countOf,
  isLatePart,
  latePartTitleOf,
  verificationRowKey,
  verificationListBadgeOf,
  verificationOf,
  verificationToneOf,
  type VerificationTone,
} from '@/lib/localShopZ';
import { recheckLocalShopZ, supportCloseLocalShopZTill } from '@/lib/localShopZRequestApi';
import type { ZReport, ZReportDetail, ZVerification, ZVerificationTill } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { ZMismatchTable } from '@/components/dashboard/z-report/z-exception-details';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const TONE_BADGE: Record<VerificationTone, string> = {
  success: 'border-green-600/40 bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300',
  pending: 'border-sky-500/40 bg-sky-50 text-sky-800 dark:bg-sky-950/40 dark:text-sky-300',
  warning: 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300',
  error: 'border-destructive/50 bg-destructive/10 text-destructive',
  muted: 'border-border bg-muted text-muted-foreground',
};

function StateBadge({ state, className }: { state: string; className?: string }) {
  const t = useTranslations('independentTill.verification');
  const label = t.has(`state.${state}`) ? t(`state.${state}`) : state;
  return (
    <Badge variant="outline" className={cn('text-[11px]', TONE_BADGE[verificationToneOf(state)], className)}>
      {label}
    </Badge>
  );
}

/** The Z list's (and ZBadges') small badge: waiting, unsynced, or — super admin — a mismatch. */
export function ZVerificationBadge({ z }: { z: Pick<ZReport, 'verification'> }) {
  const t = useTranslations('independentTill.verification');
  const isSuperAdmin = useIsSuperAdmin();
  const key = verificationListBadgeOf(z.verification, isSuperAdmin);
  if (!key) return null;
  const tone = verificationToneOf(z.verification?.state);
  return (
    <Badge
      variant="outline"
      className={cn('ms-2 text-[11px]', TONE_BADGE[tone])}
      title={z.verification?.message ?? undefined}
    >
      {t(`listBadge.${key}`)}
    </Badge>
  );
}

export function ZVerificationPanel({ z }: { z: ZReportDetail }) {
  const t = useTranslations('independentTill.verification');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  // "בדוק שוב" / a support close answer with the object; shown until the Z reloads.
  const [fresh, setFresh] = useState<ZVerification | null>(null);
  const [closing, setClosing] = useState<ZVerificationTill | null>(null);
  const [note, setNote] = useState('');
  const v = fresh ?? verificationOf(z);
  const shopId = z.shopId ?? '';

  const settle = (out: ZVerification) => {
    setFresh(out);
    void qc.invalidateQueries({ queryKey: ['z-report', z.id] });
    void qc.invalidateQueries({ queryKey: ['z-reports'] });
  };
  const recheck = useMutation({
    mutationFn: () => recheckLocalShopZ(shopId, z.id),
    onSuccess: settle,
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const close = useMutation({
    mutationFn: (till: ZVerificationTill) =>
      supportCloseLocalShopZTill(shopId, z.id, till.machineId, note.trim(), isLatePart(till)),
    onSuccess: (out) => {
      setClosing(null);
      setNote('');
      settle(out);
      toast.success(t('closed'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (!v) return null;
  const tone = verificationToneOf(v.state);
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'pending' ? Clock : tone === 'muted' ? ShieldCheck : AlertTriangle;
  // A till's "late documents" part goes by its label, never as a second "קופה N".
  const tillLabel = (x: ZVerificationTill) =>
    latePartTitleOf(x) ?? (x.posNumber ? t('till', { n: x.posNumber }) : x.machineId.slice(0, 8));

  return (
    <div className="space-y-3 rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            <Icon
              className={cn(
                'h-4 w-4 shrink-0',
                tone === 'success' && 'text-green-600',
                tone === 'warning' && 'text-amber-600',
                tone === 'error' && 'text-destructive',
              )}
              aria-hidden
            />
            {t('title')}
            <StateBadge state={v.state} />
          </div>
          {v.message ? <p>{v.message}</p> : null}
          {v.checkedAt ? (
            <p className="text-xs text-muted-foreground">{t('checkedAt', { at: formatDateTime(v.checkedAt) })}</p>
          ) : null}
        </div>
        {shopId ? (
          <Button size="sm" variant="outline" disabled={recheck.isPending} onClick={() => recheck.mutate()}>
            <RefreshCw className={cn('h-3.5 w-3.5', recheck.isPending && 'animate-spin')} aria-hidden />
            {recheck.isPending ? t('rechecking') : t('recheck')}
          </Button>
        ) : null}
      </div>

      {(v.tills ?? []).length > 0 ? (
        <ul className="divide-y rounded-md border">
          {(v.tills ?? []).map((x) => {
            const support = x.closedBySupport;
            const missingDocs = countOf(support?.missingDocuments);
            const missingShifts = countOf(support?.missingShiftIds);
            const totals = support?.printedTotals
              ? Object.entries(support.printedTotals)
                  .map(([k, val]) => `${k} ${String(val)}`)
                  .join(' · ')
              : '';
            return (
              <li key={verificationRowKey(x)} className="space-y-1 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{tillLabel(x)}</span>
                    <StateBadge state={x.state} />
                    {x.reason && t.has(`reason.${x.reason}`) ? (
                      <span className="text-xs text-muted-foreground">{t(`reason.${x.reason}`)}</span>
                    ) : null}
                  </span>
                  {isSuperAdmin && shopId && canSupportCloseTill(x) ? (
                    <Button size="sm" variant="outline" className="h-7" onClick={() => setClosing(x)}>
                      {t('supportClose')}
                    </Button>
                  ) : null}
                </div>
                {x.message ? <p className="text-xs">{x.message}</p> : null}
                <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  {x.named != null ? <span>{t('counts', { arrived: x.arrived ?? 0, named: x.named })}</span> : null}
                  {x.missing ? <span>· {t('missing', { n: x.missing })}</span> : null}
                  {x.shiftsAwaited ? <span>· {t('shiftsAwaited', { n: x.shiftsAwaited })}</span> : null}
                </p>
                {support ? (
                  <div className="space-y-0.5 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                    <p>{t('closedBy', { by: support.by ?? '—', at: formatDateTime(support.at) })}</p>
                    {support.note ? <p>{t('closedNote', { note: support.note })}</p> : null}
                    {missingDocs ? <p>{t('closedMissingDocs', { n: missingDocs })}</p> : null}
                    {missingShifts ? <p>{t('closedMissingShifts', { n: missingShifts })}</p> : null}
                    {totals ? <p dir="auto">{t('printedTotals', { totals })}</p> : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {/* Everything arrived and the same computation disagrees: a bug, for support only. */}
      {v.state === 'mismatch' && isSuperAdmin && (v.discrepancies ?? []).length > 0 ? (
        <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-2">
          <p className="font-medium text-destructive">{t('discrepanciesTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('discrepanciesHint')}</p>
          <ZMismatchTable details={{ discrepancies: v.discrepancies }} />
        </div>
      ) : null}

      <Dialog
        open={closing !== null}
        onOpenChange={(open) => {
          if (!open && !close.isPending) {
            setClosing(null);
            setNote('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{closing ? t('closeTitle', { till: tillLabel(closing) }) : ''}</DialogTitle>
            <DialogDescription>{t('closeText')}</DialogDescription>
          </DialogHeader>
          {closing?.message ? <p className="text-xs text-muted-foreground">{closing.message}</p> : null}
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">{t('note')}</span>
            <textarea
              className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-sm"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={close.isPending} onClick={() => setClosing(null)}>
              {t('cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={close.isPending || !closing}
              onClick={() => closing && close.mutate(closing)}
            >
              {close.isPending ? t('closing') : t('confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
