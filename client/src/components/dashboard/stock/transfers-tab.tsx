'use client';

/**
 * "העברות" — move stock between two places (the store to a bar, a bar to a till), and the low-stock
 * alerts with their suggested transfer in one tap ("העבר 8 מהמחסן"). A transfer never makes units:
 * it is two movements in the log, out of one location and into the other.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeftRight, PackageX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { BlockItemSheet, StockUpdateSheet, invalidateStock, useStockAlertsOf } from '@/components/dashboard/live-control';
import { alertBody, alertTitle, formatQty, LEVEL_LABELS, type StockAlert } from '@/lib/stockLive';
import { postTransfer } from '@/lib/stockLiveApi';

export function TransfersTab({ scope }: { scope: { companyId?: string | null; shopId?: string | null } }) {
  const qc = useQueryClient();
  const alerts = useStockAlertsOf(scope);
  const [sheet, setSheet] = useState<{ alert?: StockAlert } | null>(null);
  const [blockFor, setBlockFor] = useState<StockAlert | null>(null);

  const move = useMutation({
    mutationFn: (a: StockAlert) =>
      postTransfer({
        productId: a.productId,
        from: { level: a.suggestTransfer!.level, targetId: a.suggestTransfer!.targetId },
        to: { level: a.location.level, targetId: a.location.targetId },
        quantity: a.suggestTransfer!.quantity,
        note: 'העברה מוצעת — התראת מלאי נמוך',
      }),
    onSuccess: (out, a) => {
      toast.success(`הועברו ${formatQty(a.suggestTransfer!.quantity)} ל${a.location.name ?? LEVEL_LABELS[a.location.level]} · יש שם ${formatQty(out.to.quantity)}`);
      invalidateStock(qc);
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'ההעברה נכשלה')),
  });

  const rows = alerts.data ?? [];
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">העברה בין מחסן, נקודות מכירה וקופות — כל העברה נרשמת ביומן התנועות.</p>
        <Button size="sm" className="min-h-10 gap-1" onClick={() => setSheet({})}>
          <ArrowLeftRight className="size-4" /> העברה חדשה
        </Button>
      </div>

      <div className="space-y-2">
        <h2 className="font-semibold">התראות מלאי נמוך</h2>
        {alerts.isPending ? (
          <div className="h-20 animate-pulse rounded-2xl bg-muted" />
        ) : alerts.isError ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(alerts.error, 'טעינת ההתראות נכשלה')}</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">אין התראות מלאי נמוך כרגע</p>
        ) : (
          <ul className="grid gap-2 lg:grid-cols-2">
            {rows.map((a) => {
              const busy = move.isPending && move.variables?.id === a.id;
              return (
                <li key={a.id} className={cn('space-y-2 rounded-2xl border bg-card p-3', a.kind === 'out' ? 'border-destructive/40' : 'border-amber-500/50')}>
                  <div>
                    <p className="font-semibold">{alertTitle(a)}</p>
                    <p className="text-sm text-muted-foreground">{alertBody(a)}</p>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {a.suggestTransfer && a.suggestTransfer.quantity > 0 ? (
                      <Button size="sm" className="min-h-10 gap-1" disabled={busy} onClick={() => move.mutate(a)}>
                        <ArrowLeftRight className="size-4" />
                        {busy ? 'מעביר…' : `העבר ${formatQty(a.suggestTransfer.quantity)} מ${a.suggestTransfer.name ?? LEVEL_LABELS[a.suggestTransfer.level]}`}
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" className="min-h-10" onClick={() => setSheet({ alert: a })}>
                      כמות אחרת
                    </Button>
                    <Button size="sm" variant="secondary" className="min-h-10 gap-1" onClick={() => setBlockFor(a)}>
                      <PackageX className="size-4" /> חסום / אזל
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {sheet ? (
        <StockUpdateSheet
          scope={scope}
          initialMode="transfer"
          context={
            sheet.alert
              ? {
                  productId: sheet.alert.productId,
                  location: { level: sheet.alert.location.level, targetId: sheet.alert.location.targetId },
                  transfer: sheet.alert.suggestTransfer
                    ? {
                        from: { level: sheet.alert.suggestTransfer.level, targetId: sheet.alert.suggestTransfer.targetId },
                        to: { level: sheet.alert.location.level, targetId: sheet.alert.location.targetId },
                        quantity: sheet.alert.suggestTransfer.quantity,
                      }
                    : null,
                }
              : undefined
          }
          onDone={() => setSheet(null)}
        />
      ) : null}
      {blockFor ? (
        <BlockItemSheet scope={{ ...scope, shopId: blockFor.shopId ?? scope.shopId }} context={{ productId: blockFor.productId }} onDone={() => setBlockFor(null)} />
      ) : null}
    </section>
  );
}
