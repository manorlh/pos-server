'use client';

/**
 * "מכירות מושהות" at a remote close (pos-server app/services/held_sales_close.py): the list the till
 * reported, and the manager's choice — "בטל מכירות מושהות וסגור" (exactly these sales; a reason) or
 * "סגור והשאר מושהות" (where the shop allows it, or support with a reason). Non-blocking: it sends and
 * closes; the till acts once at rest (never over an open sale) and the run shows what it did.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cancelHeldSales, keepHeldSales } from '@/lib/liveControlApi';
import { CANCEL_LABEL, KEEP_LABEL, asOffer, canSend, heldSaleLine, type HeldSalesState } from '@/lib/heldSales';

export function HeldSalesDialog({
  machineId,
  machineName,
  runId,
  state,
  onClose,
}: {
  machineId: string;
  machineName: string;
  runId?: string | null;
  state: HeldSalesState;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const sales = state.heldSalesList ?? [];
  const cancelOffer = state.cancelHeldSales ?? null;
  const keepOffer = asOffer(state.keepHeldSales);
  const done = (text: string) => {
    toast.success(text);
    qc.invalidateQueries({ queryKey: ['device-commands'] });
    onClose();
  };
  const fail = (e: unknown) => {
    const detail = (e as { response?: { data?: { detail?: { message?: string } } } })?.response?.data?.detail;
    toast.error(detail?.message ?? axiosErrorToToastMessage(e, 'השליחה נכשלה'));
  };
  const cancel = useMutation({
    mutationFn: () => cancelHeldSales({ machineId, runId: runId ?? undefined, saleIds: sales.map((s) => s.id), reason: reason.trim() }),
    onSuccess: () => done('נשלח לקופה — תבטל את המכירות שברשימה ותיסגר כשאין בה מכירה פתוחה'),
    onError: fail,
  });
  const keep = useMutation({
    mutationFn: () => keepHeldSales({ machineId, runId: runId ?? undefined, reason: reason.trim() || undefined }),
    onSuccess: () => done('נשלח לקופה — תיסגר ותשאיר את המכירות המושהות'),
    onError: fail,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>מכירות מושהות · {machineName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {sales.length === 0 ? (
            <p className="text-muted-foreground">הקופה עוד לא דיווחה את הרשימה — היא תופיע כאן בדיווח הבא.</p>
          ) : (
            <ul className="space-y-1.5">
              {sales.map((s) => (
                <li key={s.id} className="rounded-lg border p-2">
                  <p className="tabular-nums">{heldSaleLine(s)}</p>
                  {s.items.length > 0 ? <p className="text-xs text-muted-foreground">{s.items.join(', ')}</p> : null}
                </li>
              ))}
            </ul>
          )}
          {(state.heldSalesCancelled ?? []).length > 0 ? (
            <p className="text-xs text-muted-foreground">בוטלו כבר: {(state.heldSalesCancelled ?? []).length}</p>
          ) : null}
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="סיבה (חובה לביטול)"
            maxLength={300}
            className="min-h-10"
          />
          {cancelOffer && !cancelOffer.allowed && cancelOffer.whyNot ? (
            <p className="text-xs text-muted-foreground">{CANCEL_LABEL}: {cancelOffer.whyNot}</p>
          ) : null}
          {keepOffer && !keepOffer.allowed && keepOffer.whyNot ? (
            <p className="text-xs text-muted-foreground">{KEEP_LABEL}: {keepOffer.whyNot}</p>
          ) : null}
          <p className="text-xs text-muted-foreground">מכירה פתוחה בקופה תמיד ממתינה — הקופה פועלת רק כשהיא פנויה.</p>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            סגור
          </Button>
          {keepOffer ? (
            <Button variant="outline" className="min-h-11" disabled={!canSend(keepOffer, reason) || keep.isPending} onClick={() => keep.mutate()}>
              {KEEP_LABEL}
            </Button>
          ) : null}
          <Button
            variant="destructive"
            className="min-h-11"
            disabled={sales.length === 0 || !canSend(cancelOffer, reason) || cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            {CANCEL_LABEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
