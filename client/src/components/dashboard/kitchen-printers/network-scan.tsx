'use client';

/**
 * "חיפוש ברשת" — the dashboard cannot see the shop's network; its tills can. A scan asks one
 * till of the shop (the print server when it is online, else the till seen last) to sweep
 * its LAN: "הקופה X סורקת את הרשת…", polled every two seconds until it answers. The results
 * — address, name, kind, already configured — stay as "the last scan" with its time.
 * Choosing one fills the network printer form (address and port).
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Loader2, Radar } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  fetchPrinterScan,
  orderScanResults,
  scanErrorKey,
  scanResultUsable,
  scanRunning,
  startPrinterScan,
  type DiscoveredPrinter,
  type PrinterScanState,
} from '@/lib/printerScanApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const POLL_MS = 2000;

/** The scan's state for one shop, polled while a scan runs. */
export function usePrinterScan(shopId: string, enabled = true) {
  // Intentionally not in "פקודות שנשלחו" (lib/deviceCommandsStore.ts): a scan is a search whose results are this panel, not a device command.
  return useQuery({
    queryKey: ['printer-scan', shopId],
    queryFn: () => fetchPrinterScan(shopId),
    enabled: enabled && !!shopId,
    refetchInterval: (query) => (scanRunning(query.state.data?.request) ? POLL_MS : false),
  });
}

/** The button, the progress and the results. [onChoose]: a printer fills the form. */
export function NetworkScanPanel({
  shopId,
  canEdit,
  onChoose,
}: {
  shopId: string;
  canEdit: boolean;
  onChoose?: (printer: DiscoveredPrinter) => void;
}) {
  const t = useTranslations('kitchenPrinters.scan');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const { data, isLoading } = usePrinterScan(shopId);

  const start = useMutation({
    mutationFn: () => startPrinterScan(shopId),
    onSuccess: (state) => qc.setQueryData<PrinterScanState>(['printer-scan', shopId], state),
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      toast.error(
        e?.response?.data?.detail === 'no_till_online' ? t('noTillOnline') : axiosErrorToToastMessage(err, tc('error')),
      );
    },
  });

  const request = data?.request ?? null;
  const running = scanRunning(request);
  const last = data?.last ?? null;
  const errorKey = request && request.id !== last?.id ? scanErrorKey(request) : null;
  const rows = orderScanResults(last?.printers ?? []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit && (
          <Button size="sm" variant="outline" disabled={running || start.isPending || !data?.scanner} onClick={() => start.mutate()}>
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />} {t('button')}
          </Button>
        )}
        <span className="text-sm text-muted-foreground">
          {isLoading
            ? tc('loading')
            : running
              ? request?.status === 'pending'
                ? t('waitingFor', { till: request?.machineName ?? '?' })
                : t('scanning', { till: request?.machineName ?? '?' })
              : data?.scanner
                ? t('willScan', { till: data.scanner.name })
                : t('noTillOnline')}
        </span>
      </div>

      {errorKey && (
        <p className="text-sm text-destructive">
          {t(`errors.${errorKey}`, { till: request?.machineName ?? '?' })}
        </p>
      )}

      {last && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t('lastScan', {
              time: formatDateTime(last.completedAt),
              till: last.machineName ?? '?',
              subnet: last.subnet ?? '?',
            })}
          </p>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('none')}</p>
          ) : (
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.address')}</TableHead>
                    <TableHead>{t('columns.name')}</TableHead>
                    <TableHead>{t('columns.kind')}</TableHead>
                    <TableHead>{t('columns.status')}</TableHead>
                    {onChoose && <TableHead className="w-24" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((p) => (
                    <TableRow key={`${p.host}:${p.port}`}>
                      <TableCell dir="ltr" className="font-mono text-sm">
                        {p.host}:{p.port}
                        {p.responseMs != null && (
                          <span className="ms-2 text-xs text-muted-foreground">{p.responseMs} ms</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{p.name ?? p.model ?? t('unnamed')}</div>
                        {p.name && p.model && <div className="text-xs text-muted-foreground">{p.model}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={p.kind === 'escpos' ? 'secondary' : 'outline'}>{t(`kinds.${p.kind}`)}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {p.configuredPrinterName ? (
                          <span className="text-green-700 dark:text-green-400">
                            {t('configured', { name: p.configuredPrinterName })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t('notConfigured')}</span>
                        )}
                        {p.paper && p.paper !== 'ok' && (
                          <div className="text-xs text-destructive">{t(`paper.${p.paper}`)}</div>
                        )}
                        {p.offline && <div className="text-xs text-destructive">{t('offline')}</div>}
                      </TableCell>
                      {onChoose && (
                        <TableCell>
                          {scanResultUsable(p) && !p.configuredPrinterId && (
                            <Button size="sm" onClick={() => onChoose(p)}>
                              {t('choose')}
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The page's section. */
export function NetworkScanCard({
  shopId,
  canEdit,
  onChoose,
}: {
  shopId: string;
  canEdit: boolean;
  onChoose: (printer: DiscoveredPrinter) => void;
}) {
  const t = useTranslations('kitchenPrinters.scan');
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <NetworkScanPanel shopId={shopId} canEdit={canEdit} onChoose={canEdit ? onChoose : undefined} />
    </section>
  );
}

/** From the printer dialog: pick a printer the scan found. */
export function NetworkScanDialog({
  shopId,
  onClose,
  onChoose,
}: {
  shopId: string;
  onClose: () => void;
  onChoose: (printer: DiscoveredPrinter) => void;
}) {
  const t = useTranslations('kitchenPrinters.scan');
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        <NetworkScanPanel
          shopId={shopId}
          canEdit
          onChoose={(p) => {
            onChoose(p);
            onClose();
          }}
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
