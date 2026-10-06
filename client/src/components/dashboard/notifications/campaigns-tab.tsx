'use client';

/**
 * "קמפיינים" — a skeleton for a later phase (P1): drafts can be listed and named, but
 * approving and sending are not available (the server refuses with
 * `campaigns_disabled`). The buttons are shown disabled with that explanation, so no
 * one looks for a "send to everyone" that does not exist.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Info, Plus, Send, ShieldCheck } from 'lucide-react';
import { createCampaign, fetchCampaigns } from '@/lib/notificationsApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { NC, formatWhen, useNcErrorText } from './shared';

export function CampaignsTab({ companyId }: { companyId: string | null }) {
  const t = useTranslations(`${NC}.campaigns`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [name, setName] = useState('');

  const list = useQuery({
    queryKey: ['notification-campaigns', companyId],
    queryFn: () => fetchCampaigns(companyId),
  });
  const create = useMutation({
    mutationFn: () => createCampaign(companyId as string, name.trim()),
    onSuccess: () => {
      setName('');
      toast.success(t('created'));
      void qc.invalidateQueries({ queryKey: ['notification-campaigns'] });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  return (
    <div className="space-y-4">
      <div role="note" className="flex gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">{t('notAvailableTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('notAvailableBody')}</p>
        </div>
      </div>

      {companyId ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !create.isPending) create.mutate();
          }}
        >
          <div className="min-w-[14rem] flex-1 space-y-1 sm:max-w-sm">
            <Label htmlFor="cmp-name">{t('name')}</Label>
            <Input id="cmp-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <Button type="submit" disabled={!name.trim() || create.isPending}>
            <Plus aria-hidden />
            {t('createDraft')}
          </Button>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">{t('pickCompany')}</p>
      )}

      {list.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(list.error)}
        </p>
      ) : (list.data?.items ?? []).length === 0 ? (
        <p className="rounded-lg border bg-muted/30 p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {(list.data?.items ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
              <span className="font-medium">{c.name}</span>
              <Badge variant="secondary">{t.has(`status.${c.status}`) ? t(`status.${c.status}`) : c.status}</Badge>
              <span className="text-xs text-muted-foreground">{formatWhen(c.createdAt)}</span>
              <span className="flex-1" />
              <Button size="sm" variant="outline" disabled title={t('disabledHint')}>
                <ShieldCheck aria-hidden />
                {t('approve')}
              </Button>
              <Button size="sm" disabled title={t('disabledHint')}>
                <Send aria-hidden />
                {t('send')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {(list.data?.items ?? []).length > 0 ? <p className="text-xs text-muted-foreground">{t('disabledHint')}</p> : null}
    </div>
  );
}
