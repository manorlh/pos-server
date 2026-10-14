'use client';

/**
 * "בקשות אישור גם בשעות שקטות" (P:\specs\manager-approval-mobile.md §6): quiet hours hold the
 * approval pushes back too by default; this lets them through. The user's own preference
 * (`GET/PUT /users/me/preferences` → `approvalsInQuietHours`), saved as soon as it is switched —
 * only this key is sent. Shown to whoever may see the requests ("בקשות אישור").
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { fetchApprovalsInQuietHours, saveApprovalsInQuietHours } from '@/lib/approvalsApi';
import { Switch } from '@/components/ui/switch';

const KEY = ['approvals', 'quiet-hours-preference'] as const;

export function ApprovalsQuietHoursToggle() {
  const t = useTranslations('approvals.quiet');
  const qc = useQueryClient();
  const allowed = canAccess(useDashboardAccess(), 'approvals', 'view');
  const pref = useQuery({ queryKey: KEY, queryFn: fetchApprovalsInQuietHours, enabled: allowed, retry: false });
  const save = useMutation({
    mutationFn: (value: boolean) => saveApprovalsInQuietHours(value),
    onMutate: (value) => qc.setQueryData(KEY, value),
    onSuccess: (value) => {
      qc.setQueryData(KEY, value);
      toast.success(t('saved'));
    },
    onError: () => {
      toast.error(t('failed'));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  if (!allowed || pref.isError) return null;
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="min-w-0">
        <span className="block text-sm">{t('label')}</span>
        <span className="text-muted-foreground block text-xs">{t('hint')}</span>
      </span>
      <Switch
        checked={pref.data === true}
        disabled={pref.isPending || save.isPending}
        onCheckedChange={(v) => save.mutate(v)}
        aria-label={t('label')}
      />
    </div>
  );
}
