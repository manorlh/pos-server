'use client';

/**
 * "מצב עבודה: קיוסק / קופה" of one kiosk (pos-server app/services/kiosk_till_mode.py;
 * P:/specs/kiosk-landscape-till-mode.md §5, P:/specs/web-till-spec-v2.md §6.6): the mode now and who
 * is on the till, the switch both ways as a non-blocking kiosk command (`enter_till` /
 * `return_kiosk` — the kiosk carries it out when no order or payment holds it, and says what holds
 * it meanwhile), and the owner's gate for a super admin or a distributor. Where the gate is closed
 * and the reader may not open it, nothing is drawn at all — the feature does not exist.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Monitor } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { setKioskTillModeGate, type KioskCommandIn, type KioskSummary } from '@/lib/kioskApi';

/** Who may open or close the owner's gate (`kioskTillModeEnabled`, admin only on the server too). */
const GATE_ROLES = ['super_admin', 'distributor'];

export function KioskWorkModeCard({
  kiosk,
  canWrite,
  busy,
  send,
}: {
  kiosk: KioskSummary;
  canWrite: boolean;
  busy: boolean;
  send: (body: KioskCommandIn) => void;
}) {
  const t = useTranslations('kiosks.workMode');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const role = useAuth((s) => s.user?.role ?? null);
  const mayGate = !!role && GATE_ROLES.includes(role);
  const till = kiosk.tillMode ?? null;
  const gate = useMutation({
    mutationFn: (enabled: boolean) => setKioskTillModeGate(kiosk.machineId, enabled),
    onSuccess: () => {
      toast.success(t('gateSaved'));
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  // An older server, or a closed gate the reader may not open: the feature does not exist here.
  if (!till || (!till.enabled && !mayGate)) return null;
  const inTill = till.mode === 'till';
  const display = kiosk.display;

  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('title')}</span>
        {till.enabled ? (
          <Badge variant={inTill ? 'default' : 'secondary'}>{t('now', { mode: t(inTill ? 'till' : 'kiosk') })}</Badge>
        ) : null}
        {inTill && till.employee ? <span className="text-sm text-muted-foreground">{t('employee', { name: till.employee })}</span> : null}
        {inTill && till.since ? <span className="text-xs text-muted-foreground">{t('since', { time: formatDateTime(till.since) })}</span> : null}
      </div>
      {till.enabled ? (
        <>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={inTill ? 'outline' : 'default'} disabled={!canWrite || busy || !inTill} onClick={() => send({ action: 'return_kiosk' })}>
              {t('toKiosk')}
            </Button>
            <Button size="sm" variant={inTill ? 'default' : 'outline'} disabled={!canWrite || busy || inTill} onClick={() => send({ action: 'enter_till' })}>
              {t('toTill')}
            </Button>
          </div>
          {till.blockedText ? <p className="text-xs text-amber-700 dark:text-amber-400">{till.blockedText}</p> : null}
          <p className="text-xs text-muted-foreground">{t('hint')}</p>
        </>
      ) : null}
      {mayGate ? (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={till.enabled} disabled={gate.isPending} onCheckedChange={(v) => gate.mutate(v)} />
          <span>{t('gate')}</span>
        </label>
      ) : null}
      {mayGate && !till.enabled ? <p className="text-xs text-muted-foreground">{t('gateHint')}</p> : null}
      {display?.widthDp && display.heightDp ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Monitor className="h-3.5 w-3.5" />
          {t('display', {
            orientation: t(`orientation.${display.orientation === 'landscape' ? 'landscape' : 'portrait'}`),
            size: display.diagonalInches ? `${display.diagonalInches}"` : display.sizeClass ?? '—',
            width: display.widthDp,
            height: display.heightDp,
          })}
        </p>
      ) : null}
    </div>
  );
}
