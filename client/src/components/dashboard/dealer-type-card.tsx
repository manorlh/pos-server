'use client';

/**
 * "סוג עוסק" on the company page (docs/SPEC_BUSINESS_TYPE.md): the type, who changed it
 * and when (with every earlier change), and — for an exempt dealer — the year's turnover
 * against the exempt dealer's ceiling, warning as it gets close and once it is passed.
 *
 * The ceiling is a platform setting, set by law and updated every year, so the super
 * admin edits it here rather than it being written into the code.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, BadgeCheck, Receipt } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { dealerTypeOf, parseThreshold, turnoverPercent, type DealerTurnover } from '@/lib/dealerType';
import { fetchDealerTurnover, fetchDealerTypeSettings, saveDealerTypeSettings } from '@/lib/dealerTypeApi';
import type { Company } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** The type as a small badge: an exempt dealer stands out, it changes what the tills issue. */
export function DealerTypeBadge({ company }: { company: Pick<Company, 'dealerType'> }) {
  const t = useTranslations('businessType');
  const type = dealerTypeOf(company.dealerType);
  return (
    <Badge variant={type === 'exempt' ? 'secondary' : 'outline'} className="gap-1">
      {type === 'exempt' ? <Receipt className="h-3 w-3" aria-hidden /> : <BadgeCheck className="h-3 w-3" aria-hidden />}
      {t(type)}
    </Badge>
  );
}

export function DealerTypeCard({ company }: { company: Company }) {
  const t = useTranslations('businessType');
  const type = dealerTypeOf(company.dealerType);
  const history = company.dealerTypeHistory ?? [];
  const last = history.length ? history[history.length - 1] : null;
  const [showHistory, setShowHistory] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {t('title')}
          <DealerTypeBadge company={company} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{t(`${type}Hint`)}</p>
        {company.dealerTypeChangedAt ? (
          <p className="text-xs text-muted-foreground">
            {last?.byName
              ? t('changedBy', { at: formatDateTime(company.dealerTypeChangedAt), name: last.byName })
              : t('changedAt', { at: formatDateTime(company.dealerTypeChangedAt) })}
            {history.length > 1 ? (
              <>
                {' · '}
                <button type="button" className="underline" onClick={() => setShowHistory((v) => !v)}>
                  {t('historyTitle')}
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        {showHistory ? (
          <ul className="space-y-0.5 text-xs text-muted-foreground">
            {history.map((h, i) => (
              <li key={`${h.at}-${i}`}>
                {t('historyRow', {
                  at: formatDateTime(h.at),
                  from: t(dealerTypeOf(h.from)),
                  to: t(dealerTypeOf(h.to)),
                  name: h.byName ?? '—',
                })}
              </li>
            ))}
          </ul>
        ) : null}
        {type === 'exempt' ? <ExemptTurnover companyId={company.id} /> : null}
      </CardContent>
    </Card>
  );
}

function ExemptTurnover({ companyId }: { companyId: string }) {
  const t = useTranslations('businessType');
  const isSuperAdmin = useAuth((s) => s.user?.role === 'super_admin');
  const [editOpen, setEditOpen] = useState(false);
  const { data } = useQuery<DealerTurnover>({
    queryKey: ['dealer-turnover', companyId],
    queryFn: () => fetchDealerTurnover(companyId),
  });
  if (!data) return null;
  const percent = turnoverPercent(data);
  const tone =
    data.status === 'exceeded'
      ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100'
      : data.status === 'approaching'
        ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100'
        : 'border-border';

  return (
    <div className={cn('space-y-2 rounded-md border p-3', tone)}>
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium">{t('turnoverTitle', { year: data.year })}</p>
        {isSuperAdmin ? (
          <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
            {t('editThreshold')}
          </Button>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-xs opacity-75">{t('turnover')}</p>
          <p className="font-semibold">{formatCurrency(data.turnover)}</p>
        </div>
        <div>
          <p className="text-xs opacity-75">{t('threshold')}</p>
          <p className="font-semibold">{data.threshold ? formatCurrency(data.threshold) : t('thresholdUnset')}</p>
        </div>
      </div>
      {data.threshold && percent != null ? (
        <>
          <div className="h-2 w-full overflow-hidden rounded bg-muted" aria-hidden>
            <div
              className={cn(
                'h-full',
                data.status === 'exceeded' ? 'bg-red-600' : data.status === 'approaching' ? 'bg-amber-500' : 'bg-emerald-600',
              )}
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
          <p className="flex items-start gap-1.5 text-xs">
            {data.status !== 'ok' ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
            {data.status === 'exceeded'
              ? t('statusExceeded', { percent })
              : data.status === 'approaching'
                ? t('statusApproaching', { percent })
                : t('statusOk', { percent })}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{t('thresholdUnsetHint')}</p>
      )}
      {isSuperAdmin ? <ThresholdDialog open={editOpen} onOpenChange={setEditOpen} /> : null}
    </div>
  );
}

function ThresholdDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">{open ? <ThresholdForm onOpenChange={onOpenChange} /> : null}</DialogContent>
    </Dialog>
  );
}

function ThresholdForm({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const t = useTranslations('businessType');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['dealer-type-settings'], queryFn: fetchDealerTypeSettings });
  const [threshold, setThreshold] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const thresholdText = threshold ?? (data?.exemptTurnoverThreshold != null ? String(data.exemptTurnoverThreshold) : '');
  const warnText = warn ?? String(Math.round((data?.warnRatio ?? 0.8) * 100));
  const parsed = parseThreshold(thresholdText);
  const warnPercent = Number(warnText);
  const valid = parsed.ok && Number.isFinite(warnPercent) && warnPercent > 0 && warnPercent <= 100;

  const save = useMutation({
    mutationFn: () =>
      saveDealerTypeSettings({
        exemptTurnoverThreshold: parsed.ok ? parsed.value : null,
        warnRatio: warnPercent / 100,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['dealer-type-settings'] });
      qc.invalidateQueries({ queryKey: ['dealer-turnover'] });
      toast.success(t('thresholdSaved'));
      onOpenChange(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('editThreshold')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">{t('thresholdUnsetHint')}</p>
        <div className="space-y-1">
          <Label htmlFor="dealer-threshold">{t('thresholdLabel')}</Label>
          <Input
            id="dealer-threshold"
            inputMode="decimal"
            value={thresholdText}
            onChange={(e) => setThreshold(e.target.value)}
          />
          {!parsed.ok ? <p className="text-xs text-destructive">{t('thresholdInvalid')}</p> : null}
        </div>
        <div className="space-y-1">
          <Label htmlFor="dealer-warn">{t('warnRatioLabel')}</Label>
          <Input id="dealer-warn" inputMode="numeric" value={warnText} onChange={(e) => setWarn(e.target.value)} />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => save.mutate()} disabled={!valid || save.isPending}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
