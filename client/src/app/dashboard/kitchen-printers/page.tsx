'use client';

/**
 * "מדפסות" — the printers of one shop: kitchen / bar ticket printers (SPEC §4) and receipt
 * printers ("מדפסות חשבוניות": bills and receipts, the cash drawer on their port), a test
 * print for each, what prints where, and the two kitchen options. Everything here reaches
 * the shop's tills on their next pull (they are woken when it changes); the tills then
 * print without the cloud, except through a cloud (relay) printer.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Printer, Trash2 } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  createKitchenPrinter,
  deleteKitchenPrinter,
  fetchKitchenPrinters,
  testKitchenPrinter,
  updateKitchenPrinter,
  type KitchenPrinter,
  type KitchenPrinterInput,
  type PrinterPurpose,
} from '@/lib/kitchenPrintersApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PrinterDialog } from '@/components/dashboard/kitchen-printers/printer-dialog';
import { TestDialog } from '@/components/dashboard/kitchen-printers/test-dialog';
import { RoutingEditor } from '@/components/dashboard/kitchen-printers/routing-editor';
import { OptionsCard } from '@/components/dashboard/kitchen-printers/options-card';
import { StationsCard } from '@/components/dashboard/kitchen-printers/stations-card';
import { PrintServerCard } from '@/components/dashboard/kitchen-printers/print-server-card';

export default function KitchenPrintersPage() {
  const t = useTranslations('kitchenPrinters');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  // Printers belong to a shop: the page needs one.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';
  const queryKey = ['kitchen-printers', shopId];

  const { data: page, isLoading } = useQuery({
    queryKey,
    queryFn: () => fetchKitchenPrinters(shopId),
    enabled: !!shopId,
  });

  const [dialog, setDialog] = useState<{ printer: KitchenPrinter | null; purpose: PrinterPurpose } | null>(null);
  const [testing, setTesting] = useState<{ printer: KitchenPrinter; jobIds: string[] } | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey });
    qc.invalidateQueries({ queryKey: ['kitchen-printer-routing', shopId] });
  };

  const save = useMutation({
    mutationFn: (v: { id: string | null; body: KitchenPrinterInput }) =>
      v.id ? updateKitchenPrinter(v.id, v.body) : createKitchenPrinter(shopId, v.body),
    onSuccess: (_, v) => {
      toast.success(v.id ? t('updated') : t('created'));
      setDialog(null);
      refresh();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteKitchenPrinter(id),
    onSuccess: () => {
      toast.success(t('deleted'));
      refresh();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const test = useMutation({
    mutationFn: (printer: KitchenPrinter) => testKitchenPrinter(printer.id),
    onSuccess: (jobs, printer) => setTesting({ printer, jobIds: jobs.map((j) => j.id) }),
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      toast.error(
        e?.response?.data?.detail === 'printer_has_no_till'
          ? t('test.noTill')
          : axiosErrorToToastMessage(err, tc('error')),
      );
    },
  });

  const connection = (p: KitchenPrinter): string => {
    const hosted = p.connectionType === 'cloud';
    const reach = hosted ? p.hostConnection : p.connectionType;
    const how =
      reach === 'network'
        ? t('connection.network', { address: `${p.host}:${p.port ?? 9100}` })
        : reach === 'bluetooth'
          ? p.btAddress
            ? t('connection.bluetooth', { device: [p.btName, p.btAddress].filter(Boolean).join(' ') })
            : t('connection.bluetoothOnTill')
          : reach === 'usb'
            ? t('connection.usb')
            : t('connection.till');
    return p.connectionType === 'cloud'
      ? t('connection.cloud', { host: p.hostMachineName ?? '?', how })
      : how;
  };

  const scopeText = (p: KitchenPrinter): string =>
    p.machineName
      ? t('scopeMachine', { name: p.machineName })
      : p.areaName
        ? t('scopeArea', { name: p.areaName })
        : t('scopeShop');

  const canEdit = page?.canEdit === true;
  const kitchen = (page?.printers ?? []).filter((p) => (p.purpose ?? 'kitchen') === 'kitchen');
  const receipts = (page?.printers ?? []).filter((p) => p.purpose === 'receipt');

  const table = (printers: KitchenPrinter[], empty: string) =>
    printers.length === 0 ? (
      <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">{empty}</div>
    ) : (
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.name')}</TableHead>
              <TableHead>{t('columns.connection')}</TableHead>
              <TableHead>{t('columns.scope')}</TableHead>
              <TableHead>{t('columns.print')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-36" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {printers.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">{p.name}</TableCell>
                <TableCell>{connection(p)}</TableCell>
                <TableCell>{scopeText(p)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {[
                    p.paperWidth === 58 ? t('paper58') : t('paper80'),
                    p.copies > 1 && p.purpose !== 'receipt' ? t('copiesN', { n: p.copies }) : null,
                    p.cutPaper ? t('cutShort') : null,
                    p.beep && p.purpose !== 'receipt' ? t('beepShort') : null,
                    p.cashDrawer ? t('drawerShort') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </TableCell>
                <TableCell>
                  <Badge variant={p.isActive ? 'secondary' : 'outline'}>
                    {p.isActive ? tc('active') : tc('inactive')}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!p.isActive || test.isPending}
                      onClick={() => test.mutate(p)}
                    >
                      <Printer className="h-3.5 w-3.5" /> {t('testPrint')}
                    </Button>
                    {canEdit && (
                      <>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tc('edit')}
                          onClick={() => setDialog({ printer: p, purpose: p.purpose ?? 'kitchen' })}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tc('delete')}
                          onClick={() => {
                            if (window.confirm(t('confirmDelete', { name: p.name }))) remove.mutate(p.id);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setDialog({ printer: null, purpose: 'kitchen' })}>
              <Plus className="ms-1 h-4 w-4" /> {t('add')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setDialog({ printer: null, purpose: 'receipt' })}>
              <Plus className="ms-1 h-4 w-4" /> {t('addReceipt')}
            </Button>
          </div>
        )}
      </div>

      <ScopeGate resolution={resolution}>
        {isLoading || !page ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">{t('kitchenTitle')}</h2>
              {table(kitchen, t('empty'))}
            </section>

            <section className="space-y-2">
              <h2 className="text-lg font-semibold">{t('receiptTitle')}</h2>
              <p className="text-sm text-muted-foreground">{t('receiptHint')}</p>
              {table(receipts, t('receiptEmpty'))}
            </section>

            <PrintServerCard page={page} />
            <RoutingEditor shopId={shopId} printers={kitchen} canEdit={canEdit} />
            <StationsCard shopId={shopId} printers={kitchen} canEditShop={canEdit} />
            <OptionsCard page={page} />

            {dialog && (
              <PrinterDialog
                key={dialog.printer?.id ?? 'new'}
                open
                printer={dialog.printer}
                purpose={dialog.purpose}
                page={page}
                saving={save.isPending}
                onClose={() => setDialog(null)}
                onSave={(body) => save.mutate({ id: dialog.printer?.id ?? null, body })}
              />
            )}
            {testing && (
              <TestDialog printer={testing.printer} jobIds={testing.jobIds} onClose={() => setTesting(null)} />
            )}
          </>
        )}
      </ScopeGate>
    </div>
  );
}
