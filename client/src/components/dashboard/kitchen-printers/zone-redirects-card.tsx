'use client';

/**
 * "הפניה לפי אזור שולחנות" — per table zone, "everything sent to [printer] goes to [printer]
 * instead". Leaves the routing untouched: a table's line is routed as always, and only then
 * moved by its zone's rows (pos-server docs/SPEC_PRINT_BY_ZONE.md). With the note that tells
 * it apart from a printer's own scope (a point of sale / one till).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, Plus, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  fetchZoneRedirects,
  saveZoneRedirects,
  zoneRowsDirty,
  zoneRowsProblem,
  type ZoneRedirectRow,
  type ZoneRedirectZone,
  type ZoneRedirectsPage,
} from '@/lib/printerScanApi';
import { Button } from '@/components/ui/button';
import { SimpleSelect } from './printer-dialog';

/** The select's "choose a printer"; a row stores '' until one is chosen. */
const NONE = 'none';

function ZoneRows({
  shopId,
  zone,
  printers,
  canEdit,
}: {
  shopId: string;
  zone: ZoneRedirectZone;
  printers: ZoneRedirectsPage['printers'];
  canEdit: boolean;
}) {
  const t = useTranslations('kitchenPrinters.zoneRedirects');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  // Keyed by what is saved (below): a save remounts the rows from the cloud's answer.
  const [rows, setRows] = useState<ZoneRedirectRow[]>(zone.redirects);

  const save = useMutation({
    mutationFn: () => saveZoneRedirects(shopId, zone.id, rows),
    onSuccess: (page) => {
      qc.setQueryData(['printer-zone-redirects', shopId], page);
      toast.success(t('saved', { zone: zone.name }));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const options = [
    { value: NONE, label: t('choosePrinter') },
    ...printers.map((p) => ({ value: p.id, label: p.isActive ? p.name : t('inactive', { name: p.name }) })),
  ];
  const problem = zoneRowsProblem(rows);
  const dirty = zoneRowsDirty(zone.redirects, rows);
  const set = (i: number, patch: Partial<ZoneRedirectRow>) =>
    setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="font-medium">
          {zone.name}
          {zone.areaName && <span className="ms-2 text-xs text-muted-foreground">{t('area', { name: zone.areaName })}</span>}
        </div>
        {rows.length === 0 && <span className="text-xs text-muted-foreground">{t('noRedirect')}</span>}
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t('everything')}</span>
          <div className="min-w-40">
            <SimpleSelect
              value={row.fromPrinterId || NONE}
              options={options}
              disabled={!canEdit}
              ariaLabel={t('from')}
              onChange={(v) => set(i, { fromPrinterId: v === NONE ? '' : v })}
            />
          </div>
          <ArrowLeft className="h-4 w-4 text-muted-foreground rtl:rotate-0 ltr:rotate-180" aria-hidden />
          <span>{t('goesTo')}</span>
          <div className="min-w-40">
            <SimpleSelect
              value={row.toPrinterId || NONE}
              options={options}
              disabled={!canEdit}
              ariaLabel={t('to')}
              onChange={(v) => set(i, { toPrinterId: v === NONE ? '' : v })}
            />
          </div>
          {canEdit && (
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={tc('delete')}
              onClick={() => setRows((r) => r.filter((_, j) => j !== i))}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      ))}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setRows((r) => [...r, { fromPrinterId: '', toPrinterId: '' }])}
            disabled={printers.length < 2}
          >
            <Plus className="h-4 w-4" /> {t('addRow')}
          </Button>
          {dirty && (
            <Button size="sm" onClick={() => save.mutate()} disabled={!!problem || save.isPending}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          )}
          {dirty && problem && <span className="text-xs text-destructive">{t(`problems.${problem}`)}</span>}
        </div>
      )}
    </div>
  );
}

export function ZoneRedirectsCard({ shopId, canEdit }: { shopId: string; canEdit: boolean }) {
  const t = useTranslations('kitchenPrinters.zoneRedirects');
  const { data } = useQuery({
    queryKey: ['printer-zone-redirects', shopId],
    queryFn: () => fetchZoneRedirects(shopId),
    enabled: !!shopId,
  });

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
        <p className="text-sm text-muted-foreground">{t('example')}</p>
      </div>
      <div className="rounded-md bg-muted/50 p-3 text-sm">
        <div className="font-medium">{t('whichTitle')}</div>
        <ul className="ms-4 list-disc space-y-1 text-muted-foreground">
          <li>{t('whichScope')}</li>
          <li>{t('whichZone')}</li>
          <li>{t('whichFailover')}</li>
        </ul>
      </div>
      {!data ? null : data.zones.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noZones')}</p>
      ) : data.printers.length < 2 ? (
        <p className="text-sm text-muted-foreground">{t('needTwoPrinters')}</p>
      ) : (
        <div className="space-y-2">
          {data.zones.map((zone) => (
            <ZoneRows
              key={`${zone.id}:${zone.redirects.map((r) => `${r.fromPrinterId}>${r.toPrinterId}`).join(',')}`}
              shopId={shopId} zone={zone} printers={data.printers} canEdit={canEdit} />
          ))}
        </div>
      )}
    </section>
  );
}
