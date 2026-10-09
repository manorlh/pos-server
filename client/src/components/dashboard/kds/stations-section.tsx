'use client';

/**
 * The shop's kitchen stations as the KDS sees them (pos-server SPEC_KDS.md §3): the
 * stations themselves are the printers module's (one list, one routing for printing
 * and KDS); per shop, each is a preparation station (its tasks are required for
 * "ready") or view only, with the orange / red thresholds of its screen.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { saveStation, type KdsShopOverview, type KdsStation, type KdsTargetKind } from '@/lib/kdsApi';
import { errorCodeOf } from '@/lib/workflowMode';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const WARN_MAX = 240;
const LATE_MAX = 480;

export function StationsSection({ shopId, overview }: { shopId: string; overview: KdsShopOverview }) {
  const t = useTranslations('kds.page.stations');
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{t('title')}</h2>
      <p className="text-sm text-muted-foreground">{t('hint')}</p>
      {overview.stations.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('empty')}{' '}
          <Link href="/dashboard/kitchen-printers" className="font-medium text-primary hover:underline">
            {t('printersLink')}
          </Link>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.name')}</TableHead>
                <TableHead>{t('columns.kind')}</TableHead>
                <TableHead>{t('columns.warn')}</TableHead>
                <TableHead>{t('columns.late')}</TableHead>
                <TableHead>{t('columns.screen')}</TableHead>
                <TableHead>{t('columns.printers')}</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {overview.stations.map((s) => (
                <StationRow
                  key={`${s.id}:${s.targetKind}:${s.warnMinutes}:${s.lateMinutes}`}
                  shopId={shopId}
                  station={s}
                  canEdit={overview.canEdit}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

function StationRow({ shopId, station, canEdit }: { shopId: string; station: KdsStation; canEdit: boolean }) {
  const t = useTranslations('kds.page.stations');
  const tk = useTranslations('kds');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [kind, setKind] = useState<KdsTargetKind>(station.targetKind);
  const [warn, setWarn] = useState(String(station.warnMinutes));
  const [late, setLate] = useState(String(station.lateMinutes));

  const w = Number(warn);
  const l = Number(late);
  const invalid =
    !Number.isInteger(w) || !Number.isInteger(l) || w < 1 || w > WARN_MAX || l < 1 || l > LATE_MAX || l < w;
  const dirty = kind !== station.targetKind || w !== station.warnMinutes || l !== station.lateMinutes;

  const save = useMutation({
    mutationFn: () => saveStation(shopId, station.id, { targetKind: kind, warnMinutes: w, lateMinutes: l }),
    onSuccess: (next) => {
      toast.success(t('saved'));
      qc.setQueryData<KdsShopOverview>(['kds-shop', shopId], (prev) => ({ ...next, canEdit: prev?.canEdit ?? true }));
      qc.invalidateQueries({ queryKey: ['kds-board', shopId] });
    },
    onError: (err: unknown) => {
      const code = errorCodeOf(err);
      toast.error(code && tk.has(`errors.${code}`) ? tk(`errors.${code}`) : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  return (
    <TableRow>
      <TableCell className="font-medium">{station.name}</TableCell>
      <TableCell>
        <div role="radiogroup" aria-label={t('columns.kind')} className="inline-flex rounded-lg border p-0.5">
          {(['prep', 'view'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              disabled={!canEdit}
              onClick={() => setKind(k)}
              className={cn(
                'h-9 rounded-md px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed',
                kind === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
              )}
            >
              {t(`kinds.${k}`)}
            </button>
          ))}
        </div>
      </TableCell>
      <TableCell>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={WARN_MAX}
          dir="ltr"
          className="h-9 w-20 text-start"
          value={warn}
          disabled={!canEdit}
          aria-label={t('columns.warn')}
          aria-invalid={invalid || undefined}
          onChange={(e) => setWarn(e.target.value)}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          inputMode="numeric"
          min={1}
          max={LATE_MAX}
          dir="ltr"
          className="h-9 w-20 text-start"
          value={late}
          disabled={!canEdit}
          aria-label={t('columns.late')}
          aria-invalid={invalid || undefined}
          onChange={(e) => setLate(e.target.value)}
        />
      </TableCell>
      <TableCell>
        {station.hasDevice ? (
          <Badge className="bg-emerald-600 text-white dark:bg-emerald-500">{t('hasDevice')}</Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {t('noDevice')}
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {station.printerIds.length > 0 ? t('printersCount', { count: station.printerIds.length }) : t('noPrinters')}
      </TableCell>
      <TableCell>
        {canEdit ? (
          <div className="space-y-1">
            <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
            {dirty && invalid ? <p className="text-xs text-destructive">{t('invalid')}</p> : null}
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}
