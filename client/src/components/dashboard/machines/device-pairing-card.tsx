'use client';

/**
 * "צימוד המכשיר" on the device page (pos-server P:/specs/foreign-records-upload.md §5, §6):
 *
 * - "לא מצומד — ממתין לצימוד מחדש": the device said it unpaired — when, who, why, what it had unsent.
 * - "קוד צימוד מחדש לקופה הזו": a code bound to this machine (same numbering, shift / Z, settings, license).
 * - "צימוד מכשיר לקופה הזו": claim a waiting device by its "קוד מכשיר" into this machine.
 * - "העבר מכשיר לקופה אחרת": the device of this machine moves to another (device command `move_pairing`).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  claimDeviceRequest,
  createRePairCode,
  fetchDeviceRequests,
  fetchMachines,
  moveDevicePairing,
  type RePairCode,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import type { PosMachine } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

function tillLabel(m: Pick<PosMachine, 'name' | 'posNumber'>): string {
  return m.posNumber ? `${m.posNumber} · ${m.name}` : m.name;
}

/** "לא מצומד — ממתין לצימוד מחדש" — for the list and the page header. */
export function UnpairedBadge({ m }: { m: Pick<PosMachine, 'unpairedAt'> }) {
  const t = useTranslations('devicePairing');
  if (!m.unpairedAt) return null;
  return (
    <Badge variant="destructive" title={formatDateTime(m.unpairedAt)}>
      {t('unpairedBadge')}
    </Badge>
  );
}

export function DevicePairingCard({ m, superAdmin }: { m: PosMachine; superAdmin: boolean }) {
  const t = useTranslations('devicePairing');
  const qc = useQueryClient();
  const [code, setCode] = useState<RePairCode | null>(null);
  const [deviceCode, setDeviceCode] = useState('');
  const [target, setTarget] = useState('');
  const [forced, setForced] = useState(false);
  const err = (e: unknown) => toast.error(t('error', { message: axiosErrorToToastMessage(e, '') }));

  const pending = useQuery({
    queryKey: ['device-requests', m.shopId ?? null],
    queryFn: () => fetchDeviceRequests({ shopId: m.shopId ?? undefined }),
    refetchInterval: 15_000,
  });
  const machines = useQuery({ queryKey: ['machines'], queryFn: fetchMachines, staleTime: 60_000 });

  const rePair = useMutation({
    mutationFn: () => createRePairCode(m.id),
    onSuccess: setCode,
    onError: err,
  });
  const claim = useMutation({
    mutationFn: (c: string) => claimDeviceRequest({ deviceCode: c, machineId: m.id }),
    onSuccess: (out) => {
      toast.success(t('claimed', { name: out.posNumber ?? out.machineName }));
      setDeviceCode('');
      void qc.invalidateQueries({ queryKey: ['device-requests'] });
      void qc.invalidateQueries({ queryKey: ['machine', m.id] });
    },
    onError: err,
  });
  const move = useMutation({
    mutationFn: () => moveDevicePairing(m.id, target, forced),
    onSuccess: () => toast.success(t('moveSent')),
    onError: err,
  });

  const doClaim = (c: string) => {
    if (c.trim() && window.confirm(t('claimConfirm', { code: c.trim(), name: tillLabel(m) }))) claim.mutate(c.trim());
  };
  const targets = (machines.data ?? []).filter(
    (x) => x.id !== m.id && x.tenantId === m.tenantId && x.isActive !== false,
  );
  const targetRow = targets.find((x) => x.id === target);
  const info = m.unpairedInfo;
  const device = info?.deviceInfo
    ? [info.deviceInfo.model, info.deviceInfo.platform].filter((v) => typeof v === 'string' && v).join(' · ')
    : '';

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          {t('title')}
          <UnpairedBadge m={m} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {m.unpairedAt ? (
          <div className="space-y-0.5 rounded-md border border-destructive/40 bg-destructive/5 p-3">
            <p className="font-medium">
              {t('unpairedLine', { at: formatDateTime(m.unpairedAt), by: m.unpairedBy ?? '—' })}
            </p>
            {info?.reason ? (
              <p className="text-xs">
                {t('unpairedReason', {
                  reason: ['manual', 'forced', 'cloud_move'].includes(info.reason) ? t(`reasons.${info.reason}`) : info.reason,
                })}
              </p>
            ) : null}
            {info?.pendingTotal ? <p className="text-xs">{t('unpairedPending', { count: info.pendingTotal })}</p> : null}
            {device ? <p className="text-xs text-muted-foreground">{t('unpairedDevice', { device })}</p> : null}
          </div>
        ) : null}

        <div className="space-y-1">
          <Button size="sm" variant="outline" onClick={() => rePair.mutate()} disabled={rePair.isPending}>
            {t('rePairCode')}
          </Button>
          <p className="text-xs text-muted-foreground">{t('rePairCodeHint')}</p>
          {code ? (
            <p className="font-mono text-base font-semibold" dir="ltr">
              {t('codeLine', { code: code.code, until: formatDateTime(code.expiresAt) })}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <p className="font-medium">{t('claimTitle')}</p>
          <p className="text-xs text-muted-foreground">{t('claimHint')}</p>
          <div className="flex max-w-sm gap-2">
            <Input
              dir="ltr"
              value={deviceCode}
              placeholder={t('deviceCodePlaceholder')}
              onChange={(e) => setDeviceCode(e.target.value.toUpperCase())}
              maxLength={8}
            />
            <Button size="sm" onClick={() => doClaim(deviceCode)} disabled={!deviceCode.trim() || claim.isPending}>
              {t('claim')}
            </Button>
          </div>
          <p className="text-xs font-medium text-muted-foreground">{t('pendingTitle')}</p>
          {(pending.data ?? []).length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('pendingEmpty')}</p>
          ) : (
            <ul className="space-y-1">
              {(pending.data ?? []).map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1">
                  <span className="text-xs">
                    {t('pendingRow', {
                      code: r.deviceCode,
                      model: r.model ?? r.platform ?? '—',
                      last: String(r.lastPairing?.posNumber ?? r.lastPairing?.machineName ?? '—'),
                    })}
                  </span>
                  <Button size="sm" variant="secondary" onClick={() => doClaim(r.deviceCode)} disabled={claim.isPending}>
                    {t('claim')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {!m.unpairedAt ? (
          <div className="space-y-2">
            <p className="font-medium">{t('moveTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('moveHint')}</p>
            <div className="flex max-w-md flex-wrap items-center gap-2">
              <select
                className="h-9 min-w-48 rounded-md border bg-background px-2 text-sm"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label={t('moveTarget')}
              >
                <option value="">{t('moveTarget')}</option>
                {targets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {tillLabel(x)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="outline"
                disabled={!target || move.isPending}
                onClick={() => {
                  if (targetRow && window.confirm(t('moveConfirm', { from: tillLabel(m), to: tillLabel(targetRow) }))) {
                    move.mutate();
                  }
                }}
              >
                {t('move')}
              </Button>
            </div>
            {superAdmin ? (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={forced} onChange={(e) => setForced(e.target.checked)} />
                {t('moveForced')}
              </label>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
