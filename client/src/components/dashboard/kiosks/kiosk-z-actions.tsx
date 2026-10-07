'use client';

/**
 * A kiosk's shift and Z by its Z mode (pos-server app/services/kiosk_z.py, docs/SPEC_KIOSK.md
 * §25): a kiosk in the shop Z is offered "סגירת משמרת" (its shift goes into the shop's next Z),
 * one with its own Z ("Z עצמאי" / "Z לכל קופה") "הפקת Z" — never both. Beside it: where the
 * last one stands (sent, waiting for a payment, closed, Z N…), and the kiosk's own "Z עצמאי"
 * switch — the same override as the shop's "קופות בזד הסניפי" card (super admin, clean break).
 * The rules are in lib/kioskZ.ts.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FilePlus2, Loader2, LogOut } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ForceCloseOption } from '@/components/dashboard/z-wizard/force-close-option';
import { cn } from '@/lib/utils';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import type { KioskCommandIn, KioskSummary } from '@/lib/kioskApi';
import { jobTone, kioskLastJob, kioskZOffer, zSwitchBody, zSwitchOf, type KioskJob, type KioskZKind } from '@/lib/kioskZ';
import { refusalOf } from '@/lib/zParticipation';
import { fetchZParticipation, saveZParticipation, zParticipationKey } from '@/lib/zParticipationApi';

const KIND_TONE: Record<KioskZKind, string> = {
  shop: 'border-sky-300 text-sky-800 dark:border-sky-800 dark:text-sky-200',
  independent: 'border-violet-300 text-violet-800 dark:border-violet-800 dark:text-violet-200',
  own: 'border-violet-300 text-violet-800 dark:border-violet-800 dark:text-violet-200',
};

const JOB_TONE: Record<string, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  wait: 'text-amber-700 dark:text-amber-400',
  bad: 'text-red-700 dark:text-red-400',
  muted: 'text-muted-foreground',
};

function kindOf(k: KioskSummary): KioskZKind {
  return kioskZOffer(k, true).kind;
}

/** "Z סניפי" / "Z עצמאי" / "Z לכל קופה" — the kiosk's Z mode, per device. */
export function KioskZBadge({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.z');
  const kind = kindOf(k);
  return (
    <Badge variant="outline" className={cn('whitespace-nowrap', KIND_TONE[kind])} title={t(`kindHint.${kind}`)}>
      {t(`kind.${kind}`)}
    </Badge>
  );
}

/** Where the last close / Z of the kiosk's own action stands. */
export function KioskZJobLine({ k }: { k: KioskSummary }) {
  const t = useTranslations('kiosks.z');
  const job = kioskLastJob(k);
  if (!job) return null;
  const which = kindOf(k) === 'shop' ? 'lastClose' : 'lastZ';
  return (
    <div className="space-y-0.5 text-xs">
      <p className={JOB_TONE[jobTone(job.state)]}>
        {t(which)}: {jobText(t, job)}
        {job.requestedAt ? <span className="text-muted-foreground"> · {formatDateTime(job.requestedAt)}</span> : null}
      </p>
      {job.state === 'done' && job.zReportId ? (
        <Link href={`/dashboard/z-reports/${job.zReportId}`} className="text-primary underline">
          {t('openZ')}
        </Link>
      ) : null}
      {job.printOn === 'controller' ? <p className="text-muted-foreground">{t('printOnController')}</p> : null}
    </div>
  );
}

function jobText(t: ReturnType<typeof useTranslations>, job: KioskJob): string {
  if (job.state === 'done') return job.zNumber != null ? t('state.doneZ', { n: job.zNumber }) : t('state.done');
  if (job.state === 'failed') return job.detail ? t('state.failedWhy', { why: job.detail }) : t('state.failed');
  return t.has(`state.${job.state}`) ? t(`state.${job.state}`) : (job.message ?? job.state);
}

/** The one shift / Z action of the kiosk, by its mode, in the kiosk's detail. */
export function KioskZActions({
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
  const t = useTranslations('kiosks.z');
  const [force, setForce] = useState(false);
  const offer = kioskZOffer(kiosk, canWrite);
  const isClose = offer.action === 'close_shift';
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('title')}</span>
        <KioskZBadge k={kiosk} />
      </div>
      <p className="text-xs text-muted-foreground">{t(`kindHint.${offer.kind}`)}</p>
      {canWrite ? (
        <>
          {!isClose ? <ForceCloseOption checked={force} onChange={setForce} disabled={busy || !offer.enabled} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={isClose ? 'outline' : 'default'}
              disabled={busy || !offer.enabled}
              onClick={() => {
                if (!window.confirm(t(isClose ? 'closeConfirm' : 'zConfirm'))) return;
                send(isClose ? { action: 'close_shift' } : { action: 'till_z', force });
                setForce(false);
              }}
            >
              {isClose ? <LogOut /> : <FilePlus2 />} {t(isClose ? 'closeShift' : 'tillZ')}
            </Button>
            {offer.block && offer.block !== 'no_write' ? (
              <span className="text-xs text-muted-foreground">{t(`block.${offer.block}`)}</span>
            ) : null}
          </div>
        </>
      ) : null}
      <KioskZJobLine k={kiosk} />
    </div>
  );
}

/**
 * "Z עצמאי לקיוסק הזה" — the per-device override, through the shop's "קופות בזד הסניפי"
 * (`PUT /shops/{id}/z-participation` naming this kiosk only). The super admin's alone, and
 * only with no open shift and no closed shift waiting for a Z; the server's refusal as is.
 */
export function KioskZModeSwitch({ kiosk }: { kiosk: KioskSummary }) {
  const t = useTranslations('kiosks.z');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const shopId = kiosk.shopId ?? '';
  const [refusal, setRefusal] = useState<string | null>(null);
  const card = useQuery({
    queryKey: zParticipationKey(shopId),
    queryFn: () => fetchZParticipation(shopId),
    enabled: !!shopId,
  });
  const row = card.data?.tills.find((x) => x.machineId === kiosk.machineId) ?? null;
  const kind = kindOf(kiosk);
  const sw = zSwitchOf(kind, card.data && row ? { canEdit: card.data.canEdit, openShift: row.openShift, awaitingZ: row.awaitingZ } : null);
  const save = useMutation({
    mutationFn: () => saveZParticipation(shopId, zSwitchBody(kiosk.machineId, sw.target)),
    onSuccess: (out) => {
      setRefusal(null);
      qc.setQueryData(zParticipationKey(shopId), out);
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['z-candidates'] });
      toast.success(t('switch.saved'));
    },
    onError: (err: unknown) => {
      const r = refusalOf(err);
      setRefusal(r?.message ?? null);
      if (!r?.message) toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });
  if (!shopId) return null;
  return (
    <div className="space-y-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-3">
        <span>
          <span className="block text-sm font-medium">{t('switch.label')}</span>
          <span className="block text-xs text-muted-foreground">{t('switch.hint')}</span>
        </span>
        {card.isLoading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Switch
            checked={kind === 'independent'}
            disabled={!sw.allowed || save.isPending}
            aria-label={t('switch.label')}
            onCheckedChange={() => {
              if (window.confirm(t(sw.target === 'independent' ? 'switch.confirmIndependent' : 'switch.confirmShop'))) save.mutate();
            }}
          />
        )}
      </div>
      {sw.block && sw.block !== 'unknown' ? <p className="text-xs text-muted-foreground">{t(`switch.block.${sw.block}`)}</p> : null}
      {kind === 'own' ? <p className="text-xs text-muted-foreground">{t('switch.ownNote')}</p> : null}
      {refusal ? <p className="text-xs text-red-700 dark:text-red-400">{refusal}</p> : null}
      <Link href={`/dashboard/shops/${shopId}`} className="text-xs text-primary underline">
        {t('switch.shopCard')}
      </Link>
    </div>
  );
}
