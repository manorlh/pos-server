'use client';

/**
 * "מגירות לפי קופה" (the owner, 15.10.2026): a cash drawer is either on a receipt printer (network /
 * Bluetooth / USB) or on the till's own drawer port — and with several tills it must be easy to see
 * and mark which till has one. One row per till of the shop: its own drawer ("פתיחת מגירה", set here
 * at the till level through the same route as "הגדרות הדפסה"), the receipt printers with a drawer it
 * uses, and a summary. The rows come from lib/tillDrawers.ts.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import {
  savePrinterSettings,
  type KitchenOptions,
  type KitchenPrinter,
  type KitchenPrintersPage,
} from '@/lib/kitchenPrintersApi';
import {
  CASH_DRAWER_KEY,
  DRAWER_MODES,
  INHERIT,
  drawerChange,
  drawerModeKey,
  tillDrawerRows,
  type Resolved,
  type TillDrawerRow,
} from '@/lib/tillDrawers';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SimpleSelect } from './printer-dialog';

export function DrawersCard({
  page,
  onEditPrinter,
}: {
  page: KitchenPrintersPage;
  /** "ערוך מדפסת": opens the printer's dialog on the page. */
  onEditPrinter: (printer: KitchenPrinter) => void;
}) {
  const t = useTranslations('kitchenPrinters.drawers');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const rows = tillDrawerRows(page);
  const def = page.options.parameters.find((p) => p.key === CASH_DRAWER_KEY);
  const modes: readonly string[] = def?.enumOptions?.length ? def.enumOptions : DRAWER_MODES;
  const printersById = new Map(page.printers.map((p) => [p.id, p]));
  const areaName = (id: string | null | undefined) => page.areas.find((a) => a.id === id)?.name ?? '';

  const save = useMutation({
    mutationFn: (v: { machineId: string; value: string | null }) =>
      savePrinterSettings(page.shopId, 'machine', v.machineId, { [CASH_DRAWER_KEY]: v.value }),
    onSuccess: (next: KitchenOptions) => {
      qc.setQueryData<KitchenPrintersPage>(['kitchen-printers', page.shopId], (old) => (old ? { ...old, options: next } : old));
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const modeLabel = (value: unknown) => {
    const key = drawerModeKey(value);
    return key ? t(`modes.${key}`) : value === null || value === undefined || value === '' ? '—' : String(value);
  };
  const sourceLabel = (r: Resolved) =>
    r.source === 'area' ? t('sources.area', { name: areaName(r.areaId) }) : t(`sources.${r.source}`);
  const inheritLabel = (r: Resolved) =>
    r.source === 'device_default'
      ? t('inheritDevice', { value: modeLabel(r.value) })
      : t('inherit', { value: modeLabel(r.value), source: sourceLabel(r) });

  const summary = (row: TillDrawerRow) => {
    const s = row.summary;
    switch (s.kind) {
      case 'builtIn':
        return <Badge variant="secondary">{t('summary.builtIn')}</Badge>;
      case 'ownPrinter':
        return <Badge variant="secondary">{t('summary.ownPrinter')}</Badge>;
      case 'printer':
        return <Badge variant="secondary">{t('summary.printer', { name: s.printerName })}</Badge>;
      case 'several':
        return <Badge>{t('summary.several')}</Badge>;
      default:
        return <Badge variant="outline">{t('summary.none')}</Badge>;
    }
  };

  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{t('noTills')}</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.till')}</TableHead>
                <TableHead>{t('columns.builtIn')}</TableHead>
                <TableHead>{t('columns.printers')}</TableHead>
                <TableHead>{t('columns.summary')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const choices = [
                  { value: INHERIT, label: inheritLabel(row.inherited) },
                  ...modes.map((m) => ({ value: m, label: modeLabel(m) })),
                  // A value the list does not know (an old one): still shown as it is.
                  ...(row.own !== null && !modes.includes(row.own) ? [{ value: row.own, label: row.own }] : []),
                ];
                return (
                  <TableRow key={row.machineId}>
                    <TableCell className="align-top font-medium">
                      <div className="flex flex-col">
                        <span>{row.name}</span>
                        {row.areaId ? <span className="text-xs text-muted-foreground">{areaName(row.areaId)}</span> : null}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="w-72 max-w-full space-y-1">
                        <SimpleSelect
                          value={row.own ?? INHERIT}
                          options={choices}
                          disabled={!page.canEdit || save.isPending}
                          ariaLabel={t('builtInAria', { name: row.name })}
                          onChange={(choice) => {
                            const value = drawerChange(row, choice);
                            if (value !== undefined) save.mutate({ machineId: row.machineId, value });
                          }}
                        />
                        {row.own !== null ? (
                          <p className="text-xs text-muted-foreground">{t('setOnTill', { value: inheritLabel(row.inherited) })}</p>
                        ) : null}
                        {row.builtInUnreachable ? (
                          <p className="flex items-start gap-1 text-xs text-amber-600">
                            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                            {t('noPortWarning')}
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground">
                            {row.ownDrawer === 'port' ? t('hasPort') : row.ownDrawer === 'ownPrinter' ? t('onOwnPrinter') : t('noPort')}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      {row.printers.length === 0 ? (
                        <span className="text-sm text-muted-foreground">—</span>
                      ) : (
                        <ul className="space-y-0.5">
                          {row.printers.map((p) => {
                            const printer = printersById.get(p.id);
                            return (
                              <li key={p.id} className="flex flex-wrap items-center gap-1 text-sm">
                                {page.canEdit && printer ? (
                                  <Button
                                    variant="link"
                                    size="sm"
                                    className="h-auto p-0"
                                    title={t('editPrinter')}
                                    onClick={() => onEditPrinter(printer)}
                                  >
                                    {p.name}
                                  </Button>
                                ) : (
                                  <span>{p.name}</span>
                                )}
                                <span className="text-xs text-muted-foreground">({t(`scopes.${p.scope}`)})</span>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="align-top">{summary(row)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
