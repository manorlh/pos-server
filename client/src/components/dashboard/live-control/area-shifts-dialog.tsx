'use client';

/**
 * "סגירת משמרות לנקודת מכירה" (pos-server remote_till_z.area_shift_preview / area_shift_request): every
 * till of a point of sale, each its own remote shift close — the same rules ("כפה סגירה" by each till's
 * default or the manager's tick for this close, its own totals confirmed). Non-blocking: it sends and
 * closes; each till's progress shows on its row.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchAreaShiftPreview, requestAreaShiftClose } from '@/lib/liveControlApi';
import { money } from '@/lib/remoteTillZ';
import { defaultsOf, forceExplain, groupCheckbox, rowModeWords } from '@/lib/remoteCloseForce';
import { ForceCloseToggle } from './force-close-toggle';

export function AreaShiftsDialog({ shopId, areaId, areaName, onClose }: { shopId: string; areaId: string; areaName: string; onClose: () => void }) {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: ['device-commands', 'area-shifts', shopId, areaId],
    queryFn: () => fetchAreaShiftPreview(shopId, areaId),
  });
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  // "כפה סגירה" for every till of this close: null — each till's own default.
  const [tick, setTick] = useState<boolean | null>(null);
  const rows = preview.data?.tills ?? [];
  const chosen = rows.filter((r) => r.canRequest && !unchecked.has(r.machineId));
  const modes = chosen.map((r) => r.force);
  const box = groupCheckbox(modes, tick);
  const send = useMutation({
    mutationFn: () =>
      requestAreaShiftClose({
        shopId,
        areaId,
        totalsKeys: Object.fromEntries(chosen.map((r) => [r.machineId, r.totalsKey ?? ''])),
        ...(box.send !== undefined ? { force: box.send } : {}),
      }),
    onSuccess: (out) => {
      const ok = out.results.filter((r) => r.ok).length;
      const failed = out.results.filter((r) => !r.ok);
      toast.success(
        box.send === false || (box.send === undefined && defaultsOf(modes) === 'off')
          ? `נשלח ל-${ok} קופות — כל אחת תיסגר כשאין בה מכירה או תשלום פתוחים`
          : `נשלח ל-${ok} קופות — כל אחת תיסגר לפי "כפה סגירה" (עסקת אשראי בדרך תמתין)`,
      );
      for (const f of failed) toast.error(`${rows.find((r) => r.machineId === f.machineId)?.name ?? f.machineId}: ${f.message ?? 'לא נשלח'}`);
      qc.invalidateQueries({ queryKey: ['device-commands'] });
      onClose();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, 'השליחה נכשלה')),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>סגירת משמרות לנקודת מכירה · {areaName}</DialogTitle>
        </DialogHeader>
        {preview.isPending ? (
          <Skeleton className="h-32 w-full rounded-xl" />
        ) : preview.isError ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(preview.error, 'הטעינה נכשלה')}</p>
        ) : (
          <div className="space-y-2 text-sm">
          {chosen.length > 0 ? (
            <ForceCloseToggle
              checked={box.checked}
              indeterminate={box.indeterminate}
              defaultWords={
                defaultsOf(modes) === 'mixed'
                  ? 'ברירת המחדל שונה בין הקופות'
                  : defaultsOf(modes) === 'off'
                    ? 'ברירת המחדל: המתנה למנוחה'
                    : 'ברירת המחדל: כפייה'
              }
              explain={box.indeterminate ? 'כל קופה לפי ברירת המחדל שלה (ברשימה)' : forceExplain(box.checked, 'close_shift')}
              onChange={setTick}
            />
          ) : null}
          <ul className="space-y-1.5 text-sm">
            {rows.map((r) => (
              <li key={r.machineId} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  disabled={!r.canRequest}
                  checked={r.canRequest && !unchecked.has(r.machineId)}
                  onChange={(e) =>
                    setUnchecked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.delete(r.machineId);
                      else next.add(r.machineId);
                      return next;
                    })
                  }
                />
                <span className="font-medium">{r.name}</span>
                {r.posNumber ? <span className="text-xs text-muted-foreground">#{r.posNumber}</span> : null}
                {r.totals ? <span className="ms-auto tabular-nums">{money(r.totals.net)}</span> : null}
                <span className="w-full text-xs text-muted-foreground">
                  {r.canRequest ? (rowModeWords(r.force, tick) ?? r.openBasket ?? 'תיסגר כשהקופה פנויה') : r.whyNot}
                </span>
              </li>
            ))}
          </ul>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="outline" className="min-h-11" onClick={onClose}>
            ביטול
          </Button>
          <Button className="min-h-11" disabled={chosen.length === 0 || send.isPending} onClick={() => send.mutate()}>
            {send.isPending ? 'שולח…' : `סגור משמרות (${chosen.length})`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
