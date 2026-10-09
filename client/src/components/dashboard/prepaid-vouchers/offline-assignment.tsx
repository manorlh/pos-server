'use client';

/**
 * "מימוש ללא אינטרנט" in the batch's settings (the production vouchers contract §7): the batch
 * assigned to one till, or to its shop's LAN host (the main till); while assigned, the cloud and
 * every other till refuse its vouchers. Released once the device synced everything — else only by
 * force, with a reason (audited).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, WifiOff } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  assignPrepaidOffline,
  fetchPrepaidOffline,
  fetchPrepaidOfflineTargets,
  releasePrepaidOffline,
  type PrepaidOfflineAssignment,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

const SELECT = 'h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm dark:bg-input/30';

function when(iso: string | null | undefined): string | null {
  return iso ? formatDateTime(iso) : null;
}

export function OfflineAssignmentPanel({ batch }: { batch: PrepaidVoucherBatch }) {
  const t = useTranslations('prepaidVouchers.offline');
  const tp = useTranslations('prepaidVouchers');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    if (typeof detail === 'string' && detail.startsWith('prepaid_voucher_') && tp.has(`errors.${detail}`)) return tp(`errors.${detail}`);
    return axiosErrorToToastMessage(err, tc('error'));
  };
  const state = useQuery({ queryKey: ['prepaid-voucher-offline', batch.id], queryFn: () => fetchPrepaidOffline(batch.id) });
  const assignment = state.data?.assignment ?? null;
  const targets = useQuery({
    queryKey: ['prepaid-voucher-offline-targets', batch.id],
    queryFn: () => fetchPrepaidOfflineTargets(batch.id),
    enabled: state.isSuccess && assignment === null,
  });
  // "m:<machineId>" a till, "h:<shopId>" a shop's LAN host.
  const [pick, setPick] = useState('');
  const [forcing, setForcing] = useState(false);
  const [reason, setReason] = useState('');
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-offline', batch.id] });
    void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', batch.id] });
  };
  const assign = useMutation({
    mutationFn: () => {
      const [kind, id] = pick.split(':');
      return assignPrepaidOffline(batch.id, kind === 'h' ? { target: 'lan_host', shopId: id } : { target: 'machine', machineId: id });
    },
    onSuccess: () => { toast.success(t('assigned')); setPick(''); refresh(); },
    onError: (err) => toast.error(errorText(err)),
  });
  const release = useMutation({
    mutationFn: (force: boolean) => releasePrepaidOffline(batch.id, force ? { force: true, reason: reason.trim() } : {}),
    onSuccess: () => { toast.success(t('released')); setForcing(false); setReason(''); refresh(); },
    onError: (err) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      if (detail === 'prepaid_voucher_offline_pending') setForcing(true);
      toast.error(errorText(err));
    },
  });

  const describe = (a: PrepaidOfflineAssignment) =>
    a.target === 'lan_host' ? t('targetLanHost', { name: a.machineName ?? '' }) : t('targetMachine', { name: a.machineName ?? '' });

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><WifiOff className="h-4 w-4" /> {t('title')}</p>
      {state.isPending ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : state.isError ? (
        <p className="text-xs text-destructive">{errorText(state.error)}</p>
      ) : assignment ? (
        <div className="space-y-2 text-sm">
          <p className="font-medium">{describe(assignment)}</p>
          <p className="text-xs text-muted-foreground">
            {[
              t('assignedAt', { at: when(assignment.assignedAt) ?? '' }),
              assignment.lastDownloadAt ? t('downloadedAt', { at: when(assignment.lastDownloadAt) ?? '' }) : t('notDownloaded'),
              assignment.lastSyncAt ? t('syncedAt', { at: when(assignment.lastSyncAt) ?? '' }) : null,
              assignment.lastSyncPending ? t('pending', { n: assignment.lastSyncPending }) : null,
            ].filter(Boolean).join(' · ')}
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-400">{t('whileAssigned')}</p>
          {forcing ? (
            <div className="space-y-1.5 rounded-lg border border-amber-300 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/30">
              <Label htmlFor={`pv-force-${batch.id}`} className="text-xs">{t('forceReason')}</Label>
              <textarea id={`pv-force-${batch.id}`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)}
                className="w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30" />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" disabled={!reason.trim() || release.isPending} onClick={() => release.mutate(true)}>
                  {release.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('forceRelease')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setForcing(false); setReason(''); }}>{tc('cancel')}</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={release.isPending} onClick={() => release.mutate(false)}>
              {release.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('release')}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('hint')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <select className={SELECT} value={pick} onChange={(e) => setPick(e.target.value)} aria-label={t('pick')}
              disabled={targets.isPending || batch.status === 'cancelled'}>
              <option value="">{targets.isPending ? tc('loading') : t('pick')}</option>
              {(targets.data?.shops ?? []).map((s) => (
                <optgroup key={s.shopId} label={s.shopName}>
                  {s.lanHost ? <option value={`h:${s.shopId}`}>{t('optionLanHost', { name: s.lanHost.name })}</option> : null}
                  {s.machines.map((m) => <option key={m.machineId} value={`m:${m.machineId}`}>{m.name}</option>)}
                </optgroup>
              ))}
            </select>
            <Button size="sm" className="h-9 shrink-0" disabled={!pick || assign.isPending} onClick={() => assign.mutate()}>
              {assign.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('assign')}
            </Button>
          </div>
          {targets.isSuccess && (targets.data?.shops ?? []).every((s) => s.machines.length === 0 && !s.lanHost) ? (
            <p className="text-xs text-muted-foreground">{t('noTargets')}</p>
          ) : null}
        </div>
      )}
      {(state.data?.history ?? []).filter((a) => a.status !== 'active').length > 0 ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('history')}</summary>
          <ul className="mt-1 space-y-0.5">
            {(state.data?.history ?? []).filter((a) => a.status !== 'active').map((a) => (
              <li key={a.id}>
                {describe(a)} · {when(a.assignedAt)} – {when(a.releasedAt)}
                {a.forced ? ` · ${t('forced', { reason: a.releaseReason ?? '' })}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
